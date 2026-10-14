import { randomUUID } from "node:crypto";
import { EmbedBuilder } from "discord.js";
import { audit } from "./database.js";
import { zonedTime } from "./services/event-series.js";

const SNOWFLAKE = /^\d{17,20}$/;
const COLOR = /^#?[0-9a-f]{6}$/i;
const MAX_DAYS_AHEAD = 60;

export class AnnouncementError extends Error {}

/**
 * Prüft eine Ankündigung von der Website. Mindestens Text oder Embed-Titel/-Beschreibung; Bild nur per https.
 * @everyone/@here darf nur die Leitung erwähnen.
 */
export function validateAnnouncement(input, { allowEveryone = false, reference = new Date(), timezone = "Europe/Vienna" } = {}) {
  const str = (value, max, label) => {
    const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
    if (text.length > max) throw new AnnouncementError(`${label}: höchstens ${max} Zeichen (aktuell ${text.length}).`);
    return text;
  };
  const channelId = String(input.channelId ?? "");
  if (!SNOWFLAKE.test(channelId)) throw new AnnouncementError("Bitte einen Channel auswählen.");
  const content = str(input.content, 1800, "Text");
  const embed = {
    title: str(input.title, 256, "Titel"),
    description: str(input.description, 4000, "Beschreibung"),
    footer: str(input.footer, 200, "Fußzeile"),
    color: COLOR.test(String(input.color ?? "")) ? `#${String(input.color).replace("#", "").toLowerCase()}` : "#d4af37",
    imageUrl: str(input.imageUrl, 500, "Bild-Link"),
  };
  if (embed.imageUrl && !/^https:\/\/[^\s]+$/i.test(embed.imageUrl)) throw new AnnouncementError("Bild-Link: bitte eine https://-Adresse angeben.");
  if (!content && !embed.title && !embed.description) throw new AnnouncementError("Bitte einen Text oder Titel/Beschreibung für die Karte angeben.");
  const pingRoleIds = [...new Set((Array.isArray(input.pingRoleIds) ? input.pingRoleIds : []).map(String))];
  if (pingRoleIds.some(id => !SNOWFLAKE.test(id))) throw new AnnouncementError("Ungültige Rolle ausgewählt.");
  if (pingRoleIds.length > 5) throw new AnnouncementError("Höchstens 5 Rollen erwähnen.");
  const pingEveryone = Boolean(input.pingEveryone);
  if (pingEveryone && !allowEveryone) throw new AnnouncementError("@everyone darf nur die Leitung erwähnen.");
  if (/@(everyone|here)/i.test(`${content} ${embed.description}`) && !allowEveryone) throw new AnnouncementError("@everyone/@here im Text darf nur die Leitung verwenden.");
  let scheduledAt = null;
  if (input.scheduledAt) {
    // Website schickt Wanduhrzeit („2026-10-20T18:00“) in der Server-Zeitzone.
    const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(input.scheduledAt));
    const at = local ? zonedTime(...local.slice(1).map(Number), timezone) ?? new Date(NaN) : new Date(input.scheduledAt);
    if (Number.isNaN(at.getTime())) throw new AnnouncementError("Ungültiger Zeitpunkt.");
    if (at.getTime() < reference.getTime() + 60_000) throw new AnnouncementError("Der geplante Zeitpunkt muss mindestens eine Minute in der Zukunft liegen. Für sofort das Feld leer lassen.");
    if (at.getTime() > reference.getTime() + MAX_DAYS_AHEAD * 86_400_000) throw new AnnouncementError(`Höchstens ${MAX_DAYS_AHEAD} Tage im Voraus planen.`);
    scheduledAt = at.toISOString();
  }
  return { channelId, content, embed, pingRoleIds, pingEveryone, scheduledAt };
}

/** Discord-Nachricht aus einem gespeicherten Eintrag. Erwähnt werden nur ausdrücklich gewählte Rollen. */
export function announcementPayload(row) {
  const embed = typeof row.embed === "string" ? JSON.parse(row.embed || "{}") : row.embed ?? {};
  const roles = (Array.isArray(row.ping_role_ids) ? row.ping_role_ids : String(row.ping_role_ids ?? "").split(",")).filter(Boolean);
  const pings = [...(row.ping_everyone ? ["@everyone"] : []), ...roles.map(id => `<@&${id}>`)].join(" ");
  const payload = { allowedMentions: { parse: row.ping_everyone ? ["everyone"] : [], roles } };
  const content = [pings, row.content].filter(Boolean).join("\n");
  if (content) payload.content = content.slice(0, 2000);
  if (embed.title || embed.description) {
    const card = new EmbedBuilder().setColor(Number.parseInt(String(embed.color ?? "#d4af37").replace("#", ""), 16)).setTimestamp();
    if (embed.title) card.setTitle(embed.title);
    if (embed.description) card.setDescription(embed.description);
    if (embed.footer) card.setFooter({ text: embed.footer });
    if (embed.imageUrl) card.setImage(embed.imageUrl);
    payload.embeds = [card];
  }
  return payload;
}

export function createAnnouncementService(db) {
  const now = () => new Date().toISOString();
  const get = (guildId, id) => db.prepare("SELECT * FROM announcements WHERE guild_id=? AND id=?").get(guildId, id) ?? null;
  function create({ guildId, actorId, data }) {
    const id = randomUUID();
    db.prepare("INSERT INTO announcements(id,guild_id,channel_id,content,embed,ping_role_ids,ping_everyone,scheduled_at,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, guildId, data.channelId, data.content, JSON.stringify(data.embed), data.pingRoleIds.join(","), data.pingEveryone ? 1 : 0, data.scheduledAt, "scheduled", actorId, now());
    audit(db, guildId, actorId, data.scheduledAt ? "announcement.scheduled" : "announcement.created", null, { channelId: data.channelId, startsAt: data.scheduledAt, name: data.embed.title || data.content.slice(0, 80) });
    return get(guildId, id);
  }
  /** Reserviert eine Ankündigung zum Senden; nur ein Aufrufer gewinnt (kein doppeltes Posten). */
  const claim = id => db.prepare("UPDATE announcements SET status='sending' WHERE id=? AND status='scheduled'").run(id).changes === 1;
  const due = (reference = new Date()) => db.prepare("SELECT * FROM announcements WHERE status='scheduled' AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY COALESCE(scheduled_at,created_at) LIMIT 10").all(reference.toISOString());
  const markSent = (id, messageId) => db.prepare("UPDATE announcements SET status='sent',message_id=?,sent_at=?,error=NULL WHERE id=?").run(messageId, now(), id);
  const markFailed = (id, error) => db.prepare("UPDATE announcements SET status='failed',error=? WHERE id=?").run(String(error).slice(0, 300), id);
  function cancel({ guildId, id, actorId }) {
    const changed = db.prepare("UPDATE announcements SET status='cancelled' WHERE guild_id=? AND id=? AND status='scheduled'").run(guildId, id).changes;
    if (!changed) throw new AnnouncementError("Nur geplante Ankündigungen können abgebrochen werden.");
    audit(db, guildId, actorId, "announcement.cancelled", null, { announcementId: id });
  }
  const list = (guildId, limit = 40) => db.prepare("SELECT * FROM announcements WHERE guild_id=? ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, COALESCE(sent_at,scheduled_at,created_at) DESC LIMIT ?").all(guildId, limit)
    .map(row => ({ ...row, embed: JSON.parse(row.embed || "{}"), ping_role_ids: row.ping_role_ids ? row.ping_role_ids.split(",") : [] }));
  return { create, get, claim, due, markSent, markFailed, cancel, list };
}

/** Sendet eine reservierte Ankündigung. Fehler werden gespeichert und nicht wiederholt (kein Doppelpost). */
export async function deliverAnnouncement({ db, client, row }) {
  const service = createAnnouncementService(db);
  if (!service.claim(row.id)) return { ok: false, skipped: true };
  const channel = await client.channels?.fetch?.(row.channel_id).catch(() => null);
  if (!channel?.send) { service.markFailed(row.id, "Channel nicht gefunden oder nicht beschreibbar"); return { ok: false, error: "Channel nicht gefunden oder nicht beschreibbar." }; }
  try {
    const message = await channel.send(announcementPayload(row));
    service.markSent(row.id, message?.id ?? null);
    return { ok: true, messageId: message?.id ?? null, channelId: row.channel_id };
  } catch (error) {
    service.markFailed(row.id, error.message);
    return { ok: false, error: error.message };
  }
}

export async function sendDueAnnouncements({ db, client, reference = new Date() }) {
  let sent = 0;
  for (const row of createAnnouncementService(db).due(reference)) if ((await deliverAnnouncement({ db, client, row })).ok) sent++;
  return sent;
}
