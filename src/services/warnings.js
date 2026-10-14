import { randomUUID } from "node:crypto";
import { audit } from "../database.js";

/** Fachlicher Fehler im Verwarnungssystem; die Meldung ist für Staff verständlich. */
export class WarningError extends Error {
  constructor(message, code = "INVALID_INPUT") { super(message); this.code = code; }
}

const DAY = 86_400_000;
const cutoffIso = (expireDays, reference = Date.now()) => expireDays > 0 ? new Date(reference - expireDays * DAY).toISOString() : null;

/** Status einer Verwarnung: aktiv, abgelaufen (WARN_EXPIRE_DAYS) oder zurückgenommen. */
export function warningState(row, expireDays = 0, reference = Date.now()) {
  if (row.revoked_at) return "revoked";
  const cutoff = cutoffIso(expireDays, reference);
  return cutoff && row.created_at < cutoff ? "expired" : "active";
}

/**
 * Prüft, ob jemand dieses Mitglied verwarnen darf. Niemand verwarnt sich selbst oder Bots;
 * Teammitglieder können nur von der Leitung (oder Bot-Ownern) verwarnt werden.
 */
export function warnBlockReason({ actorId, targetId, targetIsBot = false, targetRoleIds = [], staffRoleIds = [], actorIsLeader = false, actorIsOwner = false }) {
  if (targetIsBot) return "Bots können nicht verwarnt werden.";
  if (actorId === targetId) return "Du kannst dich nicht selbst verwarnen.";
  if (!actorIsLeader && !actorIsOwner && targetRoleIds.some(id => staffRoleIds.includes(id))) return "Teammitglieder kann nur die Leitung verwarnen.";
  return null;
}

/** Eskalationsstufen nach Anzahl aktiver Verwarnungen (0 = Stufe aus). */
export function warningEscalation(config, activeCount) {
  const timeoutAt = config.WARN_TIMEOUT_AT ?? 0, alertAt = config.WARN_ALERT_AT ?? 0;
  return { timeout: timeoutAt > 0 && activeCount >= timeoutAt, alert: alertAt > 0 && activeCount >= alertAt };
}

/**
 * Verwarnungen ohne Geldwirkung. Einträge werden nie gelöscht: Rücknahmen setzen revoked_*,
 * abgelaufene Verwarnungen zählen nur nicht mehr als aktiv.
 */
export function createWarningService(db) {
  const now = () => new Date().toISOString();

  function activeCount(guildId, userId, { expireDays = 0 } = {}) {
    const cutoff = cutoffIso(expireDays);
    return db.prepare(`SELECT COUNT(*) n FROM member_warnings WHERE guild_id=? AND user_id=? AND revoked_at IS NULL${cutoff ? " AND created_at>=?" : ""}`)
      .get(...[guildId, userId, ...(cutoff ? [cutoff] : [])]).n;
  }

  const add = db.transaction(({ guildId, userId, actorId, reason, caseRef = null, expireDays = 0, source = "discord" }) => {
    const text = String(reason ?? "").trim();
    if (!text) throw new WarningError("Für eine Verwarnung ist ein Grund erforderlich.");
    if (text.length > 300) throw new WarningError("Der Grund darf höchstens 300 Zeichen lang sein.");
    const id = randomUUID();
    db.prepare("INSERT INTO member_warnings(id,guild_id,user_id,actor_id,reason,case_ref,created_at) VALUES(?,?,?,?,?,?,?)").run(id, guildId, userId, actorId, text, caseRef || null, now());
    const active = activeCount(guildId, userId, { expireDays });
    audit(db, guildId, actorId, "sanction.warning", userId, { warningId: id, reason: text, caseRef: caseRef || null, activeWarnings: active, source });
    return { id, active };
  });

  function list(guildId, userId, { limit = 25, expireDays = 0 } = {}) {
    return db.prepare("SELECT * FROM member_warnings WHERE guild_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(guildId, userId, limit)
      .map(row => ({ ...row, state: warningState(row, expireDays) }));
  }

  function recent(guildId, { limit = 50, expireDays = 0, activeOnly = false } = {}) {
    const cutoff = activeOnly ? cutoffIso(expireDays) : null;
    return db.prepare(`SELECT * FROM member_warnings WHERE guild_id=?${activeOnly ? " AND revoked_at IS NULL" : ""}${cutoff ? " AND created_at>=?" : ""} ORDER BY created_at DESC,rowid DESC LIMIT ?`)
      .all(...[guildId, ...(cutoff ? [cutoff] : []), limit])
      .map(row => ({ ...row, state: warningState(row, expireDays) }));
  }

  const get = (guildId, id) => db.prepare("SELECT * FROM member_warnings WHERE guild_id=? AND id=?").get(guildId, id) ?? null;

  const revoke = db.transaction(({ guildId, warningId, actorId, reason, allowSelf = false }) => {
    const text = String(reason ?? "").trim();
    if (!text) throw new WarningError("Für die Rücknahme ist ein Grund erforderlich.");
    const row = get(guildId, warningId);
    if (!row) throw new WarningError("Diese Verwarnung wurde nicht gefunden.", "NOT_FOUND");
    if (row.revoked_at) throw new WarningError("Diese Verwarnung wurde bereits zurückgenommen.", "ALREADY_REVOKED");
    if (row.user_id === actorId && !allowSelf) throw new WarningError("Eigene Verwarnungen kann nur jemand anderes zurücknehmen.", "SELF_REVOKE");
    const ts = now();
    db.prepare("UPDATE member_warnings SET revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=? AND revoked_at IS NULL").run(ts, actorId, text, warningId);
    audit(db, guildId, actorId, "sanction.warning_revoked", row.user_id, { warningId, reason: text, originalReason: row.reason });
    return { ...row, revoked_at: ts, revoked_by: actorId, revoke_reason: text };
  });

  /** Löscht eine Verwarnung endgültig (z. B. Fehleintrag oder Testdaten). Der Vorgang selbst bleibt im Audit-Log. */
  const remove = db.transaction(({ guildId, warningId, actorId, reason, allowSelf = false }) => {
    const text = String(reason ?? "").trim();
    if (!text) throw new WarningError("Für das Löschen ist ein Grund erforderlich.");
    const row = get(guildId, warningId);
    if (!row) throw new WarningError("Diese Verwarnung wurde nicht gefunden.", "NOT_FOUND");
    if (row.user_id === actorId && !allowSelf) throw new WarningError("Eigene Verwarnungen kann nur jemand anderes löschen.", "SELF_REVOKE");
    db.prepare("DELETE FROM member_warnings WHERE id=? AND guild_id=?").run(warningId, guildId);
    audit(db, guildId, actorId, "sanction.warning_deleted", row.user_id, { warningId, reason: text, originalReason: row.reason, wasRevoked: row.revoked_at ? "ja" : "nein" });
    return row;
  });

  return { add, list, recent, get, revoke, remove, activeCount };
}
