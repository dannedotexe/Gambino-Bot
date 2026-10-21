import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { candidateEvents, handleEventProofInteraction, handleEventProofMessage, proofsByUser } from "../src/event-proofs.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", U = "30000000000000001", O = "30000000000000002", TEAM = "20000000000000009";
const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_EVENT_TEAM: TEAM }) };
const ref = new Date("2026-10-20T19:00:00Z");
const addEvent = (db, id, startsAt, extra = {}) => db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at,attendance_closed_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run(id, G, extra.name ?? id, "", startsAt, "HQ", "h", extra.status ?? "scheduled", "x", extra.closed ?? null);
const message = (id, replies) => ({ id, guildId: G, channelId: "t1", author: { id: U }, attachments: new Map([["a", { contentType: "image/png", name: "a.png" }], ["b", { contentType: "image/png", name: "b.png" }]]), reply: async p => { replies.push(p); return { id: `r-${id}` }; } });

test("Passende Events: alle von heute (auch frühere und abgeschlossene), angemeldete zuerst, morgen und abgesagte nicht", () => {
  const db = testDb();
  addEvent(db, "rang", "2026-10-20T18:20:00Z", { name: "Kampf um die Rangfolge" });
  addEvent(db, "cayo", "2026-10-20T18:50:00Z", { name: "Cayo Perico" });
  addEvent(db, "soon", "2026-10-20T19:30:00Z");
  addEvent(db, "morning", "2026-10-20T08:00:00Z");
  addEvent(db, "evening", "2026-10-20T21:30:00Z");
  addEvent(db, "tomorrow", "2026-10-20T23:00:00Z", { name: "01:00 Wiener Zeit = morgen" });
  addEvent(db, "yesterday", "2026-10-19T19:00:00Z");
  addEvent(db, "done", "2026-10-20T18:00:00Z", { closed: "x" });
  addEvent(db, "off", "2026-10-20T18:40:00Z", { status: "cancelled" });
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('rang',?,'signed_up','x')").run(U);
  assert.deepEqual(candidateEvents(db, { guildId: G, userId: U, reference: ref }).map(e => e.id), ["rang", "cayo", "soon", "done", "evening", "morning"]);
  // Kurz nach Mitternacht: das Event von gestern Abend ist noch wählbar.
  assert.deepEqual(candidateEvents(db, { guildId: G, userId: U, reference: new Date("2026-10-20T23:30:00Z") }).map(e => e.id).sort(), ["cayo", "done", "evening", "rang", "soon", "tomorrow"]);
});

test("Bild: bei mehreren Events fragen, Person wählt, Team darf korrigieren, Fremde nicht", async () => {
  const db = testDb(), replies = [];
  addEvent(db, "rang", "2026-10-20T18:20:00Z", { name: "Kampf um die Rangfolge" });
  addEvent(db, "cayo", "2026-10-20T18:50:00Z", { name: "Cayo Perico" });
  await handleEventProofMessage({ db, config, message: message("m1", replies), reference: ref });
  assert.match(replies[0].content, /Zu welchem Event/);
  assert.deepEqual(replies[0].components[0].components[0].options.map(o => o.data.value), ["cayo", "rang"]);
  const answers = [];
  const i = (user, roles, value) => ({ customId: "evp:pick:m1", user: { id: user }, member: { roles: { cache: new Map(roles.map(r => [r, true])) } }, values: [value], reply: async p => answers.push(p), update: async p => answers.push(p) });
  await handleEventProofInteraction({ i: i(O, [], "cayo"), db, config });
  assert.match(answers[0].content, /nur die Person/);
  await handleEventProofInteraction({ i: i(U, [], "cayo"), db, config });
  assert.match(answers[1].content, /✅ Event-Log für \*\*Cayo Perico\*\*/);
  assert.equal(answers[1].components[0].components[0].data.placeholder, "Falsches Event? Anderes wählen …");
  await handleEventProofInteraction({ i: i(O, [TEAM], "rang"), db, config });
  assert.deepEqual([...proofsByUser(db, "rang")], [[U, 2]], "Team hat korrigiert, 2 Bilder gezählt");
  assert.equal(proofsByUser(db, "cayo").size, 0);
});

test("Bild: auch bei nur einem Event wird gefragt (nichts automatisch); abgeschlossene Events bleiben wählbar", async () => {
  const db = testDb(), replies = [];
  addEvent(db, "cayo", "2026-10-20T18:50:00Z", { name: "Cayo Perico" });
  addEvent(db, "early", "2026-10-20T09:00:00Z", { name: "Ohne Anmeldung", closed: "x", status: "ended" });
  await handleEventProofMessage({ db, config, message: message("m2", replies), reference: ref });
  assert.match(replies[0].content, /Zu welchem Event/);
  assert.deepEqual(replies[0].components[0].components[0].options.map(o => o.data.value), ["cayo", "early"]);
  assert.equal(proofsByUser(db, "cayo").size, 0, "nicht automatisch zugeordnet");
  const updates = [];
  await handleEventProofInteraction({ i: { customId: "evp:pick:m2", user: { id: U }, member: { roles: { cache: new Map() } }, values: ["early"], update: async p => updates.push(p) }, db, config });
  assert.match(updates[0].content, /Ohne Anmeldung/);
  assert.deepEqual(updates[0].components[0].components[0].options.map(o => o.data.value), ["cayo"], "Verschieben bleibt möglich");
});

test("Anwesenheit: „Mit Event-Log = da“ trägt alle mit Bild ein – auch Nichtangemeldete (Website und Discord)", async () => {
  const { createDashboardApi } = await import("../src/dashboard-api.js");
  const { handleAttendanceInteraction } = await import("../src/attendance.js");
  const db = testDb();
  addEvent(db, "e1", "2026-10-19T18:00:00Z");
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e1',?,'signed_up','x'),('e1','30000000000000005','signed_up','x')").run(U);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES('p1',?,'e1',?,'t',1,?,?),('p2',?,'e1',?,'t',2,?,?)").run(G, U, now, now, G, O, now, now);
  const guild = { id: G, members: { cache: new Map(), fetch: async () => new Map() }, roles: { cache: new Map() }, channels: { fetch: async () => null } };
  const api = createDashboardApi({ db, client: { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { cache: new Map() }, channels: { fetch: async () => null } }, config });
  const res = await api.post({ id: "40000000000000001", owner: false, roles: [TEAM] }, new URL("/api/events/e1/attendance/proofs", "https://x"), {});
  assert.match(res.body.message, /2 Personen/);
  const status = id => db.prepare("SELECT status FROM event_participants WHERE event_id='e1' AND user_id=?").get(id)?.status;
  assert.equal(status(U), "present"); assert.equal(status(O), "present", "nicht angemeldet, aber mit Bild");
  assert.equal(status("30000000000000005"), "signed_up", "ohne Bild unverändert");
  const listed = await api.get({ id: "40000000000000001", owner: false, roles: [TEAM] }, new URL("/api/events?scope=upcoming", "https://x"));
  assert.deepEqual(listed.body.events[0].proofs, { [U]: 1, [O]: 2 });
  // Discord: Button erscheint im Auswahlfenster
  const replies = [];
  await handleAttendanceInteraction({ i: { customId: "att:open:e1", user: { id: "x" }, member: { roles: { cache: new Map([[TEAM, true]]) } }, guild: null, reply: async p => replies.push(p) }, db, client: {}, config });
  const buttons = replies[0].components.at(-1).components.map(b => b.data.custom_id);
  assert.ok(buttons.includes("att:proofs:e1"));
  assert.match(replies[0].content, /\*\*2\*\* Personen haben Event-Logs gepostet, 1 Angemeldete ohne Bild/);
});

test("Website: Event-Logs pro Tag, fehlende Logs, nicht zugeordnete Bilder zuordnen", async () => {
  const { eventLogDay } = await import("../src/event-proofs.js");
  const { createDashboardApi } = await import("../src/dashboard-api.js");
  const db = testDb(), now = "2026-10-20T18:55:00.000Z";
  addEvent(db, "cayo", "2026-10-20T18:50:00Z", { name: "Cayo Perico" });
  addEvent(db, "other", "2026-10-21T18:50:00Z");
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('cayo',?,'signed_up','x'),('cayo','30000000000000077','signed_up','x')").run(U);
  const proof = (id, eventId) => db.prepare("INSERT INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)").run(id, G, eventId, U, "t1", now, now);
  proof("70000000000000001", "cayo"); proof("70000000000000002", null);
  const day = eventLogDay(db, { guildId: G, day: "2026-10-20", timezone: "Europe/Vienna" });
  assert.deepEqual(day.events.map(e => [e.id, e.proofs.length, e.missing]), [["cayo", 1, ["30000000000000077"]]]);
  assert.equal(day.unassigned.length, 1);
  const client = { guilds: { cache: new Map(), fetch: async () => null }, users: { cache: new Map(), fetch: async () => null }, channels: { fetch: async () => null } };
  const api = createDashboardApi({ db, client, config });
  const team = { id: "40000000000000002", owner: false, roles: [TEAM] }, nobody = { id: "1", owner: false, roles: [] };
  assert.equal((await api.get(nobody, new URL("/api/event-logs?day=2026-10-20", "https://x"))).status, 403);
  const res = await api.get(team, new URL("/api/event-logs?day=2026-10-20", "https://x"));
  assert.equal(res.status, 200); assert.equal(res.body.events[0].name, "Cayo Perico");
  const ok = await api.post(team, new URL("/api/event-logs/70000000000000002/assign", "https://x"), { eventId: "cayo" });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare("SELECT event_id FROM event_proofs WHERE message_id='70000000000000002'").get().event_id, "cayo");
  assert.equal((await api.post(team, new URL("/api/event-logs/70000000000000002/assign", "https://x"), { eventId: "other" })).status, 200, "verschieben");
  assert.equal(db.prepare("SELECT event_id FROM event_proofs WHERE message_id='70000000000000002'").get().event_id, "other");
  assert.equal((await api.post(team, new URL("/api/event-logs/70000000000000002/assign", "https://x"), { eventId: "nope" })).status, 409);
  assert.equal((await api.post(nobody, new URL("/api/event-logs/70000000000000002/delete", "https://x"))).status, 403);
  const del = await api.post(team, new URL("/api/event-logs/70000000000000002/delete", "https://x"));
  assert.equal(del.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event_proofs WHERE message_id='70000000000000002'").get().n, 0);
  assert.equal((await api.post(team, new URL("/api/event-logs/70000000000000002/delete", "https://x"))).status, 404);
});

test("Fehlendes Event-Log: DM an Angemeldete ohne Bild, genau einmal, mit Link zum Logbuch", async () => {
  const { remindMissingEventLogs } = await import("../src/event-proofs.js");
  const db = testDb(), dms = [], reference = new Date("2026-10-20T21:00:00Z");
  const cfg = { ...config, CHANNEL_EVENT_FORUM: "60000000000000070", EVENT_LOG_REMINDER_MINUTES: 90 };
  addEvent(db, "cayo", "2026-10-20T19:00:00Z", { name: "Cayo Perico" });
  addEvent(db, "later", "2026-10-20T20:00:00Z");
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('cayo',?,'signed_up','x'),('cayo',?,'signed_up','x'),('cayo','30000000000000003','absent','x'),('later',?,'signed_up','x')").run(U, O, U);
  db.prepare("INSERT INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES('p1',?,'cayo',?,'t',1,'x','x')").run(G, O);
  db.prepare("INSERT INTO event_logbooks(guild_id,user_id,thread_id,title,created_at) VALUES(?,?,'70000000000000099','Tony | 1','x')").run(G, U);
  const client = { user: { id: "bot" }, users: { fetch: async id => ({ send: async p => dms.push([id, p.content]) }) } };
  assert.equal(await remindMissingEventLogs({ db, client, config: cfg, reference }), 1);
  assert.equal(dms[0][0], U); assert.match(dms[0][1], /Cayo Perico/); assert.match(dms[0][1], /<#70000000000000099>/);
  assert.equal(await remindMissingEventLogs({ db, client, config: cfg, reference }), 0, "nur einmal; „later“ noch nicht fällig");
  assert.equal(await remindMissingEventLogs({ db, client, config: { ...cfg, EVENT_LOG_REMINDER_MINUTES: 0 }, reference: new Date("2026-10-20T23:00:00Z") }), 0, "0 = aus");
});
