/**
 * Anmeldung zu einem Event → kurzer Ping im eigenen Event-Logbuch, damit man die Bilder (vor/nach dem Event) nicht
 * vergisst. Zum Eventbeginn ersetzt ein neuer Ping („geht jetzt los“) den Anmelde-Hinweis. Abmelden entfernt den
 * Hinweis wieder; nach dem Event räumt der Bot ihn auf (das Logbuch bleibt sauber).
 */
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const KEEP_AFTER_START = 30 * 60_000;

export async function pingSignup({ db, client, config, event, userId }) {
  if (!config.EVENT_SIGNUP_LOGBOOK_PING || !config.CHANNEL_EVENT_FORUM) return false;
  const guildId = event.guild_id ?? config.DISCORD_GUILD_ID;
  if (db.prepare("SELECT 1 FROM event_signup_pings WHERE event_id=? AND user_id=?").get(event.id, userId)) return false;
  const threadId = db.prepare("SELECT thread_id FROM event_logbooks WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL AND archived_at IS NULL").get(guildId, userId)?.thread_id;
  if (!threadId) return false;
  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread?.send) return false;
  const message = await thread.send({ content: `<@${userId}> ✅ Angemeldet für **${event.name}** – <t:${unix(event.starts_at)}:F> (<t:${unix(event.starts_at)}:R>).\n📸 Nicht vergessen: **während dem Event ein Bild** hier posten (ganzer Bildschirm mit Datum & Uhrzeit).`, allowedMentions: { users: [userId] } }).catch(() => null);
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

/** Hinweise zu Events, die vor mehr als 30 Minuten begonnen haben oder abgesagt wurden, entfernen. */
export async function cleanupSignupPings({ db, client, reference = new Date() }) {
  const rows = db.prepare(`SELECT p.event_id,p.user_id FROM event_signup_pings p LEFT JOIN events e ON e.id=p.event_id
    WHERE e.id IS NULL OR e.status='cancelled' OR e.starts_at<? LIMIT 25`).all(new Date(reference.getTime() - KEEP_AFTER_START).toISOString());
  for (const row of rows) await removeSignupPing({ db, client, eventId: row.event_id, userId: row.user_id });
  return rows.length;
}

const threadOf = (db, guildId, userId) => db.prepare("SELECT thread_id FROM event_logbooks WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL AND archived_at IS NULL").get(guildId, userId)?.thread_id;

/**
 * Event beginnt: jeder Angemeldete bekommt im eigenen Event-Logbuch einen neuen Ping; der Anmelde-Hinweis wird
 * dafür gelöscht. Einmal pro Event, nur Events, die in den letzten 15 Minuten begonnen haben.
 */
export async function pingEventStart({ db, client, config, reference = new Date() }) {
  if (!config.EVENT_SIGNUP_LOGBOOK_PING || !config.CHANNEL_EVENT_FORUM || !config.DISCORD_GUILD_ID) return 0;
  const guildId = config.DISCORD_GUILD_ID;
  let sent = 0;
  for (const event of db.prepare("SELECT * FROM events WHERE guild_id=? AND status='scheduled' AND start_ping_at IS NULL AND starts_at<=? AND starts_at>? ORDER BY starts_at LIMIT 5")
    .all(guildId, reference.toISOString(), new Date(reference.getTime() - 15 * 60_000).toISOString())) {
    if (!db.prepare("UPDATE events SET start_ping_at=? WHERE id=? AND start_ping_at IS NULL").run(reference.toISOString(), event.id).changes) continue;
    for (const { user_id: userId } of db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(event.id)) {
      const threadId = threadOf(db, guildId, userId);
      if (!threadId) continue;
      await removeSignupPing({ db, client, eventId: event.id, userId });
      // Bild zu diesem Event schon gepostet → keine Erinnerung nötig.
      if (db.prepare("SELECT 1 FROM event_proofs WHERE event_id=? AND user_id=?").get(event.id, userId)) continue;
      const thread = await client.channels.fetch(threadId).catch(() => null);
      const message = await thread?.send?.({ content: `<@${userId}> 🔔 **${event.name}** geht jetzt los!\n📸 Jetzt das **Bild vom Event** hier posten – und nach dem Event noch eins.`, allowedMentions: { users: [userId] } }).catch(() => null);
      if (!message) continue;
      db.prepare("INSERT OR REPLACE INTO event_signup_pings(event_id,user_id,channel_id,message_id,created_at) VALUES(?,?,?,?,?)").run(event.id, userId, thread.id, message.id, reference.toISOString());
      sent++;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return sent;
}
