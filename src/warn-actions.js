import { EmbedBuilder } from "discord.js";
import { audit } from "./database.js";
import { accessGroups } from "./config.js";
import { logEmbed } from "./presentation.js";
import { warningEscalation } from "./services/warnings.js";

/**
 * Folgen einer gespeicherten Verwarnung in Discord: DM an die Person, optionaler Timeout und
 * Meldung an die Leitung. Jeder Schritt ist unabhängig; Fehler werden zurückgegeben, nie geworfen,
 * damit die bereits gespeicherte Verwarnung bestehen bleibt.
 */
export async function deliverWarning({ db, client, config, guildId, userId, actorId, reason, caseRef = null, warning }) {
  const result = { dm: false, timeout: null, alert: false };
  const active = warning.active;
  const expiry = config.WARN_EXPIRE_DAYS > 0 ? `Verwarnungen verfallen nach ${config.WARN_EXPIRE_DAYS} Tagen.` : null;

  if (config.WARN_DM_ENABLED) {
    const dm = new EmbedBuilder().setColor(0xe67e22).setAuthor({ name: "GAMBINOS  •  VERWARNUNG" }).setTitle("⚠️ Du wurdest verwarnt")
      .setDescription(`**Grund:** ${reason}${caseRef ? `\n**Fallbezug:** ${caseRef}` : ""}`)
      .addFields({ name: "Aktive Verwarnungen", value: String(active), inline: true }, { name: "Referenz", value: `\`${warning.id.slice(0, 8)}\``, inline: true })
      .setFooter({ text: `GAMBINOS  •  Bei Fragen öffne ein Ticket.${expiry ? ` ${expiry}` : ""}` }).setTimestamp();
    result.dm = await client.users.fetch(userId).then(user => user.send({ embeds: [dm] })).then(() => true).catch(() => false);
  }

  const escalation = warningEscalation(config, active);
  if (escalation.timeout) {
    const guild = client.guilds?.cache?.get(guildId) ?? await client.guilds?.fetch?.(guildId).catch(() => null);
    const member = await guild?.members?.fetch(userId).catch(() => null);
    if (member?.moderatable) {
      const minutes = config.WARN_TIMEOUT_MINUTES;
      result.timeout = await member.timeout(minutes * 60_000, `Gambinos: ${active} aktive Verwarnungen`).then(() => "applied").catch(() => "failed");
    } else result.timeout = "failed";
    audit(db, guildId, actorId, result.timeout === "applied" ? "sanction.warning_timeout" : "sanction.warning_timeout_failed", userId, { warningId: warning.id, activeWarnings: active, minutes: config.WARN_TIMEOUT_MINUTES });
  }

  if (escalation.alert) {
    const channelId = config.CHANNEL_SANCTION_LOG || config.CHANNEL_AUDIT_LOG;
    const channel = channelId ? await client.channels?.fetch?.(channelId).catch(() => null) : null;
    if (channel?.send) {
      const leaders = accessGroups(config).leaders;
      result.alert = await channel.send({
        content: leaders.map(id => `<@&${id}>`).join(" ") || undefined,
        embeds: [logEmbed("🚨 Verwarnungsgrenze erreicht", `<@${userId}> hat jetzt **${active} aktive Verwarnungen**.\n**Letzter Grund:** ${reason}\n**Verwarnt von:** <@${actorId}>`, "warning")],
        allowedMentions: { roles: leaders },
      }).then(() => true).catch(() => false);
    }
  }
  return result;
}

/** Kurzer Text für Staff, was nach der Verwarnung passiert ist. */
export function deliverySummary(result, config) {
  const parts = [];
  if (config.WARN_DM_ENABLED) parts.push(result.dm ? "Person per DM informiert" : "DM nicht zustellbar (DMs geschlossen)");
  if (result.timeout === "applied") parts.push(`automatischer Timeout (${config.WARN_TIMEOUT_MINUTES} Min.)`);
  if (result.timeout === "failed") parts.push("Timeout nicht möglich (Rolle des Bots zu niedrig oder Person nicht auf dem Server)");
  if (result.alert) parts.push("Leitung benachrichtigt");
  return parts.join(" · ");
}
