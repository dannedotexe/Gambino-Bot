import { ChannelType, PermissionFlagsBits } from "discord.js";

// Layout from page 2 of Gambinos Bot Idee.pdf. The duplicate "bewerbungen"
// channels intentionally live in different categories.
export const CHANNEL_LAYOUT = [
  { name: "INFORMATION", channels: ["willkommen", "regeln", "sanktionsliste", "ankündigungen", "neue-spieler"] },
  { name: "EVENTS", channels: ["event-infos", "event-ankündigungen", "event-anmeldung", "event-ergebnisse", "event-logs"] },
  { name: "COMMUNITY", channels: ["chat", "abstimmungen", "giveaway", "marktplatz", "kleidung"] },
  { name: "SUPPORT", channels: ["ticket", "bewerbungen", "rang-anträge", "abmeldungen"] },
  { name: "STAFF", channels: ["staff-dashboard", "bewerbungen", "sanktions-logs", "ticket-logs", "auszahlungen", "server-statistik"] },
];

export const CHANNEL_BINDINGS = {
  CHANNEL_TICKET_CATEGORY: ["SUPPORT", null],
  CHANNEL_TICKET_LOG: ["STAFF", "ticket-logs"],
  CHANNEL_APPLICATION_REVIEW: ["STAFF", "bewerbungen"],
  CHANNEL_EVENT_ANNOUNCEMENTS: ["EVENTS", "event-ankündigungen"],
  CHANNEL_AUDIT_LOG: ["STAFF", "sanktions-logs"],
  CHANNEL_AUTOMOD_LOG: ["STAFF", "sanktions-logs"],
  CHANNEL_STATS: ["STAFF", "server-statistik"],
};

export function bindCreatedChannels(db, guildId, config, categories, channels) {
  const values = {};
  for (const [key, [categoryName, channelName]] of Object.entries(CHANNEL_BINDINGS)) {
    const categoryId = categories.get(categoryName)?.id;
    const channelId = channelName ? channels.get(`${categoryName}/${channelName}`)?.id : categoryId;
    if (channelId) values[key] = channelId;
  }
  const save = db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) save.run(guildId, key, value, new Date().toISOString());
  })();
  Object.assign(config, values);
  return values;
}

export function loadChannelBindings(db, guildId, config) {
  if (!guildId) return;
  const rows = db.prepare("SELECT key,value FROM guild_settings WHERE guild_id=?").all(guildId);
  for (const { key, value } of rows) if (Object.hasOwn(CHANNEL_BINDINGS, key)) config[key] = value;
}

export async function createMissingChannels(guild, config, clientUserId) {
  const permissions = guild.members.me?.permissions;
  if (!permissions?.has(PermissionFlagsBits.ManageChannels)) throw new Error("Dem Bot fehlt die Berechtigung „Channels verwalten“. Es wurde nichts angelegt.");
  const categories = new Map();
  const channels = new Map();
  const created = [];
  const failed = [];
  const existing = await guild.channels.fetch();
  const staffRoles = [...new Set([...(config.ROLE_LEADERS ?? []), ...(config.ROLE_STAFF ?? []), ...(config.ROLE_FINANCE ?? []), ...(config.ROLE_REVIEWERS ?? []), ...(config.ROLE_EVENT_TEAM ?? [])])];
  for (const group of CHANNEL_LAYOUT) {
    let category = existing.find(c => c.type === ChannelType.GuildCategory && c.name === group.name);
    if (!category) {
      const permissionOverwrites = group.name === "STAFF" ? [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: clientUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ...staffRoles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ] : undefined;
      try {
        category = await guild.channels.create({ name: group.name, type: ChannelType.GuildCategory, permissionOverwrites });
        created.push(`Kategorie ${group.name}`);
      } catch (error) {
        failed.push(`Kategorie ${group.name}: ${error.message}`);
        continue;
      }
    }
    if (group.name === "STAFF") {
      const everyoneOverwrite = category.permissionOverwrites?.cache?.get(guild.roles.everyone.id);
      if (!everyoneOverwrite?.deny?.has(PermissionFlagsBits.ViewChannel)) {
        failed.push("Kategorie STAFF: Bereits vorhanden und nicht privat; aus Sicherheitsgründen wurden darin keine fehlenden Staff-Channels angelegt.");
        categories.set(group.name, category);
        continue;
      }
    }
    categories.set(group.name, category);
    for (const name of group.channels) {
      const key = `${group.name}/${name}`;
      let channel = existing.find(c => c.type === ChannelType.GuildText && c.parentId === category.id && c.name === name);
      if (!channel) {
        try {
          channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id });
          created.push(`${group.name} / #${name}`);
        } catch (error) {
          failed.push(`${group.name} / #${name}: ${error.message}`);
          continue;
        }
      }
      channels.set(key, channel);
    }
  }
  return { categories, channels, created, failed, staffRolesConfigured: staffRoles.length > 0 };
}
