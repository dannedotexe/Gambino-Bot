import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { createGiveawayService } from "../src/services/giveaways.js";
import { createSeriesService } from "../src/services/event-series.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { resetData, resetPreview } from "../src/services/reset.js";
import { setSetting, getSetting } from "../src/database.js";
import { loadConfig } from "../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Backups aus dem Test landen in einem temporären Ordner, nie im Projekt.
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gambino-reset-"));

const G = "10000000000000001", U = "30000000000000001", STAFF = "30000000000000002", LEAD_ROLE = "20000000000000001";

function seed() {
  const db = testDb(), finance = createFinance(db);
  finance.credit({ guildId: G, userId: U, actorId: STAFF, cents: 500000, reason: "Event", key: "k1" });
  finance.sanction({ guildId: G, userId: U, actorId: STAFF, cents: 100000, reason: "Zu spät" });
  const plan = finance.previewPayout(G, U);
  finance.payout({ guildId: G, userId: U, actorId: STAFF, key: "p1", expectedGross: plan.gross, expectedDeduction: plan.deduction });
  finance.warn({ guildId: G, userId: U, actorId: STAFF, reason: "Spam" });
  createGiveawayService(db);
  db.prepare("INSERT INTO giveaways(id,guild_id,channel_id,prize,winner_count,conditions,created_by,ends_at,status,created_at) VALUES('g1',?,'c','Auto',1,'-',?,?,'active',?)").run(G, STAFF, new Date(Date.now() + 1e6).toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO giveaway_entries(giveaway_id,user_id,created_at) VALUES('g1',?,?)").run(U, new Date().toISOString());
  db.prepare("INSERT INTO member_verifications(guild_id,user_id,ingame_id,first_name,last_name,nickname,verified_at,updated_at) VALUES(?,?,'12','Tony','Soprano','12 | Tony Soprano',?,?)").run(G, U, "x", "x");
  setSetting(db, G, "CHANNEL_TICKET_LOG", "40000000000000001");
  createSeriesService(db).seedDefaults(G);
  return { db, finance };
}

test("Reset löscht Testdaten, behält Einstellungen, Vorlagen und (standardmäßig) Verifizierungen", () => {
  const { db, finance } = seed();
  const defaults = resetPreview(db, G).filter(a => a.default).map(a => a.id);
  assert.ok(defaults.includes("giveaways") && defaults.includes("finance") && !defaults.includes("verifications"));
  const result = resetData(db, { guildId: G, areas: defaults, actorId: STAFF });
  assert.ok(result.removed.finance >= 3);
  for (const table of ["accounts", "transactions", "sanctions", "payout_allocations", "member_warnings", "giveaways", "giveaway_entries"]) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  assert.equal(finance.balance(G, U), 0);
  assert.equal(getSetting(db, G, "CHANNEL_TICKET_LOG"), "40000000000000001", "Einstellungen bleiben");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event_series").get().n, 14, "Aktivitäten-Vorlagen bleiben");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM member_verifications").get().n, 1);
  assert.deepEqual(db.prepare("SELECT action FROM audit_logs").all().map(r => r.action), ["admin.data_reset"], "nur der Reset selbst ist protokolliert");
  // Schutz der Buchungen ist danach wieder aktiv.
  finance.credit({ guildId: G, userId: U, actorId: STAFF, cents: 100, reason: "neu", key: "k2" });
  assert.throws(() => db.prepare("DELETE FROM transactions").run(), /dürfen nicht gelöscht werden|unveränderlich/);
  assert.throws(() => db.prepare("DELETE FROM audit_logs").run(), /dürfen nicht gelöscht werden|unveränderlich/);
});

test("Reset über die Website nur für Bot-Owner und nur mit Bestätigungswort", async () => {
  const { db } = seed();
  const config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_LEADERS: LEAD_ROLE, ROLE_STAFF: "20000000000000002" });
  const guild = { id: G, members: { cache: new Map(), fetch: async () => null }, channels: { fetch: async () => null }, roles: { fetch: async () => new Map() } };
  const client = { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, channels: { fetch: async () => null }, users: { fetch: async () => null } };
  const api = createDashboardApi({ db, client, config });
  const owner = { id: STAFF, owner: true, roles: [] }, leaderOnly = { id: STAFF, owner: false, roles: [LEAD_ROLE] }, staff = { id: STAFF, owner: false, roles: ["20000000000000002"] };
  const leader = owner;
  const post = (m, body) => api.post(m, new URL("/api/reset", "https://x"), body);
  assert.equal((await api.get(staff, new URL("/api/reset", "https://x"))).status, 403);
  assert.equal((await post(staff, { areas: ["finance"], confirm: "ZURÜCKSETZEN" })).status, 403);
  assert.equal((await post(leaderOnly, { areas: ["finance"], confirm: "ZURÜCKSETZEN" })).status, 403, "Verwaltung nur für Bot-Owner");
  assert.equal((await post(leader, { areas: ["finance"], confirm: "ja" })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts").get().n, 1, "ohne Bestätigung passiert nichts");
  const ok = await post(leader, { areas: ["finance", "giveaways"], confirm: "zurücksetzen" });
  assert.equal(ok.status, 200);
  assert.ok(fs.readdirSync(process.env.BACKUP_DIR).some(name => name.startsWith("gambino-vor-reset-")), "Backup vor dem Löschen");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM member_warnings").get().n, 1, "nicht gewählte Bereiche bleiben");
});
