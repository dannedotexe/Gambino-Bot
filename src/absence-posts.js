import { EmbedBuilder } from "discord.js";
import { BRAND_COLOR } from "./presentation.js";
import { formatDay, localDay } from "./services/absences.js";

/** Kurze, öffentliche Meldung im Abmeldungs-Channel. Den Grund zeigt sie nur mit ABSENCE_SHOW_REASON. */
export async function postAbsence({ client, config, row, kind = "created" }) {
  if (!config.CHANNEL_ABSENCES) return false;
  const channel = await client.channels.fetch(config.CHANNEL_ABSENCES).catch(() => null);
  if (!channel?.send) return false;
  const embed = new EmbedBuilder().setColor(kind === "created" ? BRAND_COLOR : 0x2ecc71).setTimestamp()
    .setDescription(kind === "created"
      ? `🚫 <@${row.user_id}> ist abgemeldet: **${formatDay(row.starts_on)} – ${formatDay(row.ends_on)}**${config.ABSENCE_SHOW_REASON ? `\n**Grund:** ${row.reason}` : ""}`
      : `✅ <@${row.user_id}> ist wieder da (Abmeldung bis ${formatDay(row.ends_on)} beendet).`)
    .setFooter({ text: "GAMBINOS  •  Abmeldungen" });
  return channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
}

/**
 * Vergibt ROLE_ABSENT, solange eine Abmeldung läuft, und entfernt sie danach. role_applied merkt sich, wo der Bot
 * die Rolle gesetzt hat; manuell vergebene Rollen ohne Abmeldung bleiben unangetastet.
 */
export async function syncAbsenceRoles({ db, client, config, reference = new Date() }) {
  const guildId = config.DISCORD_GUILD_ID, roles = config.ROLE_ABSENT ?? [];
  if (!guildId || !roles.length) return { added: 0, removed: 0 };
  const today = localDay(reference, config.TIMEZONE);
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { added: 0, removed: 0 };
  let added = 0, removed = 0;
  const start = db.prepare("SELECT * FROM member_absences WHERE guild_id=? AND ended_at IS NULL AND role_applied=0 AND starts_on<=? AND ends_on>=?").all(guildId, today, today);
  for (const row of start) {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (member) for (const roleId of roles) if (!member.roles.cache.has(roleId)) await member.roles.add(roleId, "Gambinos: Abmeldung").then(() => { added++; }).catch(error => console.warn("Abmelde-Rolle nicht vergeben:", error.message));
    db.prepare("UPDATE member_absences SET role_applied=1 WHERE id=?").run(row.id);
  }
  const stop = db.prepare("SELECT * FROM member_absences WHERE guild_id=? AND role_applied=1 AND (ended_at IS NOT NULL OR ends_on<? OR starts_on>?)").all(guildId, today, today);
  for (const row of stop) {
    const stillAbsent = db.prepare("SELECT 1 FROM member_absences WHERE guild_id=? AND user_id=? AND id<>? AND ended_at IS NULL AND starts_on<=? AND ends_on>=?").get(guildId, row.user_id, row.id, today, today);
    if (!stillAbsent) {
      const member = await guild.members.fetch(row.user_id).catch(() => null);
      if (member) for (const roleId of roles) if (member.roles.cache.has(roleId)) await member.roles.remove(roleId, "Gambinos: Abmeldung beendet").then(() => { removed++; }).catch(error => console.warn("Abmelde-Rolle nicht entfernt:", error.message));
    }
    db.prepare("UPDATE member_absences SET role_applied=0 WHERE id=?").run(row.id);
  }
  return { added, removed };
}

const shortClock = (iso, timezone) => new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
/** „Kurz weg“-Meldung im Abmeldungs-Channel; sie wird gelöscht, sobald die Person zurück ist oder die Zeit abläuft. */
export async function postShortAbsence({ client, config, row, service }) {
  if (!config.CHANNEL_ABSENCES) return false;
  const channel = await client.channels.fetch(config.CHANNEL_ABSENCES).catch(() => null);
  if (!channel?.send) return false;
  const until = Math.floor(new Date(row.ends_at).getTime() / 1000);
  const embed = new EmbedBuilder().setColor(0xf39c12).setFooter({ text: "GAMBINOS  •  Kurz weg" })
    .setDescription(`⏱️ <@${row.user_id}> ist **kurz weg** bis **${shortClock(row.ends_at, config.TIMEZONE)}** (<t:${until}:R>)${config.ABSENCE_SHOW_REASON && row.reason ? `\n**Grund:** ${row.reason}` : ""}`);
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  if (sent) service.setMessage(row.id, channel.id, sent.id);
  return Boolean(sent);
}

/** Meldungen beendeter oder abgelaufener „Kurz weg“-Einträge entfernen (hält den Channel sauber). */
export async function cleanupShortAbsencePosts({ client, config, service, reference = new Date() }) {
  let removed = 0;
  for (const row of service.withStaleMessage(config.DISCORD_GUILD_ID, reference)) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    const message = await channel?.messages?.fetch(row.message_id).catch(() => null);
    await message?.delete?.().catch(() => {});
    service.clearMessage(row.id);
    removed++;
  }
  return removed;
}
