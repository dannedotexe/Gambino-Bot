import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export function openDatabase(filename) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  initializeSchema(db);
  return db;
}

export function initializeSchema(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,key));
    CREATE TABLE IF NOT EXISTS accounts (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0), updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,user_id));
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), gross_cents INTEGER, deduction_cents INTEGER, net_cents INTEGER, reason TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS transactions_user_time ON transactions(guild_id,user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS sanctions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), remaining_cents INTEGER NOT NULL CHECK(remaining_cents >= 0), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','partial','paid','void')), case_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sanctions_open ON sanctions(guild_id,user_id,status);
    CREATE TABLE IF NOT EXISTS payout_allocations (id TEXT PRIMARY KEY, payout_id TEXT NOT NULL REFERENCES transactions(id), sanction_id TEXT NOT NULL REFERENCES sanctions(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at TEXT NOT NULL, UNIQUE(payout_id,sanction_id));
    CREATE TABLE IF NOT EXISTS sanction_refunds (id TEXT PRIMARY KEY, sanction_id TEXT NOT NULL REFERENCES sanctions(id), transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT UNIQUE, user_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')), claimed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE IF NOT EXISTS ticket_transcripts (ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), messages TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log_deliveries (audit_id TEXT PRIMARY KEY REFERENCES audit_logs(id), attempted_at TEXT NOT NULL, result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tickets_user_open ON tickets(guild_id,user_id,status);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL, starts_at TEXT NOT NULL, location TEXT NOT NULL, host_id TEXT NOT NULL, equipment TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', max_participants INTEGER, status TEXT NOT NULL CHECK(status IN ('scheduled','cancelled','ended')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_participants (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'signed_up' CHECK(status IN ('signed_up','present','absent','left')), updated_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id));
    CREATE TABLE IF NOT EXISTS event_reminders (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, minutes_before INTEGER NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY(event_id,minutes_before));
    CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, answers TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','review','accepted','rejected','withdrawn')), reviewer_id TEXT, review_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_id TEXT);
    CREATE INDEX IF NOT EXISTS applications_user_open ON applications(guild_id,user_id,status);
    CREATE TABLE IF NOT EXISTS giveaways (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, prize TEXT NOT NULL, ends_at TEXT NOT NULL, winner_count INTEGER NOT NULL, conditions TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','ended','cancelled')), winners TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE IF NOT EXISTS giveaway_entries (giveaway_id TEXT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE, user_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(giveaway_id,user_id));
    CREATE TABLE IF NOT EXISTS giveaway_announcements (giveaway_id TEXT PRIMARY KEY REFERENCES giveaways(id), sent_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_time ON audit_logs(guild_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS automod_actions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, rule TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)").run(new Date().toISOString());
}

export function audit(db, guildId, actorId, action, targetId = null, details = {}) {
  db.prepare("INSERT INTO audit_logs(id,guild_id,actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), guildId, actorId, action, targetId, JSON.stringify(details), new Date().toISOString());
}
