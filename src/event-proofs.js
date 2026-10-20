import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import { accessGroups } from "./config.js";
import { audit } from "./database.js";

/**
 * Event-Nachweise: Bilder im Event-Logbuch-Forum werden einem Event zugeordnet. Der Bot fragt per Menü, zu welchem
 * Event das Bild gehört (nur laufende, gleich beginnende oder kürzlich begonnene Events; angemeldete zuerst).
 * Gibt es genau ein passendes Event, wird direkt zugeordnet. Die Nachweise erscheinen bei der Anwesenheit.
 */
const WINDOW_BEFORE = 60 * 60_000, WINDOW_AFTER = 8 * 3_600_000;
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const imagesOf = message => [...(message.attachments?.values?.() ?? [])].filter(a => /^image\//.test(a.contentType ?? "") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.name ?? ""));
const clock = (iso, timezone) => new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
const day = (iso, timezone) => new Intl.DateTimeFormat("de-AT", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: timezone }).format(new Date(iso));

/** Passende Events zum Zeitpunkt: beginnen in der nächsten Stunde oder haben in den letzten 8 Std. begonnen, Anwesenheit noch offen. */
export function candidateEvents(db, { guildId, userId, reference = new Date() }) {
  const from = new Date(reference.getTime() - WINDOW_AFTER).toISOString(), until = new Date(reference.getTime() + WINDOW_BEFORE).toISOString();
  const rows = db.prepare(`SELECT e.*, EXISTS(SELECT 1 FROM event_participants p WHERE p.event_id=e.id AND p.user_id=? AND p.status IN ('signed_up','present')) AS joined
    FROM events e WHERE e.guild_id=? AND e.status IN ('scheduled','ended') AND e.attendance_closed_at IS NULL AND e.starts_at>=? AND e.starts_at<=?`).all(userId, guildId, from, until);
  const distance = e => Math.abs(new Date(e.starts_at).getTime() - reference.getTime());
  return rows.sort((a, b) => b.joined - a.joined || distance(a) - distance(b)).slice(0, 25);
}

const eventLabel = (event, timezone) => `${event.name}`.slice(0, 80) + ` · ${clock(event.starts_at, timezone)}`;

/** Antwort unter dem Bild: Zuordnung anzeigen bzw. Auswahl anbieten. */
export function proofPrompt(db, config, proof, candidates) {
  const event = proof.event_id ? db.prepare("SELECT * FROM events WHERE id=?").get(proof.event_id) : null;
  const closed = Boolean(event?.attendance_closed_at);
  const others = candidates.filter(e => e.id !== proof.event_id);
  const content = event
    ? `✅ Event-Log für **${event.name}** (${day(event.starts_at, config.TIMEZONE)}, ${clock(event.starts_at, config.TIMEZONE)})${closed ? " · Anwesenheit abgeschlossen" : ""}`
    : candidates.length ? "📸 **Zu welchem Event gehört das?**" : "📸 Gerade läuft kein Event. Das Bild bleibt gespeichert – das Team kann es zuordnen.";
  const options = (event ? others : candidates).map(e => ({ label: eventLabel(e, config.TIMEZONE).slice(0, 100), value: e.id, description: `${e.joined ? "✅ angemeldet · " : ""}Beginn <${day(e.starts_at, config.TIMEZONE)} ${clock(e.starts_at, config.TIMEZONE)}>`.replace(/[<>]/g, "").slice(0, 100) }));
  const components = !closed && options.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`evp:pick:${proof.message_id}`)
    .setPlaceholder(event ? "Falsches Event? Anderes wählen …" : "Event auswählen …").addOptions(options))] : [];
  return { content, components, allowedMentions: { parse: [] } };
}

function assign(db, { proof, eventId, actorId }) {
  db.prepare("UPDATE event_proofs SET event_id=?,assigned_by=?,updated_at=? WHERE message_id=?").run(eventId, actorId, new Date().toISOString(), proof.message_id);
  audit(db, proof.guild_id, actorId, "event.proof", proof.user_id, { eventId, messageId: proof.message_id });
  return db.prepare("SELECT * FROM event_proofs WHERE message_id=?").get(proof.message_id);
}

/** Bild im Event-Logbuch: speichern, bei genau einem passenden Event direkt zuordnen, sonst fragen. */
export async function handleEventProofMessage({ db, config, message, reference = new Date() }) {
  const images = imagesOf(message);
  if (!images.length) return false;
  const now = reference.toISOString();
  db.prepare("INSERT OR IGNORE INTO event_proofs(message_id,guild_id,event_id,user_id,channel_id,images,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?)")
    .run(message.id, message.guildId, message.author.id, message.channelId ?? message.channel?.id, images.length, now, now);
  let proof = db.prepare("SELECT * FROM event_proofs WHERE message_id=?").get(message.id);
  const candidates = candidateEvents(db, { guildId: message.guildId, userId: message.author.id, reference });
  if (candidates.length === 1) proof = assign(db, { proof, eventId: candidates[0].id, actorId: message.author.id });
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
  const current = proof.event_id ? db.prepare("SELECT attendance_closed_at FROM events WHERE id=?").get(proof.event_id) : null;
  if (current?.attendance_closed_at) return i.reply({ content: "Die Anwesenheit für dieses Event ist schon abgeschlossen.", flags: MessageFlags.Ephemeral });
  const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND attendance_closed_at IS NULL AND status IN ('scheduled','ended')").get(i.values[0], proof.guild_id);
  if (!event) return i.reply({ content: "Dieses Event ist nicht mehr offen.", flags: MessageFlags.Ephemeral });
  const updated = assign(db, { proof, eventId: event.id, actorId: i.user.id });
  return i.update(proofPrompt(db, config, updated, candidateEvents(db, { guildId: proof.guild_id, userId: proof.user_id, reference: new Date(proof.created_at) })));
}

/** Nachweise je Person für ein Event (Anzahl Bilder). */
export const proofsByUser = (db, eventId) => new Map(db.prepare("SELECT user_id, SUM(images) n FROM event_proofs WHERE event_id=? GROUP BY user_id").all(eventId).map(r => [r.user_id, r.n]));
export const proofMessages = (db, eventId) => db.prepare("SELECT * FROM event_proofs WHERE event_id=? ORDER BY user_id,created_at").all(eventId);
export { unix };
