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
  assert.equal(row.status, "scheduled");
  assert.equal(sent.length, 2);
  await assert.rejects(announceControl({ db, client, config, actorId: "x", family: "D", when: "jetzt" }), ControlError);
  assert.ok(buildCommands().some(c => c.name === "staatliche"));
});
