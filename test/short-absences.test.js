import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createShortAbsenceService, parseShortUntil } from "../src/services/short-absences.js";
import { AbsenceError, createAbsenceService } from "../src/services/absences.js";
import { cleanupShortAbsencePosts, postShortAbsence } from "../src/absence-posts.js";
import { buildAbsencePanelPayload, buildCommands } from "../src/commands.js";

const TZ = "Europe/Vienna", ref = new Date("2026-10-20T17:00:00Z"); // 19:00 Wien
const G = "10000000000000001", U = "30000000000000001";
const iso = d => d.toISOString();

test("Dauer verstehen: Minuten, Stunden, Uhrzeit; Grenzen", () => {
  assert.equal(iso(parseShortUntil("30", TZ, ref)), "2026-10-20T17:30:00.000Z");
  assert.equal(iso(parseShortUntil("30 min", TZ, ref)), "2026-10-20T17:30:00.000Z");
  assert.equal(iso(parseShortUntil("45m", TZ, ref)), "2026-10-20T17:45:00.000Z");
  assert.equal(iso(parseShortUntil("2h", TZ, ref)), "2026-10-20T19:00:00.000Z");
  assert.equal(iso(parseShortUntil("2 Std", TZ, ref)), "2026-10-20T19:00:00.000Z");
  assert.equal(iso(parseShortUntil("1,5 h", TZ, ref)), "2026-10-20T18:30:00.000Z");
  assert.equal(iso(parseShortUntil("1:30 h", TZ, ref)), "2026-10-20T18:30:00.000Z");
  assert.equal(iso(parseShortUntil("bis 21:30", TZ, ref)), "2026-10-20T19:30:00.000Z");
  assert.equal(iso(parseShortUntil("21 Uhr", TZ, ref)), "2026-10-20T19:00:00.000Z");
  assert.equal(iso(parseShortUntil("bis 01:00", TZ, ref)), "2026-10-20T23:00:00.000Z", "nach Mitternacht = morgen");
  assert.throws(() => parseShortUntil("2 min", TZ, ref), AbsenceError);
  assert.throws(() => parseShortUntil("13h", TZ, ref), /12 Stunden/);
  assert.throws(() => parseShortUntil("irgendwann", TZ, ref), AbsenceError);
});

test("Kurz weg: entschuldigt bei Events in der Zeit, neu melden ersetzt, Wieder da beendet", () => {
  const db = testDb(), short = createShortAbsenceService(db), absences = createAbsenceService(db);
  const { row } = short.create({ guildId: G, userId: U, until: new Date("2026-10-20T19:00:00Z"), reason: "Essen", reference: ref });
  assert.equal(short.activeFor(G, U, ref).id, row.id);
  assert.equal(absences.wasAbsent(G, U, "2026-10-20T18:20:00Z", TZ), true, "Event um 20:20 Wien entschuldigt");
  assert.equal(absences.wasAbsent(G, U, "2026-10-20T19:30:00Z", TZ), false, "danach nicht");
  const second = short.create({ guildId: G, userId: U, until: new Date("2026-10-20T18:00:00Z"), reference: new Date("2026-10-20T17:10:00Z") });
  assert.equal(second.previous.id, row.id, "verkürzt = alter Eintrag beendet");
  assert.equal(short.active(G, new Date("2026-10-20T17:20:00Z")).length, 1);
  const ended = short.end({ guildId: G, userId: U, reference: new Date("2026-10-20T17:30:00Z") });
  assert.ok(ended);
  assert.equal(short.activeFor(G, U, new Date("2026-10-20T17:31:00Z")), null);
  assert.equal(absences.wasAbsent(G, U, "2026-10-20T17:45:00Z", TZ), false, "nach „Wieder da“ nicht mehr entschuldigt");
  assert.equal(absences.wasAbsent(G, U, "2026-10-20T17:20:00Z", TZ), true, "vorher schon");
});

test("Meldung im Abmeldungs-Channel und Löschen nach Ablauf; Panel-Button und /abwesend kurz", async () => {
  const db = testDb(), short = createShortAbsenceService(db), sent = [], deleted = [];
  const channel = { id: "60000000000000001", send: async p => { sent.push(p); return { id: "msg1" }; }, messages: { fetch: async id => ({ delete: async () => deleted.push(id) }) } };
  const client = { channels: { fetch: async () => channel } };
  const config = { DISCORD_GUILD_ID: G, CHANNEL_ABSENCES: channel.id, TIMEZONE: TZ, ABSENCE_SHOW_REASON: false };
  const { row } = short.create({ guildId: G, userId: U, until: new Date(Date.now() + 30 * 60_000), reason: "Arzt" });
  await postShortAbsence({ client, config, row, service: short });
  assert.match(sent[0].embeds[0].data.description, /kurz weg/);
  assert.doesNotMatch(sent[0].embeds[0].data.description, /Arzt/, "Grund nur mit Einstellung");
  assert.equal(await cleanupShortAbsencePosts({ client, config, service: short }), 0, "läuft noch");
  assert.equal(await cleanupShortAbsencePosts({ client, config, service: short, reference: new Date(Date.now() + 31 * 60_000) }), 1);
  assert.deepEqual(deleted, ["msg1"]);
  assert.ok(buildAbsencePanelPayload().components[0].components.some(b => b.data.custom_id === "absence:short"));
  assert.ok(buildCommands().find(c => c.name === "abwesend").options.some(o => o.name === "kurz"));
});
