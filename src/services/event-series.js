import { randomUUID } from "node:crypto";
import { audit, getSetting, setSetting } from "../database.js";

export const WEEKDAYS = { 1: "Mo", 2: "Di", 3: "Mi", 4: "Do", 5: "Fr", 6: "Sa", 7: "So" };
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** Grand-RP-Aktivitäten der Gambinos. Werden einmalig pro Server angelegt, standardmäßig inaktiv. */
export const DEFAULT_SERIES = [
  { name: "Cayo Perico", weekdays: [3], times: ["20:20"] },
  { name: "Flugzeugträger", weekdays: [4], times: ["21:30"] },
  { name: "Angriff auf das Gefängnis", weekdays: [5], times: ["20:20"] },
  { name: "Ladenraub", kind: "flexible", availability: "alle 3 Stunden möglich" },
  { name: "RP Fabrik", weekdays: ALL_DAYS, times: ["10:30", "16:30", "22:30"] },
  { name: "Banküberfall", weekdays: [3, 6], times: ["21:30"] },
  { name: "Übernahme des Hotels", weekdays: ALL_DAYS, times: ["02:20"] },
  { name: "Waffenfabrik", weekdays: ALL_DAYS, times: ["03:20"] },
  { name: "Überfall auf ein Drogenlabor", kind: "flexible", availability: "jeden Tag von 10:00 bis 23:00 Uhr" },
  { name: "Familie Razzia", kind: "flexible", availability: "den ganzen Tag verfügbar" },
  { name: "Gießerei", weekdays: ALL_DAYS, times: ["14:20"] },
  { name: "Bizwar", weekdays: ALL_DAYS, times: ["19:05", "01:05"] },
  { name: "Kampf um die Rangfolge", weekdays: ALL_DAYS, times: ["20:50"] },
  { name: "Der Kampf um die Werft", weekdays: ALL_DAYS, times: ["01:10", "19:10", "22:10"], location: "Hafen von Los Santos",
    description: "Schlacht um den Hafen – Belohnung: Munition & Waffen für das Familienlager.\n⚠️ **Alle Teilnehmer müssen POV aufnehmen und 48 Stunden aufbewahren** (sonst 30 Tage Sperre)." },
];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const now = () => new Date().toISOString();

/** Lokales Datum/Uhrzeit in der Zielzeitzone als Teile. */
function localParts(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return parts;
}

/** Wandelt lokale Wanduhrzeit in der Zeitzone in einen UTC-Zeitpunkt um; null, wenn es die Zeit nicht gibt (Sommerzeit-Lücke). */
export function zonedTime(year, month, day, hour, minute, timezone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const want = [year, month, day, hour, minute].join(":");
  const candidates = [-36, 0, 36].map(h => {
    const p = localParts(new Date(naive + h * 3_600_000), timezone);
    return naive - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - (naive + h * 3_600_000));
  });
  const hit = [...new Set(candidates)].sort((a, b) => a - b).find(epoch => { const p = localParts(new Date(epoch), timezone); return [p.year, p.month, p.day, p.hour, p.minute].join(":") === want; });
  return hit == null ? null : new Date(hit);
}

/** Alle Termine einer Serie im Zeitraum (from, until]. Wochentag 1 = Montag … 7 = Sonntag, in der Server-Zeitzone. */
export function occurrencesBetween(series, from, until, timezone) {
  if (series.kind !== "scheduled") return [];
  const weekdays = parseList(series.weekdays).map(Number), times = parseList(series.times);
  const result = [];
  const start = localParts(from, timezone);
  const days = Math.ceil((until - from) / 86_400_000) + 2;
  for (let offset = -1; offset <= days; offset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (!weekdays.includes(weekday)) continue;
    for (const time of times) {
      const [, h, m] = TIME.exec(time) ?? [];
      if (h == null) continue;
      const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(h), Number(m), timezone);
      if (at && at > from && at <= until) result.push(at);
    }
  }
  return result.sort((a, b) => a - b);
}

export const nextOccurrence = (series, timezone, reference = new Date()) =>
  occurrencesBetween(series, reference, new Date(reference.getTime() + 8 * 86_400_000), timezone)[0] ?? null;

function parseList(value) { return String(value ?? "").split(",").map(item => item.trim()).filter(Boolean); }

export function describeSchedule(series) {
  if (series.kind !== "scheduled") return series.availability || "flexibel";
  const days = parseList(series.weekdays).map(Number).sort((a, b) => a - b);
  const dayText = days.length === 7 ? "täglich" : days.map(day => WEEKDAYS[day]).join(", ");
  return `${dayText} · ${parseList(series.times).sort().join(", ")} Uhr`;
}

export function validateSeries(input) {
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new Error("Name: 2 bis 100 Zeichen.");
  const kind = input.kind === "flexible" ? "flexible" : "scheduled";
  const weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : parseList(input.weekdays)).map(Number))].filter(day => day >= 1 && day <= 7).sort((a, b) => a - b);
  const times = [...new Set((Array.isArray(input.times) ? input.times : parseList(String(input.times ?? "").replace(/\./g, ":"))).map(t => String(t).trim().padStart(5, "0")))].sort();
  if (kind === "scheduled") {
    if (!weekdays.length) throw new Error("Bitte mindestens einen Wochentag wählen.");
    if (!times.length || times.length > 12 || !times.every(t => TIME.test(t))) throw new Error("Uhrzeiten im Format HH:MM angeben, z. B. 20:20 oder 10:30, 16:30 (max. 12).");
  }
  const availability = String(input.availability ?? "").trim().slice(0, 200);
  if (kind === "flexible" && !availability) throw new Error("Bitte die Verfügbarkeit beschreiben, z. B. „alle 3 Stunden möglich“.");
  const lead = input.leadMinutes == null || input.leadMinutes === "" ? 120 : Number(input.leadMinutes);
  if (!Number.isInteger(lead) || lead < 5 || lead > 1440) throw new Error("Vorlaufzeit: 5 bis 1440 Minuten.");
  const max = input.maxParticipants == null || input.maxParticipants === "" ? null : Number(input.maxParticipants);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > 500)) throw new Error("Teilnehmerlimit: 1 bis 500 oder leer.");
  const min = input.minParticipants == null || input.minParticipants === "" ? null : Number(input.minParticipants);
  if (min !== null && (!Number.isInteger(min) || min < 1 || min > 500)) throw new Error("Mindestteilnehmer: 1 bis 500 oder leer.");
  if (min !== null && max !== null && min > max) throw new Error("Die Mindestzahl darf nicht über dem Teilnehmerlimit liegen.");
  return {
    name, kind, weekdays: kind === "scheduled" ? weekdays.join(",") : "", times: kind === "scheduled" ? times.join(",") : "", availability,
    description: String(input.description ?? "").trim().slice(0, 1000), location: String(input.location ?? "").trim().slice(0, 100),
    lead_minutes: lead, max_participants: max, min_participants: min,
  };
}

export function createSeriesService(db) {
  const list = guildId => db.prepare("SELECT * FROM event_series WHERE guild_id=? ORDER BY sort_order,name").all(guildId);
  const get = (guildId, id) => db.prepare("SELECT * FROM event_series WHERE guild_id=? AND id=?").get(guildId, id);

  /** Legt die Standard-Aktivitäten genau einmal pro Server an (gelöschte kommen nicht zurück). */
  function seedDefaults(guildId, actorId = "system") {
    if (!guildId || getSetting(db, guildId, "EVENT_SERIES_SEEDED")) return 0;
    let created = 0;
    db.transaction(() => {
      DEFAULT_SERIES.forEach((item, index) => {
        const data = validateSeries({ kind: "scheduled", ...item });
        created += db.prepare("INSERT OR IGNORE INTO event_series(id,guild_id,name,kind,weekdays,times,availability,description,location,lead_minutes,max_participants,active,sort_order,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)")
          .run(randomUUID(), guildId, data.name, data.kind, data.weekdays, data.times, data.availability, data.description, data.location, data.lead_minutes, data.max_participants, index, actorId, now(), now()).changes;
      });
      setSetting(db, guildId, "EVENT_SERIES_SEEDED", now());
    })();
    return created;
  }

  /**
   * Später hinzugekommene Standard-Aktivität einmalig ergänzen (nur wenn es keine mit dem Namen gibt).
   * active: auf Wunsch der Leitung direkt eingeschaltet.
   */
  function addDefaultOnce(guildId, name, { active = false, key, actorId = "system" } = {}) {
    if (!guildId || !getSetting(db, guildId, "EVENT_SERIES_SEEDED") || getSetting(db, guildId, key)) return false;
    const item = DEFAULT_SERIES.find(x => x.name === name);
    return db.transaction(() => {
      setSetting(db, guildId, key, now());
      if (!item || db.prepare("SELECT 1 FROM event_series WHERE guild_id=? AND lower(name)=lower(?)").get(guildId, name)) return false;
      const data = validateSeries({ kind: "scheduled", ...item });
      const order = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 n FROM event_series WHERE guild_id=?").get(guildId).n;
      db.prepare("INSERT INTO event_series(id,guild_id,name,kind,weekdays,times,availability,description,location,lead_minutes,max_participants,active,sort_order,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), guildId, data.name, data.kind, data.weekdays, data.times, data.availability, data.description, data.location, data.lead_minutes, data.max_participants, active ? 1 : 0, order, actorId, now(), now());
      audit(db, guildId, actorId, "event.series_created", null, { name: data.name, schedule: describeSchedule(data), source: "standard" });
      return true;
    })();
  }

  const create = db.transaction(({ guildId, actorId, input }) => {
    const data = validateSeries(input);
    if (db.prepare("SELECT 1 FROM event_series WHERE guild_id=? AND name=?").get(guildId, data.name)) throw new Error("Eine Aktivität mit diesem Namen existiert bereits.");
    const id = randomUUID(), order = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 n FROM event_series WHERE guild_id=?").get(guildId).n;
    db.prepare("INSERT INTO event_series(id,guild_id,name,kind,weekdays,times,availability,description,location,lead_minutes,max_participants,active,sort_order,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, guildId, data.name, data.kind, data.weekdays, data.times, data.availability, data.description, data.location, data.lead_minutes, data.max_participants, input.active ? 1 : 0, order, actorId, now(), now());
    db.prepare("UPDATE event_series SET min_participants=? WHERE id=?").run(data.min_participants, id);
    audit(db, guildId, actorId, "event.series_created", id, { name: data.name, schedule: describeSchedule(data) });
    return get(guildId, id);
  });

  const update = db.transaction(({ guildId, id, actorId, input }) => {
    const old = get(guildId, id);
    if (!old) throw new Error("Aktivität nicht gefunden.");
    const data = validateSeries({ ...old, weekdays: old.weekdays, times: old.times, leadMinutes: old.lead_minutes, maxParticipants: old.max_participants, minParticipants: old.min_participants, ...input });
    if (data.name !== old.name && db.prepare("SELECT 1 FROM event_series WHERE guild_id=? AND name=? AND id<>?").get(guildId, data.name, id)) throw new Error("Eine Aktivität mit diesem Namen existiert bereits.");
    db.prepare("UPDATE event_series SET name=?,kind=?,weekdays=?,times=?,availability=?,description=?,location=?,lead_minutes=?,max_participants=?,updated_at=? WHERE id=?")
      .run(data.name, data.kind, data.weekdays, data.times, data.availability, data.description, data.location, data.lead_minutes, data.max_participants, now(), id);
    db.prepare("UPDATE event_series SET min_participants=? WHERE id=?").run(data.min_participants, id);
    audit(db, guildId, actorId, "event.series_updated", id, { name: data.name, schedule: describeSchedule(data) });
    return get(guildId, id);
  });

  const setActive = db.transaction(({ guildId, id, actorId, active }) => {
    const changed = db.prepare("UPDATE event_series SET active=?,updated_at=? WHERE guild_id=? AND id=? AND active<>? RETURNING *").get(active ? 1 : 0, now(), guildId, id, active ? 1 : 0);
    if (changed) audit(db, guildId, actorId, active ? "event.series_activated" : "event.series_deactivated", id, { name: changed.name });
    return changed ?? get(guildId, id);
  });

  /** Löscht nur die Vorlage; bereits erstellte Events bleiben samt Teilnahme in der Historie. */
  const remove = db.transaction(({ guildId, id, actorId }) => {
    const row = get(guildId, id);
    if (!row) return null;
    db.prepare("DELETE FROM event_series WHERE id=?").run(id);
    audit(db, guildId, actorId, "event.series_deleted", id, { name: row.name });
    return row;
  });

  /**
   * Termine aktiver Serien, deren Ankündigung jetzt fällig ist (Start innerhalb der Vorlaufzeit) und für die
   * noch kein Event existiert. Der Unique-Index (series_id, starts_at) verhindert Doppelungen zusätzlich.
   */
  function dueOccurrences(guildId, timezone, reference = new Date()) {
    const due = [];
    for (const series of db.prepare("SELECT * FROM event_series WHERE guild_id=? AND active=1 AND kind='scheduled'").all(guildId)) {
      const until = new Date(reference.getTime() + series.lead_minutes * 60_000);
      for (const at of occurrencesBetween(series, reference, until, timezone)) {
        if (!db.prepare("SELECT 1 FROM events WHERE series_id=? AND starts_at=?").get(series.id, at.toISOString())) due.push({ series, startsAt: at });
      }
    }
    return due;
  }

  return { list, get, seedDefaults, addDefaultOnce, create, update, setActive, remove, dueOccurrences };
}
