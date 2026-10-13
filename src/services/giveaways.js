import { randomInt } from "node:crypto";
import { audit } from "../database.js";

const now = () => new Date().toISOString();

/** Giveaway-Logik. Ziehung erfolgt genau einmal: nur der Statuswechsel active -> ended darf auslosen. */
export function createGiveawayService(db, { random = randomInt } = {}) {
  const entryCount = id => db.prepare("SELECT COUNT(*) n FROM giveaway_entries WHERE giveaway_id=?").get(id).n;

  const join = db.transaction(({ guildId, giveawayId, userId, memberRoleIds = [] }) => {
    const giveaway = db.prepare("SELECT * FROM giveaways WHERE id=? AND guild_id=?").get(giveawayId, guildId);
    if (!giveaway || giveaway.status !== "active" || new Date(giveaway.ends_at) <= new Date()) return { status: "closed", giveaway };
    if (giveaway.required_role_id && !memberRoleIds.includes(giveaway.required_role_id)) return { status: "missing_role", giveaway };
    const inserted = db.prepare("INSERT OR IGNORE INTO giveaway_entries(giveaway_id,user_id,created_at) VALUES(?,?,?)").run(giveawayId, userId, now()).changes;
    if (!inserted) return { status: "already", giveaway };
    audit(db, guildId, userId, "giveaway.entry", giveawayId, { status: "joined" });
    return { status: "joined", giveaway };
  });

  const leave = db.transaction(({ guildId, giveawayId, userId }) => {
    const giveaway = db.prepare("SELECT * FROM giveaways WHERE id=? AND guild_id=?").get(giveawayId, guildId);
    if (!giveaway || giveaway.status !== "active" || new Date(giveaway.ends_at) <= new Date()) return { status: "closed", giveaway };
    // giveaway_entries ist absichtlich nicht append-only: nur aktive Teilnahmen zählen für die Ziehung.
    const removed = db.prepare("DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=?").run(giveawayId, userId).changes;
    if (!removed) return { status: "not_joined", giveaway };
    audit(db, guildId, userId, "giveaway.entry", giveawayId, { status: "left" });
    return { status: "left", giveaway };
  });

  /** Beendet ein aktives Giveaway und zieht Gewinner. Gibt null zurück, wenn es bereits beendet/abgebrochen ist. */
  const draw = db.transaction(giveawayId => {
    const row = db.prepare("SELECT * FROM giveaways WHERE id=?").get(giveawayId);
    if (!row) return null;
    const changed = db.prepare("UPDATE giveaways SET status='ended',ended_at=? WHERE id=? AND status='active'").run(now(), giveawayId).changes;
    if (!changed) return null;
    const participants = db.prepare("SELECT user_id FROM giveaway_entries WHERE giveaway_id=? ORDER BY user_id").all(giveawayId).map(x => x.user_id);
    for (let n = participants.length - 1; n > 0; n--) { const j = random(n + 1); [participants[n], participants[j]] = [participants[j], participants[n]]; }
    const winners = participants.slice(0, row.winner_count);
    db.prepare("UPDATE giveaways SET winners=? WHERE id=?").run(JSON.stringify(winners), giveawayId);
    audit(db, row.guild_id, row.created_by, "giveaway.ended", giveawayId, { prize: row.prize, winnerIds: winners, entries: participants.length });
    return { winners, entries: participants.length };
  });

  const cancel = db.transaction(({ guildId, giveawayId, actorId, reason = "" }) => {
    const row = db.prepare("UPDATE giveaways SET status='cancelled',ended_at=? WHERE id=? AND guild_id=? AND status='active' RETURNING *").get(now(), giveawayId, guildId);
    if (!row) return null;
    audit(db, guildId, actorId, "giveaway.cancelled", giveawayId, { prize: row.prize, entries: entryCount(giveawayId), reason });
    return row;
  });

  return { entryCount, join, leave, draw, cancel };
}
