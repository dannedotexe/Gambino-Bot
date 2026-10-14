import { getSetting, setSetting } from "../database.js";
import { zonedTime } from "./event-series.js";
import { localDay } from "./absences.js";

const DAY = 86_400_000;
export const TRACKING_SINCE_KEY = "ACTIVITY_TRACKING_SINCE";

// Eine Event-Teilnahme zählt, wenn jemand als anwesend markiert wurde oder bei einem bereits begonnenen,
// nicht abgesagten Event angemeldet war und nicht als abwesend markiert wurde.
const PARTICIPATION = "p.status IN ('present','signed_up') AND e.status<>'cancelled' AND e.starts_at<=?";

/** Beginn der aktuellen Woche (Montag 00:00) bzw. des Monats in der Server-Zeitzone als UTC-Zeitpunkt. */
export function periodStart(period, timezone, reference = new Date()) {
  if (period === "all") return new Date(0);
  const [y, m, d] = localDay(reference, timezone).split("-").map(Number);
  let day = new Date(Date.UTC(y, m - 1, d));
  if (period === "week") day = new Date(day.getTime() - (((day.getUTCDay() + 6) % 7) * DAY));
  else if (period === "month") day = new Date(Date.UTC(y, m - 1, 1));
  return zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, timezone)
    ?? zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 1, 0, timezone);
}

/**
 * Aktivität der Mitglieder: letzte Nachricht (nur Zeitpunkt und Anzahl, nie Inhalte), Event-Teilnahmen,
 * Inaktivitätsbericht und Rangliste.
 */
export function createActivityService(db) {
  const lastWrite = new Map();

  /** Merkt sich die letzte Nachricht. Schreibt höchstens einmal pro Minute und Person in die Datenbank. */
  function recordMessage(guildId, userId, at = new Date(), { throttleMs = 60_000 } = {}) {
    const key = `${guildId}:${userId}`, ms = at.getTime();
    if (throttleMs && ms - (lastWrite.get(key) ?? 0) < throttleMs) return false;
    lastWrite.set(key, ms);
    if (lastWrite.size > 50_000) lastWrite.clear();
    db.prepare("INSERT INTO member_activity(guild_id,user_id,last_message_at,messages) VALUES(?,?,?,1) ON CONFLICT(guild_id,user_id) DO UPDATE SET last_message_at=MAX(COALESCE(last_message_at,''),excluded.last_message_at),messages=messages+1").run(guildId, userId, at.toISOString());
    return true;
  }

  /** Seit wann Nachrichten erfasst werden. Wird beim ersten Aufruf gesetzt, damit alte Mitglieder nicht sofort „inaktiv“ sind. */
  function trackingSince(guildId, reference = new Date()) {
    const stored = getSetting(db, guildId, TRACKING_SINCE_KEY);
    if (stored) return stored;
    setSetting(db, guildId, TRACKING_SINCE_KEY, reference.toISOString());
    return reference.toISOString();
  }

  const lastMessage = (guildId, userId) => db.prepare("SELECT last_message_at,messages FROM member_activity WHERE guild_id=? AND user_id=?").get(guildId, userId) ?? null;

  function eventStats(guildId, userId, reference = new Date()) {
    const iso = reference.toISOString();
    const row = db.prepare(`SELECT COUNT(*) n, MAX(e.starts_at) last FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.user_id=? AND ${PARTICIPATION}`).get(guildId, userId, iso);
    const absent = db.prepare("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.user_id=? AND p.status='absent'").get(guildId, userId).n;
    return { participations: row.n, lastEvent: row.last ?? null, absences: absent };
  }

  /**
   * Inaktive Mitglieder: weder Nachricht noch Event-Teilnahme seit `days` Tagen. Abgemeldete werden markiert,
   * nicht als inaktiv gezählt. Beitritt und Erfassungsbeginn gelten als frühester „zuletzt aktiv“-Zeitpunkt.
   */
  function inactivityReport(guildId, members, { days, absentIds = new Set(), reference = new Date() }) {
    const since = trackingSince(guildId, reference);
    const cutoff = new Date(reference.getTime() - days * DAY).toISOString(), iso = reference.toISOString();
    const messages = new Map(db.prepare("SELECT user_id,last_message_at FROM member_activity WHERE guild_id=?").all(guildId).map(r => [r.user_id, r.last_message_at]));
    const events = new Map(db.prepare(`SELECT p.user_id, MAX(e.starts_at) last FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND ${PARTICIPATION} GROUP BY p.user_id`).all(guildId, iso).map(r => [r.user_id, r.last]));
    const notices = new Map(db.prepare("SELECT user_id,notified_at FROM inactivity_notices WHERE guild_id=?").all(guildId).map(r => [r.user_id, r.notified_at]));
    return members.map(member => {
      const lastMsg = messages.get(member.id) ?? null, lastEvent = events.get(member.id) ?? null;
      const joined = member.joinedAt ? new Date(member.joinedAt).toISOString() : null;
      const lastSeen = [lastMsg, lastEvent].filter(Boolean).sort().at(-1) ?? null;
      const baseline = [lastSeen, joined, since].filter(Boolean).sort().at(-1);
      const absent = absentIds.has(member.id);
      return {
        userId: member.id, name: member.name ?? null, lastMessage: lastMsg, lastEvent, lastSeen, joinedAt: joined,
        inactiveDays: Math.floor((reference.getTime() - Date.parse(baseline)) / DAY),
        inactive: !absent && baseline < cutoff, absent, notifiedAt: notices.get(member.id) ?? null,
      };
    }).sort((a, b) => b.inactiveDays - a.inactiveDays);
  }

  const markNotified = (guildId, userId, at = new Date()) =>
    db.prepare("INSERT INTO inactivity_notices(guild_id,user_id,notified_at) VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET notified_at=excluded.notified_at").run(guildId, userId, at.toISOString());

  /** Rangliste nach Event-Teilnahmen im Zeitraum (week, month, all). */
  function leaderboard(guildId, { period = "week", timezone, limit = 10, reference = new Date() } = {}) {
    const from = periodStart(period, timezone, reference).toISOString();
    return db.prepare(`SELECT p.user_id, COUNT(*) n, SUM(p.status='present') present FROM event_participants p JOIN events e ON e.id=p.event_id
      WHERE e.guild_id=? AND ${PARTICIPATION} AND e.starts_at>=? GROUP BY p.user_id ORDER BY n DESC, present DESC, MIN(e.starts_at) LIMIT ?`).all(guildId, reference.toISOString(), from, limit)
      .map(row => ({ userId: row.user_id, count: row.n, present: row.present }));
  }

  return { recordMessage, trackingSince, lastMessage, eventStats, inactivityReport, markNotified, leaderboard };
}
