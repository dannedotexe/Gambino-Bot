import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { closeAttendance, handleAttendanceInteraction, requestAttendance, requestDueAttendance } from "../src/attendance.js";
import { noShowsOf } from "../src/event-checks.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", LOG = "60000000000000009", TEAM = "20000000000000004";
const A = "30000000000000001", B = "30000000000000002", C = "30000000000000003", STAFF = "30000000000000009";
const cfg = () => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_EVENT_TEAM: TEAM, CHANNEL_EVENT_LOG: LOG, NOSHOW_THRESHOLD: "3" });
function setup() {
  const db = testDb(), posts = [], edits = [];
  const channel = { id: LOG, send: async p => { posts.push(p); return { id: `m${posts.length}`, edit: async e => edits.push(e) }; }, messages: { fetch: async () => ({ edit: async e => edits.push(e) }) } };
  const client = { user: { id: "bot" }, channels: { fetch: async id => id === LOG ? channel : null } };
  const start = new Date(Date.now() - 3 * 3_600_000).toISOString();
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES('e1',?,'Bizwar','',?,'HQ',?,'scheduled',?)").run(G, start, STAFF, start);
  for (const id of [A, B, C]) db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e1',?,'signed_up',?)").run(id, start);
  return { db, client, posts, edits, config: cfg() };
}
const interaction = (customId, { roles = [TEAM], values = [] } = {}) => {
  const out = {};
  return { out, customId, values, user: { id: STAFF }, member: { roles: { cache: new Map(roles.map(r => [r, true])) } }, guild: { members: { fetch: async () => new Map() } },
    reply: async p => { out.reply = p; }, update: async p => { out.update = p; } };
};

test("Anwesenheit: Abfrage im Event-Log, Auswahl im Menü, Abschluss setzt Rest auf nicht da", async () => {
  const x = setup();
  assert.equal(await requestAttendance({ ...x, event: { id: "e1" } }), true);
  assert.equal(await requestAttendance({ ...x, event: { id: "e1" } }), false, "nur einmal");
  assert.match(x.posts[0].content, new RegExp(TEAM));
  assert.equal(x.posts[0].components[0].components[0].data.custom_id, "att:open:e1");

  const denied = interaction("att:open:e1", { roles: [] });
  await handleAttendanceInteraction({ i: denied, ...x });
  assert.match(denied.out.reply.content, /nur das Event-Team/);

  const open = interaction("att:open:e1");
  await handleAttendanceInteraction({ i: open, ...x });
  const menu = open.out.reply.components[0].components[0].data;
  assert.equal(menu.max_values, 3);

  await handleAttendanceInteraction({ i: interaction("att:pick:e1:0", { values: [A, C] }), ...x });
  const status = id => x.db.prepare("SELECT status FROM event_participants WHERE event_id='e1' AND user_id=?").get(id).status;
  assert.deepEqual([status(A), status(B), status(C)], ["present", "signed_up", "present"]);
  assert.equal(noShowsOf(x.db, x.config, G, B).length, 0, "vor dem Abschluss kein No-Show");

  const close = interaction("att:close:e1");
  await handleAttendanceInteraction({ i: close, ...x });
  assert.match(close.out.update.content, /2 von 3 da/);
  assert.equal(status(B), "absent");
  assert.equal(x.db.prepare("SELECT status FROM events WHERE id='e1'").get().status, "ended");
  assert.equal(noShowsOf(x.db, x.config, G, B).length, 1, "nach dem Abschluss zählt der No-Show");
  assert.ok(x.edits.length >= 1, "Log-Nachricht aktualisiert");
  assert.match(closeAttendance(x.db, { eventId: "e1", actorId: STAFF }).error, /bereits/);
});

test("Fällige Abfragen: nur Events ab Einführung, ohne Anmeldungen wird direkt abgeschlossen", async () => {
  const x = setup();
  // Einführung „jetzt“ → das 3 Stunden alte Event ist davor und wird nicht abgefragt.
  assert.equal(await requestDueAttendance({ ...x, reference: new Date() }), 0);
  x.db.prepare("UPDATE guild_settings SET value=? WHERE key='ATTENDANCE_SINCE'").run(new Date(Date.now() - 86_400_000).toISOString());
  assert.equal(await requestDueAttendance({ ...x }), 1);
  x.db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES('e2',?,'Leer','',?,'HQ',?,'ended',?)").run(G, new Date(Date.now() - 4 * 3_600_000).toISOString(), STAFF, new Date().toISOString());
  await requestDueAttendance({ ...x });
  assert.ok(x.db.prepare("SELECT attendance_closed_at FROM events WHERE id='e2'").get().attendance_closed_at);
});

test("Abfrage kommt bei Eventbeginn in den Event-Check-Channel", async () => {
  const x = setup(), CHECK = "60000000000000077", checkPosts = [];
  const checkChannel = { id: CHECK, send: async p => { checkPosts.push(p); return { id: "c1" }; } };
  const client = { ...x.client, channels: { fetch: async id => id === CHECK ? checkChannel : x.client.channels.fetch(id) } };
  const config = { ...x.config, CHANNEL_EVENT_CHECK: CHECK };
  x.db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?)").run(G, "ATTENDANCE_SINCE", new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString());
  x.db.prepare("UPDATE events SET starts_at=? WHERE id='e1'").run(new Date(Date.now() + 10 * 60_000).toISOString());
  assert.equal(await requestDueAttendance({ db: x.db, client, config }), 0, "vor Beginn nichts");
  x.db.prepare("UPDATE events SET starts_at=? WHERE id='e1'").run(new Date(Date.now() - 60_000).toISOString());
  assert.equal(await requestDueAttendance({ db: x.db, client, config }), 1);
  assert.equal(checkPosts.length, 1);
  assert.equal(x.posts.length, 0, "nicht ins Event-Log");
  assert.match(checkPosts[0].components[0].components[0].data.label, /Event vorbei/);
});

test("Anwesenheit: nicht Angemeldete können als anwesend hinzugefügt werden", async () => {
  const x = setup(), D = "30000000000000004";
  const add = { ...interaction("att:add:e1", { values: [D] }), users: new Map([[D, { bot: false }]]) };
  add.update = async p => { add.out.update = p; };
  await handleAttendanceInteraction({ i: add, ...x });
  assert.equal(x.db.prepare("SELECT status FROM event_participants WHERE event_id='e1' AND user_id=?").get(D).status, "present");
  assert.match(add.out.update.components.at(-1).components[0].data.label, /1\/4 da/);
});

test("Win/Lose: Win verteilt den Betrag an jeden Anwesenden, nur einmal; Win nur mit Finanzrecht", async () => {
  const x = setup();
  x.config.ROLE_FINANCE = ["20000000000000003"];
  await handleAttendanceInteraction({ i: interaction("att:pick:e1:0", { values: [A, C] }), ...x });
  const close = interaction("att:close:e1");
  await handleAttendanceInteraction({ i: close, ...x });
  assert.deepEqual(close.out.update.components[0].components.map(b => b.data.custom_id), ["att:win:e1", "att:lose:e1"]);
  const noFinance = interaction("att:win:e1");
  await handleAttendanceInteraction({ i: noFinance, ...x });
  assert.match(noFinance.out.reply.content, /nur Finanzen/);
  const win = { ...interaction("att:winmodal:e1", { roles: ["20000000000000003"] }), fields: { getTextInputValue: id => id === "amount" ? "25k" : "" }, message: {} };
  win.update = async p => { win.out.update = p; };
  await handleAttendanceInteraction({ i: win, ...x });
  assert.match(win.out.update.content, /je \*\*\$25\.000,00\*\* an 2 Anwesende/);
  const balance = id => x.db.prepare("SELECT COALESCE(balance_cents,0) b FROM accounts WHERE user_id=?").get(id)?.b ?? 0;
  assert.deepEqual([balance(A), balance(B), balance(C)], [2_500_000, 0, 2_500_000]);
  const again = { ...interaction("att:winmodal:e1", { roles: ["20000000000000003"] }), fields: { getTextInputValue: id => id === "amount" ? "25k" : "" }, message: {} };
  await handleAttendanceInteraction({ i: again, ...x });
  assert.match(again.out.reply.content, /bereits/);
  assert.equal(balance(A), 2_500_000, "nicht doppelt");
  assert.equal(x.db.prepare("SELECT outcome FROM events WHERE id='e1'").get().outcome, "win");
});

test("Nicht gespielt: Event abgeschlossen ohne No-Shows, danach keine Anwesenheit mehr", async () => {
  const x = setup();
  await requestAttendance({ ...x, event: { id: "e1" } });
  assert.deepEqual(x.posts[0].components[0].components.map(b => b.data.custom_id), ["att:open:e1", "att:skip:e1"]);
  const skip = interaction("att:skip:e1");
  await handleAttendanceInteraction({ i: skip, ...x });
  assert.match(skip.out.reply.content, /nicht gespielt/);
  const row = x.db.prepare("SELECT status,attendance_closed_at FROM events WHERE id='e1'").get();
  assert.equal(row.status, "cancelled"); assert.ok(row.attendance_closed_at);
  assert.equal(noShowsOf(x.db, x.config, G, A).length, 0);
  const again = interaction("att:open:e1");
  await handleAttendanceInteraction({ i: again, ...x });
  assert.match(again.out.reply.content, /bereits abgeschlossen/);
});

test("No-Show entfernen: zählt nicht mehr, nur einmal möglich", async () => {
  const { removeNoShow } = await import("../src/event-checks.js");
  const x = setup();
  await handleAttendanceInteraction({ i: interaction("att:pick:e1:0", { values: [A] }), ...x });
  await handleAttendanceInteraction({ i: interaction("att:close:e1"), ...x });
  assert.equal(noShowsOf(x.db, x.config, G, B).length, 1);
  assert.ok(removeNoShow(x.db, { guildId: G, eventId: "e1", userId: B, actorId: STAFF, reason: "entschuldigt" }).ok);
  assert.equal(noShowsOf(x.db, x.config, G, B).length, 0);
  assert.match(removeNoShow(x.db, { guildId: G, eventId: "e1", userId: B, actorId: STAFF }).error, /bereits/);
  assert.equal(noShowsOf(x.db, x.config, G, C).length, 1, "andere bleiben");
});

test("Event-Post hat „Event beenden“; vor Start Hinweis; ohne Anmeldungen trotzdem nachtragbar", async () => {
  const { eventCardPayload } = await import("../src/event-posts.js");
  const card = eventCardPayload({ event: { id: "e9", name: "x", starts_at: new Date().toISOString(), status: "scheduled" }, participants: [] });
  assert.ok(card.components[0].components.some(b => b.data.custom_id === "att:open:e9"));
  const x = setup();
  x.db.prepare("UPDATE events SET starts_at=? WHERE id='e1'").run(new Date(Date.now() + 3_600_000).toISOString());
  const early = interaction("att:open:e1");
  await handleAttendanceInteraction({ i: early, ...x });
  assert.match(early.out.reply.content, /noch nicht begonnen/);
  const member = interaction("att:open:e1", { roles: [] });
  await handleAttendanceInteraction({ i: member, ...x });
  assert.match(member.out.reply.content, /nur das Event-Team/);
  // Leeres Event, still abgeschlossen → „Event beenden“ öffnet trotzdem zum Nachtragen.
  x.db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at,attendance_closed_at) VALUES('e2',?,'Leer','',?,'HQ',?,'scheduled',?,?)").run(G, new Date(Date.now() - 60_000).toISOString(), STAFF, new Date().toISOString(), new Date().toISOString());
  const open = interaction("att:open:e2");
  await handleAttendanceInteraction({ i: open, ...x });
  assert.ok(open.out.reply.components.some(r => r.components[0].data.custom_id === "att:add:e2"));
  assert.equal(x.db.prepare("SELECT attendance_closed_at FROM events WHERE id='e2'").get().attendance_closed_at, null);
});

test("manuell geöffnetes leeres Event wird nicht vom Hintergrund wieder geschlossen", async () => {
  const x = setup();
  x.db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?)").run(G, "ATTENDANCE_SINCE", new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString());
  x.db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at,attendance_closed_at) VALUES('e3',?,'Leer','',?,'HQ',?,'scheduled',?,?)").run(G, new Date(Date.now() - 60_000).toISOString(), STAFF, new Date().toISOString(), new Date().toISOString());
  await handleAttendanceInteraction({ i: interaction("att:open:e3"), ...x });
  await requestDueAttendance({ ...x });
  assert.equal(x.db.prepare("SELECT attendance_closed_at FROM events WHERE id='e3'").get().attendance_closed_at, null);
});

test("Event ohne Anmeldungen: wartet auf Event-Logs, endet nach der Auto-Ende-Zeit; mit Logs normale Abfrage", async () => {
  const x = setup();
  x.db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?)").run(G, "ATTENDANCE_SINCE", new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString());
  const add = (id, minutesAgo) => x.db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES(?,'" + G + "','RP Fabrik','',?,'HQ',?,'scheduled',?)").run(id, new Date(Date.now() - minutesAgo * 60_000).toISOString(), STAFF, new Date().toISOString());
  add("e4", 1); add("e5", (x.config.EVENT_SERIES_AUTO_END_MINUTES ?? 120) + 5); add("e6", 1);
  const now = new Date().toISOString();
  x.db.prepare("INSERT INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES('pp','" + G + "','e6',?,'t',1,?,?)").run(A, now, now);
  await requestDueAttendance({ ...x });
  const row = id => x.db.prepare("SELECT status,attendance_closed_at,attendance_message_id FROM events WHERE id=?").get(id);
  assert.equal(row("e4").status, "scheduled", "kurz nach Beginn: Bilder können noch kommen"); assert.equal(row("e4").attendance_closed_at, null);
  assert.equal(row("e5").status, "ended"); assert.ok(row("e5").attendance_closed_at);
  assert.ok(row("e6").attendance_message_id, "mit Event-Log: Abfrage wird gepostet");
  assert.equal(x.db.prepare("SELECT status FROM event_participants WHERE event_id='e6' AND user_id=?").get(A).status, "present");
});

test("Abschließen: wer ein Event-Log gepostet hat, wird automatisch anwesend (ausdrücklich abwesend bleibt)", async () => {
  const { closeAttendance } = await import("../src/attendance.js");
  const x = setup(), now = new Date().toISOString();
  x.db.prepare("INSERT INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES('q1','" + G + "','e1',?,'t',1,?,?),('q2','" + G + "','e1','30000000000000077','t',1,?,?)").run(A, now, now, now, now);
  const before = Object.fromEntries(x.db.prepare("SELECT user_id,status FROM event_participants WHERE event_id='e1'").all().map(r => [r.user_id, r.status]));
  const { rows } = closeAttendance(x.db, { eventId: "e1", actorId: STAFF });
  const status = Object.fromEntries(rows.map(r => [r.user_id, r.status]));
  assert.equal(status[A], before[A] === "absent" ? "absent" : "present");
  assert.equal(status["30000000000000077"], "present", "nicht angemeldet, aber Log gepostet");
  for (const [id, s] of Object.entries(before)) if (id !== A && s === "signed_up") assert.equal(status[id], "absent", "ohne Log und nicht markiert = abwesend");
});

test("Win mit Kills: Anfahrt für alle, Prämie × eigene Kills, Auszahlung genau einmal", async () => {
  const x = setup();
  x.config.ROLE_FINANCE = ["20000000000000003"];
  await handleAttendanceInteraction({ i: interaction("att:pick:e1:0", { values: [A, C] }), ...x });
  await handleAttendanceInteraction({ i: interaction("att:close:e1"), ...x });
  const fin = ["20000000000000003"];
  const modal = { ...interaction("att:winmodal:e1", { roles: fin }), fields: { getTextInputValue: id => id === "amount" ? "25k" : "10.000" } };
  await handleAttendanceInteraction({ i: modal, ...x });
  assert.equal(modal.out.reply.components[0].components[0].data.custom_id, "att:killsel:e1:2500000:1000000");
  const shown = [];
  const sel = { ...interaction("att:killsel:e1:2500000:1000000", { roles: fin, values: [A] }), showModal: async m => shown.push(m) };
  await handleAttendanceInteraction({ i: sel, ...x });
  assert.equal(shown[0].data.custom_id, `att:killset:e1:2500000:1000000:${A}`);
  const set = { ...interaction(`att:killset:e1:2500000:1000000:${A}`, { roles: fin }), fields: { getTextInputValue: () => "3" } };
  set.update = async p => { set.out.update = p; };
  await handleAttendanceInteraction({ i: set, ...x });
  assert.match(set.out.update.content, /3 Kills → \*\*\$55\.000,00/);
  const pay = interaction("att:payout:e1:2500000:1000000", { roles: fin });
  await handleAttendanceInteraction({ i: pay, ...x });
  const balance = id => x.db.prepare("SELECT balance_cents b FROM accounts WHERE user_id=?").get(id)?.b ?? 0;
  assert.deepEqual([balance(A), balance(B), balance(C)], [5_500_000, 0, 2_500_000]);
  assert.match(pay.out.update.content, /3 Kills · gesamt \*\*\$80\.000,00/);
  const again = interaction("att:payout:e1:2500000:1000000", { roles: fin });
  await handleAttendanceInteraction({ i: again, ...x });
  assert.equal(balance(A), 5_500_000, "nicht doppelt");
});

test("Mein Bereich zeigt Event-Bilanz und durch Events verdientes Geld", async () => {
  const { createDashboardApi } = await import("../src/dashboard-api.js");
  const x = setup();
  x.config.ROLE_FINANCE = ["20000000000000003"];
  await handleAttendanceInteraction({ i: interaction("att:pick:e1:0", { values: [A] }), ...x });
  await handleAttendanceInteraction({ i: interaction("att:close:e1"), ...x });
  const win = { ...interaction("att:winmodal:e1", { roles: ["20000000000000003"] }), fields: { getTextInputValue: id => id === "amount" ? "25k" : "" }, message: {} };
  win.update = async () => {};
  await handleAttendanceInteraction({ i: win, ...x });
  const guild = { id: G, members: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map() }, channels: { fetch: async () => null } };
  const api = createDashboardApi({ db: x.db, client: { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { cache: new Map() } }, config: x.config });
  const mine = (await api.get({ id: A, owner: false, roles: [], family: true, team: false }, new URL("/api/my", "https://x"))).body;
  assert.deepEqual(mine.events.record, { wins: 1, losses: 0 });
  assert.equal(mine.events.earned, 2_500_000);
  assert.equal(mine.events.past[0].won_cents, 2_500_000);
});

test("Kill-Logs: Kills am Bild eintragen → beim Auszahlen vorausgefüllt (Handeingabe hat Vorrang)", async () => {
  const { handleEventProofInteraction } = await import("../src/event-proofs.js");
  const x = setup(), now = new Date().toISOString(), fin = ["20000000000000003"];
  x.config.ROLE_FINANCE = fin;
  const proof = (id, user, kills = null) => x.db.prepare("INSERT INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,kills,created_at,updated_at) VALUES(?,'" + G + "','e1',?,'t',1,?,?,?)").run(id, user, kills, now, now);
  proof("k1", A); proof("k2", A, 1); proof("k3", C, 4);
  // Person trägt am eigenen Bild 2 Kills ein (Button → Fenster).
  const shown = [], updates = [], replies = [];
  const base = { user: { id: A }, client: { channels: { fetch: async () => null } }, reply: async p => replies.push(p), update: async p => updates.push(p), showModal: async m => shown.push(m) };
  await handleEventProofInteraction({ i: { ...base, customId: "evp:kills:k1" }, db: x.db, config: x.config });
  assert.equal(shown[0].data.custom_id, "evp:killset:k1");
  await handleEventProofInteraction({ i: { ...base, customId: "evp:killset:k1", fields: { getTextInputValue: () => "2" } }, db: x.db, config: x.config });
  assert.match(updates[0].content, /🎯 Kill-Log: \*\*2 Kills\*\*/);
  await handleEventProofInteraction({ i: { ...base, user: { id: B }, customId: "evp:kills:k1" }, db: x.db, config: x.config });
  assert.match(replies[0].content, /nur die Person/, "nur der Poster");
  // Auszahlen: A = 2 + 1 = 3 Kills aus den Logs, C = 4 aus dem Log, aber von Hand auf 1 korrigiert.
  await handleAttendanceInteraction({ i: interaction("att:pick:e1:0", { values: [A, C] }), ...x });
  await handleAttendanceInteraction({ i: interaction("att:close:e1"), ...x });
  x.db.prepare("INSERT INTO event_kills(event_id,user_id,kills,updated_at) VALUES('e1',?,1,?)").run(C, now);
  const modal = { ...interaction("att:winmodal:e1", { roles: fin }), fields: { getTextInputValue: id => id === "amount" ? "25k" : "10.000" } };
  await handleAttendanceInteraction({ i: modal, ...x });
  assert.match(modal.out.reply.content, /3 Kills 📸 → \*\*\$55\.000,00/);
  assert.match(modal.out.reply.content, /1 Kill \(Kill-Log: 4\) → \*\*\$35\.000,00/);
  // Nach der Auszahlung lässt sich am Bild nichts mehr ändern.
  await handleAttendanceInteraction({ i: interaction("att:payout:e1:2500000:1000000", { roles: fin }), ...x });
  await handleEventProofInteraction({ i: { ...base, customId: "evp:kills:k1" }, db: x.db, config: x.config });
  assert.match(replies.at(-1).content, /schon ausgezahlt/);
});
