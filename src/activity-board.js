import { randomUUID } from "node:crypto";
import { EmbedBuilder } from "discord.js";
import { audit, getSetting, setSetting } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { eventButtons, eventEmbed } from "./commands.js";
import { describeSchedule, nextOccurrence } from "./services/event-series.js";

export const BOARD_SETTING_KEY = "PANEL_ACTIVITY_BOARD";
const unix = date => Math.floor(new Date(date).getTime() / 1000);

/** Öffentliche Übersicht aller aktiven Aktivitäten mit dem nächsten Termin. */
export function buildActivityBoard(seriesList, timezone, reference = new Date()) {
  const active = seriesList.filter(item => item.active);
  const scheduled = active.filter(item => item.kind === "scheduled").map(item => ({ item, next: nextOccurrence(item, timezone, reference) })).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  const flexible = active.filter(item => item.kind === "flexible");
  const embed = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  AKTIVITÄTEN" }).setTitle("📆 Familien-Aktivitäten")
    .setDescription(active.length ? "Feste Termine werden automatisch als Event mit Anmeldung angekündigt." : "Zurzeit sind keine Aktivitäten aktiv.")
    .setFooter({ text: `GAMBINOS  •  Zeiten in ${timezone}` }).setTimestamp();
  if (scheduled.length) embed.addFields({ name: "🕒 Feste Termine", value: scheduled.map(({ item, next }) => `**${item.name}** · ${describeSchedule(item)}${next ? ` · nächstes <t:${unix(next)}:R>` : ""}`).join("\n").slice(0, 1024) });
  if (flexible.length) embed.addFields({ name: "🔁 Flexibel verfügbar", value: flexible.map(item => `**${item.name}** · ${describeSchedule(item)}`).join("\n").slice(0, 1024) });
  return { embeds: [embed] };
}

export async function refreshActivityBoard({ db, client, config, series }) {
  const guildId = config.DISCORD_GUILD_ID;
  const stored = guildId ? getSetting(db, guildId, BOARD_SETTING_KEY) : null;
  if (!stored) return false;
  const [channelId, messageId] = stored.split(":");
  const channel = await client.channels.fetch(channelId).catch(() => null);
  const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
  if (!message) return false;
  return message.edit(buildActivityBoard(series.list(guildId), config.TIMEZONE)).then(() => true).catch(() => false);
}

export async function publishActivityBoard({ db, channel, config, series, actorId }) {
  const sent = await channel.send(buildActivityBoard(series.list(config.DISCORD_GUILD_ID), config.TIMEZONE));
  setSetting(db, config.DISCORD_GUILD_ID, BOARD_SETTING_KEY, `${channel.id}:${sent.id}`);
  audit(db, config.DISCORD_GUILD_ID, actorId, "config.panel_published", sent.id, { channelId: channel.id, name: "Aktivitäten-Übersicht" });
  return sent;
}

let missingChannelWarned = false;
/** Legt fällige Termine aktiver Serien als normale Events an (genau einmal je Termin). */
export async function createSeriesEvents({ db, client, config, series, reference = new Date() }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId) return 0;
  const due = series.dueOccurrences(guildId, config.TIMEZONE, reference);
  if (!due.length) return 0;
  const channel = config.CHANNEL_EVENT_ANNOUNCEMENTS ? await client.channels.fetch(config.CHANNEL_EVENT_ANNOUNCEMENTS).catch(() => null) : null;
  if (!channel) {
    if (!missingChannelWarned) console.warn("Aktivitäten fällig, aber CHANNEL_EVENT_ANNOUNCEMENTS ist nicht gesetzt oder nicht erreichbar. Bitte in den Einstellungen festlegen.");
    missingChannelWarned = true;
    return 0;
  }
  missingChannelWarned = false;
  let created = 0;
  for (const { series: item, startsAt } of due) {
    const id = randomUUID(), createdAt = new Date().toISOString();
    const event = { id, guild_id: guildId, name: item.name, description: item.description || `Wiederkehrende Familienaktivität · ${describeSchedule(item)}`, starts_at: startsAt.toISOString(), location: item.location, host_id: client.user.id, equipment: "", notes: "Automatisch aus dem Aktivitätenplan erstellt.", max_participants: item.max_participants };
    // Reservierung über den Unique-Index (series_id, starts_at): parallele Ticks oder Neustarts erzeugen kein Duplikat.
    const reserved = db.prepare("INSERT OR IGNORE INTO events(id,guild_id,name,description,starts_at,location,host_id,equipment,notes,max_participants,status,created_at,series_id) VALUES(?,?,?,?,?,?,?,?,?,?,'scheduled',?,?)")
      .run(id, guildId, event.name, event.description, event.starts_at, event.location, event.host_id, event.equipment, event.notes, event.max_participants, createdAt, item.id).changes;
    if (!reserved) continue;
    try {
      const sent = await channel.send({ embeds: [eventEmbed(event, 0)], components: [eventButtons(id)] });
      db.transaction(() => {
        db.prepare("UPDATE events SET channel_id=?,message_id=? WHERE id=?").run(channel.id, sent.id, id);
        audit(db, guildId, client.user.id, "event.created", id, { name: event.name, startsAt: event.starts_at, channelId: channel.id, seriesId: item.id });
      })();
      created++;
    } catch (error) {
      // Ankündigung fehlgeschlagen: Reservierung zurücknehmen, damit der nächste Lauf es erneut versucht.
      db.prepare("DELETE FROM events WHERE id=? AND message_id IS NULL").run(id);
      console.warn(`Aktivität ${item.name} konnte nicht angekündigt werden:`, error.message);
    }
  }
  return created;
}

/** Beendet automatisch erstellte Termine nach Ablauf der Dauer; Anwesenheit bleibt danach dokumentierbar. */
export async function endSeriesEvents({ db, client, config, reference = new Date() }) {
  const cutoff = new Date(reference.getTime() - config.EVENT_SERIES_AUTO_END_MINUTES * 60_000).toISOString();
  const rows = db.prepare("SELECT * FROM events WHERE series_id IS NOT NULL AND status='scheduled' AND starts_at<=? LIMIT 50").all(cutoff);
  for (const row of rows) {
    const changed = db.transaction(() => {
      const updated = db.prepare("UPDATE events SET status='ended' WHERE id=? AND status='scheduled'").run(row.id).changes;
      if (updated) audit(db, row.guild_id, client.user.id, "event.ended", row.id, { name: row.name, reason: "automatisch nach Ablauf" });
      return updated;
    })();
    if (!changed || !row.channel_id || !row.message_id) continue;
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    const message = channel ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
    const participants = db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(row.id);
    await message?.edit({ embeds: [eventEmbed({ ...row, name: `BEENDET · ${row.name}` }, participants.length, participants)], components: [] }).catch(() => {});
  }
  return rows.length;
}
