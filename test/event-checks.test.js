import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { checkEventMinimums, noShowsOf, processNoShows } from "../src/event-checks.js";
import { createReminderPrefs } from "../src/reminder-prefs.js";
import { sendEventReminder, eventCardPayload } from "../src/event-posts.js";
import { createAbsenceService } from "../src/services/absences.js";
import { createHandler } from "../src/commands.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", LOG = "50000000000000009", CH = "50000000000000001";
const ROLE = { leaders: "20000000000000001", events: "20000000000000005" };
const A = "30000000000000001", B = "30000000000000002", C = "30000000000000003", HOST = "30000000000000009";
const cfg = (extra = {}) => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_LEADERS: ROLE.leaders, ROLE_EVENT_TEAM: ROLE.events, CHANNEL_EVENT_LOG: LOG, CHANNEL_ACTIVITY_LOG: LOG, ...extra });

function fake() {
  const posts = [], dms = [], replies = [];
  const card = { url: "https://discord.com/channels/x/y/z", edit: async () => {}, reply: async p => { replies.push(p); } };
  const channel = id => ({ id, send: async p => { posts.push({ id, ...p }); return { id: "m" }; }, messages: { fetch: async () => card } });
  const client = { user: { id: "bot" }, channels: { fetch: async id => channel(id) }, users: { fetch: async id => ({ send: async p => { dms.push({ id, ...p }); } }) }, guilds: { cache: new Map(), fetch: async () => null } };
  return { posts, dms, replies, client };
}
const addEvent = (db, { id, startsAt, status = "scheduled", min = null, people = [] }) => {
  db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,name,description,starts_at,location,host_id,status,created_at,min_participants) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, G, CH, "card", `Event ${id}`, "-", startsAt, "HQ", HOST, status, startsAt, min);
  for (const [user, state] of people) db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,?,?)").run(id, user, state, startsAt);
};
const inMinutes = m => new Date(Date.now() + m * 60_000).toISOString();

test("Mindestteilnehmer: Meldung ans Event-Team genau einmal, Standardwert greift", async () => {
  const db = testDb(), f = fake(), config = cfg({ EVENT_MIN_PARTICIPANTS: "2" });
  addEvent(db, { id: "e1", startsAt: inMinutes(20), min: 3, people: [[A, "signed_up"]] });
  addEvent(db, { id: "e2", startsAt: inMinutes(20), people: [[A, "signed_up"]] }); // Standard 2
  addEvent(db, { id: "e3", startsAt: inMinutes(20), people: [[A, "signed_up"], [B, "signed_up"]] }); // genug
  addEvent(db, { id: "e4", startsAt: inMinutes(120), min: 5 }); // noch zu früh
  const result = await checkEventMinimums({ db, client: f.client, config });
  assert.deepEqual(result.map(r => [r.eventId, r.action, r.count, r.minimum]), [["e1", "alerted", 1, 3], ["e2", "alerted", 1, 2]]);
  assert.equal(f.posts.length, 2);
  assert.match(f.posts[0].content, new RegExp(ROLE.events));
  assert.equal((await checkEventMinimums({ db, client: f.client, config })).length, 0, "nur einmal");
  assert.equal(db.prepare("SELECT status FROM events WHERE id='e1'").get().status, "scheduled");
});

test("Mindestteilnehmer: automatische Absage informiert Angemeldete (DM-Wunsch beachtet)", async () => {
  const db = testDb(), f = fake(), config = cfg({ EVENT_MIN_AUTO_CANCEL: "true" });
  createReminderPrefs(db).set(G, A, true);
  addEvent(db, { id: "e1", startsAt: inMinutes(10), min: 4, people: [[A, "signed_up"], [B, "signed_up"]] });
  const [r] = await checkEventMinimums({ db, client: f.client, config });
  assert.equal(r.action, "cancelled");
  assert.equal(db.prepare("SELECT status FROM events WHERE id='e1'").get().status, "cancelled");
  assert.deepEqual(f.dms.map(d => d.id), [A], "A bekommt DM");
  const ping = f.posts.find(p => p.id === CH);
  assert.match(ping.content, new RegExp(B)); assert.doesNotMatch(ping.content, new RegExp(A), "A wird nicht erwähnt");
});

test("Erinnerung: DM für Personen mit DM-Wunsch, Channel-Erwähnung für alle anderen", async () => {
  const db = testDb(), f = fake(), config = cfg();
  createReminderPrefs(db).set(G, B, true);
  addEvent(db, { id: "e1", startsAt: inMinutes(60), people: [[A, "signed_up"], [B, "signed_up"]] });
  await sendEventReminder({ db, client: f.client, config, event: db.prepare("SELECT * FROM events WHERE id='e1'").get() });
  assert.deepEqual(f.dms.map(d => d.id), [B]);
  assert.match(f.dms[0].content, /discord\.com\/channels/, "DM enthält Link zur Event-Karte");
  assert.equal(f.replies[0].content, `<@${A}>`);
  const card = eventCardPayload({ event: { id: "e1", name: "x", starts_at: inMinutes(60), status: "scheduled", min_participants: 4 }, participants: [] });
  assert.ok(card.components[0].components.some(b => b.data.custom_id === "event:dm:e1"));
  assert.match(JSON.stringify(card.embeds[0].data.fields), /mind\. 4/);
});

test("No-Shows: nur bei abgeschlossener Anwesenheit, Abgemeldete zählen nicht, Meldung ab Grenze", async () => {
  const db = testDb(), f = fake(), config = cfg({ NOSHOW_THRESHOLD: "3", NOSHOW_ACTION: "both" });
  const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();
  addEvent(db, { id: "old1", startsAt: hoursAgo(24 * 10), status: "ended", people: [[A, "signed_up"], [C, "present"]] });
  addEvent(db, { id: "old2", startsAt: hoursAgo(24 * 5), status: "ended", people: [[A, "absent"], [C, "present"]] });
  addEvent(db, { id: "noatt", startsAt: hoursAgo(24 * 3), status: "ended", people: [[A, "signed_up"]] }); // keine Anwesenheit erfasst
  addEvent(db, { id: "new", startsAt: hoursAgo(12), status: "ended", people: [[A, "signed_up"], [B, "signed_up"], [C, "present"]] });
  // Verbindlich: nur Events mit abgeschlossener Anwesenheit zählen („noatt“ ist nicht abgeschlossen).
  db.prepare("UPDATE events SET attendance_closed_at=? WHERE id IN ('old1','old2','new')").run(hoursAgo(1));
  // B war an dem Tag abgemeldet
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(new Date(hoursAgo(12)));
  db.prepare("INSERT INTO member_absences(id,guild_id,user_id,starts_on,ends_on,reason,created_by,created_at) VALUES('ab',?,?,?,?,'Urlaub',?,?)").run(G, B, day, day, B, hoursAgo(48));
  assert.equal(noShowsOf(db, config, G, A).length, 3);
  assert.equal(noShowsOf(db, config, G, B).length, 0, "entschuldigt");
  const actions = await processNoShows({ db, client: f.client, config });
  assert.deepEqual(actions.map(a => [a.userId, a.count]), [[A, 3]]);
  assert.match(f.posts.find(p => p.id === LOG).content, new RegExp(ROLE.leaders));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM member_warnings WHERE user_id=?").get(A).n, 1, "automatische Verwarnung");
  assert.equal((await processNoShows({ db, client: f.client, config })).length, 0, "nicht doppelt");
});

test("Discord: Erinnerungsart umschalten per Button und /event erinnerung", async () => {
  const db = testDb(), f = fake(), config = cfg();
  const handler = createHandler({ db, finance: createFinance(db), config, client: { ...f.client, ws: { ping: 1 } } });
  const replies = [];
  const click = { customId: "event:dm:e1", guildId: G, user: { id: A }, member: { roles: { cache: new Map() } }, inGuild: () => true, isButton: () => true, reply: async p => { replies.push(p); } };
  await handler.eventButton(click);
  assert.equal(createReminderPrefs(db).wantsDm(G, A), true);
  await handler.eventButton(click);
  assert.equal(createReminderPrefs(db).wantsDm(G, A), false);
  const cmd = { id: "1", commandName: "event", guildId: G, user: { id: A }, member: { roles: { cache: new Map() } }, inGuild: () => true, isChatInputCommand: () => true, options: { getSubcommand: () => "erinnerung", getString: () => "dm", getUser: () => null, getInteger: () => null }, reply: async p => { replies.push(p); } };
  await handler.command(cmd);
  assert.equal(createReminderPrefs(db).wantsDm(G, A), true);
  assert.match(JSON.stringify(replies.at(-1)), /per DM/);
});

test("Erinnerung: ohne Anmeldungen keine Nachricht; {minuten} ist eine feste Zahl", async () => {
  const db = testDb(), f = fake(), config = cfg();
  addEvent(db, { id: "leer", startsAt: inMinutes(60) });
  assert.equal(await sendEventReminder({ db, client: f.client, config, event: db.prepare("SELECT * FROM events WHERE id='leer'").get() }), false);
  assert.equal(f.replies.length + f.posts.length, 0);
  const { fillTemplate } = await import("../src/event-posts.js");
  assert.match(fillTemplate("in {minuten} Minuten", { name: "x", starts_at: inMinutes(15) }), /in 15 Minuten/);
});
