/**
 * Zugriffsprotokoll der Website (Sicherheit): wer die Seite öffnet oder sich anmeldet, mit IP-Adresse.
 * Nur für Bot-Owner sichtbar; Einträge älter als ACCESS_LOG_DAYS werden automatisch gelöscht.
 */
const HOUR = 3_600_000;

/**
 * IP der Person hinter dem Reverse-Proxy. Das Dashboard lauscht nur auf localhost, also kommt jede Verbindung vom Proxy.
 * Der letzte X-Forwarded-For-Eintrag stammt vom eigenen Proxy (davor kann der Browser beliebiges eintragen).
 */
export function clientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] ?? "").split(",").map(part => part.trim()).filter(Boolean);
  const raw = forwarded.at(-1) || req.socket?.remoteAddress || "unbekannt";
  return raw.replace(/^::ffff:/, "").slice(0, 64);
}

export function createAccessLog(db) {
  let lastPrune = 0;
  const prune = (days, now) => {
    if (now - lastPrune < HOUR) return;
    lastPrune = now;
    db.prepare("DELETE FROM access_log WHERE created_at<?").run(new Date(now - days * 24 * HOUR).toISOString());
  };

  /** Seitenaufrufe derselben Person von derselben IP werden höchstens einmal pro Stunde gespeichert. */
  function record({ guildId, userId = null, ip, kind = "visit", userAgent = "", days = 30, reference = Date.now() }) {
    prune(days, reference);
    if (kind === "visit") {
      const since = new Date(reference - HOUR).toISOString();
      const recent = db.prepare("SELECT 1 FROM access_log WHERE guild_id=? AND ip=? AND user_id IS ? AND kind IN ('visit','login') AND created_at>=? LIMIT 1").get(guildId, ip, userId, since);
      if (recent) return false;
    }
    db.prepare("INSERT INTO access_log(guild_id,user_id,ip,kind,user_agent,created_at) VALUES(?,?,?,?,?,?)")
      .run(guildId, userId, ip, kind, String(userAgent ?? "").slice(0, 200), new Date(reference).toISOString());
    return true;
  }

  const list = (guildId, { limit = 300 } = {}) => db.prepare("SELECT * FROM access_log WHERE guild_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(guildId, limit);

  /** IP-Adressen, von denen sich mehrere verschiedene Discord-Konten angemeldet haben (Hinweis auf Zweitaccounts). */
  const sharedIps = guildId => db.prepare(`SELECT ip, GROUP_CONCAT(DISTINCT user_id) users, COUNT(DISTINCT user_id) n, MAX(created_at) last FROM access_log
    WHERE guild_id=? AND user_id IS NOT NULL GROUP BY ip HAVING n>1 ORDER BY last DESC`).all(guildId).map(row => ({ ...row, users: row.users.split(",") }));

  return { record, list, sharedIps };
}
