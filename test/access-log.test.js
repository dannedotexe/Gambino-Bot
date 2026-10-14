import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { clientIp, createAccessLog } from "../src/services/access-log.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001";

test("IP kommt vom eigenen Proxy (letzter X-Forwarded-For-Eintrag), nicht vom Browser", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "6.6.6.6, 84.115.20.7" }, socket: { remoteAddress: "127.0.0.1" } }), "84.115.20.7");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "127.0.0.1");
});

test("Aufrufe pro Person und IP höchstens stündlich, Anmeldungen immer, alte Einträge werden gelöscht", () => {
  const db = testDb(), log = createAccessLog(db), t = Date.parse("2026-10-14T10:00:00Z");
  assert.equal(log.record({ guildId: G, userId: "30000000000000001", ip: "1.1.1.1", reference: t }), true);
  assert.equal(log.record({ guildId: G, userId: "30000000000000001", ip: "1.1.1.1", reference: t + 60_000 }), false);
  assert.equal(log.record({ guildId: G, userId: "30000000000000001", ip: "1.1.1.1", kind: "login", reference: t + 120_000 }), true);
  log.record({ guildId: G, userId: "30000000000000002", ip: "1.1.1.1", kind: "login", reference: t + 180_000 });
  assert.deepEqual(log.sharedIps(G).map(x => [x.ip, x.n]), [["1.1.1.1", 2]]);
  createAccessLog(db).record({ guildId: G, userId: null, ip: "2.2.2.2", days: 30, reference: t + 31 * 86_400_000 });
  assert.deepEqual(log.list(G).map(e => e.ip), ["2.2.2.2"]);
});

test("Zugriffsprotokoll sieht nur der Bot-Owner", async () => {
  const db = testDb();
  createAccessLog(db).record({ guildId: G, userId: null, ip: "3.3.3.3" });
  const config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_LEADERS: "20000000000000001" });
  const guild = { id: G, members: { cache: new Map(), fetch: async () => new Map() }, channels: { fetch: async () => null } };
  const api = createDashboardApi({ db, client: { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { cache: new Map() } }, config });
  const get = m => api.get(m, new URL("/api/access-log", "https://x"));
  assert.equal((await get({ id: "1", owner: false, roles: ["20000000000000001"] })).status, 403);
  const ok = await get({ id: "1", owner: true, roles: [] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.entries[0].ip, "3.3.3.3");
});
