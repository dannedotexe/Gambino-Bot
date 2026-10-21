/**
 * Anmeldung zu einem Event → kurzer Ping im eigenen Event-Logbuch, damit man die Bilder (vor/nach dem Event) nicht
 * vergisst. Abmelden entfernt den Hinweis wieder; nach dem Event räumt der Bot ihn auf (das Logbuch bleibt sauber).
 */
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const KEEP_AFTER_START = 4 * 3_600_000;

export async function pingSignup({ db, client, config, event, userId }) {
  if (!config.EVENT_SIGNUP_LOGBOOK_PING || !config.CHANNEL_EVENT_FORUM) return false;
  const guildId = event.guild_id ?? config.DISCORD_GUILD_ID;
  if (db.prepare("SELECT 1 FROM event_signup_pings WHERE event_id=? AND user_id=?").get(event.id, userId)) return false;
  const threadId = db.prepare("SELECT thread_id FROM event_logbooks WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL AND archived_at IS NULL").get(guildId, userId)?.thread_id;
  if (!threadId) return false;
  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread?.send) return false;
  const message = await thread.send({ content: `<@${userId}> ✅ Angemeldet für **${event.name}** – <t:${unix(event.starts_at)}:F> (<t:${unix(event.starts_at)}:R>).\n📸 Nicht vergessen: **vor und nach dem Event ein Bild** hier posten (ganzer Bildschirm mit Datum & Uhrzeit).`, allowedMentions: { users: [userId] } }).catch(() => null);
  if (!message) return false;
  db.prepare("INSERT OR REPLACE INTO event_signup_pings(event_id,user_id,channel_id,message_id,created_at) VALUES(?,?,?,?,?)").run(event.id, userId, thread.id, message.id, new Date().toISOString());
  return true;
}

export async function removeSignupPing({ db, client, eventId, userId }) {
  const row = db.prepare("SELECT * FROM event_signup_pings WHERE event_id=? AND user_id=?").get(eventId, userId);
  if (!row) return false;
  db.prepare("DELETE FROM event_signup_pings WHERE event_id=? AND user_id=?").run(eventId, userId);
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  const message = await channel?.messages?.fetch(row.message_id).catch(() => null);
  await message?.delete?.().catch(() => {});
  return true;
}

/** Hinweise zu Events, die vor mehr als 4 Std. begonnen haben oder abgesagt wurden, entfernen. */
export async function cleanupSignupPings({ db, client, reference = new Date() }) {
  const rows = db.prepare(`SELECT p.event_id,p.user_id FROM event_signup_pings p LEFT JOIN events e ON e.id=p.event_id
    WHERE e.id IS NULL OR e.status='cancelled' OR e.starts_at<? LIMIT 25`).all(new Date(reference.getTime() - KEEP_AFTER_START).toISOString());
  for (const row of rows) await removeSignupPing({ db, client, eventId: row.event_id, userId: row.user_id });
  return rows.length;
}
