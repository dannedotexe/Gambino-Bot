import { EmbedBuilder } from "discord.js";
import { getSetting, setSetting } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { formatMoney } from "./services/finance.js";
import { localDay } from "./services/absences.js";
import { zonedTime } from "./services/event-series.js";
import { familyMembers, inactivityFor } from "./inactivity.js";

const LAST_KEY = "WEEKLY_REPORT_LAST";
const DAY = 86_400_000;
const localMidnight = (day, tz) => { const [y, m, d] = day.split("-").map(Number); return zonedTime(y, m, d, 0, 0, tz) ?? zonedTime(y, m, d, 1, 0, tz); };
const shiftDay = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Vorwoche (Montag 00:00 bis Montag 00:00) in der Server-Zeitzone. */
export function previousWeek(reference, timezone) {
  const today = localDay(reference, timezone);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const thisMonday = shiftDay(today, -weekday), lastMonday = shiftDay(thisMonday, -7);
  return { fromDay: lastMonday, toDay: shiftDay(thisMonday, -1), from: localMidnight(lastMonday, timezone).toISOString(), to: localMidnight(thisMonday, timezone).toISOString(), thisMonday, weekday };
}

/** Kennzahlen eines Zeitraums [from, to). */
export function weeklyNumbers(db, guildId, { from, to, fromDay, toDay }) {
  const one = (sql, ...p) => db.prepare(sql).get(...p) ?? {};
  const count = (sql, ...p) => one(sql, ...p).n ?? 0;
  const g = guildId;
  return {
    events: {
      ended: count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='ended' AND starts_at>=? AND starts_at<?", g, from, to),
      cancelled: count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='cancelled' AND starts_at>=? AND starts_at<?", g, from, to),
      participations: count("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND e.status<>'cancelled' AND p.status IN ('present','signed_up') AND e.starts_at>=? AND e.starts_at<?", g, from, to),
      present: count("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.status='present' AND e.starts_at>=? AND e.starts_at<?", g, from, to),
      absent: count("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.status='absent' AND e.starts_at>=? AND e.starts_at<?", g, from, to),
      top: db.prepare("SELECT p.user_id, COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND e.status<>'cancelled' AND p.status IN ('present','signed_up') AND e.starts_at>=? AND e.starts_at<? GROUP BY p.user_id ORDER BY n DESC LIMIT 3").all(g, from, to),
    },
    members: {
      joins: count("SELECT COALESCE(SUM(joins),0) n FROM member_stats_daily WHERE guild_id=? AND day>=? AND day<=?", g, fromDay, toDay),
      leaves: count("SELECT COALESCE(SUM(leaves),0) n FROM member_stats_daily WHERE guild_id=? AND day>=? AND day<=?", g, fromDay, toDay),
      verified: count("SELECT COUNT(*) n FROM member_verifications WHERE guild_id=? AND verified_at>=? AND verified_at<?", g, from, to),
      accepted: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND kind='bewerbung' AND status='accepted' AND updated_at>=? AND updated_at<?", g, from, to),
      rejected: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND kind='bewerbung' AND status='rejected' AND updated_at>=? AND updated_at<?", g, from, to),
      openApplications: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status IN ('open','review')", g),
      promotions: count("SELECT COUNT(*) n FROM rank_changes WHERE guild_id=? AND kind='promotion' AND created_at>=? AND created_at<?", g, from, to),
      demotions: count("SELECT COUNT(*) n FROM rank_changes WHERE guild_id=? AND kind='demotion' AND created_at>=? AND created_at<?", g, from, to),
    },
    absences: {
      created: count("SELECT COUNT(*) n FROM member_absences WHERE guild_id=? AND created_at>=? AND created_at<?", g, from, to),
    },
    discipline: {
      sanctions: one("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM sanctions WHERE guild_id=? AND created_at>=? AND created_at<?", g, from, to),
      warnings: count("SELECT COUNT(*) n FROM member_warnings WHERE guild_id=? AND created_at>=? AND created_at<?", g, from, to),
      moderation: Object.fromEntries(db.prepare("SELECT action k, COUNT(*) n FROM moderation_actions WHERE guild_id=? AND result='applied' AND created_at>=? AND created_at<? GROUP BY action").all(g, from, to).map(r => [r.k, r.n])),
      openSanctions: one("SELECT COUNT(*) n, COALESCE(SUM(remaining_cents),0) cents FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", g),
    },
    finance: {
      credits: one("SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM transactions WHERE guild_id=? AND type='credit' AND created_at>=? AND created_at<?", g, from, to),
      payouts: one("SELECT COUNT(*) n, COALESCE(SUM(net_cents),0) net, COALESCE(SUM(deduction_cents),0) deduction FROM transactions WHERE guild_id=? AND type='payout' AND created_at>=? AND created_at<?", g, from, to),
      balanceNow: count("SELECT COALESCE(SUM(balance_cents),0) n FROM accounts WHERE guild_id=?", g),
    },
    tickets: {
      created: count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND created_at>=? AND created_at<?", g, from, to),
      closed: count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND closed_at>=? AND closed_at<?", g, from, to),
      openNow: count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'", g),
    },
  };
}

const fmt = day => day.split("-").reverse().join(".");

export function weeklyReportPayload(numbers, { fromDay, toDay }, extra = {}) {
  const n = numbers, mod = n.discipline.moderation;
  const medals = ["🥇", "🥈", "🥉"];
  const top = n.events.top.length ? n.events.top.map((r, i) => `${medals[i]} <@${r.user_id}> · ${r.n}`).join("\n") : "—";
  const embed = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  WOCHENBERICHT" })
    .setTitle(`📊 Woche ${fmt(fromDay)} – ${fmt(toDay)}`)
    .addFields(
      { name: "📅 Events", value: `**${n.events.ended}** durchgeführt · ${n.events.cancelled} abgesagt\n**${n.events.participations}** Teilnahmen (${n.events.present} bestätigt, ${n.events.absent} gefehlt)`, inline: true },
      { name: "🏆 Aktivste", value: top, inline: true },
      { name: "👥 Mitglieder", value: `+${n.members.joins} / −${n.members.leaves} auf dem Server\n${n.members.verified} verifiziert\nBewerbungen: ${n.members.accepted} angenommen, ${n.members.rejected} abgelehnt (${n.members.openApplications} offen)`, inline: false },
      { name: "🏅 Ränge", value: `${n.members.promotions} Beförderungen · ${n.members.demotions} Degradierungen`, inline: true },
      { name: "🚫 Abmeldungen & Aktivität", value: `${n.absences.created} neue Abmeldungen${extra.absentNow != null ? ` · ${extra.absentNow} gerade abgemeldet` : ""}${extra.inactive != null ? `\n${extra.inactive} inaktiv (≥ ${extra.inactiveDays} Tage)` : ""}`, inline: true },
      { name: "⚖️ Disziplin", value: `${n.discipline.sanctions.n} Sanktionen (${formatMoney(n.discipline.sanctions.cents)}) · ${n.discipline.warnings} Verwarnungen\nModeration: ${mod.timeout ?? 0} Timeouts · ${mod.kick ?? 0} Kicks · ${mod.ban ?? 0} Banns\nOffen gesamt: ${n.discipline.openSanctions.n} (${formatMoney(n.discipline.openSanctions.cents)})`, inline: false },
      { name: "💸 Familienkonto", value: `${n.finance.credits.n} Gutschriften (${formatMoney(n.finance.credits.cents)})\n${n.finance.payouts.n} Auszahlungen: ${formatMoney(n.finance.payouts.net)} netto, ${formatMoney(n.finance.payouts.deduction)} Sanktionsabzug\nNoch auszuzahlen: ${formatMoney(n.finance.balanceNow)}`, inline: true },
      { name: "🎫 Tickets", value: `${n.tickets.created} eröffnet · ${n.tickets.closed} geschlossen\n${n.tickets.openNow} gerade offen`, inline: true },
    )
    .setFooter({ text: "GAMBINOS  •  Automatischer Wochenbericht (Montag)" }).setTimestamp();
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

/** Erstellt und sendet den Bericht der Vorwoche. force=true sendet auch außerhalb des Montags (Test über die Website). */
export async function sendWeeklyReport({ db, client, config, reference = new Date(), force = false }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId || !config.CHANNEL_WEEKLY_REPORT) return { sent: false, reason: "no_channel" };
  const week = previousWeek(reference, config.TIMEZONE);
  if (!force) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: config.TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(reference));
    if (week.weekday !== 0 || hour < config.WEEKLY_REPORT_HOUR) return { sent: false, reason: "not_due" };
    if (getSetting(db, guildId, LAST_KEY) === week.fromDay) return { sent: false, reason: "already_sent" };
    setSetting(db, guildId, LAST_KEY, week.fromDay);
  }
  const channel = await client.channels.fetch(config.CHANNEL_WEEKLY_REPORT).catch(() => null);
  if (!channel?.send) return { sent: false, reason: "channel_unavailable" };
  let extra = {};
  const guild = client.guilds?.cache?.get(guildId) ?? await client.guilds?.fetch?.(guildId).catch(() => null);
  if (guild) {
    const report = inactivityFor({ db, config, guildId, members: await familyMembers({ db, guild, config }).catch(() => []), reference });
    extra = { inactive: report.filter(r => r.inactive).length, absentNow: report.filter(r => r.absent).length, inactiveDays: config.INACTIVITY_DAYS };
  }
  const ok = await channel.send(weeklyReportPayload(weeklyNumbers(db, guildId, week), week, extra)).then(() => true).catch(() => false);
  return { sent: ok, reason: ok ? "sent" : "send_failed", week };
}
