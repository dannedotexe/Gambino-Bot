import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { audit } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { zonedTime } from "./services/event-series.js";

export class PollError extends Error {}
const SNOWFLAKE = /^\d{17,20}$/;
export const MAX_OPTIONS = 10;
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);

/**
 * Prüft eine neue Abstimmung. Optionen als Liste oder durch „;“ bzw. Zeilenumbruch getrennt (2–10, je max. 80 Zeichen).
 * Ende entweder als Dauer in Stunden oder als Wanduhrzeit „YYYY-MM-DDTHH:MM“ in der Server-Zeitzone.
 */
export function validatePoll(input, { reference = new Date(), timezone = "Europe/Vienna" } = {}) {
  const question = String(input.question ?? "").trim();
  if (question.length < 3) throw new PollError("Bitte eine Frage angeben (mindestens 3 Zeichen).");
  if (question.length > 250) throw new PollError("Die Frage darf höchstens 250 Zeichen lang sein.");
  const raw = Array.isArray(input.options) ? input.options : String(input.options ?? "").split(/[;\n]/);
  const options = raw.map(option => String(option).trim()).filter(Boolean);
  if (options.length < 2) throw new PollError("Bitte mindestens 2 Antwortmöglichkeiten angeben (getrennt durch ; ).");
  if (options.length > MAX_OPTIONS) throw new PollError(`Höchstens ${MAX_OPTIONS} Antwortmöglichkeiten.`);
  if (options.some(option => option.length > 80)) throw new PollError("Jede Antwortmöglichkeit darf höchstens 80 Zeichen lang sein.");
  if (new Set(options.map(o => o.toLocaleLowerCase("de-AT"))).size !== options.length) throw new PollError("Jede Antwortmöglichkeit darf nur einmal vorkommen.");
  const channelId = String(input.channelId ?? "");
  if (!SNOWFLAKE.test(channelId)) throw new PollError("Bitte einen Channel auswählen.");
  const requiredRoleId = input.requiredRoleId ? String(input.requiredRoleId) : null;
  if (requiredRoleId && !SNOWFLAKE.test(requiredRoleId)) throw new PollError("Ungültige Rolle.");
  let endsAt;
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(input.endsAt ?? ""));
  if (local) endsAt = zonedTime(...local.slice(1).map(Number), timezone);
  else if (input.hours != null) endsAt = new Date(reference.getTime() + Number(input.hours) * 3_600_000);
  if (!endsAt || Number.isNaN(endsAt.getTime())) throw new PollError("Bitte ein gültiges Ende angeben.");
  if (endsAt.getTime() < reference.getTime() + 5 * 60_000) throw new PollError("Die Abstimmung muss mindestens 5 Minuten laufen.");
  if (endsAt.getTime() > reference.getTime() + 30 * 86_400_000) throw new PollError("Eine Abstimmung darf höchstens 30 Tage laufen.");
  return { question, options, channelId, requiredRoleId, anonymous: Boolean(input.anonymous), hideResults: Boolean(input.hideResults), endsAt: endsAt.toISOString() };
}

export function createPollService(db) {
  const now = () => new Date().toISOString();
  const parse = row => row && ({ ...row, options: JSON.parse(row.options), anonymous: Boolean(row.anonymous), hide_results: Boolean(row.hide_results) });
  const get = (guildId, id) => parse(db.prepare("SELECT * FROM polls WHERE guild_id=? AND id=?").get(guildId, id));
  const byId = id => parse(db.prepare("SELECT * FROM polls WHERE id=?").get(id));

  function create({ guildId, actorId, data }) {
    const id = randomUUID();
    db.prepare("INSERT INTO polls(id,guild_id,channel_id,question,options,anonymous,hide_results,required_role_id,ends_at,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,'open',?,?)")
      .run(id, guildId, data.channelId, data.question, JSON.stringify(data.options), data.anonymous ? 1 : 0, data.hideResults ? 1 : 0, data.requiredRoleId, data.endsAt, actorId, now());
    audit(db, guildId, actorId, "poll.created", null, { name: data.question, endsAt: data.endsAt, channelId: data.channelId });
    return get(guildId, id);
  }
  const setMessage = (id, messageId) => db.prepare("UPDATE polls SET message_id=? WHERE id=?").run(messageId, id);

  /** Eine Stimme pro Person; erneutes Klicken ändert die Stimme. */
  const vote = db.transaction(({ pollId, userId, optionIndex }) => {
    const poll = byId(pollId);
    if (!poll || poll.status !== "open" || new Date(poll.ends_at) <= new Date()) return { status: "closed", poll };
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return { status: "invalid", poll };
    const previous = db.prepare("SELECT option_index FROM poll_votes WHERE poll_id=? AND user_id=?").get(pollId, userId)?.option_index ?? null;
    if (previous === optionIndex) return { status: "same", poll, optionIndex };
    db.prepare("INSERT INTO poll_votes(poll_id,user_id,option_index,voted_at) VALUES(?,?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET option_index=excluded.option_index,voted_at=excluded.voted_at").run(pollId, userId, optionIndex, now());
    return { status: previous == null ? "voted" : "changed", poll, optionIndex, previous };
  });
  const unvote = db.transaction(({ pollId, userId }) => {
    const poll = byId(pollId);
    if (!poll || poll.status !== "open") return { status: "closed", poll };
    const changed = db.prepare("DELETE FROM poll_votes WHERE poll_id=? AND user_id=?").run(pollId, userId).changes;
    return { status: changed ? "removed" : "none", poll };
  });

  function results(pollId) {
    const poll = byId(pollId);
    const counts = poll.options.map(() => 0);
    for (const row of db.prepare("SELECT option_index, COUNT(*) n FROM poll_votes WHERE poll_id=? GROUP BY option_index").all(pollId)) if (counts[row.option_index] != null) counts[row.option_index] = row.n;
    return { counts, total: counts.reduce((a, b) => a + b, 0) };
  }
  /** Wer was gewählt hat – bei anonymen Abstimmungen nie. */
  const voters = pollId => byId(pollId)?.anonymous ? null : db.prepare("SELECT user_id,option_index,voted_at FROM poll_votes WHERE poll_id=? ORDER BY voted_at").all(pollId);
  const myVote = (pollId, userId) => db.prepare("SELECT option_index FROM poll_votes WHERE poll_id=? AND user_id=?").get(pollId, userId)?.option_index ?? null;

  /** Schließt genau einmal (Ablauf oder manuell). */
  function close({ guildId, id, actorId = null, cancel = false }) {
    const changed = db.prepare("UPDATE polls SET status=?,closed_at=?,closed_by=? WHERE guild_id=? AND id=? AND status='open'").run(cancel ? "cancelled" : "closed", now(), actorId, guildId, id).changes;
    if (!changed) return null;
    audit(db, guildId, actorId ?? "system", cancel ? "poll.cancelled" : "poll.closed", null, { name: get(guildId, id).question, entries: results(id).total });
    return get(guildId, id);
  }
  const due = (reference = new Date()) => db.prepare("SELECT id,guild_id FROM polls WHERE status='open' AND ends_at<=? LIMIT 20").all(reference.toISOString());
  const list = (guildId, limit = 30) => db.prepare("SELECT * FROM polls WHERE guild_id=? ORDER BY status='open' DESC, created_at DESC LIMIT ?").all(guildId, limit).map(parse);
  return { create, setMessage, get, byId, vote, unvote, results, voters, myVote, close, due, list };
}

const NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const MEDALS = ["🥇", "🥈", "🥉"];
const OPEN_COLOR = 0xd4af37, DONE_COLOR = 0x30d158, CANCEL_COLOR = 0x8e8e93;
const bar = (share, width = 14) => { const n = Math.round(share * width); return "▰".repeat(n) + "▱".repeat(width - n); };
const votes = n => `${n} ${n === 1 ? "Stimme" : "Stimmen"}`;

/**
 * Discord-Nachricht: Frage, Antworten mit Zahlen-Emoji und Balken (bzw. verdeckt), Führung mit 👑,
 * Knöpfe mit Live-Zähler solange offen.
 */
export function pollPayload(poll, { counts, total }) {
  const open = poll.status === "open", reveal = !open || !poll.hide_results;
  const max = Math.max(...counts), lead = i => reveal && total > 0 && counts[i] === max;
  const lines = poll.options.map((option, i) => {
    if (!reveal) return `${NUMBERS[i]} **${option}**`;
    const share = total ? counts[i] / total : 0;
    return `${NUMBERS[i]} **${option}**${lead(i) ? (open ? " 👑" : " 🏆") : ""}\n${bar(share)} **${Math.round(share * 100)} %** · ${votes(counts[i])}`;
  });
  const color = poll.status === "cancelled" ? CANCEL_COLOR : open ? OPEN_COLOR : DONE_COLOR;
  const head = poll.status === "cancelled" ? "🚫 Abgebrochen" : open ? (poll.hide_results ? "🙈 Zwischenstand verdeckt – Ergebnis erst am Ende" : "🗳️ Stimme jetzt ab!") : "🏁 Abstimmung beendet";
  const notes = [poll.anonymous ? "🔒 anonym" : "👁️ Stimmen fürs Team sichtbar", poll.required_role_id ? `nur <@&${poll.required_role_id}>` : null].filter(Boolean).join(" · ");
  const embed = new EmbedBuilder().setColor(color).setAuthor({ name: "GAMBINOS  •  ABSTIMMUNG" }).setTitle(`📊 ${poll.question}`.slice(0, 256))
    .setDescription(`*${head}*\n\n${lines.join("\n\n")}`.slice(0, 4096))
    .addFields(
      { name: "🗳️ Stimmen", value: `**${total}**`, inline: true },
      { name: open ? "⏳ Endet" : "🕒 Beendet", value: open ? `<t:${unix(poll.ends_at)}:R>\n<t:${unix(poll.ends_at)}:f>` : `<t:${unix(poll.closed_at ?? poll.ends_at)}:f>`, inline: true },
      { name: "👤 Gestellt von", value: `<@${poll.created_by}>`, inline: true },
      { name: "ℹ️ Info", value: notes.slice(0, 1024), inline: false },
    )
    .setFooter({ text: open ? "Eine Stimme pro Person · jederzeit änderbar" : "GAMBINOS  •  Abstimmung" });
  const components = [];
  if (open) {
    const buttons = poll.options.map((option, i) => new ButtonBuilder().setCustomId(`poll:vote:${poll.id}:${i}`).setEmoji(NUMBERS[i])
      .setLabel(`${option}${reveal ? ` · ${counts[i]}` : ""}`.slice(0, 80)).setStyle(lead(i) ? ButtonStyle.Primary : ButtonStyle.Secondary));
    for (let i = 0; i < buttons.length; i += 5) components.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
    components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`poll:unvote:${poll.id}`).setEmoji("↩️").setLabel("Stimme zurückziehen").setStyle(ButtonStyle.Secondary)));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

/** Ergebnis-Karte mit Podium (🥇🥈🥉), Gewinner groß. */
export function pollResultPayload(poll, { counts, total }) {
  const ranked = poll.options.map((option, i) => ({ option, i, n: counts[i] })).sort((a, b) => b.n - a.n || a.i - b.i);
  const max = ranked[0]?.n ?? 0, winners = total ? ranked.filter(r => r.n === max) : [];
  const headline = !total ? "Es wurde nicht abgestimmt." : winners.length > 1
    ? `🤝 **Gleichstand** zwischen ${winners.map(w => `**${w.option}**`).join(" und ")} – je ${votes(max)}.`
    : `🏆 **${winners[0].option}** gewinnt mit **${votes(max)}** (${Math.round(max / total * 100)} %).`;
  const podium = total ? ranked.map((r, k) => `${MEDALS[k] ?? `**${k + 1}.**`} ${r.option} · ${bar(r.n / total, 10)} ${Math.round(r.n / total * 100)} % · ${votes(r.n)}`).join("\n") : "";
  const embed = new EmbedBuilder().setColor(DONE_COLOR).setAuthor({ name: "GAMBINOS  •  ERGEBNIS" }).setTitle(`🏁 ${poll.question}`.slice(0, 256))
    .setDescription(`${headline}${podium ? `\n\n${podium}` : ""}`.slice(0, 4096))
    .setFooter({ text: `${votes(total)} insgesamt` }).setTimestamp(new Date(poll.closed_at ?? poll.ends_at));
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export async function publishPoll({ db, client, poll, pingRoleIds = [] }) {
  const service = createPollService(db);
  const channel = await client.channels?.fetch?.(poll.channel_id).catch(() => null);
  if (!channel?.send) throw new PollError("Der Channel ist nicht erreichbar oder der Bot darf dort nicht schreiben.");
  const ping = pingRoleIds.filter(id => SNOWFLAKE.test(id));
  const message = await channel.send({ ...pollPayload(poll, service.results(poll.id)), ...(ping.length ? { content: `${ping.map(id => `<@&${id}>`).join(" ")} 📊 Neue Abstimmung!`, allowedMentions: { roles: ping } } : {}) });
  service.setMessage(poll.id, message.id);
  return message;
}

/** Aktualisiert die Abstimmungs-Nachricht (Zwischenstand bzw. Endergebnis). */
export async function refreshPollMessage({ db, client, pollId }) {
  const service = createPollService(db), poll = service.byId(pollId);
  if (!poll?.message_id) return false;
  const channel = await client.channels?.fetch?.(poll.channel_id).catch(() => null);
  const message = await channel?.messages?.fetch?.(poll.message_id).catch(() => null);
  if (!message) return false;
  return message.edit(pollPayload(poll, service.results(pollId))).then(() => true).catch(() => false);
}

/** Beendet abgelaufene Abstimmungen und postet das Ergebnis; erinnert eine Stunde vor Ende (Abstimmungen ab 3 Std. Dauer). */
export async function closeDuePolls({ db, client, reference = new Date() }) {
  const service = createPollService(db);
  let closed = 0;
  for (const { id, guild_id: guildId } of service.due(reference)) {
    const poll = service.close({ guildId, id });
    if (!poll) continue;
    closed++;
    await refreshPollMessage({ db, client, pollId: id });
    await announcePollResult({ db, client, poll });
  }
  const soon = new Date(reference.getTime() + 3_600_000).toISOString();
  for (const row of db.prepare("SELECT * FROM polls WHERE status='open' AND reminded_at IS NULL AND message_id IS NOT NULL AND ends_at<=? AND ends_at>? AND (julianday(ends_at)-julianday(created_at))*24>=3 LIMIT 10").all(soon, reference.toISOString())) {
    if (!db.prepare("UPDATE polls SET reminded_at=? WHERE id=? AND reminded_at IS NULL").run(reference.toISOString(), row.id).changes) continue;
    const channel = await client.channels?.fetch?.(row.channel_id).catch(() => null);
    const original = await channel?.messages?.fetch?.(row.message_id).catch(() => null);
    const total = service.results(row.id).total;
    await original?.reply?.({ content: `⏰ **Noch 1 Stunde!** „${row.question}“ endet <t:${unix(row.ends_at)}:R> – bisher ${votes(total)}. Noch nicht abgestimmt? Jetzt oben klicken! 🗳️`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
  }
  return closed;
}

export async function announcePollResult({ db, client, poll }) {
  if (poll.status !== "closed") return false;
  const results = createPollService(db).results(poll.id);
  const channel = await client.channels?.fetch?.(poll.channel_id).catch(() => null);
  if (!channel?.send) return false;
  const payload = pollResultPayload(poll, results);
  const original = poll.message_id ? await channel.messages?.fetch?.(poll.message_id).catch(() => null) : null;
  return (original ? original.reply(payload) : channel.send(payload)).then(() => true).catch(() => false);
}
