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

const WEEKDAYS = { so: 0, sonntag: 0, sun: 0, sunday: 0, mo: 1, montag: 1, mon: 1, monday: 1, di: 2, dienstag: 2, tue: 2, tuesday: 2, mi: 3, mittwoch: 3, wed: 3, wednesday: 3,
  do: 4, donnerstag: 4, thu: 4, thursday: 4, fr: 5, freitag: 5, fri: 5, friday: 5, sa: 6, samstag: 6, sonnabend: 6, sat: 6, saturday: 6 };
const MONTHS = { jan: 1, januar: 1, jänner: 1, january: 1, feb: 2, februar: 2, february: 2, mär: 3, mar: 3, märz: 3, maerz: 3, march: 3, apr: 4, april: 4, mai: 5, may: 5,
  jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, november: 11, dez: 12, dec: 12, dezember: 12, december: 12 };
const NUMBERS = { ein: 1, eine: 1, einen: 1, einer: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, vierzehn: 14, zwanzig: 20, dreißig: 30, dreissig: 30 };
const weekdayOf = day => new Date(`${day}T12:00:00Z`).getUTCDay();
const lastOfMonth = day => { const [y, m] = day.split("-").map(Number); return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const num = word => /^\d+$/.test(word) ? Number(word) : NUMBERS[word] ?? null;

/** Datum mit Tag/Monat/(Jahr); ohne Jahr gilt das nächste passende Datum ab heute. */
function fromParts(d, m, y, today) {
  if (y != null && y < 100) y += 2000;
  const year = y ?? Number(today.slice(0, 4));
  if (!validDay(year, m, d)) return null;
  let day = `${year}-${pad(m)}-${pad(d)}`;
  if (y == null && day < addDays(today, -7) && validDay(year + 1, m, d)) day = `${year + 1}-${pad(m)}-${pad(d)}`;
  return day;
}

/**
 * Liest Datumsangaben großzügig: „heute“, „morgen“, „übermorgen“, „gestern“, Wochentage („Freitag“, „Fr“, „nächsten Montag“),
 * „Wochenende“, „Monatsende“, „in 3 Tagen“, „20.10“, „20.10.“, „20.10.26“, „20/10“, „20-10-2026“, „2026-10-20“, „20. Oktober“,
 * „20 Okt 2026“, „ab morgen“ … Mit `base` (Startdatum) zusätzlich Dauern wie „3 Tage“, „1 Woche“, „zwei Wochen“, „+5“ (inklusive).
 */
export function parseDay(input, timezone, reference = new Date(), { base = null } = {}) {
  const original = String(input ?? "").trim();
  const today = localDay(reference, timezone);
  let raw = original.toLowerCase().replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(ab|von|vom|bis|bis zum|bis zur|zum|zur|am|den|dem|ca\.?|etwa|ungefähr)\s+/, "").replace(/^(ab|bis|zum|am|den)\s+/, "").replace(/\s+uhr$/, "").trim();
  if (!raw) throw new AbsenceError("Bitte ein Datum angeben (z. B. heute, morgen, Freitag oder 20.10.).");
  if (["heute", "jetzt", "sofort", "gleich", "today", "now"].includes(raw)) return today;
  if (["morgen", "tomorrow"].includes(raw)) return addDays(today, 1);
  if (["übermorgen", "uebermorgen"].includes(raw)) return addDays(today, 2);
  if (raw === "gestern") return addDays(today, -1);
  if (raw === "vorgestern") return addDays(today, -2);
  if (["wochenende", "ende der woche", "ende dieser woche", "wochenende."].includes(raw)) return addDays(today, (7 - weekdayOf(today)) % 7);
  if (["monatsende", "ende des monats", "ende monat", "ende vom monat"].includes(raw)) return lastOfMonth(today);
  // Dauer relativ zum Start (nur für „Bis“): „3 tage“, „1 woche“, „+5“, „eine woche“, „2 wochen“
  let match = /^\+?\s*(\d{1,3}|[a-zäöüß]+)\s*(t|tag|tage|tagen|d|day|days|w|wo|woche|wochen|week|weeks|monat|monate|monaten|month|months)$/.exec(raw);
  const plus = /^\+\s*(\d{1,3})$/.exec(raw);
  if ((match && num(match[1]) != null) || plus) {
    const n = plus ? Number(plus[1]) : num(match[1]);
    const unit = plus ? "t" : match[2];
    const days = /^(w|wo|woche|wochen|week|weeks)$/.test(unit) ? n * 7 : /^mon/.test(unit) ? n * 30 : n;
    if (base) return addDays(base, Math.max(0, days - 1));
    return addDays(today, days);
  }
  // „in 3 tagen“, „in einer woche“
  match = /^in\s+(\d{1,3}|[a-zäöüß]+)\s*(tag|tage|tagen|woche|wochen|monat|monaten)$/.exec(raw);
  if (match && num(match[1]) != null) {
    const n = num(match[1]);
    return addDays(today, /^woche/.test(match[2]) ? n * 7 : /^monat/.test(match[2]) ? n * 30 : n);
  }
  // Wochentage: „freitag“, „fr“, „nächsten montag“, „kommenden fr“
  match = /^(nächste[nmrs]?|naechste[nmrs]?|kommende[nmrs]?|diese[nmrs]?)?\s*([a-zäöü]+)\.?$/.exec(raw);
  if (match && WEEKDAYS[match[2]] != null) {
    let diff = (WEEKDAYS[match[2]] - weekdayOf(today) + 7) % 7;
    if (match[1] && /^(nächst|naechst|kommend)/.test(match[1]) && diff === 0) diff = 7;
    return addDays(today, diff);
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) { const [, y, m, d] = match.map(Number); if (validDay(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`; }
  // 20.10 | 20.10. | 20.10.26 | 20.10.2026 | 20/10 | 20-10-2026 | 20.10 2026
  match = /^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]?\s*(\d{2}|\d{4})?\.?$/.exec(raw);
  if (match) { const day = fromParts(Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : null, today); if (day) return day; }
  // 20. oktober | 20 okt 2026 | 20. okt. 26
  match = /^(\d{1,2})\.?\s*([a-zäöü]+)\.?\s*(\d{2}|\d{4})?$/.exec(raw);
  if (match && MONTHS[match[2]]) { const day = fromParts(Number(match[1]), MONTHS[match[2]], match[3] ? Number(match[3]) : null, today); if (day) return day; }
  // oktober 20 | okt 20 2026
  match = /^([a-zäöü]+)\.?\s*(\d{1,2})\.?\s*(\d{2}|\d{4})?$/.exec(raw);
  if (match && MONTHS[match[1]]) { const day = fromParts(Number(match[2]), MONTHS[match[1]], match[3] ? Number(match[3]) : null, today); if (day) return day; }
  // nur Tag: „20“ / „20.“ → nächster 20. (diesen oder nächsten Monat)
  match = /^(\d{1,2})\.?$/.exec(raw);
  if (match) {
    const d = Number(match[1]); let [y, m] = today.split("-").map(Number);
    for (let k = 0; k < 3; k++) { const day = validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null; if (day && day >= today) return day; m++; if (m > 12) { m = 1; y++; } }
  }
  throw new AbsenceError(`„${original.slice(0, 30)}“ ist kein gültiges Datum. Das geht z. B.: heute, morgen, Freitag, 20.10., 20. Oktober${base ? ", 3 Tage, 1 Woche" : ""}.`);
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
