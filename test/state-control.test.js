import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { ControlError, announceControl, parseWhen } from "../src/state-control.js";
import { loadConfig } from "../src/config.js";
import { buildCommands } from "../src/commands.js";

const TZ = "Europe/Vienna", ref = new Date("2026-10-18T14:10:00Z"); // 16:10 Wien

test("Wann: jetzt, in X Minuten, Uhrzeit heute; Vergangenheit abgelehnt", () => {
  assert.equal(parseWhen("jetzt", TZ, ref).toISOString(), ref.toISOString());
  assert.equal(parseWhen("in 20", TZ, ref).toISOString(), "2026-10-18T14:30:00.000Z");
  assert.equal(parseWhen("16:30", TZ, ref).toISOString(), "2026-10-18T14:30:00.000Z");
  assert.equal(parseWhen("17 Uhr", TZ, ref).toISOString(), "2026-10-18T15:00:00.000Z");
  assert.throws(() => parseWhen("15:00", TZ, ref), ControlError);
  assert.throws(() => parseWhen("morgen irgendwann", TZ, ref), ControlError);
});

test("Staatliche Kontrolle wird als Event mit Anmeldung angekündigt; /staatliche existiert", async () => {
  const db = testDb(), sent = [];
  const channel = { id: "60000000000000001", guildId: "10000000000000001", send: async p => { sent.push(p); return { id: `m${sent.length}`, channelId: "60000000000000001" }; } };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel } };
  const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: "10000000000000001" }), CHANNEL_EVENT_SIGNUP: "60000000000000001" };
  const r = await announceControl({ db, client, config, actorId: "30000000000000001", family: "Death Note", when: "in 15" });
  const row = db.prepare("SELECT * FROM events WHERE id=?").get(r.id);
  assert.equal(row.name, "🛡️ Staatliche Kontrolle – Verteidigung gegen Death Note");
  const attack = await announceControl({ db, client, config, actorId: "30000000000000001", family: "Ballas", when: "jetzt", mode: "attack" });
  assert.equal(attack.name, "🚩 Staatliche Kontrolle – Angriff auf Ballas");
  assert.equal(row.max_participants, 10, "Standard-Limit 10 → Warteliste ab dem Elften");
  const open = await announceControl({ db, client, config, actorId: "30000000000000001", family: "Vagos", when: "jetzt", max: 0 });
  assert.equal(db.prepare("SELECT max_participants FROM events WHERE id=?").get(open.id).max_participants, null, "0 = unbegrenzt");
  const big = await announceControl({ db, client, config, actorId: "30000000000000001", family: "Families", when: "jetzt", max: "25" });
  assert.equal(db.prepare("SELECT max_participants FROM events WHERE id=?").get(big.id).max_participants, 25);
  await assert.rejects(announceControl({ db, client, config, actorId: "x", family: "Lost", when: "jetzt", max: 500 }), ControlError);
  assert.equal(row.status, "scheduled");
  assert.equal(sent.length, 4);
  await assert.rejects(announceControl({ db, client, config, actorId: "x", family: "D", when: "jetzt" }), ControlError);
  assert.ok(buildCommands().some(c => c.name === "staatliche"));
});

test("Staatliche Kontrolle endet nach Ablauf automatisch und ihre Posts werden gelöscht", async () => {
  const { endSeriesEvents } = await import("../src/activity-board.js");
  const db = testDb(), deleted = [];
  const message = id => ({ id, delete: async () => { deleted.push(id); }, edit: async () => {} });
  const channel = { id: "60000000000000001", guildId: "10000000000000001", send: async () => ({ id: "card", channelId: "60000000000000001" }), messages: { fetch: async id => message(id) } };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel } };
  const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: "10000000000000001" }), CHANNEL_EVENT_SIGNUP: "60000000000000001" };
  const r = await announceControl({ db, client, config, actorId: "30000000000000001", family: "Ballas", when: "jetzt" });
  const ended = [];
  await endSeriesEvents({ db, client, config, reference: new Date(Date.now() + 30 * 60_000), onEnded: e => ended.push(e.id) });
  assert.equal(db.prepare("SELECT status FROM events WHERE id=?").get(r.id).status, "scheduled", "vor Ablauf nicht beendet");
  await endSeriesEvents({ db, client, config, reference: new Date(Date.now() + (config.EVENT_SERIES_AUTO_END_MINUTES + 1) * 60_000), onEnded: e => ended.push(e.id) });
  assert.equal(db.prepare("SELECT status FROM events WHERE id=?").get(r.id).status, "ended");
  assert.deepEqual(ended, [r.id], "Anwesenheits-Abfrage wird angestoßen");
  assert.ok(deleted.includes("card"), "Event-Karte gelöscht");
});

test("Als normales Event angelegte „Staatliche Kontrolle“ (anderer Treffpunkt) endet und wird gelöscht", async () => {
  const { endSeriesEvents } = await import("../src/activity-board.js");
  const { isControlEvent } = await import("../src/state-control.js");
  const db = testDb(), deleted = [];
  const channel = { id: "60000000000000001", messages: { fetch: async id => ({ id, delete: async () => { deleted.push(id); }, edit: async () => {} }) } };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel } };
  const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: "10000000000000001" }) };
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,name,description,starts_at,location,host_id,status,created_at) VALUES('k','10000000000000001','60000000000000001','card2','Staatliche Kontrolle','gegen Mayhem',?,'Fam.Garage','h','scheduled',?)").run(start, start);
  db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,name,description,starts_at,location,host_id,status,created_at) VALUES('b','10000000000000001','60000000000000001','card3','Bizwar','',?,'HQ','h','scheduled',?)").run(start, start);
  assert.ok(isControlEvent({ name: "🛡️ staatliche Kontrolle vs Ballas", location: "x" }));
  assert.ok(!isControlEvent({ name: "Bizwar", location: "HQ" }));
  await endSeriesEvents({ db, client, config, reference: new Date(Date.now() + (config.EVENT_SERIES_AUTO_END_MINUTES + 1) * 60_000) });
  assert.equal(db.prepare("SELECT status FROM events WHERE id='k'").get().status, "ended");
  assert.equal(db.prepare("SELECT status FROM events WHERE id='b'").get().status, "scheduled", "normale Events bleiben unberührt");
  assert.ok(deleted.includes("card2"));
});
