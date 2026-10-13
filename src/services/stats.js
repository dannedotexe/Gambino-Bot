/**
 * Statistiken ausschließlich aus der Bot-Datenbank. Jeder Wert nennt seinen Bezug:
 * - "im Zeitraum": nach Erstellzeit (created_at) des Datensatzes im gewählten Zeitraum gefiltert.
 * - "aktuell": Momentaufnahme, unabhängig vom Zeitraum.
 * Finanzwerte werden nur geliefert, wenn includeFinance gesetzt ist.
 */
export const PERIODS = { 7: "letzte 7 Tage", 30: "letzte 30 Tage", 90: "letzte 90 Tage", 365: "letzte 365 Tage", 0: "gesamter Zeitraum" };

export function periodStart(days, reference = new Date()) {
  return days > 0 ? new Date(reference.getTime() - days * 86_400_000).toISOString() : "0000-01-01T00:00:00.000Z";
}

export function collectStats(db, guildId, { days = 30, includeFinance = false, reference = new Date() } = {}) {
  const since = periodStart(days, reference);
  const nowIso = reference.toISOString();
  const one = (sql, ...params) => db.prepare(sql).get(...params) ?? {};
  const grouped = (sql, ...params) => Object.fromEntries(db.prepare(sql).all(...params).map(row => [row.k, row.n]));

  const members = one("SELECT COALESCE(SUM(joins),0) joins, COALESCE(SUM(leaves),0) leaves FROM member_stats_daily WHERE guild_id=? AND day>=?", guildId, since.slice(0, 10));
  const tickets = {
    created: one("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND created_at>=?", guildId, since).n,
    closed: one("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND closed_at>=?", guildId, since).n,
    openNow: one("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'", guildId).n,
    unclaimedNow: one("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open' AND claimed_by IS NULL", guildId).n,
    avgCloseHours: one("SELECT AVG((julianday(closed_at)-julianday(created_at))*24) n FROM tickets WHERE guild_id=? AND closed_at>=?", guildId, since).n,
  };
  const events = {
    byStatus: grouped("SELECT status k, COUNT(*) n FROM events WHERE guild_id=? AND starts_at>=? AND starts_at<=? GROUP BY status", guildId, since, nowIso),
    upcomingNow: one("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>?", guildId, nowIso).n,
    signups: one("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND e.starts_at>=? AND e.starts_at<=? AND p.status IN ('signed_up','present','absent')", guildId, since, nowIso).n,
    present: one("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND e.starts_at>=? AND e.starts_at<=? AND p.status='present'", guildId, since, nowIso).n,
    absent: one("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND e.starts_at>=? AND e.starts_at<=? AND p.status='absent'", guildId, since, nowIso).n,
  };
  const applications = {
    bewerbung: grouped("SELECT status k, COUNT(*) n FROM applications WHERE guild_id=? AND kind='bewerbung' AND created_at>=? GROUP BY status", guildId, since),
    rang: grouped("SELECT status k, COUNT(*) n FROM applications WHERE guild_id=? AND kind='rang' AND created_at>=? GROUP BY status", guildId, since),
    openNow: one("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status IN ('open','review')", guildId).n,
  };
  const sanctions = {
    byStatus: grouped("SELECT status k, COUNT(*) n FROM sanctions WHERE guild_id=? AND created_at>=? GROUP BY status", guildId, since),
    openCountNow: one("SELECT COUNT(*) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", guildId).n,
    warnings: one("SELECT COUNT(*) n FROM member_warnings WHERE guild_id=? AND created_at>=?", guildId, since).n,
  };
  const giveaways = {
    created: one("SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND created_at>=?", guildId, since).n,
    ended: one("SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND status='ended' AND ended_at>=?", guildId, since).n,
    entries: one("SELECT COUNT(*) n FROM giveaway_entries e JOIN giveaways g ON g.id=e.giveaway_id WHERE g.guild_id=? AND g.created_at>=?", guildId, since).n,
    activeNow: one("SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND status='active'", guildId).n,
  };
  const automod = one("SELECT COUNT(*) n FROM automod_actions WHERE guild_id=? AND created_at>=?", guildId, since).n;
  // Staff-Aktivität: Aktionen, die nur Staff ausführen kann (keine Selbstbedienung von Mitgliedern).
  const staffActions = db.prepare(`SELECT actor_id, COUNT(*) n FROM audit_logs WHERE guild_id=? AND created_at>=?
    AND action IN ('ticket.claimed','ticket.closed','ticket.reopened','application.claimed','application.accepted','application.rejected','application.commented',
    'event.created','event.updated','event.ended','event.cancelled','event.attendance','sanction.created','sanction.warning','sanction.warning_revoked','sanction.void','sanction.corrected','sanction.refunded',
    'finance.credit','finance.payout','finance.correction','giveaway.created','giveaway.cancelled')
    GROUP BY actor_id ORDER BY n DESC LIMIT 5`).all(guildId, since);

  const result = { days, since, members, tickets, events, applications, sanctions, giveaways, automod, staffActions };
  if (includeFinance) {
    result.finance = {
      credited: one("SELECT COALESCE(SUM(amount_cents),0) n, COUNT(*) c FROM transactions WHERE guild_id=? AND type='credit' AND created_at>=?", guildId, since),
      payouts: one("SELECT COALESCE(SUM(gross_cents),0) gross, COALESCE(SUM(deduction_cents),0) deduction, COALESCE(SUM(net_cents),0) net, COUNT(*) c FROM transactions WHERE guild_id=? AND type='payout' AND created_at>=?", guildId, since),
      corrections: grouped("SELECT type k, COALESCE(SUM(amount_cents),0) n FROM transactions WHERE guild_id=? AND type IN ('correction_credit','correction_debit','sanction_refund') AND created_at>=? GROUP BY type", guildId, since),
      balanceNow: one("SELECT COALESCE(SUM(balance_cents),0) n FROM accounts WHERE guild_id=?", guildId).n,
      openSanctionsNow: one("SELECT COALESCE(SUM(remaining_cents),0) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", guildId).n,
    };
  }
  return result;
}

export function recordMemberChange(db, guildId, kind, memberCount = null, reference = new Date()) {
  const day = reference.toISOString().slice(0, 10);
  const column = kind === "leave" ? "leaves" : "joins";
  db.prepare(`INSERT INTO member_stats_daily(guild_id,day,${column},member_count) VALUES(?,?,1,?) ON CONFLICT(guild_id,day) DO UPDATE SET ${column}=${column}+1, member_count=COALESCE(excluded.member_count,member_count)`)
    .run(guildId, day, memberCount);
}
