import { EmbedBuilder } from "discord.js";
import { colorNumber, defaultsFor } from "./services/texts.js";

export const LEADERBOARD_SETTING_KEY = "PANEL_LEADERBOARD";
const MEDALS = ["🥇", "🥈", "🥉"];

const lines = (rows, empty) => rows.length
  ? rows.map((row, index) => `${MEDALS[index] ?? `**${index + 1}.**`} <@${row.userId}> · **${row.count}** ${row.count === 1 ? "Teilnahme" : "Teilnahmen"}`).join("\n").slice(0, 1024)
  : empty;

/** Ranglisten-Embed: Woche und Monat nach Event-Teilnahmen. */
export function buildLeaderboard({ activity, guildId, timezone, texts = defaultsFor("leaderboard"), reference = new Date() }) {
  const week = activity.leaderboard(guildId, { period: "week", timezone, reference });
  const month = activity.leaderboard(guildId, { period: "month", timezone, reference });
  const embed = new EmbedBuilder().setColor(colorNumber(texts.color)).setTimestamp(reference)
    .addFields({ name: texts.weekTitle, value: lines(week, texts.emptyText), inline: true }, { name: texts.monthTitle, value: lines(month, texts.emptyText), inline: true });
  if (texts.author) embed.setAuthor({ name: texts.author });
  if (texts.title) embed.setTitle(texts.title);
  if (texts.description) embed.setDescription(texts.description);
  if (texts.footer) embed.setFooter({ text: texts.footer });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}
