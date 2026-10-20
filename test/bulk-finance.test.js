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

test("Sammelauszahlung: Vorschau ab Mindestbetrag, jede Auszahlung genau einmal, geänderte Konten übersprungen", async () => {
  const { finance, api, dms } = setup({ PAYOUT_MINIMUM_CENTS: "100000" });
  finance.credit({ guildId: G, userId: A, actorId: "x", cents: 500_000, reason: "Event", key: "a" });
  finance.credit({ guildId: G, userId: B, actorId: "x", cents: 300_000, reason: "Event", key: "b" });
  finance.credit({ guildId: G, userId: C, actorId: "x", cents: 50_000, reason: "Event", key: "c" });
  finance.sanction({ guildId: G, userId: A, actorId: "x", cents: 100_000, reason: "Zu spät" });
  const preview = await api.get(fin, new URL("/api/payouts/bulk-preview", "https://x"));
  assert.deepEqual(preview.body.items.map(i => [i.userId, i.net, i.deduction]), [[A, 400_000, 100_000], [B, 300_000, 0]], "C unter Mindestbetrag");
  finance.credit({ guildId: G, userId: B, actorId: "x", cents: 1_000, reason: "Nachtrag", key: "b2" });
  const items = preview.body.items.map(i => ({ userId: i.userId, expectedGross: i.gross, expectedDeduction: i.deduction }));
  const res = await post(api, fin, "/api/payouts/bulk", { requestId: preview.body.requestId, items });
  assert.equal(res.status, 200);
  assert.equal(res.body.done.length, 1); assert.equal(res.body.skipped.length, 1);
  assert.match(res.body.skipped[0].reason, /geändert/);
  assert.equal(finance.previewPayout(G, A).gross, 0);
  assert.equal(finance.previewPayout(G, B).gross, 301_000, "B unverändert");
  const again = await post(api, fin, "/api/payouts/bulk", { requestId: preview.body.requestId, items: items.slice(0, 1) });
  assert.equal(again.body.done[0].fresh, false, "zweiter Klick bucht nichts doppelt");
  assert.equal(dms.length, 1);
  assert.equal((await post(api, staff, "/api/payouts/bulk", { requestId: randomUUID(), items })).status, 403, "nur Finanzen");
});
