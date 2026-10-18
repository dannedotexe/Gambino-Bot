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

const BASE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,key));
    CREATE TABLE IF NOT EXISTS accounts (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0), updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,user_id));
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), gross_cents INTEGER, deduction_cents INTEGER, net_cents INTEGER, reason TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS transactions_user_time ON transactions(guild_id,user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS sanctions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), remaining_cents INTEGER NOT NULL CHECK(remaining_cents >= 0), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','partial','paid','void')), case_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sanctions_open ON sanctions(guild_id,user_id,status);
    CREATE TABLE IF NOT EXISTS payout_allocations (id TEXT PRIMARY KEY, payout_id TEXT NOT NULL REFERENCES transactions(id), sanction_id TEXT NOT NULL REFERENCES sanctions(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), created_at TEXT NOT NULL, UNIQUE(payout_id,sanction_id));
    CREATE TABLE IF NOT EXISTS sanction_refunds (id TEXT PRIMARY KEY, sanction_id TEXT NOT NULL REFERENCES sanctions(id), transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT UNIQUE, user_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')), claimed_by TEXT, message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE IF NOT EXISTS ticket_transcripts (ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), messages TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_time ON audit_logs(guild_id,created_at DESC);
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
    CREATE TABLE IF NOT EXISTS automod_actions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, rule TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const appendOnly = (table, label) => `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${label} sind unveränderlich'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${label} dürfen nicht gelöscht werden'); END;
`;

/**
 * Versionierte Migrationen. Jede Migration ist idempotent (IF NOT EXISTS), läuft genau einmal in einer
 * Transaktion und wird in schema_migrations mit Name und Zeitpunkt festgehalten. Neue Änderungen
 * immer als neue Version anhängen, niemals bestehende Versionen umschreiben.
 */
export const MIGRATIONS = [
  { version: 1, name: "basisschema", up: db => db.exec(BASE_SCHEMA) },
  {
    version: 2,
    name: "audit-historie-statistik",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS sanction_changes (id TEXT PRIMARY KEY, sanction_id TEXT NOT NULL REFERENCES sanctions(id), guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, change_type TEXT NOT NULL CHECK(change_type IN ('created','corrected','voided','refunded','allocated')), old_amount_cents INTEGER, new_amount_cents INTEGER, old_remaining_cents INTEGER, new_remaining_cents INTEGER, reference_id TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sanction_changes_sanction ON sanction_changes(sanction_id,created_at);
      CREATE TABLE IF NOT EXISTS member_warnings (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL, case_ref TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS member_warnings_user ON member_warnings(guild_id,user_id,created_at);
      CREATE TABLE IF NOT EXISTS application_notes (id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), guild_id TEXT NOT NULL, author_id TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS application_notes_app ON application_notes(application_id,created_at);
      CREATE TABLE IF NOT EXISTS application_role_grants (application_id TEXT PRIMARY KEY REFERENCES applications(id), guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, actor_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS member_stats_daily (guild_id TEXT NOT NULL, day TEXT NOT NULL, joins INTEGER NOT NULL DEFAULT 0, leaves INTEGER NOT NULL DEFAULT 0, member_count INTEGER, PRIMARY KEY(guild_id,day));
      CREATE INDEX IF NOT EXISTS audit_action_time ON audit_logs(guild_id,action,created_at);
      CREATE INDEX IF NOT EXISTS audit_actor_time ON audit_logs(guild_id,actor_id,created_at);
      CREATE INDEX IF NOT EXISTS transactions_type_time ON transactions(guild_id,type,created_at);
      CREATE INDEX IF NOT EXISTS payout_allocations_sanction ON payout_allocations(sanction_id);
      CREATE INDEX IF NOT EXISTS sanction_refunds_sanction ON sanction_refunds(sanction_id);
      CREATE INDEX IF NOT EXISTS automod_time ON automod_actions(guild_id,created_at);
      CREATE INDEX IF NOT EXISTS events_guild_status ON events(guild_id,status,starts_at);
      CREATE INDEX IF NOT EXISTS giveaways_status_end ON giveaways(status,ends_at);
      ${appendOnly("transactions", "Transaktionen")}
      ${appendOnly("payout_allocations", "Sanktionsverrechnungen")}
      ${appendOnly("sanction_refunds", "Sanktionserstattungen")}
      ${appendOnly("sanction_changes", "Sanktionsänderungen")}
      ${appendOnly("audit_logs", "Audit-Logs")}
    `),
  },
  {
    version: 3,
    name: "wiederkehrende-aktivitaeten",
    up: db => {
      if (!db.prepare("PRAGMA table_info(events)").all().some(column => column.name === "series_id")) db.exec("ALTER TABLE events ADD COLUMN series_id TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_series (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('scheduled','flexible')), weekdays TEXT NOT NULL DEFAULT '', times TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', lead_minutes INTEGER NOT NULL DEFAULT 120 CHECK(lead_minutes BETWEEN 5 AND 1440), max_participants INTEGER, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(guild_id,name));
        CREATE UNIQUE INDEX IF NOT EXISTS events_series_occurrence ON events(series_id,starts_at) WHERE series_id IS NOT NULL;
      `);
    },
  },
  {
    version: 4,
    name: "verifizierung",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS member_verifications (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, ingame_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, nickname TEXT NOT NULL, verified_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,user_id));
      CREATE UNIQUE INDEX IF NOT EXISTS member_verifications_ingame ON member_verifications(guild_id,ingame_id);
    `),
  },
  {
    version: 5,
    name: "abmeldungen-aktivitaet-moderation",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS member_absences (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, ended_by TEXT, role_applied INTEGER NOT NULL DEFAULT 0 CHECK(role_applied IN (0,1)), CHECK(ends_on>=starts_on));
      CREATE INDEX IF NOT EXISTS member_absences_user ON member_absences(guild_id,user_id,ends_on);
      CREATE INDEX IF NOT EXISTS member_absences_period ON member_absences(guild_id,starts_on,ends_on);
      CREATE TABLE IF NOT EXISTS member_activity (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, last_message_at TEXT, messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS inactivity_notices (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, notified_at TEXT NOT NULL, PRIMARY KEY(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS moderation_actions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('timeout','untimeout','kick','ban','unban')), reason TEXT NOT NULL, duration_minutes INTEGER, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS moderation_actions_user ON moderation_actions(guild_id,user_id,created_at);
      ${appendOnly("moderation_actions", "Moderationsmaßnahmen")}
    `),
  },
  {
    version: 6,
    name: "ankuendigungen-rang-historie",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', embed TEXT NOT NULL DEFAULT '{}', ping_role_ids TEXT NOT NULL DEFAULT '', ping_everyone INTEGER NOT NULL DEFAULT 0, scheduled_at TEXT, status TEXT NOT NULL CHECK(status IN ('scheduled','sending','sent','failed','cancelled')), message_id TEXT, error TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT);
      CREATE INDEX IF NOT EXISTS announcements_due ON announcements(status,scheduled_at);
      CREATE TABLE IF NOT EXISTS rank_changes (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT, from_label TEXT, to_label TEXT, kind TEXT NOT NULL CHECK(kind IN ('promotion','demotion','change')), reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS rank_changes_user ON rank_changes(guild_id,user_id,created_at);
      ${appendOnly("rank_changes", "Rangänderungen")}
    `),
  },
  {
    version: 7,
    name: "abstimmungen",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, question TEXT NOT NULL, options TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0 CHECK(anonymous IN (0,1)), hide_results INTEGER NOT NULL DEFAULT 0 CHECK(hide_results IN (0,1)), required_role_id TEXT, ends_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed','cancelled')), created_by TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT);
      CREATE INDEX IF NOT EXISTS polls_status_end ON polls(status,ends_at);
      CREATE TABLE IF NOT EXISTS poll_votes (poll_id TEXT NOT NULL REFERENCES polls(id), user_id TEXT NOT NULL, option_index INTEGER NOT NULL, voted_at TEXT NOT NULL, PRIMARY KEY(poll_id,user_id));
    `),
  },
  {
    version: 8,
    name: "event-mindestteilnehmer-noshows-dm",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS reminder_prefs (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, dm INTEGER NOT NULL DEFAULT 0 CHECK(dm IN (0,1)), updated_at TEXT NOT NULL, PRIMARY KEY(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS noshow_notices (event_id TEXT NOT NULL, user_id TEXT NOT NULL, guild_id TEXT NOT NULL, count INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id));
    `),
  },
  {
    version: 9,
    name: "konto-loeschanfragen",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS account_closures (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('role_removed','left')), status TEXT NOT NULL CHECK(status IN ('pending','confirmed','dismissed')), created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, note TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS account_closures_pending ON account_closures(guild_id,user_id) WHERE status='pending';
    `),
  },
  {
    version: 10,
    name: "website-zugriffsprotokoll",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT, ip TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('visit','login','login_denied')), user_agent TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS access_log_time ON access_log(guild_id,created_at);
      CREATE INDEX IF NOT EXISTS access_log_ip ON access_log(guild_id,ip);
    `),
  },
  {
    version: 11,
    name: "rollen-sicherungen",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS role_snapshots (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('auto','manual','before_restore')), actor_id TEXT, member_count INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS role_snapshots_time ON role_snapshots(guild_id,created_at);
    `),
  },
  {
    version: 12,
    name: "anwesenheit-abschliessen",
    up: db => {
      const have = new Set(db.prepare("PRAGMA table_info(events)").all().map(c => c.name));
      for (const [column, type] of [["attendance_closed_at", "TEXT"], ["attendance_closed_by", "TEXT"], ["attendance_channel_id", "TEXT"], ["attendance_message_id", "TEXT"]]) if (!have.has(column)) db.exec(`ALTER TABLE events ADD COLUMN ${column} ${type}`);
      // Bisherige beendete Events mit erfasster Anwesenheit gelten als abgeschlossen (No-Show-Historie bleibt gleich).
      db.exec(`UPDATE events SET attendance_closed_at=starts_at WHERE status='ended' AND attendance_closed_at IS NULL AND EXISTS(SELECT 1 FROM event_participants p WHERE p.event_id=events.id AND p.status='present')`);
    },
  },
  {
    version: 13,
    name: "erinnerungen-aufraeumen",
    up: db => {
      const have = new Set(db.prepare("PRAGMA table_info(events)").all().map(c => c.name));
      for (const column of ["reminder_channel_id", "reminder_message_id"]) if (!have.has(column)) db.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`);
    },
  },
];

// Spalten, die auch bei älteren Datenbanken (vor der Versionierung) sicher nachgezogen werden.
const COLUMNS = [
  ["tickets", "message_id", "TEXT"],
  ["tickets", "claimed_at", "TEXT"],
  ["tickets", "closed_by", "TEXT"],
  ["giveaways", "required_role_id", "TEXT"],
  ["automod_actions", "details", "TEXT NOT NULL DEFAULT '{}'"],
  ["events", "series_id", "TEXT"],
  ["events", "announce_channel_id", "TEXT"],
  ["events", "announce_message_id", "TEXT"],
  ["member_warnings", "revoked_at", "TEXT"],
  ["events", "min_participants", "INTEGER"],
  ["events", "min_checked_at", "TEXT"],
  ["event_series", "min_participants", "INTEGER"],
  ["member_warnings", "revoked_by", "TEXT"],
  ["member_warnings", "revoke_reason", "TEXT"],
];

export function initializeSchema(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const migrationColumns = db.prepare("PRAGMA table_info(schema_migrations)").all();
  if (!migrationColumns.some(column => column.name === "name")) db.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT");
  // Ältere Installationen haben Version 1 bereits vermerkt; das Basisschema ist idempotent und wird trotzdem geprüft.
  db.exec(BASE_SCHEMA);
  for (const migration of MIGRATIONS) {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations(version,applied_at,name) VALUES(?,?,?)").run(migration.version, new Date().toISOString(), migration.name);
    });
    try { apply(); }
    catch (error) { throw new Error(`Datenbank-Migration ${migration.version} (${migration.name}) fehlgeschlagen: ${error.message}`); }
  }
  for (const [table, column, definition] of COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function audit(db, guildId, actorId, action, targetId = null, details = {}) {
  const id = randomUUID();
  db.prepare("INSERT INTO audit_logs(id,guild_id,actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, guildId, actorId, action, targetId, JSON.stringify(details), new Date().toISOString());
  return id;
}

export function getSetting(db, guildId, key) {
  return db.prepare("SELECT value FROM guild_settings WHERE guild_id=? AND key=?").get(guildId, key)?.value ?? null;
}

export function setSetting(db, guildId, key, value) {
  db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(guildId, key, value, new Date().toISOString());
}
