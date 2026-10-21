import { EmbedBuilder } from "discord.js";

const GOLD = 0xd4af37;
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);

/** Preis lesbar machen: reine Beträge („100000“, „100k“, „$1.500.000“) werden zu „$100.000“, Text bleibt Text. */
export function prizeLabel(prize) {
  const raw = String(prize ?? "").trim(), compact = raw.replace(/[\s$]/g, "").toLowerCase();
  const m = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d+))?(k|m|mio)?$/.exec(compact);
  if (!m) return raw;
  let value = Number(m[1].replace(/[.,]/g, "")) + (m[2] && m[3] ? Number(`0.${m[2]}`) : 0);
  if (m[3] === "k") value *= 1_000; else if (m[3]) value *= 1_000_000;
  if (!Number.isFinite(value) || value <= 0) return raw;
  return `$${Math.round(value).toLocaleString("de-DE")}`;
}

/** Ergebnis-Karte nach dem Ende (ersetzt die Teilnahme-Karte). */
export function giveawayResultPayload(row, { entries = null } = {}) {
  const winners = JSON.parse(row.winners ?? "[]"), prize = prizeLabel(row.prize);
  const embed = new EmbedBuilder().setColor(GOLD).setAuthor({ name: "GAMBINOS  •  GIVEAWAY" }).setTitle(`🎉 ${prize}`.slice(0, 256))
    .setDescription(winners.length ? `Das Giveaway ist vorbei – herzlichen Glückwunsch!` : "Das Giveaway ist vorbei. Es gab keine Teilnahmen, daher wurde niemand gezogen.")
    .addFields(
      { name: "🏆 Gewinner", value: winners.length ? winners.map(id => `<@${id}>`).join("\n").slice(0, 1024) : "—", inline: true },
      { name: "🎁 Preis", value: `**${prize}**`.slice(0, 1024), inline: true },
      ...(entries != null ? [{ name: "🙋 Teilnahmen", value: String(entries), inline: true }] : []),
      { name: "🕒 Beendet", value: `<t:${unix(row.ended_at ?? row.ends_at)}:f>`, inline: true },
    )
    .setFooter({ text: "GAMBINOS  •  Giveaway beendet" }).setTimestamp(new Date(row.ended_at ?? row.ends_at));
  return { embeds: [embed], components: [], allowedMentions: { users: winners } };
}

/** Kurze Glückwunsch-Nachricht mit Ping (nur Gewinner). */
export function giveawayWinnerPayload(row) {
  const winners = JSON.parse(row.winners ?? "[]"), prize = prizeLabel(row.prize);
  return {
    content: winners.map(id => `<@${id}>`).join(" "),
    embeds: [new EmbedBuilder().setColor(GOLD).setTitle(`🏆 Glückwunsch${winners.length > 1 ? " an alle Gewinner" : ""}!`)
      .setDescription(`${winners.length > 1 ? "Ihr habt" : "Du hast"} **${prize}** gewonnen. 🎉\nMelde${winners.length > 1 ? "t euch" : " dich"} bei der Leitung, um den Gewinn abzuholen.`)],
    allowedMentions: { users: winners },
  };
}
