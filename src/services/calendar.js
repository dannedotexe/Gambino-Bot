import { localDay } from "./absences.js";
import { occurrencesBetween, zonedTime } from "./event-series.js";
import { weekStart } from "./tasks.js";

const DAY = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * Wochenkalender (Mo–So, Server-Zeitzone): gespeicherte Events plus noch nicht angelegte Termine aktiver Aktivitäten.
 * offset = Wochen ab der aktuellen Woche (0 = diese Woche, -1 = letzte, 1 = nächste).
 */
export function weekCalendar(db, { guildId, timezone = "Europe/Vienna", offset = 0, reference = new Date() }) {
  const monday = addDays(weekStart(localDay(reference, timezone)), offset * 7);
  const [y, m, d] = monday.split("-").map(Number);
  const from = zonedTime(y, m, d, 0, 0, timezone) ?? new Date(`${monday}T00:00:00Z`);
  const until = new Date(from.getTime() + 7 * DAY);
  const events = db.prepare(`SELECT e.id,e.name,e.starts_at,e.location,e.status,e.series_id,e.max_participants,e.outcome,
      (SELECT COUNT(*) FROM event_participants p WHERE p.event_id=e.id AND p.status IN ('signed_up','present')) AS participants,
      (SELECT COUNT(*) FROM event_waitlist w WHERE w.event_id=e.id) AS waiting
    FROM events e WHERE e.guild_id=? AND e.starts_at>=? AND e.starts_at<? ORDER BY e.starts_at`).all(guildId, from.toISOString(), until.toISOString());
  const kindOf = e => (e.location === "Staatliche Kontrolle" && !e.series_id ? "control" : e.series_id ? "series" : "event");
  const items = events.map(e => ({ id: e.id, name: e.name, startsAt: e.starts_at, status: e.status, kind: kindOf(e), participants: e.participants, max: e.max_participants, waiting: e.waiting, outcome: e.outcome }));
  // Geplante Aktivitäten, für die noch kein Event angelegt ist (werden erst kurz vorher angekündigt).
  const taken = new Set(events.filter(e => e.series_id).map(e => `${e.series_id}|${new Date(e.starts_at).toISOString()}`));
  for (const series of db.prepare("SELECT * FROM event_series WHERE guild_id=? AND active=1").all(guildId))
    for (const at of occurrencesBetween(series, new Date(from.getTime() - 1), until, timezone))
      if (at < until && !taken.has(`${series.id}|${at.toISOString()}`)) items.push({ id: null, name: series.name, startsAt: at.toISOString(), status: "planned", kind: "series", participants: 0, max: series.max_participants ?? null, waiting: 0 });
  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const days = Array.from({ length: 7 }, (_, n) => ({ day: addDays(monday, n), items: [] }));
  for (const item of items) days.find(x => x.day === localDay(new Date(item.startsAt), timezone))?.items.push(item);
  return { from: monday, until: addDays(monday, 6), today: localDay(reference, timezone), days };
}

/** Kill-Bestenliste aus den eingetragenen Kills (Win mit Kill-Prämie), Zeitraum nach Event-Beginn. */
export function killLeaderboard(db, { guildId, timezone = "Europe/Vienna", period = "week", reference = new Date(), limit = 15 }) {
  const today = localDay(reference, timezone);
  const start = period === "week" ? weekStart(today) : period === "month" ? `${today.slice(0, 7)}-01` : null;
  let since = "0";
  if (start) { const [y, m, d] = start.split("-").map(Number); since = (zonedTime(y, m, d, 0, 0, timezone) ?? new Date(`${start}T00:00:00Z`)).toISOString(); }
  return db.prepare(`SELECT k.user_id AS userId, SUM(k.kills) AS kills, COUNT(DISTINCT k.event_id) AS events, MAX(k.kills) AS best
    FROM event_kills k JOIN events e ON e.id=k.event_id WHERE e.guild_id=? AND e.starts_at>=? AND k.kills>0
    GROUP BY k.user_id ORDER BY kills DESC, best DESC LIMIT ?`).all(guildId, since, limit);
}

export function killsOf(db, guildId, userId) {
  return db.prepare("SELECT COALESCE(SUM(k.kills),0) AS kills, COALESCE(MAX(k.kills),0) AS best FROM event_kills k JOIN events e ON e.id=k.event_id WHERE e.guild_id=? AND k.user_id=?").get(guildId, userId);
}
