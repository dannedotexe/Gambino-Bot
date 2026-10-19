import { createHash } from "node:crypto";
import { EmbedBuilder } from "discord.js";
import { getSetting, setSetting } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { createFinance, formatMoney } from "./services/finance.js";

/**
 * Immer aktuelle Auszahlungsliste in CHANNEL_PAYOUT_LIST: eine Nachricht, die der Bot bearbeitet, sobald sich
 * Guthaben oder Sanktionen ändern. Nur Konten mit Guthaben; sortiert nach Netto.
 */
const MESSAGE_KEY = "PAYOUT_LIST_MESSAGE", HASH_KEY = "PAYOUT_LIST_HASH";

export function buildPayoutList(db, guildId, { minimumCents = null, name = id => `<@${id}>`, reference = new Date() } = {}) {
  const finance = createFinance(db);
  const rows = db.prepare("SELECT user_id FROM accounts WHERE guild_id=? AND balance_cents>0").all(guildId)
    .map(r => ({ userId: r.user_id, ...finance.previewPayout(guildId, r.user_id) }))
    .sort((a, b) => b.net - a.net || b.gross - a.gross);
  const totals = rows.reduce((t, r) => ({ gross: t.gross + r.gross, deduction: t.deduction + r.deduction, net: t.net + r.net }), { gross: 0, deduction: 0, net: 0 });
  const lines = rows.map((r, n) => {
    const ok = minimumCents == null || r.gross >= minimumCents;
    return `**${n + 1}.** ${name(r.userId)} · **${formatMoney(r.net)}**${r.deduction ? ` (brutto ${formatMoney(r.gross)} − ${formatMoney(r.deduction)} Sanktion)` : ""}${ok ? "" : " · ⏳ unter Mindestbetrag"}`;
  });
  // Auf mehrere Embeds verteilen (je max. ~3800 Zeichen, höchstens 9 + Kopf).
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > 3800) { chunks.push(current); current = line; } else current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  const head = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  AUSZAHLUNGSLISTE" }).setTitle("💵 Wer bekommt wie viel")
    .setDescription(rows.length
      ? `**${rows.length}** Mitglieder · auszuzahlen gesamt **${formatMoney(totals.net)}**${totals.deduction ? `\nBrutto ${formatMoney(totals.gross)} · davon Sanktionen −${formatMoney(totals.deduction)}` : ""}${minimumCents != null ? `\nMindestbetrag für Auszahlung: ${formatMoney(minimumCents)}` : ""}`
      : "Aktuell hat niemand ausstehendes Guthaben.")
    .setFooter({ text: "Aktualisiert sich automatisch (spätestens 1 Minute nach jeder Buchung)" }).setTimestamp(reference);
  const body = chunks.slice(0, 9).map((text, k) => new EmbedBuilder().setColor(BRAND_COLOR).setDescription(text + (k === 8 && chunks.length > 9 ? "\n… weitere auf der Website" : "")));
  return { embeds: [head, ...body], allowedMentions: { parse: [] } };
}

/** Postet die Liste einmal und bearbeitet sie danach nur noch, wenn sich die Zahlen geändert haben. */
export async function refreshPayoutList({ db, client, config, force = false }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId || !config.CHANNEL_PAYOUT_LIST) return false;
  // Erwähnungen zeigen den Server-Namen an, pingen aber niemanden (allowedMentions leer).
  const payload = buildPayoutList(db, guildId, { minimumCents: config.PAYOUT_MINIMUM_CENTS ?? null });
  const hash = createHash("sha256").update(JSON.stringify(payload.embeds.map(e => e.data.description ?? "")) + config.CHANNEL_PAYOUT_LIST).digest("hex");
  if (!force && getSetting(db, guildId, HASH_KEY) === hash) return false;
  const channel = await client.channels.fetch(config.CHANNEL_PAYOUT_LIST).catch(() => null);
  if (!channel?.send) return false;
  const stored = getSetting(db, guildId, MESSAGE_KEY);
  const [storedChannel, storedMessage] = String(stored ?? "").split(":");
  const existing = storedChannel === channel.id && storedMessage ? await channel.messages?.fetch(storedMessage).catch(() => null) : null;
  if (existing) await existing.edit(payload);
  else { const message = await channel.send(payload); setSetting(db, guildId, MESSAGE_KEY, `${channel.id}:${message.id}`); }
  setSetting(db, guildId, HASH_KEY, hash);
  return true;
}
