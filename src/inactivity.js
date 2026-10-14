import { EmbedBuilder } from "discord.js";
import { audit, getSetting, setSetting } from "./database.js";
import { logEmbed } from "./presentation.js";
import { createAbsenceService, localDay } from "./services/absences.js";
import { createActivityService } from "./services/activity.js";

const LAST_RUN_KEY = "INACTIVITY_LAST_RUN";

/**
 * Wer bei der Inaktivitätsprüfung zählt: alle mit Familienmitglieder-Rolle (ROLE_MEMBERS). Ohne diese Rolle
 * alle Personen mit Familienkonto, die noch auf dem Server sind. Bots zählen nie.
 */
export async function familyMembers({ db, guild, config }) {
  const all = await guild.members.fetch().catch(() => guild.members.cache);
  const roles = config.ROLE_MEMBERS ?? [];
  const accounts = roles.length ? null : new Set(db.prepare("SELECT user_id FROM accounts WHERE guild_id=?").all(guild.id).map(r => r.user_id));
  return [...all.values()].filter(m => !m.user?.bot && (roles.length ? roles.some(id => m.roles.cache.has(id)) : accounts.has(m.id)))
    .map(m => ({ id: m.id, name: m.displayName ?? m.user?.username, joinedAt: m.joinedAt ?? null }));
}

export function inactivityFor({ db, config, guildId, members, reference = new Date() }) {
  const absences = createAbsenceService(db), activity = createActivityService(db);
  return activity.inactivityReport(guildId, members, { days: config.INACTIVITY_DAYS, absentIds: absences.absentUserIds(guildId, localDay(reference, config.TIMEZONE)), reference });
}

/** Erinnert eine inaktive Person per DM und merkt sich den Zeitpunkt. */
export async function remindInactive({ db, client, config, guildId, userId, actorId, days }) {
  const embed = new EmbedBuilder().setColor(0xe67e22).setAuthor({ name: "GAMBINOS  •  AKTIVITÄT" }).setTitle("👋 Wir vermissen dich!")
    .setDescription(`Du warst seit **${days} Tagen** weder im Discord aktiv noch bei einem Familien-Event.\n\nAlles okay? Wenn du eine Pause brauchst, melde dich bitte kurz ab (\`/abwesend melden\` oder Abmeldungs-Panel). Dann zählst du nicht als inaktiv.`)
    .setFooter({ text: "GAMBINOS  •  Automatische Erinnerung" }).setTimestamp();
  const sent = await client.users.fetch(userId).then(user => user.send({ embeds: [embed] })).then(() => true).catch(() => false);
  createActivityService(db).markNotified(guildId, userId);
  audit(db, guildId, actorId, "activity.reminder", userId, { days, result: sent ? "sent" : "dm_closed" });
  return sent;
}

/** Tägliche Prüfung (einmal pro Kalendertag): optionale DM-Erinnerung und Meldung an die Leitung. */
export async function runDailyInactivity({ db, client, config, reference = new Date() }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId || (!config.INACTIVITY_DM_ENABLED && !config.INACTIVITY_ALERT_ENABLED)) return null;
  const day = localDay(reference, config.TIMEZONE);
  if (getSetting(db, guildId, LAST_RUN_KEY) === day) return null;
  setSetting(db, guildId, LAST_RUN_KEY, day);
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const report = inactivityFor({ db, config, guildId, members: await familyMembers({ db, guild, config }), reference }).filter(r => r.inactive);
  const remindBefore = new Date(reference.getTime() - config.INACTIVITY_DAYS * 86_400_000).toISOString();
  const fresh = report.filter(r => !r.notifiedAt || r.notifiedAt < remindBefore);
  let reminded = 0;
  if (config.INACTIVITY_DM_ENABLED) {
    for (const row of fresh.slice(0, 50)) {
      if (await remindInactive({ db, client, config, guildId, userId: row.userId, actorId: client.user?.id ?? "system", days: row.inactiveDays })) reminded++;
    }
  } else {
    // Ohne DM nur merken, damit dieselben Personen nicht jeden Tag erneut gemeldet werden.
    for (const row of fresh) createActivityService(db).markNotified(guildId, row.userId, reference);
  }
  if (config.INACTIVITY_ALERT_ENABLED && fresh.length) {
    const channelId = config.CHANNEL_ACTIVITY_LOG || config.CHANNEL_AUDIT_LOG;
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    const list = fresh.slice(0, 30).map(r => `<@${r.userId}> · seit ${r.inactiveDays} Tagen`).join("\n");
    await channel?.send?.({ embeds: [logEmbed(`💤 ${fresh.length} neu inaktive Mitglieder`, `Kein Chat und kein Event seit mindestens ${config.INACTIVITY_DAYS} Tagen, nicht abgemeldet.${config.INACTIVITY_DM_ENABLED ? `\n${reminded} per DM erinnert.` : ""}\n\n${list}${fresh.length > 30 ? `\n… und ${fresh.length - 30} weitere (siehe Website → Aktivität)` : ""}`, "warning")], allowedMentions: { parse: [] } }).catch(() => {});
  }
  return { inactive: report.length, fresh: fresh.length, reminded };
}
