import { audit } from "../database.js";

const ACTIVE_PARTICIPATION = "('signed_up','present')";
const now = () => new Date().toISOString();

/** Teilnahmelogik für Familien-Events. Alle Änderungen laufen atomar und sind gegen doppelte Klicks geschützt. */
export function createEventService(db) {
  const participants = eventId =>
    db.prepare(`SELECT user_id,status FROM event_participants WHERE event_id=? AND status IN ${ACTIVE_PARTICIPATION} ORDER BY updated_at,user_id`).all(eventId);

  /**
   * Anmelden. overlapMinutes > 0: bei gleichzeitigen Events (Beginn so nah beieinander) wird man dort abgemeldet –
   * man kann nur bei einem dabei sein. switched = [{ event, promoted }] der verlassenen Events.
   */
  const join = db.transaction(({ guildId, eventId, userId, overlapMinutes = 0 }) => {
    const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled' AND signup_closed_at IS NULL").get(eventId, guildId);
    if (!event) return { status: "closed" };
    const current = db.prepare("SELECT status FROM event_participants WHERE event_id=? AND user_id=?").get(eventId, userId);
    if (current && ["signed_up", "present"].includes(current.status)) return { status: "already", event };
    const count = db.prepare(`SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status IN ${ACTIVE_PARTICIPATION}`).get(eventId).n;
    // Voll: auf die Warteliste; wer absagt, macht Platz für den Ersten auf der Liste.
    if (event.max_participants && count >= event.max_participants) {
      const waiting = db.prepare("INSERT OR IGNORE INTO event_waitlist(event_id,user_id,created_at) VALUES(?,?,?)").run(eventId, userId, now()).changes;
      if (waiting) audit(db, guildId, userId, "event.participation", userId, { eventId, status: "waitlist" });
      return { status: waiting ? "waitlisted" : "already_waiting", event, position: waitlistPosition(eventId, userId) };
    }
    db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,'signed_up',?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='signed_up',updated_at=excluded.updated_at").run(eventId, userId, now());
    audit(db, guildId, userId, "event.participation", userId, { eventId, status: "signed_up" });
    const switched = [];
    if (overlapMinutes > 0) {
      const others = db.prepare(`SELECT e.* FROM events e JOIN event_participants p ON p.event_id=e.id WHERE e.guild_id=? AND e.id<>? AND e.status='scheduled' AND e.signup_closed_at IS NULL
        AND p.user_id=? AND p.status IN ${ACTIVE_PARTICIPATION} AND ABS(strftime('%s',e.starts_at)-strftime('%s',?))<?`).all(guildId, eventId, userId, event.starts_at, overlapMinutes * 60);
      for (const other of others) {
        db.prepare(`UPDATE event_participants SET status='left',updated_at=? WHERE event_id=? AND user_id=? AND status IN ${ACTIVE_PARTICIPATION}`).run(now(), other.id, userId);
        audit(db, guildId, userId, "event.participation", userId, { eventId: other.id, status: "left", reason: `gewechselt zu ${event.name}` });
        switched.push({ event: other, promoted: promote(other) });
      }
      // Auch von Wartelisten gleichzeitiger Events herunter.
      for (const other of db.prepare(`SELECT e.* FROM events e JOIN event_waitlist w ON w.event_id=e.id WHERE w.user_id=? AND e.guild_id=? AND e.id<>? AND e.status='scheduled' AND ABS(strftime('%s',e.starts_at)-strftime('%s',?))<?`).all(userId, guildId, eventId, event.starts_at, overlapMinutes * 60)) {
        db.prepare("DELETE FROM event_waitlist WHERE event_id=? AND user_id=?").run(other.id, userId);
        switched.push({ event: other, promoted: [], waitlist: true });
      }
    }
    return { status: "joined", event, switched };
  });

  const leave = db.transaction(({ guildId, eventId, userId }) => {
    const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(eventId, guildId);
    if (!event) return { status: "closed" };
    if (db.prepare("DELETE FROM event_waitlist WHERE event_id=? AND user_id=?").run(eventId, userId).changes) {
      audit(db, guildId, userId, "event.participation", userId, { eventId, status: "waitlist_left" });
      return { status: "left_waitlist", event };
    }
    const changed = db.prepare(`UPDATE event_participants SET status='left',updated_at=? WHERE event_id=? AND user_id=? AND status IN ${ACTIVE_PARTICIPATION}`).run(now(), eventId, userId).changes;
    if (!changed) return { status: "not_joined", event };
    audit(db, guildId, userId, "event.participation", userId, { eventId, status: "left" });
    return { status: "left", event, promoted: promote(event) };
  });

  const waitlistPosition = (eventId, userId) => {
    const ids = db.prepare("SELECT user_id FROM event_waitlist WHERE event_id=? ORDER BY created_at,user_id").all(eventId).map(r => r.user_id);
    return ids.indexOf(userId) + 1;
  };
  const waitlist = eventId => db.prepare("SELECT user_id FROM event_waitlist WHERE event_id=? ORDER BY created_at,user_id").all(eventId).map(r => r.user_id);
  /** Freie Plätze mit Wartenden auffüllen (z. B. nach Absage oder höherem Limit). Gibt die Nachgerückten zurück. */
  function promote(event) {
    const promoted = [];
    for (;;) {
      const count = db.prepare(`SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status IN ${ACTIVE_PARTICIPATION}`).get(event.id).n;
      if (event.max_participants && count >= event.max_participants) break;
      const next = db.prepare("SELECT user_id FROM event_waitlist WHERE event_id=? ORDER BY created_at,user_id LIMIT 1").get(event.id);
      if (!next) break;
      db.prepare("DELETE FROM event_waitlist WHERE event_id=? AND user_id=?").run(event.id, next.user_id);
      db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,'signed_up',?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='signed_up',updated_at=excluded.updated_at").run(event.id, next.user_id, now());
      audit(db, event.guild_id, next.user_id, "event.participation", next.user_id, { eventId: event.id, status: "promoted" });
      promoted.push(next.user_id);
    }
    return promoted;
  }
  const fillFromWaitlist = db.transaction(eventId => { const event = db.prepare("SELECT * FROM events WHERE id=? AND status='scheduled'").get(eventId); return event ? promote(event) : []; });

  /** Staff dokumentiert Anwesenheit; auch Mitglieder ohne vorherige Anmeldung können erfasst werden. */
  const setAttendance = db.transaction(({ guildId, eventId, userId, status, actorId }) => {
    if (!["present", "absent"].includes(status)) throw new Error("Ungültiger Anwesenheitsstatus.");
    const event = db.prepare("SELECT id,name,starts_at FROM events WHERE id=? AND guild_id=? AND status IN ('scheduled','ended')").get(eventId, guildId);
    if (!event) return null;
    const previous = db.prepare("SELECT status FROM event_participants WHERE event_id=? AND user_id=?").get(eventId, userId)?.status ?? null;
    db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at").run(eventId, userId, status, now());
    audit(db, guildId, actorId, "event.attendance", userId, { eventId, status, previous });
    return { event, previous };
  });

  return { participants, join, leave, setAttendance, waitlist, waitlistPosition, fillFromWaitlist };
}
