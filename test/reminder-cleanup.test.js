import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { cleanupReminders, sendEventReminder } from "../src/event-posts.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", CH = "60000000000000001";
test("Erinnerungen: nur die neueste bleibt, nach Eventbeginn verschwindet sie", async () => {
  const db = testDb(), deleted = [];
  let n = 0;
  const channel = { id: CH, send: async () => ({ id: `r${++n}`, channelId: CH }), messages: { fetch: async id => ({ id, delete: async () => { deleted.push(id); } }) } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async () => null } };
  const config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G });
  const start = new Date(Date.now() + 30 * 60_000).toISOString();
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at,channel_id) VALUES('e1',?,'Bizwar','',?,'HQ','h','scheduled',?,?)").run(G, start, start, CH);
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e1','30000000000000001','signed_up',?)").run(start);
  const event = () => db.prepare("SELECT * FROM events WHERE id='e1'").get();
  assert.equal(await sendEventReminder({ db, client, config, event: event() }), true);
  assert.equal(await sendEventReminder({ db, client, config, event: event() }), true);
  assert.deepEqual(deleted, ["r1"], "vorige Erinnerung gelöscht");
  assert.equal(await cleanupReminders({ db, client, reference: new Date() }), 0, "vor Beginn bleibt sie");
  assert.equal(await cleanupReminders({ db, client, reference: new Date(Date.now() + 31 * 60_000) }), 1);
  assert.deepEqual(deleted, ["r1", "r2"]);
});
