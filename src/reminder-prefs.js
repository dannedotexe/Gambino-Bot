/** Erinnerungen per DM statt Erwähnung im Channel – pro Person einstellbar. */
export function createReminderPrefs(db) {
  const wantsDm = (guildId, userId) => Boolean(db.prepare("SELECT dm FROM reminder_prefs WHERE guild_id=? AND user_id=?").get(guildId, userId)?.dm);
  const set = (guildId, userId, dm) => db.prepare("INSERT INTO reminder_prefs(guild_id,user_id,dm,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET dm=excluded.dm,updated_at=excluded.updated_at").run(guildId, userId, dm ? 1 : 0, new Date().toISOString());
  const dmUsers = (guildId, userIds) => userIds.length ? new Set(db.prepare(`SELECT user_id FROM reminder_prefs WHERE guild_id=? AND dm=1 AND user_id IN (${userIds.map(() => "?").join(",")})`).all(guildId, ...userIds).map(r => r.user_id)) : new Set();
  return { wantsDm, set, dmUsers };
}

/** Schickt Personen mit DM-Wunsch eine private Nachricht; gibt die IDs zurück, die stattdessen im Channel erwähnt werden sollen. */
export async function splitAndSendDms({ db, client, guildId, userIds, embed, link = null }) {
  const dm = createReminderPrefs(db).dmUsers(guildId, userIds);
  const channelUsers = [];
  for (const userId of userIds) {
    if (!dm.has(userId)) { channelUsers.push(userId); continue; }
    const sent = await client.users.fetch(userId).then(user => user.send({ embeds: [embed], ...(link ? { content: link } : {}) })).then(() => true).catch(() => false);
    if (!sent) channelUsers.push(userId); // DMs geschlossen: dann doch im Channel erwähnen
  }
  return channelUsers;
}

