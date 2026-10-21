import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import { accessGroups } from "./config.js";
import { audit } from "./database.js";
import { localDay } from "./services/absences.js";
import { zonedTime } from "./services/event-series.js";

/**
 * Event-Nachweise: Bilder im Event-Logbuch-Forum werden einem Event zugeordnet. Der Bot fragt per Menü, zu welchem
 * Event das Bild gehört (alle Events von heute, kurz nach Mitternacht auch die von gestern Abend; angemeldete zuerst).
 * Es wird immer gefragt – nichts automatisch. Die Nachweise erscheinen bei der Anwesenheit und auf der Website.
 */
const LATE_NIGHT = 8 * 3_600_000;
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const imagesOf = message => [...(message.attachments?.values?.() ?? [])].filter(a => /^image\//.test(a.contentType ?? "") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.name ?? ""));
const clock = (iso, timezone) => new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
const day = (iso, timezone) => new Intl.DateTimeFormat("de-AT", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: timezone }).format(new Date(iso));

/** Mitternacht (Server-Zeitzone) des Tages, auf den reference fällt, plus offset Tage. */
function midnight(reference, timezone, offset = 0) {
  const [y, m, d] = localDay(reference, timezone).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + offset));
  return zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, timezone) ?? new Date(date.getTime());
}

/**
 * Passende Events: alle von heute (Server-Zeitzone), damit man auch später noch nachreichen kann; dazu Events,
 * die in den letzten 8 Std. begonnen haben (Bild kurz nach Mitternacht). Auch Events mit abgeschlossener Anwesenheit.
 */
export function candidateEvents(db, { guildId, userId, reference = new Date(), timezone = "Europe/Vienna" }) {
  const start = midnight(reference, timezone);
  const from = new Date(Math.min(start.getTime(), reference.getTime() - LATE_NIGHT)).toISOString(), until = midnight(reference, timezone, 1).toISOString();
  const rows = db.prepare(`SELECT e.*, EXISTS(SELECT 1 FROM event_participants p WHERE p.event_id=e.id AND p.user_id=? AND p.status IN ('signed_up','present')) AS joined
    FROM events e WHERE e.guild_id=? AND e.status IN ('scheduled','ended') AND e.starts_at>=? AND e.starts_at<?`).all(userId, guildId, from, until);
  const distance = e => Math.abs(new Date(e.starts_at).getTime() - reference.getTime());
  return rows.sort((a, b) => b.joined - a.joined || distance(a) - distance(b)).slice(0, 25);
}

const eventLabel = (event, timezone) => `${event.name}`.slice(0, 80) + ` · ${clock(event.starts_at, timezone)}`;

/** Antwort unter dem Bild: Zuordnung anzeigen bzw. Auswahl anbieten. */
export function proofPrompt(db, config, proof, candidates) {
  const event = proof.event_id ? db.prepare("SELECT * FROM events WHERE id=?").get(proof.event_id) : null;
  const others = candidates.filter(e => e.id !== proof.event_id);
  const content = event
    ? `✅ Event-Log für **${event.name}** (${day(event.starts_at, config.TIMEZONE)}, ${clock(event.starts_at, config.TIMEZONE)})`
    : candidates.length ? "📸 **Zu welchem Event gehört das?**" : "📸 Heute gibt es (noch) kein Event. Das Bild bleibt gespeichert – das Team kann es auf der Website zuordnen.";
  const options = (event ? others : candidates).map(e => ({ label: eventLabel(e, config.TIMEZONE).slice(0, 100), value: e.id, description: `${e.joined ? "✅ angemeldet · " : ""}Beginn ${day(e.starts_at, config.TIMEZONE)} ${clock(e.starts_at, config.TIMEZONE)}${e.status === "ended" ? " · vorbei" : ""}`.slice(0, 100) }));
  const components = options.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`evp:pick:${proof.message_id}`)
    .setPlaceholder(event ? "Falsches Event? Anderes wählen …" : "Event auswählen …").addOptions(options))] : [];
  return { content, components, allowedMentions: { parse: [] } };
}

function assign(db, { proof, eventId, actorId }) {
  db.prepare("UPDATE event_proofs SET event_id=?,assigned_by=?,updated_at=? WHERE message_id=?").run(eventId, actorId, new Date().toISOString(), proof.message_id);
  audit(db, proof.guild_id, actorId, "event.proof", proof.user_id, { eventId, messageId: proof.message_id });
  return db.prepare("SELECT * FROM event_proofs WHERE message_id=?").get(proof.message_id);
}

/** Bild im Event-Logbuch: speichern und fragen, zu welchem Event es gehört. */
export async function handleEventProofMessage({ db, config, message, reference = new Date() }) {
  const images = imagesOf(message);
  if (!images.length) return false;
  const now = reference.toISOString();
  db.prepare("INSERT OR IGNORE INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?)")
    .run(message.id, message.guildId, message.author.id, message.channelId ?? message.channel?.id, images.length, now, now);
  const proof = db.prepare("SELECT * FROM event_proofs WHERE message_id=?").get(message.id);
  const candidates = candidateEvents(db, { guildId: message.guildId, userId: message.author.id, reference, timezone: config.TIMEZONE });
  const reply = await message.reply(proofPrompt(db, config, proof, candidates)).catch(() => null);
  if (reply) db.prepare("UPDATE event_proofs SET prompt_message_id=? WHERE message_id=?").run(reply.id, message.id);
  return true;
}

const isTeam = (i, config) => (config.BOT_OWNER_IDS ?? []).includes(i.user.id) || accessGroups(config).events.some(id => i.member?.roles?.cache?.has?.(id));

/** Auswahl „evp:pick:<Nachricht>“: nur die Person selbst oder das Event-Team. */
export async function handleEventProofInteraction({ i, db, config }) {
  const [, action, messageId] = i.customId.split(":");
  if (action !== "pick") return i.reply({ content: "Unbekannte Aktion.", flags: MessageFlags.Ephemeral });
  const proof = db.prepare("SELECT * FROM event_proofs WHERE message_id=?").get(messageId);
  if (!proof) return i.reply({ content: "Dieses Bild gibt es nicht mehr.", flags: MessageFlags.Ephemeral });
  if (proof.user_id !== i.user.id && !isTeam(i, config)) return i.reply({ content: "Das kann nur die Person auswählen, die das Bild gepostet hat.", flags: MessageFlags.Ephemeral });
  const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status IN ('scheduled','ended')").get(i.values[0], proof.guild_id);
  if (!event) return i.reply({ content: "Dieses Event gibt es nicht mehr.", flags: MessageFlags.Ephemeral });
  const updated = assign(db, { proof, eventId: event.id, actorId: i.user.id });
  return i.update(proofPrompt(db, config, updated, candidateEvents(db, { guildId: proof.guild_id, userId: proof.user_id, reference: new Date(proof.created_at), timezone: config.TIMEZONE })));
}

/** Nachweise je Person für ein Event (Anzahl Bilder). */
export const proofsByUser = (db, eventId) => new Map(db.prepare("SELECT user_id, SUM(images) n FROM event_proofs WHERE event_id=? GROUP BY user_id").all(eventId).map(r => [r.user_id, r.n]));
export const proofMessages = (db, eventId) => db.prepare("SELECT * FROM event_proofs WHERE event_id=? ORDER BY user_id,created_at").all(eventId);
export { unix };

/**
 * Event-Logs eines Tages (Server-Zeitzone) für die Website: pro Event die Bilder und wer angemeldet ist, aber
 * keinen Log gepostet hat; dazu nicht zugeordnete Bilder des Tages.
 */
export function eventLogDay(db, { guildId, day, timezone = "Europe/Vienna" }) {
  const [y, m, d] = day.split("-").map(Number);
  const from = midnight(new Date(Date.UTC(y, m - 1, d, 12)), timezone), until = midnight(new Date(Date.UTC(y, m - 1, d, 12)), timezone, 1);
  const proofs = eventId => db.prepare("SELECT message_id AS messageId, user_id AS userId, images, created_at AS createdAt FROM event_proofs WHERE event_id=? ORDER BY created_at").all(eventId);
  const events = db.prepare("SELECT id,name,starts_at,status,attendance_closed_at FROM events WHERE guild_id=? AND status IN ('scheduled','ended') AND starts_at>=? AND starts_at<? ORDER BY starts_at")
    .all(guildId, from.toISOString(), until.toISOString()).map(e => {
      const list = proofs(e.id), posted = new Set(list.map(p => p.userId));
      const joined = db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(e.id).map(r => r.user_id);
      return { id: e.id, name: e.name, startsAt: e.starts_at, status: e.status, closed: Boolean(e.attendance_closed_at), proofs: list, people: posted.size, missing: joined.filter(id => !posted.has(id)) };
    });
  const unassigned = db.prepare("SELECT message_id AS messageId, user_id AS userId, images, created_at AS createdAt FROM event_proofs WHERE guild_id=? AND event_id IS NULL AND created_at>=? AND created_at<? ORDER BY created_at")
    .all(guildId, from.toISOString(), until.toISOString());
  return { day, events, unassigned };
}

/** Zuordnung von der Website (Event-Team): wie im Menü, danach die Antwort unter dem Bild in Discord aktualisieren. */
export async function assignProofFromWeb({ db, client, config, guildId, messageId, eventId, actorId }) {
  const proof = db.prepare("SELECT * FROM event_proofs WHERE message_id=? AND guild_id=?").get(messageId, guildId);
  if (!proof) return { error: "Dieses Bild gibt es nicht mehr." };
  const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status IN ('scheduled','ended')").get(eventId, guildId);
  if (!event) return { error: "Dieses Event gibt es nicht (mehr)." };
  const updated = assign(db, { proof, eventId: event.id, actorId });
  await refreshProofPrompt({ db, client, config, proof: updated });
  return { proof: updated, event };
}

/** Antwort unter dem Bild in Discord neu aufbauen (aktuelle Zuordnung, alle Events des Tages zur Auswahl). */
export async function refreshProofPrompt({ db, client, config, proof }) {
  if (!proof.prompt_message_id) return false;
  const channel = await client.channels.fetch(proof.channel_id).catch(() => null);
  const prompt = await channel?.messages?.fetch(proof.prompt_message_id).catch(() => null);
  if (!prompt) return false;
  return prompt.edit(proofPrompt(db, config, proof, candidateEvents(db, { guildId: proof.guild_id, userId: proof.user_id, reference: new Date(proof.created_at), timezone: config.TIMEZONE }))).then(() => true).catch(() => false);
}

/** Event-Log löschen (Website, Event-Team): Bild und Bot-Antwort in Discord entfernen, Eintrag löschen. */
export async function deleteProofFromWeb({ db, client, guildId, messageId, actorId }) {
  const proof = db.prepare("SELECT * FROM event_proofs WHERE message_id=? AND guild_id=?").get(messageId, guildId);
  if (!proof) return { error: "Dieses Bild gibt es nicht mehr." };
  const channel = await client.channels.fetch(proof.channel_id).catch(() => null);
  let discord = true;
  for (const id of [proof.message_id, proof.prompt_message_id].filter(Boolean)) {
    const message = await channel?.messages?.fetch(id).catch(() => null);
    if (message && !(await message.delete().then(() => true).catch(() => false))) discord = false;
  }
  db.prepare("DELETE FROM event_proofs WHERE message_id=?").run(messageId);
  audit(db, guildId, actorId, "event.proof_deleted", proof.user_id, { eventId: proof.event_id, messageId });
  return { proof, discord };
}

/** Angemeldete ohne Event-Log für ein Event (Anmeldung offen oder anwesend, kein Bild zugeordnet). */
export const missingLogs = (db, eventId) => db.prepare(`SELECT p.user_id FROM event_participants p WHERE p.event_id=? AND p.status IN ('signed_up','present')
  AND NOT EXISTS(SELECT 1 FROM event_proofs x WHERE x.event_id=p.event_id AND x.user_id=p.user_id) ORDER BY p.updated_at`).all(eventId).map(r => r.user_id);

/**
 * EVENT_LOG_REMINDER_MINUTES nach Eventbeginn: jeder Angemeldete ohne Bild bekommt einmal eine DM mit Link zu seinem
 * Event-Logbuch. Nur Events der letzten 12 Std. (keine Flut alter Events nach dem Update).
 */
export async function remindMissingEventLogs({ db, client, config, reference = new Date() }) {
  const minutes = config.EVENT_LOG_REMINDER_MINUTES ?? 0, guildId = config.DISCORD_GUILD_ID;
  if (!minutes || !guildId || !config.CHANNEL_EVENT_FORUM) return 0;
  const due = new Date(reference.getTime() - minutes * 60_000).toISOString(), oldest = new Date(reference.getTime() - minutes * 60_000 - 12 * 3_600_000).toISOString();
  let sent = 0;
  for (const event of db.prepare("SELECT * FROM events WHERE guild_id=? AND status IN ('scheduled','ended') AND log_reminder_at IS NULL AND starts_at<=? AND starts_at>=? ORDER BY starts_at LIMIT 10").all(guildId, due, oldest)) {
    // Erst markieren, damit ein Neustart mitten im Versand niemanden doppelt anschreibt.
    if (!db.prepare("UPDATE events SET log_reminder_at=? WHERE id=? AND log_reminder_at IS NULL").run(reference.toISOString(), event.id).changes) continue;
    const missing = missingLogs(db, event.id);
    for (const userId of missing) {
      const thread = db.prepare("SELECT thread_id FROM event_logbooks WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL AND archived_at IS NULL").get(guildId, userId)?.thread_id;
      const where = thread ? `in dein Event-Logbuch <#${thread}>` : `in dein Event-Logbuch im Forum <#${config.CHANNEL_EVENT_FORUM}>`;
      const ok = await client.users.fetch(userId).then(user => user.send({ content: `📸 **Dein Event-Log fehlt:** ${event.name} (${day(event.starts_at, config.TIMEZONE)}, ${clock(event.starts_at, config.TIMEZONE)}).\nBitte das Bild (ganzer Bildschirm mit Datum & Uhrzeit) ${where} posten und im Menü das Event wählen – sonst zählt die Teilnahme evtl. nicht.` })).then(() => true).catch(() => false);
      if (ok) sent++;
      await new Promise(r => setTimeout(r, 300));
    }
    if (missing.length) audit(db, guildId, client.user?.id ?? "system", "event.log_reminder", event.id, { name: event.name, missing: missing.length });
  }
  return sent;
}
