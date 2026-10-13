import { audit } from "../database.js";

const ACTIVE_PARTICIPATION = "('signed_up','present')";
const now = () => new Date().toISOString();

/** Teilnahmelogik für Familien-Events. Alle Änderungen laufen atomar und sind gegen doppelte Klicks geschützt. */
export function createEventService(db) {
  const participants = eventId =>
    db.prepare(`SELECT user_id,status FROM event_participants WHERE event_id=? AND status IN ${ACTIVE_PARTICIPATION} ORDER BY updated_at,user_id`).all(eventId);

  const join = db.transaction(({ guildId, eventId, userId }) => {
    const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(eventId, guildId);
    if (!event) return { status: "closed" };
    const current = db.prepare("SELECT status FROM event_participants WHERE event_id=? AND user_id=?").get(eventId, userId);
    if (current && ["signed_up", "present"].includes(current.status)) return { status: "already", event };
    const count = db.prepare(`SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status IN ${ACTIVE_PARTICIPATION}`).get(eventId).n;
    if (event.max_participants && count >= event.max_participants) return { status: "full", event };
    db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,'signed_up',?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='signed_up',updated_at=excluded.updated_at").run(eventId, userId, now());
    audit(db, guildId, userId, "event.participation", userId, { eventId, status: "signed_up" });
    return { status: "joined", event };
  });

  const leave = db.transaction(({ guildId, eventId, userId }) => {
    const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(eventId, guildId);
    if (!event) return { status: "closed" };
    const changed = db.prepare(`UPDATE event_participants SET status='left',updated_at=? WHERE event_id=? AND user_id=? AND status IN ${ACTIVE_PARTICIPATION}`).run(now(), eventId, userId).changes;
    if (!changed) return { status: "not_joined", event };
    audit(db, guildId, userId, "event.participation", userId, { eventId, status: "left" });
    return { status: "left", event };
  });

  /** Staff dokumentiert Anwesenheit; auch Mitglieder ohne vorherige Anmeldung können erfasst werden. */
  const setAttendance = db.transaction(({ guildId, eventId, userId, status, actorId }) => {
    if (!["present", "absent"].includes(status)) throw new Error("Ungültiger Anwesenheitsstatus.");
    const event = db.prepare("SELECT id,name FROM events WHERE id=? AND guild_id=? AND status IN ('scheduled','ended')").get(eventId, guildId);
    if (!event) return null;
    const previous = db.prepare("SELECT status FROM event_participants WHERE event_id=? AND user_id=?").get(eventId, userId)?.status ?? null;
    db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at").run(eventId, userId, status, now());
    audit(db, guildId, actorId, "event.attendance", userId, { eventId, status, previous });
    return { event, previous };
  });

  return { participants, join, leave, setAttendance };
}
