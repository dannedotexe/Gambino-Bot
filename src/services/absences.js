import { randomUUID } from "node:crypto";
import { audit } from "../database.js";

/** Fachlicher Fehler bei Abmeldungen; die Meldung ist für Mitglieder verständlich. */
export class AbsenceError extends Error {
  constructor(message, code = "INVALID_INPUT") { super(message); this.code = code; }
}

const DAY = 86_400_000;

/** Kalendertag (YYYY-MM-DD) eines Zeitpunkts in der Server-Zeitzone. */
export function localDay(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const validDay = (y, m, d) => { const date = new Date(Date.UTC(y, m - 1, d)); return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d; };
const pad = n => String(n).padStart(2, "0");
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
/** 2026-10-14 -> 14.10.2026 */
export const formatDay = day => day ? day.split("-").reverse().join(".") : "—";

/**
 * Liest ein Datum wie „heute“, „morgen“, „20.10.“, „20.10.2026“, „20.10.26“ oder „2026-10-20“.
 * Ohne Jahr gilt das nächste passende Datum ab heute.
 */
export function parseDay(input, timezone, reference = new Date()) {
  const raw = String(input ?? "").trim().toLowerCase();
  const today = localDay(reference, timezone);
  if (["heute", "jetzt"].includes(raw)) return today;
  if (raw === "morgen") return addDays(today, 1);
  if (raw === "übermorgen") return addDays(today, 2);
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    const [, y, m, d] = match.map(Number);
    if (validDay(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
  }
  match = /^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/.exec(raw);
  if (match) {
    const d = Number(match[1]), m = Number(match[2]);
    let y = match[3] ? Number(match[3]) : Number(today.slice(0, 4));
    if (match[3]?.length === 2) y += 2000;
    if (validDay(y, m, d)) {
      let day = `${y}-${pad(m)}-${pad(d)}`;
      if (!match[3] && day < today && validDay(y + 1, m, d)) day = `${y + 1}-${pad(m)}-${pad(d)}`;
      return day;
    }
  }
  throw new AbsenceError(`„${String(input ?? "").slice(0, 30)}“ ist kein gültiges Datum. Beispiele: heute, morgen, 20.10. oder 20.10.2026.`);
}

/**
 * Abmeldungen (Urlaub, Pause). Einträge werden nie gelöscht; ein vorzeitiges Ende setzt ended_at.
 * Ein Tag gilt als abgemeldet, wenn er zwischen starts_on und ends_on (inklusive) liegt.
 */
export function createAbsenceService(db) {
  const now = () => new Date().toISOString();
  const ACTIVE = "ended_at IS NULL";

  const create = db.transaction(({ guildId, userId, actorId, startsOn, endsOn, reason, timezone, maxDays = 60, reference = new Date() }) => {
    const text = String(reason ?? "").trim();
    if (text.length < 2) throw new AbsenceError("Bitte gib einen kurzen Grund an (z. B. Urlaub).");
    if (text.length > 300) throw new AbsenceError("Der Grund darf höchstens 300 Zeichen lang sein.");
    const today = localDay(reference, timezone);
    if (endsOn < startsOn) throw new AbsenceError("Das Ende liegt vor dem Beginn.");
    if (endsOn < today) throw new AbsenceError("Die Abmeldung liegt komplett in der Vergangenheit.");
    if (startsOn < addDays(today, -7)) throw new AbsenceError("Der Beginn darf höchstens 7 Tage zurückliegen.");
    const length = daysBetween(startsOn, endsOn) + 1;
    if (length > maxDays) throw new AbsenceError(`Eine Abmeldung darf höchstens ${maxDays} Tage dauern (angegeben: ${length}). Für längere Pausen bitte ein Ticket an die Leitung.`);
    const overlap = db.prepare(`SELECT starts_on,ends_on FROM member_absences WHERE guild_id=? AND user_id=? AND ${ACTIVE} AND starts_on<=? AND ends_on>=?`).get(guildId, userId, endsOn, startsOn);
    if (overlap) throw new AbsenceError(`Es gibt schon eine Abmeldung vom ${formatDay(overlap.starts_on)} bis ${formatDay(overlap.ends_on)}. Beende sie zuerst, wenn du sie ändern willst.`, "OVERLAP");
    const id = randomUUID();
    db.prepare("INSERT INTO member_absences(id,guild_id,user_id,starts_on,ends_on,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, guildId, userId, startsOn, endsOn, text, actorId, now());
    audit(db, guildId, actorId, "absence.created", userId, { absenceId: id, startsOn, endsOn, reason: text });
    return get(guildId, id);
  });

  const get = (guildId, id) => db.prepare("SELECT * FROM member_absences WHERE guild_id=? AND id=?").get(guildId, id) ?? null;

  /** Beendet eine Abmeldung vorzeitig (oder storniert eine geplante). */
  const end = db.transaction(({ guildId, absenceId, actorId }) => {
    const row = get(guildId, absenceId);
    if (!row) throw new AbsenceError("Diese Abmeldung wurde nicht gefunden.", "NOT_FOUND");
    if (row.ended_at) throw new AbsenceError("Diese Abmeldung ist bereits beendet.", "ALREADY_ENDED");
    const ts = now();
    db.prepare("UPDATE member_absences SET ended_at=?,ended_by=? WHERE id=? AND ended_at IS NULL").run(ts, actorId, absenceId);
    audit(db, guildId, actorId, "absence.ended", row.user_id, { absenceId, startsOn: row.starts_on, endsOn: row.ends_on });
    return { ...row, ended_at: ts, ended_by: actorId };
  });

  /** Aktuelle oder nächste offene Abmeldung einer Person (für „/abwesend beenden“). */
  const openFor = (guildId, userId, today) =>
    db.prepare(`SELECT * FROM member_absences WHERE guild_id=? AND user_id=? AND ${ACTIVE} AND ends_on>=? ORDER BY starts_on LIMIT 1`).get(guildId, userId, today) ?? null;

  const current = (guildId, today) =>
    db.prepare(`SELECT * FROM member_absences WHERE guild_id=? AND ${ACTIVE} AND starts_on<=? AND ends_on>=? ORDER BY ends_on`).all(guildId, today, today);
  const upcoming = (guildId, today, limit = 50) =>
    db.prepare(`SELECT * FROM member_absences WHERE guild_id=? AND ${ACTIVE} AND starts_on>? ORDER BY starts_on LIMIT ?`).all(guildId, today, limit);
  const forUser = (guildId, userId, limit = 20) =>
    db.prepare("SELECT * FROM member_absences WHERE guild_id=? AND user_id=? ORDER BY starts_on DESC LIMIT ?").all(guildId, userId, limit);
  const absentUserIds = (guildId, today) => new Set(current(guildId, today).map(row => row.user_id));

  /** War die Person zu diesem Zeitpunkt abgemeldet? (für entschuldigtes Fehlen bei Events) */
  function wasAbsent(guildId, userId, at, timezone) {
    const day = localDay(new Date(at), timezone);
    return Boolean(db.prepare("SELECT 1 FROM member_absences WHERE guild_id=? AND user_id=? AND starts_on<=? AND ends_on>=? AND (ended_at IS NULL OR ended_at>?)").get(guildId, userId, day, day, new Date(at).toISOString()));
  }

  return { create, get, end, openFor, current, upcoming, forUser, absentUserIds, wasAbsent };
}
