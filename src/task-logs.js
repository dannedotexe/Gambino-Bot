import { createHash } from "node:crypto";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { accessGroups } from "./config.js";
import { getSetting, setSetting } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { createFinance, formatMoney } from "./services/finance.js";
import { TaskError, createTaskService, levelFor, weekStart } from "./services/tasks.js";
import { localDay } from "./services/absences.js";

/**
 * Discord-Seite der Aufgaben-Logs: /log reicht ein, die Prüf-Karte im Staff-Channel entscheidet,
 * das öffentliche Aufgaben-Board zeigt Belohnungen und die Top-Farmer der Woche.
 */
const GREEN = 0x2e7d32, RED = 0xc62828;
const MEDALS = ["🥇", "🥈", "🥉"];
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const BOARD_MESSAGE = "TASK_BOARD_MESSAGE", BOARD_HASH = "TASK_BOARD_HASH";

const service = (db, config) => createTaskService(db, { timezone: () => config.TIMEZONE });

/** Belohnungstext einer Aufgaben-Art, z. B. „$25.000“ oder „$10.000 pro Ernte“. */
export const rewardLabel = type => type.reward_cents ? `${formatMoney(type.reward_cents)}${type.per_unit ? ` pro ${type.unit}` : ""}` : "ohne Geld";
export const typeLabel = type => `${type.emoji} ${type.name}`;
const logTitle = log => `${log.type_emoji} ${log.type_name}${log.type_per_unit ? ` ×${log.quantity} ${log.type_unit}` : ""}`;
const bar = (progress, width = 10) => "▰".repeat(Math.round(progress * width)) + "▱".repeat(width - Math.round(progress * width));
const nLogs = n => `${n} ${n === 1 ? "Log" : "Logs"}`;
const levelLine = level => `${level.emoji} **${level.name}**${level.next ? ` · noch ${level.next.missing} bis ${level.next.emoji} ${level.next.name}` : " · höchste Stufe"}`;

/** Prüf-Karte für das Team. decision: null (offen) oder der entschiedene Log. */
export function taskReviewCard(log, { profile = null, duplicate = null, imageName = null, imageUrl = null } = {}) {
  const state = log.status;
  const embed = new EmbedBuilder().setColor(state === "approved" ? GREEN : state === "rejected" ? RED : BRAND_COLOR)
    .setAuthor({ name: "GAMBINOS  •  AUFGABEN-LOG" })
    .setTitle(`${state === "approved" ? "✅ " : state === "rejected" ? "❌ " : ""}${logTitle(log)}`.slice(0, 256))
    .setDescription([
      `**Von:** <@${log.user_id}>${profile ? ` · ${profile.level.emoji} ${profile.level.name}${profile.streak > 1 ? ` · 🔥 ${profile.streak} Tage Serie` : ""}` : ""}`,
      `**Belohnung:** ${log.reward_cents ? `**${formatMoney(log.reward_cents)}**` : "keine (nur Zählung)"}`,
      log.note ? `**Notiz:** ${log.note}` : null,
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `Log ${log.id.slice(0, 8)} · eingereicht` }).setTimestamp(new Date(log.created_at));
  if (profile && state === "pending") embed.addFields({ name: "Diese Woche", value: `${profile.week.logs} bestätigt · ${formatMoney(profile.week.earned)}${profile.week.place ? ` · Platz ${profile.week.place}` : ""}`, inline: true }, { name: "Gesamt", value: `${nLogs(profile.total.logs)} · ${formatMoney(profile.total.earned)}`, inline: true });
  if (duplicate) embed.addFields({ name: "⚠️ Möglicherweise doppelter Screenshot", value: `Gleiche Bildgröße und Dateigröße wie ein Log von <@${duplicate.user_id}> <t:${unix(duplicate.created_at)}:R>. Bitte genau hinschauen.` });
  if (state === "approved") embed.addFields({ name: "Bestätigt", value: `von <@${log.reviewer_id}> <t:${unix(log.reviewed_at)}:R>${log.reward_cents ? ` · ${formatMoney(log.reward_cents)} gutgeschrieben` : ""}` });
  if (state === "rejected") embed.addFields({ name: log.reviewer_id === log.user_id ? "Zurückgezogen" : "Abgelehnt", value: `${log.reviewer_id === log.user_id ? "vom Mitglied selbst" : `von <@${log.reviewer_id}>`} <t:${unix(log.reviewed_at)}:R>\n**Grund:** ${log.reject_reason ?? "—"}`.slice(0, 1024) });
  if (imageName) embed.setImage(`attachment://${imageName}`);
  else if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

export function taskReviewButtons(log) {
  if (log.status !== "pending") return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`task:ok:${log.id}`).setLabel(log.reward_cents ? `Bestätigen · ${formatMoney(log.reward_cents)}` : "Bestätigen").setEmoji("✅").setStyle(ButtonStyle.Success),
    ...(log.type_per_unit ? [new ButtonBuilder().setCustomId(`task:qty:${log.id}`).setLabel("Menge ändern").setEmoji("✏️").setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId(`task:no:${log.id}`).setLabel("Ablehnen").setEmoji("✖️").setStyle(ButtonStyle.Danger))];
}

/** Persönliche Übersicht (/aufgaben und Board-Button). */
export function myTasksView(db, config, guildId, userId) {
  const tasks = service(db, config), p = tasks.profile(guildId, userId), recent = tasks.list(guildId, { userId, limit: 6 });
  const status = { pending: "⏳", approved: "✅", rejected: "❌" };
  return new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  DEINE AUFGABEN" })
    .setTitle(`${p.level.emoji} ${p.level.name}`)
    .setDescription(`${bar(p.level.progress)} ${p.level.next ? `${p.level.count}/${p.level.next.min} Logs bis ${p.level.next.emoji} ${p.level.next.name}` : `${p.level.count} Logs – höchste Stufe erreicht 👑`}`)
    .addFields(
      { name: "🔥 Serie", value: p.streak ? `${p.streak} ${p.streak === 1 ? "Tag" : "Tage"} am Stück` : "keine – log heute!", inline: true },
      { name: "📅 Diese Woche", value: `${nLogs(p.week.logs)} · ${formatMoney(p.week.earned)}${p.week.place ? `\nPlatz **${p.week.place}** von ${p.week.of}` : ""}`, inline: true },
      { name: "💰 Gesamt verdient", value: `${formatMoney(p.total.earned)}\n${nLogs(p.total.logs)}`, inline: true },
      { name: "Letzte Logs", value: recent.map(l => `${status[l.status]} ${logTitle(l)} · <t:${unix(l.created_at)}:R>${l.status === "rejected" && l.reject_reason ? ` – ${l.reject_reason.slice(0, 60)}` : ""}`).join("\n") || "Noch keine – starte mit `/log`." },
    ).setFooter({ text: p.pending ? `${p.pending} Log(s) warten auf Prüfung` : "Neue Logs mit /log einreichen" });
}

/** Lädt den Screenshot herunter, damit er dauerhaft an der Prüf-Karte hängt (Slash-Anhänge laufen ab). */
async function downloadProof(attachment) {
  if (!attachment?.url || (attachment.size ?? 0) > MAX_PROOF_BYTES) return null;
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PROOF_BYTES) return null;
    const extension = (/\.(png|jpe?g|webp|gif)(?:\?|$)/i.exec(attachment.name ?? "")?.[1] ?? "png").toLowerCase();
    return { buffer, name: `beweis.${extension}` };
  } catch { return null; }
}

const reviewChannelOf = async (client, config) => {
  const id = config.CHANNEL_TASK_REVIEW || config.CHANNEL_AUDIT_LOG;
  return id ? client.channels.fetch(id).catch(() => null) : null;
};

/** Prüf-Karte mit dauerhaft angehängtem Screenshot in den Prüf-Channel posten. */
async function postReviewCard({ db, client, config, log, attachment }) {
  const tasks = service(db, config), profile = tasks.profile(log.guild_id, log.user_id);
  const proof = await downloadProof(attachment);
  const channel = await reviewChannelOf(client, config);
  let posted = null;
  if (channel?.send) {
    posted = await channel.send({ embeds: [taskReviewCard(log, { profile, duplicate: log.duplicate, imageName: proof?.name, imageUrl: proof ? null : attachment.url })], components: taskReviewButtons(log),
      files: proof ? [new AttachmentBuilder(proof.buffer, { name: proof.name })] : [], allowedMentions: { parse: [] } }).catch(error => { console.warn("Aufgaben-Log konnte nicht gepostet werden:", error.message); return null; });
  }
  if (posted) tasks.attachMessage(log.id, { channelId: posted.channel?.id ?? channel.id, messageId: posted.id, proofUrl: posted.embeds?.[0]?.image?.url ?? posted.attachments?.first?.()?.url ?? null });
  return { profile, posted };
}

const proofKeyOf = a => (a.width && a.height ? `${a.width}x${a.height}:${a.size}` : null);
const imageOf = message => [...(message.attachments?.values?.() ?? [])].find(a => /^image\//.test(a.contentType ?? "") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.name ?? ""));

/** Auswahlmenü „Welche Aufgabe?“ unter einem Screenshot im Logbuch. */
export function logbookPrompt(db, config, guildId, messageId) {
  const types = service(db, config).listTypes(guildId).slice(0, 25);
  if (!types.length) return null;
  return {
    content: "📸 **Screenshot erkannt!** Welche Aufgabe ist das? Danach prüft das Team und die Belohnung kommt automatisch aufs Konto.",
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`task:pick:${messageId}`).setPlaceholder("Aufgabe auswählen …")
      .addOptions(types.map(t => ({ label: t.name.slice(0, 100), value: t.id, emoji: t.emoji || undefined, description: `${rewardLabel(t)}${t.daily_limit ? ` · max. ${t.daily_limit}×/Tag` : ""}`.slice(0, 100) })))),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`task:skip:${messageId}`).setLabel("Kein Log").setStyle(ButtonStyle.Secondary))],
    allowedMentions: { parse: [] },
  };
}

/** Nachricht in einem Logbuch-Post: Bild → Auswahlmenü darunter. Gibt true zurück, wenn gefragt wurde. */
export async function handleLogbookMessage({ db, config, message }) {
  if (!config.CHANNEL_TASK_FORUM || !message.channel?.isThread?.() || message.channel.parentId !== config.CHANNEL_TASK_FORUM) return false;
  if (/^\W*vorlage/i.test(message.channel.name ?? "") || !imageOf(message)) return false;
  const prompt = logbookPrompt(db, config, message.guildId, message.id);
  if (!prompt) return false;
  await message.reply(prompt);
  return true;
}

/** Auswahl im Logbuch: Log anlegen (bei Stückzahl erst Menge abfragen), Antwort zeigt den Status. */
async function submitFromLogbook({ i, db, client, config, messageId, typeId, quantity = 1 }) {
  const tasks = service(db, config);
  const source = await i.channel?.messages?.fetch(messageId).catch(() => null);
  if (!source) return i.update({ content: "Der Screenshot wurde gelöscht.", components: [] });
  if (db.prepare("SELECT 1 FROM task_logs WHERE source_message_id=?").get(messageId)) return i.update({ content: "Dieser Screenshot wurde bereits eingereicht.", components: [] });
  const attachment = imageOf(source);
  let log;
  try { log = tasks.submit({ guildId: i.guildId, userId: source.author.id, typeId, quantity, proofKey: attachment ? proofKeyOf(attachment) : null }); }
  catch (error) { if (error instanceof TaskError) return i.reply({ content: error.message, flags: MessageFlags.Ephemeral }); throw error; }
  db.prepare("UPDATE task_logs SET source_channel_id=?,source_message_id=?,prompt_message_id=? WHERE id=?").run(source.channelId ?? i.channelId, messageId, i.message.id, log.id);
  await i.update({ content: `⏳ **${logTitle(log)}** eingereicht${log.reward_cents ? ` · ${formatMoney(log.reward_cents)}` : ""} – wartet auf Prüfung.`, components: [] });
  await postReviewCard({ db, client, config, log, attachment });
  return null;
}

/** /log: Einreichung prüfen, speichern und als Prüf-Karte posten. */
export async function submitTaskLog({ i, db, client, config }) {
  const tasks = service(db, config), guildId = i.guildId;
  const attachment = i.options.getAttachment("beweis");
  if (!attachment || !/^image\//.test(attachment.contentType ?? "")) return i.reply({ content: "Bitte einen **Screenshot** (Bild) als Beweis anhängen.", flags: MessageFlags.Ephemeral });
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  let log;
  try {
    log = tasks.submit({ guildId, userId: i.user.id, typeId: i.options.getString("aufgabe"), quantity: i.options.getInteger("menge") ?? 1, note: i.options.getString("notiz") ?? "",
      proofKey: proofKeyOf(attachment) });
  } catch (error) {
    if (error instanceof TaskError) return i.editReply({ content: error.message });
    throw error;
  }
  const { profile, posted } = await postReviewCard({ db, client, config, log, attachment });
  return i.editReply({ embeds: [new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  AUFGABEN-LOG" }).setTitle(`📨 ${logTitle(log)} eingereicht`)
    .setDescription(`${log.reward_cents ? `Nach der Prüfung bekommst du **${formatMoney(log.reward_cents)}** aufs Familienkonto.` : "Wird nach der Prüfung gezählt."}${config.TASK_DM_ENABLED ? " Du bekommst eine DM, sobald das Team entschieden hat." : ""}`)
    .addFields({ name: "Deine Stufe", value: levelLine(profile.level), inline: false }, { name: "🔥 Serie", value: `${profile.streak} Tage`, inline: true }, { name: "Diese Woche", value: `${nLogs(profile.week.logs)} · ${formatMoney(profile.week.earned)}`, inline: true })
    .setFooter({ text: posted ? "Wartet auf Prüfung" : "Hinweis: Der Prüf-Channel ist nicht erreichbar – das Team sieht dein Log auf der Website." })] });
}

/** Nach einer Entscheidung (Discord oder Website): Karte aktualisieren, DM senden, Board auffrischen. */
export async function afterTaskDecision({ db, client, config, log, levelBefore = null }) {
  const tasks = service(db, config);
  if (log.channel_id && log.message_id) {
    const channel = await client.channels.fetch(log.channel_id).catch(() => null);
    const message = await channel?.messages?.fetch(log.message_id).catch(() => null);
    // Angehängter Screenshot bleibt beim Bearbeiten erhalten; das Embed verweist weiter darauf.
    const file = message?.attachments?.first?.()?.name ?? null;
    if (message) await message.edit({ embeds: [taskReviewCard(log, { imageName: file, imageUrl: file ? null : message.embeds?.[0]?.image?.url ?? null })], components: [] }).catch(() => {});
  }
  // Im Logbuch: Antwort unter dem Screenshot aktualisieren und Reaktion setzen.
  const raw = db.prepare("SELECT source_channel_id,source_message_id,prompt_message_id FROM task_logs WHERE id=?").get(log.id);
  if (raw?.source_channel_id) {
    const thread = await client.channels.fetch(raw.source_channel_id).catch(() => null);
    const prompt = raw.prompt_message_id ? await thread?.messages?.fetch(raw.prompt_message_id).catch(() => null) : null;
    const text = log.status === "approved" ? `✅ **${logTitle(log)}** bestätigt${log.reward_cents ? ` · **+${formatMoney(log.reward_cents)}** aufs Konto` : ""}` : `❌ **${logTitle(log)}** abgelehnt – ${log.reject_reason ?? "ohne Grund"}`;
    if (prompt) await prompt.edit({ content: text, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    const source = await thread?.messages?.fetch(raw.source_message_id).catch(() => null);
    if (source) await source.react(log.status === "approved" ? "✅" : "❌").catch(() => {});
  }
  if (config.TASK_DM_ENABLED && log.reviewer_id !== log.user_id) {
    const p = tasks.profile(log.guild_id, log.user_id);
    const levelUp = levelBefore && p.level.name !== levelBefore;
    const dm = log.status === "approved"
      ? new EmbedBuilder().setColor(GREEN).setAuthor({ name: "GAMBINOS  •  AUFGABEN-LOG" }).setTitle(`✅ ${logTitle(log)} bestätigt`)
        .setDescription(`${log.reward_cents ? `**+${formatMoney(log.reward_cents)}** sind auf deinem Familienkonto.` : "Dein Log wurde gezählt."}${levelUp ? `\n\n🎉 **Level-Up!** Du bist jetzt ${p.level.emoji} **${p.level.name}**.` : ""}`)
        .addFields({ name: "🔥 Serie", value: `${p.streak} ${p.streak === 1 ? "Tag" : "Tage"}`, inline: true }, { name: "📅 Woche", value: `${nLogs(p.week.logs)}${p.week.place ? ` · Platz ${p.week.place}` : ""}`, inline: true }, { name: "Stufe", value: levelLine(p.level) })
      : new EmbedBuilder().setColor(RED).setAuthor({ name: "GAMBINOS  •  AUFGABEN-LOG" }).setTitle(`❌ ${logTitle(log)} abgelehnt`).setDescription(`**Grund:** ${log.reject_reason ?? "—"}\n\nBei Fragen melde dich beim Team. Du kannst das Log mit einem passenden Screenshot neu einreichen.`);
    await client.users.fetch(log.user_id).then(user => user.send({ embeds: [dm.setTimestamp()] })).catch(() => {});
  }
  await refreshTaskBoard({ db, client, config }).catch(error => console.warn("Aufgaben-Board konnte nicht aktualisiert werden:", error.message));
}

const canReview = (i, config) => (config.BOT_OWNER_IDS ?? []).includes(i.user.id) || accessGroups(config).tasks.some(id => i.member?.roles?.cache?.has?.(id));
const isMember = (i, config) => { const g = accessGroups(config); return !g.members.length || (config.BOT_OWNER_IDS ?? []).includes(i.user.id) || [...g.members, ...g.anyStaff, ...g.tasks].some(id => i.member?.roles?.cache?.has?.(id)); };

/** Bestätigt oder lehnt ab und erledigt alles danach. Wirft TaskError bei ungültigen Zuständen. */
export async function decideTask({ db, client, config, guildId, id, actorId, approve, quantity = null, reason = "", owner = false }) {
  const tasks = service(db, config), before = tasks.get(guildId, id);
  const levelBefore = before ? levelFor(db.prepare("SELECT COUNT(*) n FROM task_logs WHERE guild_id=? AND user_id=? AND status='approved'").get(guildId, before.user_id).n).name : null;
  const log = approve
    ? tasks.approve({ guildId, id, actorId, finance: createFinance(db), quantity, allowSelf: owner })
    : tasks.reject({ guildId, id, actorId, reason, allowSelf: owner });
  await afterTaskDecision({ db, client, config, log, levelBefore });
  return log;
}

/** Alle Interaktionen mit customId „task:…“. */
export async function handleTaskInteraction({ i, db, client, config }) {
  const [, action, id] = i.customId.split(":");
  const reply = content => (i.deferred || i.replied ? i.followUp({ content, flags: MessageFlags.Ephemeral }) : i.reply({ content, flags: MessageFlags.Ephemeral }));
  if (action === "me") {
    if (!isMember(i, config)) return reply("Das ist nur für Familienmitglieder.");
    return i.reply({ embeds: [myTasksView(db, config, i.guildId, i.user.id)], flags: MessageFlags.Ephemeral });
  }
  if (["pick", "pickq", "skip"].includes(action)) {
    const source = await i.channel?.messages?.fetch(id).catch(() => null);
    if (source && source.author?.id !== i.user.id && !canReview(i, config)) return reply("Das kann nur die Person auswählen, die den Screenshot gepostet hat.");
    if (action === "skip") return i.update({ content: "Kein Log – alles gut.", components: [] }).then(() => i.message?.delete?.().catch(() => {}));
    const typeId = action === "pick" ? i.values[0] : i.customId.split(":")[3];
    const type = service(db, config).typeById(i.guildId, typeId);
    if (!type?.active) return reply("Diese Aufgabe gibt es nicht mehr.");
    if (action === "pick" && type.per_unit) return i.showModal(new ModalBuilder().setCustomId(`task:pickq:${id}:${typeId}`).setTitle(`${type.name}`.slice(0, 45)).addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("qty").setLabel(`Wie viele? (${type.unit})`.slice(0, 45)).setValue("1").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3))));
    let quantity = 1;
    if (action === "pickq") {
      quantity = Number(String(i.fields.getTextInputValue("qty")).trim());
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return reply("Bitte eine Zahl von 1 bis 999 eingeben.");
    }
    return submitFromLogbook({ i, db, client, config, messageId: id, typeId, quantity });
  }
  if (!canReview(i, config)) return reply("Aufgaben-Logs prüfen dürfen nur Aufgaben-Prüfer, Finanzen oder die Leitung.");
  const tasks = service(db, config), log = tasks.get(i.guildId, id);
  if (!log) return reply("Dieses Log gibt es nicht mehr.");
  if (log.status !== "pending") return reply("Dieses Log wurde bereits entschieden.");
  const owner = (config.BOT_OWNER_IDS ?? []).includes(i.user.id);
  if (action === "qty") return i.showModal(new ModalBuilder().setCustomId(`task:qtyset:${id}`).setTitle(`Menge – ${log.type_name}`.slice(0, 45)).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("qty").setLabel(`Richtige Anzahl (${log.type_unit})`.slice(0, 45)).setValue(String(log.quantity)).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3))));
  if (action === "no") return i.showModal(new ModalBuilder().setCustomId(`task:noset:${id}`).setTitle("Log ablehnen").addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Grund (bekommt das Mitglied per DM)").setPlaceholder("z. B. Datum und Uhrzeit nicht sichtbar").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(300))));
  try {
    let quantity = null, reason = "";
    if (action === "qtyset") {
      quantity = Number(String(i.fields.getTextInputValue("qty")).trim());
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return reply("Bitte eine Zahl von 1 bis 999 eingeben.");
    }
    if (action === "noset") reason = i.fields.getTextInputValue("reason");
    if (!["ok", "qtyset", "noset"].includes(action)) return reply("Unbekannte Aktion.");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const done = await decideTask({ db, client, config, guildId: i.guildId, id, actorId: i.user.id, approve: action !== "noset", quantity, reason, owner });
    return i.editReply({ content: done.status === "approved" ? `✅ Bestätigt: ${logTitle(done)} für <@${done.user_id}>${done.reward_cents ? ` · ${formatMoney(done.reward_cents)} gutgeschrieben` : ""}.` : `❌ Abgelehnt: ${logTitle(done)} von <@${done.user_id}>.`, allowedMentions: { parse: [] } });
  } catch (error) {
    if (error instanceof TaskError) return reply(error.message);
    throw error;
  }
}

/** Öffentliches Board: Aufgaben mit Belohnung, Top 5 der Woche, Anleitung. */
export function buildTaskBoard(db, config, guildId, reference = new Date()) {
  const tasks = service(db, config), types = tasks.listTypes(guildId);
  const week = weekStart(localDay(reference, config.TIMEZONE)), top = tasks.leaderboard(guildId, { since: week, limit: 5 }), sum = tasks.summary(guildId, reference);
  const commands = config.CHANNEL_BOT_COMMANDS ? ` in <#${config.CHANNEL_BOT_COMMANDS}>` : "";
  const embed = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  AUFGABEN" }).setTitle("📋 Aufgaben & Belohnungen")
    .setDescription(types.map(t => `${t.emoji} **${t.name}** · ${rewardLabel(t)}${t.daily_limit ? ` · max. ${t.daily_limit}×/Tag` : ""}`).join("\n").slice(0, 3500) || "Noch keine Aufgaben eingerichtet.")
    .addFields(
      { name: "🏆 Top-Farmer diese Woche", value: top.map((r, n) => `${MEDALS[n] ?? `**${n + 1}.**`} <@${r.userId}> · ${nLogs(r.logs)} · ${formatMoney(r.earned)}`).join("\n") || "Noch niemand – sei die/der Erste!" },
      { name: "So loggst du", value: `${config.CHANNEL_TASK_FORUM ? `Einfach den **Screenshot** in dein Logbuch in <#${config.CHANNEL_TASK_FORUM}> posten (ganzer Bildschirm mit Datum & Uhrzeit) und im Menü die Aufgabe wählen.` : `\`/log\`${commands} → Aufgabe wählen, **Screenshot** anhängen (ganzer Bildschirm mit Datum & Uhrzeit).`} Das Team prüft – die Belohnung landet automatisch auf deinem Familienkonto.` },
    )
    .setFooter({ text: `Diese Woche: ${sum.weekApproved} Logs · ${formatMoney(sum.weekPaid)} ausgezahlt · aktualisiert sich automatisch` });
  const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("task:me").setLabel("Meine Aufgaben").setEmoji("📊").setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}

/** Postet das Board einmal und bearbeitet es danach nur bei Änderungen. */
export async function refreshTaskBoard({ db, client, config, force = false }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId || !config.CHANNEL_TASK_BOARD) return false;
  const payload = buildTaskBoard(db, config, guildId);
  const hash = createHash("sha256").update(JSON.stringify(payload.embeds.map(e => [e.data.description, e.data.fields, e.data.footer])) + config.CHANNEL_TASK_BOARD).digest("hex");
  if (!force && getSetting(db, guildId, BOARD_HASH) === hash) return false;
  const channel = await client.channels.fetch(config.CHANNEL_TASK_BOARD).catch(() => null);
  if (!channel?.send) return false;
  const [storedChannel, storedMessage] = String(getSetting(db, guildId, BOARD_MESSAGE) ?? "").split(":");
  const existing = storedChannel === channel.id && storedMessage ? await channel.messages?.fetch(storedMessage).catch(() => null) : null;
  if (existing) await existing.edit(payload);
  else { const message = await channel.send(payload); setSetting(db, guildId, BOARD_MESSAGE, `${channel.id}:${message.id}`); }
  setSetting(db, guildId, BOARD_HASH, hash);
  return true;
}
