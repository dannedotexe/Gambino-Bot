import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { buildTable } from "../src/export.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", U = "30000000000000001", FIN = "20000000000000003";

test("Auszahlungs-Log: Brutto, Abzug, Netto, verrechnete Sanktionen; nur mit Finanzrolle; Excel-Tabelle", async () => {
  const db = testDb(), finance = createFinance(db);
  finance.credit({ guildId: G, userId: U, actorId: "40000000000000001", cents: 10_000, reason: "Event", key: "c" });
  finance.sanction({ guildId: G, userId: U, actorId: "40000000000000001", cents: 3_000, reason: "Zu spät" });
  finance.payout({ guildId: G, userId: U, actorId: "40000000000000001", key: "p" });
  const config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_FINANCE: FIN });
  const guild = { id: G, members: { cache: new Map(), fetch: async () => new Map() }, channels: { fetch: async () => null } };
  const api = createDashboardApi({ db, client: { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { cache: new Map() } }, config });
  const get = (m, q = "") => api.get(m, new URL(`/api/payouts${q}`, "https://x"));
  assert.equal((await get({ id: "1", owner: false, roles: [] })).status, 403);
  const res = await get({ id: "1", owner: false, roles: [FIN] }, "?days=0");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.totals, { count: 1, gross: 10_000, deduction: 3_000, net: 7_000 });
  assert.equal(res.body.payouts[0].sanctions[0].reason, "Zu spät");
  const table = buildTable("payouts", { db, guildId: G, name: id => id, finance });
  assert.deepEqual(table.rows[0].slice(2, 5), [100, 30, 70]);
  assert.match(table.rows[0][5], /Zu spät/);
});
