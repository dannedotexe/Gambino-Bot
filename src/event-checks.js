import { audit } from "./database.js";
import { accessGroups } from "./config.js";
import { logEmbed } from "./presentation.js";
import { refreshEventPosts } from "./event-posts.js";
import { createAbsenceService } from "./services/absences.js";
import { createWarningService } from "./services/warnings.js";
import { deliverWarning } from "./warn-actions.js";
import { splitAndSendDms } from "./reminder-prefs.js";

const HOUR = 3_600_000;
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const fetchChannel = (client, id) => (id ? client.channels?.fetch?.(id).catch(() => null) : null);
const activeParticipants = (db, eventId) => db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(eventId).map(r => r.user_id);

// ---------------------------------------------------------------- Mindestteilnehmer
export const minimumFor = (event, config) => event.min_participants ?? (config.EVENT_MIN_PARTICIPANTS > 0 ? config.EVENT_MIN_PARTICIPANTS : null);

/** Sagt ein Event ab, aktualisiert die Posts und informiert die Angemeldeten (DM-Wunsch wird beachtet). */
export async function cancelEvent({ db, client, config, eventId, actorId, reason }) {
  const row = db.transaction(() => {
    const changed = db.prepare("UPDATE events SET status='cancelled' WHERE id=? AND status='scheduled' RETURNING *").get(eventId);
    if (changed) audit(db, changed.guild_id, actorId, "event.cancelled", eventId, { name: changed.name, reason });
    return changed;
  })();
  if (!row) return null;
  await refreshEventPosts({ db, client, config, event: row, state: "cancelled" }).catch(() => {});
  const participants = activeParticipants(db, eventId).slice(0, 50);
  const embed = logEmbed("❌ Event abgesagt", `**${row.name}** am <t:${unix(row.starts_at)}:F> findet nicht statt.${reason ? `\n**Grund:** ${reason}` : ""}`, "warning");
  const pings = await splitAndSendDms({ db, client, guildId: row.guild_id, userIds: participants, embed });
  const channel = await fetchChannel(client, row.channel_id);
  if (pings.length && channel?.send && !(row.series_id && config.EVENT_SERIES_DELETE_ENDED)) await channel.send({ content: pings.map(id => `<@${id}>`).join(" "), embeds: [embed], allowedMentions: { users: pings } }).catch(() => {});
  return row;
}

/** Prüft einmal pro Event kurz vor Start, ob genug angemeldet sind. */
export async function checkEventMinimums({ db, client, config, reference = new Date() }) {
  const until = new Date(reference.getTime() + config.EVENT_MIN_CHECK_MINUTES * 60_000).toISOString();
  const due = db.prepare("SELECT * FROM events WHERE status='scheduled' AND min_checked_at IS NULL AND starts_at<=? AND starts_at>?").all(until, reference.toISOString());
  const results = [];
  for (const event of due) {
    const minimum = minimumFor(event, config);
    // Reservieren, damit die Prüfung auch bei parallelen Durchläufen genau einmal passiert.
    if (!db.prepare("UPDATE events SET min_checked_at=? WHERE id=? AND min_checked_at IS NULL").run(reference.toISOString(), event.id).changes || !minimum) continue;
    const count = activeParticipants(db, event.id).length;
    if (count >= minimum) continue;
    audit(db, event.guild_id, client.user?.id ?? "system", "event.min_not_reached", event.id, { name: event.name, entries: count, value: minimum });
    if (config.EVENT_MIN_AUTO_CANCEL) {
      await cancelEvent({ db, client, config, eventId: event.id, actorId: client.user?.id ?? "system", reason: `Zu wenige Anmeldungen (${count} von mindestens ${minimum})` });
      results.push({ eventId: event.id, action: "cancelled", count, minimum });
    } else {
      const channel = await fetchChannel(client, config.CHANNEL_EVENT_LOG || config.CHANNEL_AUDIT_LOG);
      const team = accessGroups(config).events;
      await channel?.send?.({ content: team.map(id => `<@&${id}>`).join(" ") || undefined, allowedMentions: { roles: team },
        embeds: [logEmbed("⚠️ Zu wenige Anmeldungen", `**${event.name}** beginnt <t:${unix(event.starts_at)}:R>.\nAngemeldet: **${count}** · benötigt: **${minimum}**\n\nBitte entscheiden, ob das Event stattfindet – absagen über die Website oder \`/event absagen\`.`, "warning")] }).catch(() => {});
      results.push({ eventId: event.id, action: "alerted", count, minimum });
    }
  }
  return results;
}

// ---------------------------------------------------------------- No-Shows
/**
 * No-Show = angemeldet (oder als abwesend markiert), aber nicht als anwesend erfasst, bei einem beendeten Event,
 * für das überhaupt Anwesenheit erfasst wurde. Wer zu dem Zeitpunkt abgemeldet war, zählt nicht.
 */
export function noShowsOf(db, config, guildId, userId, { reference = new Date() } = {}) {
  const since = new Date(reference.getTime() - config.NOSHOW_WINDOW_DAYS * 24 * HOUR).toISOString();
  const absences = createAbsenceService(db);
  return db.prepare(`SELECT e.id,e.name,e.starts_at FROM event_participants p JOIN events e ON e.id=p.event_id
    WHERE e.guild_id=? AND p.user_id=? AND e.status='ended' AND p.status IN ('signed_up','absent') AND e.starts_at>=? AND e.starts_at<=?
    AND EXISTS(SELECT 1 FROM event_participants x WHERE x.event_id=e.id AND x.status='present') ORDER BY e.starts_at DESC`).all(guildId, userId, since, reference.toISOString())
    .filter(e => !absences.wasAbsent(guildId, userId, e.starts_at, config.TIMEZONE));
}

/** Verarbeitet neue No-Shows (6–72 Stunden nach Start, damit Anwesenheit nachgetragen werden kann). */
export async function processNoShows({ db, client, config, reference = new Date() }) {
  if (!config.NOSHOW_THRESHOLD) return [];
  const from = new Date(reference.getTime() - 72 * HOUR).toISOString(), to = new Date(reference.getTime() - 6 * HOUR).toISOString();
  const candidates = db.prepare(`SELECT e.id event_id,e.guild_id,e.name,e.starts_at,p.user_id FROM event_participants p JOIN events e ON e.id=p.event_id
    WHERE e.status='ended' AND p.status IN ('signed_up','absent') AND e.starts_at>=? AND e.starts_at<=?
    AND EXISTS(SELECT 1 FROM event_participants x WHERE x.event_id=e.id AND x.status='present')
    AND NOT EXISTS(SELECT 1 FROM noshow_notices n WHERE n.event_id=e.id AND n.user_id=p.user_id)`).all(from, to);
  const absences = createAbsenceService(db), actions = [];
  for (const c of candidates) {
    if (absences.wasAbsent(c.guild_id, c.user_id, c.starts_at, config.TIMEZONE)) { db.prepare("INSERT OR IGNORE INTO noshow_notices(event_id,user_id,guild_id,count,action,created_at) VALUES(?,?,?,?,?,?)").run(c.event_id, c.user_id, c.guild_id, 0, "excused", reference.toISOString()); continue; }
    const count = noShowsOf(db, config, c.guild_id, c.user_id, { reference }).length;
    const react = count >= config.NOSHOW_THRESHOLD;
    const action = react ? config.NOSHOW_ACTION : "counted";
    if (!db.prepare("INSERT OR IGNORE INTO noshow_notices(event_id,user_id,guild_id,count,action,created_at) VALUES(?,?,?,?,?,?)").run(c.event_id, c.user_id, c.guild_id, count, action, reference.toISOString()).changes) continue;
    if (!react) continue;
    audit(db, c.guild_id, client.user?.id ?? "system", "event.noshow_limit", c.user_id, { name: c.name, entries: count, action: config.NOSHOW_ACTION });
    const reason = `Automatisch: ${count} unentschuldigte No-Shows in ${config.NOSHOW_WINDOW_DAYS} Tagen (zuletzt „${c.name}“)`;
    if (config.NOSHOW_ACTION === "warn" || config.NOSHOW_ACTION === "both") {
      const warning = createWarningService(db).add({ guildId: c.guild_id, userId: c.user_id, actorId: client.user?.id ?? "system", reason, caseRef: c.event_id.slice(0, 8), expireDays: config.WARN_EXPIRE_DAYS, source: "noshow" });
      await deliverWarning({ db, client, config, guildId: c.guild_id, userId: c.user_id, actorId: client.user?.id ?? "system", reason, warning }).catch(() => {});
    }
    if (config.NOSHOW_ACTION === "alert" || config.NOSHOW_ACTION === "both") {
      const channel = await fetchChannel(client, config.CHANNEL_ACTIVITY_LOG || config.CHANNEL_AUDIT_LOG);
      const leaders = accessGroups(config).leaders;
      await channel?.send?.({ content: leaders.map(id => `<@&${id}>`).join(" ") || undefined, allowedMentions: { roles: leaders },
        embeds: [logEmbed("🚷 Wiederholte No-Shows", `<@${c.user_id}> war **${count}×** in den letzten ${config.NOSHOW_WINDOW_DAYS} Tagen angemeldet, ist aber unentschuldigt nicht erschienen.\nZuletzt: **${c.name}** (<t:${unix(c.starts_at)}:d>)`, "warning")] }).catch(() => {});
    }
    actions.push({ userId: c.user_id, count, action });
  }
  return actions;
}

