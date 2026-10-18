import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createSeriesService, DEFAULT_SERIES, describeSchedule, occurrencesBetween, validateSeries } from "../src/services/event-series.js";
import { createSeriesEvents, endSeriesEvents, buildActivityBoard } from "../src/activity-board.js";
import { createSettingsService } from "../src/services/settings.js";
import { accessGroups, loadConfig } from "../src/config.js";

const G = "10000000000000001", TZ = "Europe/Vienna";
const env = { DISCORD_TOKEN: "test-only", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_LEADERS: "20000000000000001" };

test("alle 13 Standard-Aktivitäten werden einmalig und inaktiv angelegt", () => {
  const db = testDb(), series = createSeriesService(db);
  assert.equal(series.seedDefaults(G), 13);
  assert.equal(series.seedDefaults(G), 0, "kein zweites Anlegen");
  const list = series.list(G);
  assert.equal(list.length, DEFAULT_SERIES.length);
  assert.ok(list.every(item => item.active === 0));
  const bizwar = list.find(item => item.name === "Bizwar");
  assert.equal(describeSchedule(bizwar), "täglich · 01:05, 19:05 Uhr");
  assert.equal(describeSchedule(list.find(item => item.name === "Banküberfall")), "Mi, Sa · 21:30 Uhr");
  assert.equal(list.find(item => item.name === "Ladenraub").kind, "flexible");
  series.remove({ guildId: G, id: bizwar.id, actorId: "x" });
  assert.equal(series.seedDefaults(G), 0, "gelöschte Aktivitäten kommen nicht zurück");
});

test("Termine werden in Wiener Zeit inkl. Sommerzeitwechsel berechnet", () => {
  const cayo = { kind: "scheduled", weekdays: "3", times: "20:20" };
  // Mittwoch 14.10.2026 (Sommerzeit, UTC+2) und Mittwoch 28.10.2026 (Winterzeit, UTC+1)
  const hits = occurrencesBetween(cayo, new Date("2026-10-13T00:00:00Z"), new Date("2026-10-29T00:00:00Z"), TZ).map(d => d.toISOString());
  assert.deepEqual(hits, ["2026-10-14T18:20:00.000Z", "2026-10-21T18:20:00.000Z", "2026-10-28T19:20:00.000Z"]);
  // 02:20 existiert am Tag der Zeitumstellung im Frühjahr nicht und wird übersprungen.
  const hotel = { kind: "scheduled", weekdays: "1,2,3,4,5,6,7", times: "02:20" };
  const spring = occurrencesBetween(hotel, new Date("2026-03-28T12:00:00Z"), new Date("2026-03-30T12:00:00Z"), TZ).map(d => d.toISOString());
  assert.deepEqual(spring, ["2026-03-30T00:20:00.000Z"]);
  assert.deepEqual(occurrencesBetween({ kind: "flexible" }, new Date(), new Date(Date.now() + 864e5), TZ), []);
});

test("Validierung von Aktivitäten", () => {
  assert.throws(() => validateSeries({ name: "X1", kind: "scheduled", weekdays: [], times: "20:20" }), /Wochentag/);
  assert.throws(() => validateSeries({ name: "X1", kind: "scheduled", weekdays: [1], times: "25:00" }), /HH:MM/);
  assert.throws(() => validateSeries({ name: "X1", kind: "flexible" }), /Verfügbarkeit/);
  assert.equal(validateSeries({ name: "Fabrik", weekdays: ["1"], times: "10.30, 9:05" }).times, "09:05,10:30");
});

function fakeClient() {
  const sent = [], edits = [];
  const channel = { id: "60000000000000001", send: async payload => { const msg = { id: `m${sent.length}`, edit: async p => edits.push(p) }; sent.push({ payload, msg }); return msg; }, messages: { fetch: async id => sent.find(s => s.msg.id === id)?.msg ?? null } };
  return { sent, edits, client: { user: { id: "bot" }, channels: { fetch: async id => (id === channel.id ? channel : null) } } };
}

test("aktive Aktivität erzeugt genau ein Event pro Termin, inaktive keines; Auto-Ende danach", async () => {
  const db = testDb(), series = createSeriesService(db), { client, sent, edits } = fakeClient();
  const config = { ...loadConfig(env), CHANNEL_EVENT_ANNOUNCEMENTS: "60000000000000001", EVENT_SERIES_DELETE_ENDED: false };
  const item = series.create({ guildId: G, actorId: "lead", input: { name: "Gießerei", weekdays: [1, 2, 3, 4, 5, 6, 7], times: "14:20", leadMinutes: 120 } });
  const reference = new Date("2026-10-13T11:00:00Z"); // 13:00 Wien, Start 14:20 liegt in 80 Minuten
  assert.equal(await createSeriesEvents({ db, client, config, series, reference }), 0, "inaktiv: nichts");
  series.setActive({ guildId: G, id: item.id, actorId: "lead", active: true });
  assert.equal(await createSeriesEvents({ db, client, config, series, reference }), 1);
  assert.equal(await createSeriesEvents({ db, client, config, series, reference: new Date(reference.getTime() + 60_000) }), 0, "kein Duplikat beim nächsten Lauf");
  const event = db.prepare("SELECT * FROM events").get();
  assert.equal(event.starts_at, "2026-10-13T12:20:00.000Z");
  assert.equal(event.status, "scheduled"); assert.equal(event.series_id, item.id); assert.equal(sent.length, 1);
  assert.equal(await endSeriesEvents({ db, client, config, reference: new Date("2026-10-13T13:00:00Z") }), 0, "noch nicht vorbei");
  assert.equal(await endSeriesEvents({ db, client, config, reference: new Date("2026-10-13T14:30:00Z") }), 1);
  assert.equal(db.prepare("SELECT status FROM events").get().status, "ended");
  assert.equal(edits.length, 1);
  const board = buildActivityBoard(series.list(G), TZ, reference).embeds[0].toJSON();
  assert.match(board.fields[0].value, /Gießerei/);
});

test("ohne Event-Channel wird nichts reserviert und später nachgeholt", async () => {
  const db = testDb(), series = createSeriesService(db), { client, sent } = fakeClient();
  const config = loadConfig(env);
  const item = series.create({ guildId: G, actorId: "lead", input: { name: "Bizwar", weekdays: [1, 2, 3, 4, 5, 6, 7], times: "19:05", active: true } });
  const reference = new Date("2026-10-13T16:30:00Z");
  assert.equal(await createSeriesEvents({ db, client, config, series, reference }), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  config.CHANNEL_EVENT_ANNOUNCEMENTS = "60000000000000001";
  assert.equal(await createSeriesEvents({ db, client, config, series, reference }), 1);
  assert.equal(sent.length, 1); assert.ok(item.active);
});

test("Einstellungen: Rollen und Channels gelten sofort, sind validiert und protokolliert", () => {
  const db = testDb(), config = loadConfig(env);
  const settings = createSettingsService({ db, config, env, guildId: G });
  settings.apply();
  const leader = { actorId: "u", actorRoleIds: ["20000000000000001"] };
  settings.update({ key: "ROLE_FINANCE", value: ["20000000000000003"], ...leader });
  assert.deepEqual(accessGroups(config).finance, ["20000000000000001", "20000000000000003"]);
  settings.update({ key: "CHANNEL_TICKET_LOG", value: "60000000000000009", ...leader });
  settings.update({ key: "PAYOUT_MINIMUM_CENTS", value: "100000", ...leader });
  assert.equal(config.PAYOUT_MINIMUM_CENTS, 10_000_000);
  assert.throws(() => settings.update({ key: "ROLE_STAFF", value: ["123"], ...leader }), /ungültige ID/);
  assert.throws(() => settings.update({ key: "TIMEZONE", value: "Mars/Base", ...leader }), /TIMEZONE/);
  assert.throws(() => settings.update({ key: "DISCORD_TOKEN", value: "x", ...leader }), /nicht über die Oberfläche/);
  assert.throws(() => settings.update({ key: "ROLE_LEADERS", value: ["20000000000000002"], ...leader }), /aussperren/);
  settings.update({ key: "TICKET_CATEGORIES_JSON", value: [{ id: "support", label: "Support", roleIds: [] }, { id: "leitung", label: "Leitung", roleIds: ["20000000000000004"] }], ...leader });
  assert.deepEqual(config.TICKET_CATEGORIES_JSON.map(c => c.id), ["support", "leitung"]);
  // Neustart: gespeicherte Werte werden wieder angewendet.
  const restarted = loadConfig(env);
  createSettingsService({ db, config: restarted, env, guildId: G }).apply();
  assert.equal(restarted.CHANNEL_TICKET_LOG, "60000000000000009");
  assert.deepEqual(restarted.ROLE_FINANCE, ["20000000000000003"]);
  const described = settings.describe().find(d => d.key === "ROLE_FINANCE");
  assert.equal(described.source, "website");
  settings.reset({ key: "ROLE_FINANCE", ...leader });
  assert.deepEqual(config.ROLE_FINANCE ?? [], []);
  assert.deepEqual(accessGroups(config).finance, ["20000000000000001"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='config.changed'").get().n, 5);
});

test("ungültige gespeicherte Werte werden beim Start übersprungen statt den Bot zu blockieren", () => {
  const db = testDb();
  db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?)").run(G, "TIMEZONE", "Kaputt/Zone", "x");
  db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?)").run(G, "TICKET_MAX_OPEN_PER_USER", "4", "x");
  const config = loadConfig(env);
  const { rejected } = createSettingsService({ db, config, env, guildId: G }).apply();
  assert.equal(rejected.length, 1);
  assert.equal(config.TIMEZONE, "Europe/Vienna");
  assert.equal(config.TICKET_MAX_OPEN_PER_USER, 4);
});

test("nächste Aktivität wird erst angekündigt, wenn die vorherige begonnen hat (außer < 30 Min.)", async () => {
  const db = testDb(), series = createSeriesService(db), { client } = fakeClient();
  const config = { ...loadConfig(env), CHANNEL_EVENT_ANNOUNCEMENTS: "60000000000000001" };
  series.create({ guildId: G, actorId: "lead", input: { name: "Cayo", weekdays: [1, 2, 3, 4, 5, 6, 7], times: "17:35", leadMinutes: 120, active: true } });
  series.create({ guildId: G, actorId: "lead", input: { name: "Bizwar", weekdays: [1, 2, 3, 4, 5, 6, 7], times: "19:05", leadMinutes: 120, active: true } });
  const names = () => db.prepare("SELECT name FROM events ORDER BY starts_at").all().map(r => r.name);
  await createSeriesEvents({ db, client, config, series, reference: new Date("2026-10-13T15:10:00Z") }); // 17:10 Wien
  assert.deepEqual(names(), ["Cayo"], "Bizwar wartet, Cayo hat noch nicht begonnen");
  await createSeriesEvents({ db, client, config, series, reference: new Date("2026-10-13T15:36:00Z") }); // 17:36, Cayo läuft
  assert.deepEqual(names(), ["Cayo", "Bizwar"]);
});
