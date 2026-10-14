import { randomUUID } from "node:crypto";
import { audit } from "../database.js";

export const MOD_ACTIONS = {
  timeout: { label: "Timeout", emoji: "🔇" },
  untimeout: { label: "Timeout aufgehoben", emoji: "🔊" },
  kick: { label: "Kick", emoji: "👢" },
  ban: { label: "Bann", emoji: "⛔" },
  unban: { label: "Entbannt", emoji: "✅" },
};

/** Unveränderliche Historie der Moderationsmaßnahmen (Timeout, Kick, Bann) je Mitglied. */
export function createModerationLog(db) {
  function record({ guildId, userId, actorId, action, reason, durationMinutes = null, result = "applied" }) {
    if (!MOD_ACTIONS[action]) throw new Error("Unbekannte Moderationsmaßnahme.");
    const id = randomUUID();
    db.prepare("INSERT INTO moderation_actions(id,guild_id,user_id,actor_id,action,reason,duration_minutes,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, guildId, userId, actorId, action, String(reason).trim(), durationMinutes, result, new Date().toISOString());
    audit(db, guildId, actorId, `moderation.${action}${result === "applied" ? "" : "_failed"}`, userId, { reason: String(reason).trim(), minutes: durationMinutes, result });
    return id;
  }
  const forUser = (guildId, userId, limit = 25) => db.prepare("SELECT * FROM moderation_actions WHERE guild_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(guildId, userId, limit);
  return { record, forUser };
}
