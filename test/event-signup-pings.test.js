import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { cleanupSignupPings, pingSignup, removeSignupPing } from "../src/event-signup-pings.js";

const G = "10000000000000001", U = "30000000000000001", THREAD = "70000000000000001";

test("Anmeldung: Ping im eigenen Event-Logbuch, einmalig; Abmelden und Aufräumen entfernen ihn", async () => {
  const db = testDb(), sent = [], deleted = [];
  db.prepare("INSERT INTO event_logbooks(guild_id,user_id,thread_id,title,created_at) VALUES(?,?,?,'Tony | 1','x')").run(G, U, THREAD);
  const at = new Date(Date.now() + 3600e3).toISOString();
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES('e1',?,'Cayo Perico','',?,'HQ','h','scheduled','x')").run(G, at);
  const thread = { id: THREAD, send: async p => { sent.push(p); return { id: `m${sent.length}` }; }, messages: { fetch: async id => ({ id, delete: async () => { deleted.push(id); } }) } };
  const client = { channels: { fetch: async id => (id === THREAD ? thread : null) } };
  const config = { CHANNEL_EVENT_FORUM: "60000000000000001", EVENT_SIGNUP_LOGBOOK_PING: true, DISCORD_GUILD_ID: G };
  const event = db.prepare("SELECT * FROM events WHERE id='e1'").get();
  assert.equal(await pingSignup({ db, client, config, event, userId: U }), true);
  assert.match(sent[0].content, new RegExp(`^<@${U}> ✅ Angemeldet für \\*\\*Cayo Perico\\*\\*`));
  assert.deepEqual(sent[0].allowedMentions, { users: [U] });
  assert.equal(await pingSignup({ db, client, config, event, userId: U }), false, "nur einmal");
  assert.equal(await pingSignup({ db, client, config, event, userId: "30000000000000002" }), false, "ohne Logbuch kein Ping");
  assert.equal(await pingSignup({ db, client, config: { ...config, EVENT_SIGNUP_LOGBOOK_PING: false }, event: { ...event, id: "x" }, userId: U }), false, "abschaltbar");
  assert.equal(await removeSignupPing({ db, client, eventId: "e1", userId: U }), true);
  assert.deepEqual(deleted, ["m1"]);
  await pingSignup({ db, client, config, event, userId: U });
  assert.equal(await cleanupSignupPings({ db, client, reference: new Date() }), 0, "vor dem Event bleibt er");
  assert.equal(await cleanupSignupPings({ db, client, reference: new Date(Date.now() + 6 * 3600e3) }), 1, "4 Std. nach Beginn weg");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event_signup_pings").get().n, 0);
});
