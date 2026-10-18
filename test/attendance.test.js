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
