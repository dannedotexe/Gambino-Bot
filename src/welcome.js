import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { colorNumber, panelTexts } from "./services/texts.js";

/** Ersetzt {user} {name} {server} {mitglieder} {verifizierung} in Willkommenstexten. */
export function fillWelcome(text, { member, config, memberCount }) {
  const verification = config.CHANNEL_VERIFICATION_PANEL ? `<#${config.CHANNEL_VERIFICATION_PANEL}>` : "#neue-spieler";
  return String(text ?? "")
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{name}", member.displayName ?? member.user?.username ?? "neues Mitglied")
    .replaceAll("{server}", member.guild?.name ?? "Gambinos")
    .replaceAll("{mitglieder}", String(memberCount ?? member.guild?.memberCount ?? "?"))
    .replaceAll("{verifizierung}", verification);
}

export function welcomePayload({ member, config, texts }) {
  const ctx = { member, config, memberCount: member.guild?.memberCount };
  const fill = text => fillWelcome(text, ctx);
  const embed = new EmbedBuilder().setColor(colorNumber(texts.color)).setTimestamp();
  if (texts.author) embed.setAuthor({ name: fill(texts.author).slice(0, 256) });
  if (texts.title) embed.setTitle(fill(texts.title).slice(0, 256));
  if (texts.description) embed.setDescription(fill(texts.description).slice(0, 4096));
  if (texts.footer) embed.setFooter({ text: fill(texts.footer).slice(0, 2048) });
  const avatar = member.user?.displayAvatarURL?.({ size: 128 });
  if (avatar) embed.setThumbnail(avatar);
  const payload = { embeds: [embed], allowedMentions: { users: [member.id] } };
  const content = fill(texts.content).trim();
  if (content) payload.content = content.slice(0, 2000);
  if (texts.button && config.CHANNEL_VERIFICATION_PANEL && config.DISCORD_GUILD_ID) {
    payload.components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(texts.button.slice(0, 80)).setURL(`https://discord.com/channels/${config.DISCORD_GUILD_ID}/${config.CHANNEL_VERIFICATION_PANEL}`))];
  }
  return payload;
}

/** Begrüßt neue Mitglieder im Willkommens-Channel und optional per DM. Fehler blockieren nie den Beitritt. */
export async function sendWelcome({ db, client, config, member }) {
  if (member.user?.bot) return { channel: false, dm: false };
  if (config.DISCORD_GUILD_ID && member.guild?.id !== config.DISCORD_GUILD_ID) return { channel: false, dm: false };
  const texts = panelTexts(db, member.guild?.id ?? config.DISCORD_GUILD_ID, "welcome");
  const result = { channel: false, dm: false };
  if (config.CHANNEL_WELCOME) {
    const channel = await client.channels.fetch(config.CHANNEL_WELCOME).catch(() => null);
    if (channel?.send) result.channel = await channel.send(welcomePayload({ member, config, texts })).then(() => true).catch(error => { console.warn("Willkommensnachricht nicht gesendet:", error.message); return false; });
  }
  if (config.WELCOME_DM_ENABLED && texts.dm) {
    result.dm = await member.send({ content: fillWelcome(texts.dm, { member, config }).slice(0, 2000) }).then(() => true).catch(() => false);
  }
  return result;
}
