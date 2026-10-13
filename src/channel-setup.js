import { ChannelType, PermissionFlagsBits } from "discord.js";

// Layout from page 2 of Gambinos Bot Idee.pdf. The duplicate "bewerbungen"
// channels intentionally live in different categories.
export const CHANNEL_LAYOUT = [
  { name: "INFORMATION", emoji: "📌", channels: [{name:"willkommen",emoji:"👋"},{name:"regeln",emoji:"📜"},{name:"sanktionsliste",emoji:"⚖️"},{name:"ankündigungen",emoji:"📢"},{name:"neue-spieler",emoji:"🆕"}] },
  { name: "EVENTS", emoji: "🔮", channels: [{name:"event-infos",emoji:"📅"},{name:"event-ankündigungen",emoji:"📢"},{name:"event-anmeldung",emoji:"🎟️"},{name:"event-ergebnisse",emoji:"🏆"},{name:"event-logs",emoji:"📊"}] },
  { name: "COMMUNITY", emoji: "☁️", channels: [{name:"chat",emoji:"💬"},{name:"abstimmungen",emoji:"🗳️"},{name:"giveaway",emoji:"🎁"},{name:"marktplatz",emoji:"🛒"},{name:"kleidung",emoji:"👕"}] },
  { name: "SUPPORT", emoji: "🆘", channels: [{name:"ticket",emoji:"🎫",topic:"Gambinos Support · Wähle das Ticket-Panel unten aus, um ein privates Anliegen beim zuständigen Team zu eröffnen."},{name:"bewerbungen",emoji:"📄"},{name:"rang-anträge",emoji:"📝"},{name:"abmeldungen",emoji:"🚫"}] },
  { name: "STAFF", emoji: "👔", channels: [{name:"staff-dashboard",emoji:"📋"},{name:"bewerbungen",emoji:"📄"},{name:"rang-anträge",emoji:"📝"},{name:"sanktions-logs",emoji:"⚠️"},{name:"ticket-logs",emoji:"🗂️"},{name:"auszahlungen",emoji:"💰"},{name:"server-statistik",emoji:"📊"},{name:"bot-logs",emoji:"🧾"}] },
];

export const displayCategoryName = group => `${group.emoji}・${group.name}`;
export const displayChannelName = channel => `${channel.emoji}・${channel.name}`;

// Funktion -> [Kategorie, Channel] im Gambinos-Layout. Wird für Empfehlungen und /einstellungen kanal genutzt.
export const CHANNEL_BINDINGS = {
  CHANNEL_VERIFICATION_PANEL: ["INFORMATION", "neue-spieler"],
  CHANNEL_TICKET_PANEL: ["SUPPORT", "ticket"],
  CHANNEL_TICKET_CATEGORY: ["SUPPORT", null],
  CHANNEL_TICKET_CLOSED_CATEGORY: ["closed tickets", null],
  CHANNEL_TICKET_LOG: ["STAFF", "ticket-logs"],
  CHANNEL_APPLICATION_PANEL: ["SUPPORT", "bewerbungen"],
  CHANNEL_APPLICATION_REVIEW: ["STAFF", "bewerbungen"],
  CHANNEL_RANK_REVIEW: ["STAFF", "rang-anträge"],
  CHANNEL_EVENT_ANNOUNCEMENTS: ["EVENTS", "event-ankündigungen"],
  CHANNEL_ACTIVITY_BOARD: ["EVENTS", "event-infos"],
  CHANNEL_EVENT_RESULTS: ["EVENTS", "event-ergebnisse"],
  CHANNEL_EVENT_LOG: ["EVENTS", "event-logs"],
  CHANNEL_GIVEAWAYS: ["COMMUNITY", "giveaway"],
  CHANNEL_STAFF_DASHBOARD: ["STAFF", "staff-dashboard"],
  CHANNEL_SANCTION_LOG: ["STAFF", "sanktions-logs"],
  CHANNEL_FINANCE_LOG: ["STAFF", "auszahlungen"],
  CHANNEL_STATS: ["STAFF", "server-statistik"],
  CHANNEL_AUDIT_LOG: ["STAFF", "bot-logs"],
  CHANNEL_AUTOMOD_LOG: ["STAFF", "bot-logs"],
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
    const categoryName = displayCategoryName(group);
    let category = existing.find(c => c.type === ChannelType.GuildCategory && [group.name,categoryName].includes(c.name));
    if (!category) {
      const permissionOverwrites = group.name === "STAFF" ? [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: clientUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ...staffRoles.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ] : undefined;
      try {
        category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory, permissionOverwrites });
        created.push(`Kategorie ${group.name}`);
      } catch (error) {
        failed.push(`Kategorie ${group.name}: ${error.message}`);
        continue;
      }
    }
    if (category.name !== categoryName) {
      try {
        await category.setName(categoryName);
        created.push(`Kategorie ${group.name} mit Emoji versehen`);
      } catch (error) {
        failed.push(`Kategorie ${group.name} konnte nicht formatiert werden: ${error.message}`);
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
    for (const channelSpec of group.channels) {
      const {name} = channelSpec;
      const channelName = displayChannelName(channelSpec);
      const key = `${group.name}/${name}`;
      let channel = existing.find(c => c.type === ChannelType.GuildText && c.parentId === category.id && [name,channelName].includes(c.name));
      if (!channel) {
        try {
          channel = await guild.channels.create({ name:channelName, type: ChannelType.GuildText, parent: category.id });
          created.push(`${group.name} / #${name}`);
        } catch (error) {
          failed.push(`${group.name} / #${name}: ${error.message}`);
          continue;
        }
      } else if (channel.name !== channelName) {
        try {
          await channel.setName(channelName);
          created.push(`${group.name} / #${name} mit Emoji versehen`);
        } catch (error) {
          failed.push(`${group.name} / #${name} konnte nicht formatiert werden: ${error.message}`);
        }
      }
      if (channelSpec.topic && channel.topic !== channelSpec.topic) {
        try {
          await channel.setTopic(channelSpec.topic);
          created.push(`${group.name} / #${name} mit Beschreibung versehen`);
        } catch (error) {
          failed.push(`${group.name} / #${name} Beschreibung konnte nicht aktualisiert werden: ${error.message}`);
        }
      }
      channels.set(key, channel);
    }
  }
  return { categories, channels, created, failed, staffRolesConfigured: staffRoles.length > 0 };
}
