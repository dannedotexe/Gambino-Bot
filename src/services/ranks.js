import { randomUUID } from "node:crypto";
import { audit } from "../database.js";

/**
 * Rang aus den Rollen einer Person: die höchste konfigurierte Rang-Rolle (RANK_ROLES_JSON). Höher heißt höhere
 * Discord-Position; ohne Positionsangabe gilt die Reihenfolge der Liste (spätere Einträge = höherer Rang).
 */
export function rankFor(roleIds, ranks, positionOf = () => null) {
  const held = ranks.map((rank, index) => ({ ...rank, index, position: positionOf(rank.roleId) })).filter(rank => roleIds.includes(rank.roleId));
  if (!held.length) return null;
  return held.sort((a, b) => (b.position ?? b.index) - (a.position ?? a.index))[0];
}

/** Vergleicht zwei Rang-Stände. null = keine Rangänderung. */
export function rankChange(before, after) {
  if ((before?.roleId ?? null) === (after?.roleId ?? null)) return null;
  const level = rank => rank ? (rank.position ?? rank.index) : -1;
  const kind = level(after) > level(before) ? "promotion" : level(after) < level(before) ? "demotion" : "change";
  return { from: before?.label ?? null, to: after?.label ?? null, kind };
}

export function createRankHistory(db) {
  function record({ guildId, userId, actorId = null, from = null, to = null, kind = "change", reason = "", source = "discord" }) {
    if (!["promotion", "demotion", "change"].includes(kind)) throw new Error("Ungültige Art der Rangänderung.");
    if ((from ?? "") === (to ?? "")) throw new Error("Alter und neuer Rang sind gleich.");
    const id = randomUUID();
    db.prepare("INSERT INTO rank_changes(id,guild_id,user_id,actor_id,from_label,to_label,kind,reason,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, guildId, userId, actorId, from, to, kind, String(reason ?? "").trim().slice(0, 300), source, new Date().toISOString());
    audit(db, guildId, actorId ?? "system", `rank.${kind}`, userId, { previous: from ?? "—", value: to ?? "—", reason: String(reason ?? "").trim() || "—", source });
    return id;
  }
  const forUser = (guildId, userId, limit = 30) => db.prepare("SELECT * FROM rank_changes WHERE guild_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(guildId, userId, limit);
  const recent = (guildId, { since = null, limit = 50 } = {}) => db.prepare(`SELECT * FROM rank_changes WHERE guild_id=? ${since ? "AND created_at>=?" : ""} ORDER BY created_at DESC LIMIT ?`).all(...[guildId, ...(since ? [since] : []), limit]);
  return { record, forUser, recent };
}
