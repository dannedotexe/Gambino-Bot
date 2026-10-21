/**
 * Rang-Rolle erhalten → automatisch auch die allgemeine Familienrolle (erste Rolle aus ROLE_MEMBERS).
 * Rang-Rollen: die eingestellten (RANK_ROLES_JSON) plus Server-Rollen im Gambinos-Schema „| 10 - Boss“.
 */
export const RANK_NAME = /^[\s|]*\d{1,2}\s*-\s*\S/;

export function rankRoleIds(config, guild) {
  const ids = new Set((config.RANK_ROLES_JSON ?? []).map(r => r.roleId));
  guild?.roles?.cache?.forEach?.(role => { if (!role.managed && RANK_NAME.test(role.name ?? "")) ids.add(role.id); });
  return ids;
}

/** Gibt die Familienrolle, wenn eine Rang-Rolle da ist und die Familienrolle fehlt. true = vergeben. */
export async function ensureFamilyRole({ config, member, ranks = rankRoleIds(config, member.guild) }) {
  const family = config.ROLE_MEMBERS ?? [];
  if (!config.FAMILY_ROLE_FROM_RANK || !family.length || member.user?.bot) return false;
  const roles = member.roles?.cache;
  if (!roles || family.some(id => roles.has(id)) || ![...ranks].some(id => roles.has(id))) return false;
  await member.roles.add(family[0], "Rang-Rolle erhalten → Familienrolle");
  return true;
}

/** Beim Start: alle mit Rang-Rolle, denen die Familienrolle fehlt, nachziehen. */
export async function syncFamilyRoles({ config, guild, pauseMs = 1000 }) {
  const ranks = rankRoleIds(config, guild), result = { added: 0, failed: 0 };
  if (!config.FAMILY_ROLE_FROM_RANK || !ranks.size) return result;
  for (const member of guild.members.cache.values()) {
    try { if (await ensureFamilyRole({ config, member, ranks })) { result.added++; await new Promise(r => setTimeout(r, pauseMs)); } }
    catch { result.failed++; }
  }
  return result;
}
