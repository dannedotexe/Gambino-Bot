import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", A = "30000000000000001", B = "30000000000000002", C = "30000000000000003", STAFF = "20000000000000002", FIN = "20000000000000003";
const staff = { id: "40000000000000001", owner: false, roles: [STAFF] }, fin = { id: "40000000000000002", owner: false, roles: [FIN] };
function setup(extra = {}) {
  const db = testDb(), finance = createFinance(db), dms = [];
  const present = new Set([A, B, C]);
  const guild = { id: G, members: { cache: new Map(), fetch: async q => new Map((q?.user ?? []).filter(id => present.has(id)).map(id => [id, { id, user: { bot: false } }])) }, roles: { cache: new Map() }, channels: { fetch: async () => null } };
  const client = { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { cache: new Map(), fetch: async () => ({ send: async p => dms.push(p) }) }, channels: { fetch: async () => null } };
  const config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_STAFF: STAFF, ROLE_FINANCE: FIN, ...extra });
  return { db, finance, dms, present, api: createDashboardApi({ db, client, config }) };
}
const post = (api, m, path, body) => api.post(m, new URL(path, "https://x"), body);

test("Sammelsanktion: für alle Ausgewählten, einmalig pro Anfrage, alles oder nichts", async () => {
  const { db, finance, api, present } = setup();
  const requestId = randomUUID();
  assert.equal((await post(api, fin, "/api/sanctions/bulk", { requestId, userIds: [A, B], amount: "10000", reason: "Pflicht-Event verpasst" })).status, 403, "nur Staff");
  const ok = await post(api, staff, "/api/sanctions/bulk", { requestId, userIds: [A, B, A], amount: "10000", reason: "Pflicht-Event verpasst" });
  assert.equal(ok.status, 200);
  assert.match(ok.body.message, /2 Sanktionen à \$10\.000,00/);
  assert.equal(finance.openSanctionTotal(G, A), 1_000_000);
  assert.equal(finance.openSanctionTotal(G, B), 1_000_000);
  const again = await post(api, staff, "/api/sanctions/bulk", { requestId, userIds: [A, B], amount: "10000", reason: "Pflicht-Event verpasst" });
  assert.match(again.body.message, /bereits eingetragen/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sanctions").get().n, 2, "kein Doppel-Klick-Duplikat");
  present.delete(C);
  const partial = await post(api, staff, "/api/sanctions/bulk", { requestId: randomUUID(), userIds: [A, C], amount: "500", reason: "Test grund" });
  assert.equal(partial.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sanctions").get().n, 2, "nichts eingetragen, wenn jemand fehlt");
});

test("Sammelbuchung: gleiche Gutschrift für alle Ausgewählten, einmalig, nur Finanzen", async () => {
  const { db, finance, api, present } = setup();
  const requestId = randomUUID(), body = { requestId, userIds: [A, B], amount: "25000", reason: "Event Bankraub" };
  assert.equal((await post(api, staff, "/api/credits/bulk", body)).status, 403);
  const ok = await post(api, fin, "/api/credits/bulk", body);
  assert.match(ok.body.message, /2 Gutschriften à \$25\.000,00 verbucht \(gesamt \$50\.000,00\)/);
  assert.equal(finance.previewPayout(G, A).gross, 2_500_000);
  await post(api, fin, "/api/credits/bulk", body);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='credit'").get().n, 2, "kein Doppelklick-Duplikat");
  present.delete(C);
  assert.equal((await post(api, fin, "/api/credits/bulk", { ...body, requestId: randomUUID(), userIds: [A, C] })).status, 400);
  assert.equal(finance.previewPayout(G, A).gross, 2_500_000, "nichts gebucht, wenn jemand fehlt");
});
