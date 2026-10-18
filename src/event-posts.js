import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { splitAndSendDms } from "./reminder-prefs.js";
import { colorNumber, defaultsFor, panelTexts } from "./services/texts.js";
import { describeSchedule } from "./services/event-series.js";
import { numberedMentions } from "./presentation.js";

/*
 * Alle Discord-Posts eines Events an einer Stelle:
 * - Event-Karte mit Teilnehmen/Abmelden im Anmelde-Channel (CHANNEL_EVENT_SIGNUP, sonst Ankündigungs-Channel)
 * - kurze Ankündigung mit Link zur Karte im Ankündigungs-Channel, falls beide Channels verschieden sind
 * - Erinnerungen als Antwort auf die Karte, nur an die Angemeldeten
 * Texte sind über die Website anpassbar (Panel-Texte → Events).
 */
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const STATE = { ended: { prefix: "🏁 Beendet · ", color: 0x7f8c8d }, cancelled: { prefix: "❌ Abgesagt · ", color: 0xe74c3c } };

/** Platzhalter in Texten: {name} {zeit} {uhrzeit} {relativ} {treffpunkt} {anmeldung}. */
export function fillTemplate(template, event, { link = "", reference = new Date() } = {}) {
  const t = unix(event.starts_at);
  // {minuten}: feste Zahl zum Sendezeitpunkt – anders als {relativ} rechnet Discord sie später nicht um.
  const minutes = Math.max(0, Math.round((new Date(event.starts_at).getTime() - reference.getTime()) / 60_000));
  return String(template ?? "").replaceAll("{minuten}", String(minutes))
    .replaceAll("{name}", event.name).replaceAll("{zeit}", `<t:${t}:F>`).replaceAll("{uhrzeit}", `<t:${t}:t>`)
    .replaceAll("{relativ}", `<t:${t}:R>`).replaceAll("{treffpunkt}", event.location || "—").replaceAll("{anmeldung}", link || "");
}

const participantsOf = (db, eventId) => db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(eventId);
const seriesOf = (db, event) => (event.series_id ? db.prepare("SELECT * FROM event_series WHERE id=?").get(event.series_id) : null);

export function eventCardPayload({ event, participants = [], texts = defaultsFor("events"), state = event.status, series = null, botId = null }) {
  const look = STATE[state];
  const embed = new EmbedBuilder().setColor(look?.color ?? colorNumber(texts.color || "#d4af37"))
    .setTitle(`${look?.prefix ?? "📅 "}${event.name}`.slice(0, 256)).setTimestamp();
  if (texts.author) embed.setAuthor({ name: texts.author });
  if (event.description && !event.description.startsWith("Wiederkehrende Familienaktivität")) embed.setDescription(event.description.slice(0, 4000));
  const fields = [{ name: "🕒 Beginn", value: `<t:${unix(event.starts_at)}:F>\n<t:${unix(event.starts_at)}:R>`, inline: true }];
  if (event.location) fields.push({ name: "📍 Treffpunkt", value: event.location.slice(0, 1024), inline: true });
  if (event.host_id && event.host_id !== botId && !event.series_id) fields.push({ name: "👤 Veranstalter", value: `<@${event.host_id}>`, inline: true });
  if (event.equipment) fields.push({ name: "🧰 Ausrüstung", value: event.equipment.slice(0, 1024), inline: false });
  if (event.notes && event.notes !== "Automatisch aus dem Aktivitätenplan erstellt.") fields.push({ name: "ℹ️ Hinweise", value: event.notes.slice(0, 1024), inline: false });
  const list = numberedMentions(participants.map(p => p.user_id), { empty: texts.emptyParticipants || "—" });
  fields.push({ name: `🙋 ${texts.participantsLabel || "Teilnehmende"} (${participants.length}${event.max_participants ? `/${event.max_participants}` : ""}${event.min_participants ? ` · mind. ${event.min_participants}` : ""})`, value: list.slice(0, 1024), inline: false });
  embed.addFields(fields);
  const footer = series ? `${texts.seriesFooter || "Wiederkehrende Aktivität"} · ${describeSchedule(series)}` : texts.footer;
  if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
  const components = !look ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:join:${event.id}`).setLabel(texts.joinButton || "Teilnehmen").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`event:leave:${event.id}`).setLabel(texts.leaveButton || "Abmelden").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`event:dm:${event.id}`).setLabel(texts.dmButton || "🔔 Erinnerung per DM").setStyle(ButtonStyle.Secondary),
  )] : [];
  return { embeds: [embed], components };
}

function announcementPayload({ event, texts, link, pingRoles = [], state = event.status }) {
  const look = STATE[state];
  const embed = new EmbedBuilder().setColor(look?.color ?? colorNumber(texts.color || "#d4af37"))
    .setDescription(`${look ? `${look.prefix}**${event.name}**` : fillTemplate(texts.announceText, event, { link })}`.slice(0, 4000));
  if (texts.author) embed.setAuthor({ name: texts.author });
  const components = link && !look ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel(texts.announceButton || "Zur Anmeldung"))] : [];
  return { content: !look && pingRoles.length ? pingRoles.map(id => `<@&${id}>`).join(" ") : undefined, embeds: [embed], components, allowedMentions: { roles: look ? [] : pingRoles } };
}

const getChannel = (client, id) => (id && client.channels?.fetch ? client.channels.fetch(id).catch(() => null) : Promise.resolve(null));
const messageLink = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
async function fetchMessage(client, channelId, messageId) {
  if (!channelId || !messageId) return null;
  const channel = await getChannel(client, channelId);
  return channel ? channel.messages.fetch(messageId).catch(() => null) : null;
}

/**
 * Veröffentlicht Karte (+ Ankündigung). Gibt die IDs zurück; der Aufrufer speichert sie.
 * Wirft, wenn die Karte nicht gesendet werden kann (dann wird nichts gespeichert).
 */
export async function publishEvent({ db, client, config, event, fallbackChannel = null }) {
  const texts = panelTexts(db, config.DISCORD_GUILD_ID, "events");
  const signupId = config.CHANNEL_EVENT_SIGNUP || config.CHANNEL_EVENT_ANNOUNCEMENTS;
  const signup = (await getChannel(client, signupId)) ?? fallbackChannel;
  if (typeof signup?.send !== "function") throw new Error("Kein erreichbarer Event-Channel eingestellt (Einstellungen → Channels → Event-Anmeldung / Event-Ankündigungen).");
  const pingRoles = config.EVENT_PING_ROLES ?? [];
  const announceSeparately = config.CHANNEL_EVENT_ANNOUNCEMENTS && config.CHANNEL_EVENT_ANNOUNCEMENTS !== signup.id;
  const card = eventCardPayload({ event, texts, series: seriesOf(db, event), botId: client.user?.id });
  if (!announceSeparately && pingRoles.length) Object.assign(card, { content: pingRoles.map(id => `<@&${id}>`).join(" "), allowedMentions: { roles: pingRoles } });
  const message = await signup.send(card);
  let announcement = null;
  if (announceSeparately) {
    const channel = await getChannel(client, config.CHANNEL_EVENT_ANNOUNCEMENTS);
    const link = messageLink(signup.guildId ?? config.DISCORD_GUILD_ID, signup.id, message.id);
    announcement = channel ? await channel.send(announcementPayload({ event, texts, link, pingRoles })).catch(error => { console.warn("Event-Ankündigung fehlgeschlagen:", error.message); return null; }) : null;
  }
  return { channelId: signup.id, messageId: message.id, announceChannelId: announcement?.channelId ?? null, announceMessageId: announcement?.id ?? null, message, announcement };
}

/** Speichert die Post-IDs eines Events. */
export function storeEventPosts(db, eventId, posted) {
  db.prepare("UPDATE events SET channel_id=?,message_id=?,announce_channel_id=?,announce_message_id=? WHERE id=?").run(posted.channelId, posted.messageId, posted.announceChannelId, posted.announceMessageId, eventId);
}

export async function deleteEventPosts({ client, posted }) {
  await posted.message?.delete().catch(() => {});
  await posted.announcement?.delete().catch(() => {});
}

/**
 * Aktualisiert Karte und Ankündigung nach Änderungen, Anmeldungen oder Statuswechsel. Bei beendeten automatischen
 * Aktivitäten werden die Posts auf Wunsch gelöscht (EVENT_SERIES_DELETE_ENDED); Daten bleiben in der Datenbank.
 */
export async function refreshEventPosts({ db, client, config, event, state = event.status, cardOnly = false }) {
  const texts = panelTexts(db, config.DISCORD_GUILD_ID, "events");
  const card = await fetchMessage(client, event.channel_id, event.message_id);
  const announcement = cardOnly ? null : await fetchMessage(client, event.announce_channel_id, event.announce_message_id);
  if (event.series_id && state !== "scheduled" && config.EVENT_SERIES_DELETE_ENDED) {
    await card?.delete?.()?.catch?.(() => {}); await announcement?.delete?.()?.catch?.(() => {});
    return Boolean(card);
  }
  if (card) await card.edit({ ...eventCardPayload({ event, participants: participantsOf(db, event.id), texts, state, series: seriesOf(db, event), botId: client.user?.id }), content: state === "scheduled" ? card.content || null : null, allowedMentions: { parse: [] } }).catch(() => {});
  if (announcement) {
    const link = card ? messageLink(card.guildId ?? config.DISCORD_GUILD_ID, card.channelId, card.id) : "";
    await announcement.edit({ ...announcementPayload({ event, texts, link, state }), content: state === "scheduled" ? announcement.content || null : null, allowedMentions: { parse: [] } }).catch(() => {});
  }
  return Boolean(card);
}

/** Erinnerung als Antwort auf die Event-Karte; erwähnt nur Angemeldete. */
export async function sendEventReminder({ db, client, config, event }) {
  const texts = panelTexts(db, config.DISCORD_GUILD_ID, "events");
  const all = participantsOf(db, event.id).slice(0, 50).map(p => p.user_id);
  // Ohne Anmeldungen gibt es niemanden zu erinnern – keine leeren Erinnerungen im Channel.
  if (!all.length) return false;
  const card = await fetchMessage(client, event.channel_id, event.message_id);
  const embed = new EmbedBuilder().setColor(colorNumber(texts.color || "#d4af37"))
    .setDescription(`${fillTemplate(texts.reminderText, event)}${event.location ? `\n📍 ${event.location}` : ""}${event.equipment ? `\n🧰 ${event.equipment}` : ""}`.slice(0, 4000));
  // Wer Erinnerungen per DM möchte, bekommt sie privat und wird im Channel nicht erwähnt.
  const link = card?.url ?? (event.channel_id && event.message_id && config.DISCORD_GUILD_ID ? `https://discord.com/channels/${config.DISCORD_GUILD_ID}/${event.channel_id}/${event.message_id}` : null);
  const participants = await splitAndSendDms({ db, client, guildId: event.guild_id ?? config.DISCORD_GUILD_ID, userIds: all, embed, link });
  // Im Channel wird die Familienrolle markiert statt jede angemeldete Person einzeln (Event-Ping-Rolle, sonst Familienrolle).
  const roles = (config.EVENT_PING_ROLES?.length ? config.EVENT_PING_ROLES : config.ROLE_MEMBERS ?? []).slice(0, 5);
  const payload = roles.length
    ? { content: roles.map(id => `<@&${id}>`).join(" "), embeds: [embed], allowedMentions: { roles, repliedUser: false } }
    : { content: participants.length ? participants.map(id => `<@${id}>`).join(" ") : undefined, embeds: [embed], allowedMentions: { users: participants, repliedUser: false } };
  // Nur die neueste Erinnerung bleibt stehen; die vorige wird gelöscht (hält den Event-Channel sauber).
  await deleteReminder({ db, client, event });
  const channel = card ? null : await getChannel(client, event.channel_id);
  const sent = card ? await card.reply(payload).catch(error => { console.warn(`Event-Erinnerung ${event.id} fehlgeschlagen:`, error.message); return null; })
    : channel ? await channel.send(payload).catch(() => null) : null;
  if (sent?.id) db.prepare("UPDATE events SET reminder_channel_id=?,reminder_message_id=? WHERE id=?").run(sent.channelId ?? sent.channel?.id ?? event.channel_id, sent.id, event.id);
  return Boolean(sent);
}

/** Löscht die zuletzt gesendete Erinnerung eines Events (falls vorhanden). */
export async function deleteReminder({ db, client, event }) {
  const row = db.prepare("SELECT reminder_channel_id,reminder_message_id FROM events WHERE id=?").get(event.id);
  if (!row?.reminder_message_id) return false;
  db.prepare("UPDATE events SET reminder_channel_id=NULL,reminder_message_id=NULL WHERE id=?").run(event.id);
  const message = await fetchMessage(client, row.reminder_channel_id, row.reminder_message_id);
  return Boolean(await message?.delete?.().then(() => true).catch(() => false));
}

/** Erinnerungen von Events, die begonnen haben, abgesagt oder beendet sind, verschwinden aus dem Channel. */
export async function cleanupReminders({ db, client, reference = new Date() }) {
  const rows = db.prepare("SELECT id FROM events WHERE reminder_message_id IS NOT NULL AND (starts_at<=? OR status<>'scheduled') LIMIT 25").all(reference.toISOString());
  for (const row of rows) await deleteReminder({ db, client, event: row });
  return rows.length;
}
