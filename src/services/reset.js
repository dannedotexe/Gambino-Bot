import fs from "node:fs";
import path from "node:path";
import { audit } from "../database.js";

/**
 * Bereiche für „Testdaten zurücksetzen“. Einstellungen (Channels, Rollen, Panel-Texte, Panels) und die
 * wiederkehrenden Aktivitäten bleiben immer erhalten. Reihenfolge der Löschbefehle beachtet Fremdschlüssel.
 */
export const RESET_AREAS = {
  finance: { label: "Familienkonten, Buchungen, Auszahlungen & Sanktionen", default: true, sql: [
    "DELETE FROM payout_allocations WHERE sanction_id IN (SELECT id FROM sanctions WHERE guild_id=@g) OR payout_id IN (SELECT id FROM transactions WHERE guild_id=@g)",
    "DELETE FROM sanction_refunds WHERE sanction_id IN (SELECT id FROM sanctions WHERE guild_id=@g) OR transaction_id IN (SELECT id FROM transactions WHERE guild_id=@g)",
    "DELETE FROM sanction_changes WHERE guild_id=@g",
    "DELETE FROM sanctions WHERE guild_id=@g",
    "DELETE FROM transactions WHERE guild_id=@g",
    "DELETE FROM accounts WHERE guild_id=@g",
  ] },
  warnings: { label: "Verwarnungen & Moderationsmaßnahmen (Timeout/Kick/Bann-Historie)", default: true, sql: [
    "DELETE FROM member_warnings WHERE guild_id=@g",
    "DELETE FROM moderation_actions WHERE guild_id=@g",
  ] },
  tickets: { label: "Tickets & Transkripte (Ticket-Channels in Discord bleiben bestehen)", default: true, sql: [
    "DELETE FROM ticket_transcripts WHERE ticket_id IN (SELECT id FROM tickets WHERE guild_id=@g)",
    "DELETE FROM tickets WHERE guild_id=@g",
  ] },
  applications: { label: "Bewerbungen & Rang-Anträge", default: true, sql: [
    "DELETE FROM application_notes WHERE guild_id=@g",
    "DELETE FROM application_role_grants WHERE guild_id=@g",
    "DELETE FROM applications WHERE guild_id=@g",
  ] },
  events: { label: "Events, Anmeldungen & Anwesenheit (die Aktivitäten-Vorlagen bleiben)", default: true, sql: [
    "DELETE FROM event_reminders WHERE event_id IN (SELECT id FROM events WHERE guild_id=@g)",
    "DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE guild_id=@g)",
    "DELETE FROM events WHERE guild_id=@g",
  ] },
  giveaways: { label: "Giveaways & Teilnahmen", default: true, sql: [
    "DELETE FROM giveaway_announcements WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id=@g)",
    "DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id=@g)",
    "DELETE FROM giveaways WHERE guild_id=@g",
  ] },
  activity: { label: "Abmeldungen, Aktivität (letzte Nachrichten) & Inaktivitäts-Erinnerungen", default: true, sql: [
    "DELETE FROM member_absences WHERE guild_id=@g",
    "DELETE FROM member_activity WHERE guild_id=@g",
    "DELETE FROM inactivity_notices WHERE guild_id=@g",
    "DELETE FROM guild_settings WHERE guild_id=@g AND key IN ('ACTIVITY_TRACKING_SINCE','INACTIVITY_LAST_RUN')",
  ] },
  stats: { label: "Statistik-Zähler & AutoMod-Protokoll", default: true, sql: [
    "DELETE FROM member_stats_daily WHERE guild_id=@g",
    "DELETE FROM automod_actions WHERE guild_id=@g",
  ] },
  audit: { label: "Protokoll (Audit-Log) – der Reset selbst wird danach neu protokolliert", default: true, sql: [
    "DELETE FROM audit_log_deliveries WHERE audit_id IN (SELECT id FROM audit_logs WHERE guild_id=@g)",
    "DELETE FROM audit_logs WHERE guild_id=@g",
  ] },
  announcements: { label: "Ankündigungen (geplante und gesendete; Nachrichten in Discord bleiben)", default: true, sql: [
    "DELETE FROM announcements WHERE guild_id=@g",
  ] },
  ranks: { label: "Rang-Historie (Beförderungen/Degradierungen)", default: true, sql: [
    "DELETE FROM rank_changes WHERE guild_id=@g",
  ] },
  polls: { label: "Abstimmungen & Stimmen (Nachrichten in Discord bleiben)", default: true, sql: [
    "DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE guild_id=@g)",
    "DELETE FROM polls WHERE guild_id=@g",
  ] },
  verifications: { label: "Verifizierungen (Discord-Namen und Rollen bleiben, Spieler müssten sich neu verifizieren)", default: false, sql: [
    "DELETE FROM member_verifications WHERE guild_id=@g",
  ] },
};
const PROTECTED = ["transactions", "payout_allocations", "sanction_refunds", "sanction_changes", "audit_logs", "moderation_actions", "rank_changes"];
export const RESET_CONFIRM_WORD = "ZURÜCKSETZEN";

/** Zählt, was ein Reset je Bereich löschen würde (für die Vorschau). */
export function resetPreview(db, guildId) {
  const count = (sql) => db.prepare(sql).get({ g: guildId }).n;
  const counters = {
    finance: "SELECT (SELECT COUNT(*) FROM accounts WHERE guild_id=@g)+(SELECT COUNT(*) FROM transactions WHERE guild_id=@g)+(SELECT COUNT(*) FROM sanctions WHERE guild_id=@g) n",
    warnings: "SELECT (SELECT COUNT(*) FROM member_warnings WHERE guild_id=@g)+(SELECT COUNT(*) FROM moderation_actions WHERE guild_id=@g) n",
    tickets: "SELECT COUNT(*) n FROM tickets WHERE guild_id=@g",
    applications: "SELECT COUNT(*) n FROM applications WHERE guild_id=@g",
    events: "SELECT COUNT(*) n FROM events WHERE guild_id=@g",
    giveaways: "SELECT COUNT(*) n FROM giveaways WHERE guild_id=@g",
    activity: "SELECT (SELECT COUNT(*) FROM member_absences WHERE guild_id=@g)+(SELECT COUNT(*) FROM member_activity WHERE guild_id=@g) n",
    stats: "SELECT (SELECT COUNT(*) FROM member_stats_daily WHERE guild_id=@g)+(SELECT COUNT(*) FROM automod_actions WHERE guild_id=@g) n",
    audit: "SELECT COUNT(*) n FROM audit_logs WHERE guild_id=@g",
    announcements: "SELECT COUNT(*) n FROM announcements WHERE guild_id=@g",
    ranks: "SELECT COUNT(*) n FROM rank_changes WHERE guild_id=@g",
    polls: "SELECT COUNT(*) n FROM polls WHERE guild_id=@g",
    verifications: "SELECT COUNT(*) n FROM member_verifications WHERE guild_id=@g",
  };
  return Object.entries(RESET_AREAS).map(([id, area]) => ({ id, label: area.label, default: area.default, count: count(counters[id]) }));
}

/** Sicherung vor dem Reset (SQLite-Backup-API, WAL-sicher). Ohne Backup-Funktion (Tests) wird übersprungen. */
export async function backupBeforeReset(db, dir = process.env.BACKUP_DIR ?? "./backups") {
  if (typeof db.backup !== "function") return null;
  const target = path.resolve(dir, `gambino-vor-reset-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  await db.backup(target);
  fs.chmodSync(target, 0o600);
  return target;
}

/**
 * Löscht die gewählten Bereiche in EINER Transaktion. Die Schutz-Trigger der unveränderlichen Tabellen werden dafür
 * kurz entfernt und in derselben Transaktion unverändert wiederhergestellt; bei einem Fehler wird alles zurückgerollt.
 */
export function resetData(db, { guildId, areas, actorId, backup = null }) {
  const chosen = [...new Set(areas)].filter(id => RESET_AREAS[id]);
  if (!chosen.length) throw new Error("Bitte mindestens einen Bereich auswählen.");
  const before = Object.fromEntries(resetPreview(db, guildId).map(row => [row.id, row.count]));
  db.transaction(() => {
    const triggers = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${PROTECTED.map(() => "?").join(",")})`).all(...PROTECTED);
    for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    for (const id of chosen) for (const sql of RESET_AREAS[id].sql) db.prepare(sql).run({ g: guildId });
    for (const trigger of triggers) db.exec(trigger.sql);
    audit(db, guildId, actorId, "admin.data_reset", null, { areas: chosen.join(","), removed: chosen.map(id => `${id}: ${before[id]}`).join(", "), backup: backup ? path.basename(backup) : "—" });
  })();
  return { areas: chosen, removed: Object.fromEntries(chosen.map(id => [id, before[id]])) };
}
