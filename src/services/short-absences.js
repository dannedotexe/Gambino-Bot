import { randomUUID } from "node:crypto";
import { audit } from "../database.js";
import { zonedTime } from "./event-series.js";
import { AbsenceError } from "./absences.js";

/**
 * „Kurz weg“: Abmeldung für Minuten oder Stunden (z. B. 30 min, 2 h, bis 21:30) – höchstens 12 Stunden.
 * Wer kurz weg ist, gilt bei Events in dieser Zeit als entschuldigt. Für ganze Tage gibt es die normale Abmeldung.
 */
export const SHORT_MAX_MINUTES = 12 * 60;

/** „30“, „30 min“, „45m“, „2h“, „2 std“, „1,5 h“, „1:30 h“, „bis 21:30“, „21:30“, „21 uhr“ → Ende als Date. */
export function parseShortUntil(input, timezone = "Europe/Vienna", reference = new Date()) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^für /, "");
  if (!raw) throw new AbsenceError("Bitte angeben, wie lange du weg bist (z. B. 30 min, 2h oder bis 21:30).");
  const clock = /^(?:bis )?(\d{1,2})(?:[:.](\d{2}))?(?: ?uhr)?$/.exec(raw);
  const duration = /^(\d+(?:[.,]\d+)?)(?::(\d{2}))? ?(m|min|mins|minute|minuten|h|std|stunde|stunden)?$/.exec(raw);
  let until;
  // „bis 21:30“, „21:30“, „21 uhr“ = Uhrzeit; eine reine Zahl ohne Einheit = Minuten.
  if (clock && (raw.startsWith("bis") || /[:.]|uhr/.test(raw))) {
    const hour = Number(clock[1]), minute = Number(clock[2] ?? 0);
    if (hour > 23 || minute > 59) throw new AbsenceError("Ungültige Uhrzeit.");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(reference).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
    until = zonedTime(parts.year, parts.month, parts.day, hour, minute, timezone);
    if (until && until <= reference) until = new Date(until.getTime() + 86_400_000); // „bis 01:00“ kurz vor Mitternacht = morgen
  } else if (duration) {
    const value = Number(duration[1].replace(",", ".")), unit = duration[3] ?? "min";
    const minutes = duration[2] != null ? value * 60 + Number(duration[2]) : /^(h|std|stunde|stunden)$/.test(unit) ? value * 60 : value;
    until = new Date(reference.getTime() + Math.round(minutes) * 60_000);
  }
  if (!until || Number.isNaN(until.getTime())) throw new AbsenceError("Das habe ich nicht verstanden. Beispiele: 30 min, 2h, 1,5 h, bis 21:30.");
  const minutes = (until - reference) / 60_000;
  if (minutes < 5) throw new AbsenceError("Mindestens 5 Minuten.");
  if (minutes > SHORT_MAX_MINUTES) throw new AbsenceError("„Kurz weg“ geht höchstens 12 Stunden – für länger bitte normal abmelden.");
  return until;
}

export function createShortAbsenceService(db) {
  const now = () => new Date().toISOString();
  const get = id => db.prepare("SELECT * FROM short_absences WHERE id=?").get(id) ?? null;
  /** Laufender „Kurz weg“-Eintrag einer Person (oder null). */
  const activeFor = (guildId, userId, reference = new Date()) =>
    db.prepare("SELECT * FROM short_absences WHERE guild_id=? AND user_id=? AND ended_at IS NULL AND ends_at>? ORDER BY ends_at DESC LIMIT 1").get(guildId, userId, reference.toISOString()) ?? null;
  const active = (guildId, reference = new Date()) =>
    db.prepare("SELECT * FROM short_absences WHERE guild_id=? AND ended_at IS NULL AND ends_at>? ORDER BY ends_at").all(guildId, reference.toISOString());

  /** Neuer Eintrag ersetzt einen laufenden (Verlängern/Verkürzen = einfach neu melden). */
  const create = db.transaction(({ guildId, userId, actorId = userId, until, reason = "", reference = new Date() }) => {
    const text = String(reason ?? "").trim().slice(0, 200);
    const previous = activeFor(guildId, userId, reference);
    if (previous) db.prepare("UPDATE short_absences SET ended_at=? WHERE id=?").run(reference.toISOString(), previous.id);
    const id = randomUUID();
    db.prepare("INSERT INTO short_absences(id,guild_id,user_id,starts_at,ends_at,reason,created_at) VALUES(?,?,?,?,?,?,?)").run(id, guildId, userId, reference.toISOString(), until.toISOString(), text, now());
    audit(db, guildId, actorId, "absence.short", userId, { until: until.toISOString(), reason: text, replaced: previous?.id ?? null });
    return { row: get(id), previous };
  });

  const end = db.transaction(({ guildId, userId, actorId = userId, reference = new Date() }) => {
    const row = activeFor(guildId, userId, reference);
    if (!row) return null;
    db.prepare("UPDATE short_absences SET ended_at=? WHERE id=?").run(reference.toISOString(), row.id);
    audit(db, guildId, actorId, "absence.short_ended", userId, { id: row.id });
    return { ...row, ended_at: reference.toISOString() };
  });

  /** War die Person zu diesem Zeitpunkt kurz weg? */
  const coveredAt = (guildId, userId, at) => {
    const iso = new Date(at).toISOString();
    return Boolean(db.prepare("SELECT 1 FROM short_absences WHERE guild_id=? AND user_id=? AND starts_at<=? AND COALESCE(ended_at,ends_at)>=?").get(guildId, userId, iso, iso));
  };

  const setMessage = (id, channelId, messageId) => db.prepare("UPDATE short_absences SET channel_id=?,message_id=? WHERE id=?").run(channelId, messageId, id);
  /** Abgelaufene oder beendete Einträge mit noch stehender Meldung. */
  const withStaleMessage = (guildId, reference = new Date()) =>
    db.prepare("SELECT * FROM short_absences WHERE guild_id=? AND message_id IS NOT NULL AND (ended_at IS NOT NULL OR ends_at<=?)").all(guildId, reference.toISOString());
  const clearMessage = id => db.prepare("UPDATE short_absences SET message_id=NULL WHERE id=?").run(id);

  return { create, end, activeFor, active, coveredAt, setMessage, withStaleMessage, clearMessage, get };
}
