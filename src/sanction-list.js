import { EmbedBuilder } from "discord.js";
import { formatMoney } from "./services/finance.js";
import { colorNumber, defaultsFor } from "./services/texts.js";

export const SANCTION_LIST_SETTING_KEY = "PANEL_SANCTION_LIST";
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);

/**
 * Öffentliche Liste offener Sanktionen, je Mitglied gruppiert. Beträge und Gründe lassen sich ausblenden
 * (SANCTION_LIST_SHOW_AMOUNTS / SANCTION_LIST_SHOW_REASONS). Niemand wird dabei angepingt.
 */
export function buildSanctionList({ db, guildId, config, texts = defaultsFor("sanctionList") }) {
  const rows = db.prepare("SELECT user_id,reason,remaining_cents,created_at FROM sanctions WHERE guild_id=? AND status IN ('open','partial') ORDER BY created_at").all(guildId);
  const byUser = new Map();
  for (const row of rows) { if (!byUser.has(row.user_id)) byUser.set(row.user_id, []); byUser.get(row.user_id).push(row); }
  const showAmounts = config.SANCTION_LIST_SHOW_AMOUNTS !== false, showReasons = config.SANCTION_LIST_SHOW_REASONS !== false;
  const people = [...byUser.entries()].map(([userId, items]) => ({ userId, items, total: items.reduce((sum, item) => sum + item.remaining_cents, 0) }))
    .sort((a, b) => b.total - a.total || b.items.length - a.items.length);
  const blocks = people.map(p => {
    const head = `<@${p.userId}> · ${p.items.length} ${p.items.length === 1 ? "offene Sanktion" : "offene Sanktionen"}${showAmounts ? ` · **${formatMoney(p.total)}**` : ""}`;
    const details = showReasons ? p.items.slice(0, 5).map(item => `└ ${item.reason.slice(0, 90)}${showAmounts ? ` (${formatMoney(item.remaining_cents)})` : ""} · <t:${unix(item.created_at)}:d>`).join("\n") + (p.items.length > 5 ? `\n└ … und ${p.items.length - 5} weitere` : "") : "";
    return [head, details].filter(Boolean).join("\n");
  });
  let description = texts.description ? `${texts.description}\n\n` : "";
  let shown = 0;
  for (const block of blocks) {
    if (description.length + block.length + 40 > 4000) break;
    description += `${block}\n\n`; shown++;
  }
  if (!blocks.length) description += texts.emptyText;
  else if (shown < blocks.length) description += `… und ${blocks.length - shown} weitere Mitglieder.`;
  const embed = new EmbedBuilder().setColor(colorNumber(texts.color)).setDescription(description.trim().slice(0, 4096)).setTimestamp();
  if (texts.author) embed.setAuthor({ name: texts.author });
  if (texts.title) embed.setTitle(texts.title);
  const total = people.reduce((sum, p) => sum + p.total, 0);
  const footer = [texts.footer, showAmounts && people.length ? `Gesamt offen: ${formatMoney(total)}` : ""].filter(Boolean).join("  •  ");
  if (footer) embed.setFooter({ text: footer });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}
