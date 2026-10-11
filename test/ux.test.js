import test from "node:test";
import assert from "node:assert/strict";
import { parseEventDate, payoutListPayload } from "../src/commands.js";
import { testDb } from "./helpers.js";

test("Eventdatum nimmt lokale Wiener Eingabe und ISO mit Offset an", () => {
  assert.equal(parseEventDate("31.12.2026 19:00", "Europe/Vienna")?.toISOString(), "2026-12-31T18:00:00.000Z");
  assert.equal(parseEventDate("2026-12-31T19:00:00+01:00")?.toISOString(), "2026-12-31T18:00:00.000Z");
});

test("ungültige und nicht existierende lokale Eventzeiten werden abgewiesen", () => {
  assert.equal(parseEventDate("31.02.2026 19:00", "Europe/Vienna"), null);
  assert.equal(parseEventDate("29.03.2026 02:30", "Europe/Vienna"), null);
  assert.equal(parseEventDate("morgen um sieben", "Europe/Vienna"), null);
});

test("Auszahlungsliste zeigt alle Konten in nachvollziehbaren Seiten", () => {
  const db = testDb();
  const insert = db.prepare("INSERT INTO accounts(guild_id,user_id,balance_cents,updated_at) VALUES(?,?,?,?)");
  for (let n = 1; n <= 23; n++) insert.run("guild", String(10000000000000000n + BigInt(n)), n * 100, new Date().toISOString());
  const first = payoutListPayload(db, "guild", 1000, 1);
  const second = payoutListPayload(db, "guild", 1000, 2);
  const last = payoutListPayload(db, "guild", 1000, 3);
  assert.match(first.embeds[0].data.description, /23 Familienkonten · Seite 1 von 3/);
  assert.equal(first.embeds[0].data.fields[0].name, "Mitglieder 1–10");
  assert.equal(second.embeds[0].data.fields[0].name, "Mitglieder 11–20");
  assert.equal(last.embeds[0].data.fields[0].name, "Mitglieder 21–23");
  assert.equal(first.components[0].components[0].data.disabled, true);
  assert.equal(last.components[0].components[1].data.disabled, true);
  db.close?.();
});
