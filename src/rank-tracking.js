import { AuditLogEvent } from "discord.js";
import { createRankHistory, rankChange, rankFor } from "./services/ranks.js";

/**
 * Erkennt Rangänderungen an Discord-Rollen (Rang-Rollen aus RANK_ROLES_JSON) und protokolliert sie.
 * Wer die Rolle geändert hat, wird – falls der Bot das Audit-Log lesen darf – aus dem Discord-Audit-Log ermittelt.
 */
export async function trackRankChange({ db, config, oldMember, newMember }) {
  const ranks = config.RANK_ROLES_JSON ?? [];
  if (!ranks.length || oldMember?.partial || newMember.user?.bot) return null;
  if (config.DISCORD_GUILD_ID && newMember.guild.id !== config.DISCORD_GUILD_ID) return null;
  const position = id => newMember.guild.roles?.cache?.get(id)?.position ?? null;
  const before = rankFor([...oldMember.roles.cache.keys()], ranks, position), after = rankFor([...newMember.roles.cache.keys()], ranks, position);
  const change = rankChange(before, after);
  if (!change) return null;
  let actorId = null;
  const logs = await newMember.guild.fetchAuditLogs?.({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 }).catch(() => null);
  const entry = logs?.entries?.find?.(e => e.target?.id === newMember.id && Date.now() - e.createdTimestamp < 30_000);
  if (entry?.executor?.id) actorId = entry.executor.id;
  const reason = entry?.reason ?? "";
  createRankHistory(db).record({ guildId: newMember.guild.id, userId: newMember.id, actorId, ...change, reason, source: actorId && actorId === newMember.client?.user?.id ? "bot" : "discord" });
  return change;
}
