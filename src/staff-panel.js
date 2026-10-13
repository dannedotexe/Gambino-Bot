import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { BRAND_COLOR } from "./presentation.js";
import { formatMoney } from "./services/finance.js";
import { PERIODS, collectStats } from "./services/stats.js";

export const PANEL_SETTING_KEY = "PANEL_STAFF_DASHBOARD";
export const STATS_SETTING_KEY = "PANEL_STATS_CHANNEL";

/** Ansichten und die dafür nötige Rollengruppe (siehe accessGroups). */
export const VIEWS = {
  tickets: { label: "Offene Tickets", emoji: "🎫", group: "staff" },
  applications: { label: "Bewerbungen & Rang-Anträge", emoji: "📨", group: "reviewers" },
  events: { label: "Anstehende Events", emoji: "📅", group: "events" },
  sanctions: { label: "Offene Sanktionen", emoji: "⚖️", group: "staff" },
  payouts: { label: "Ausstehende Auszahlungen", emoji: "💸", group: "financeView" },
  activity: { label: "Letzte Aktionen", emoji: "🧾", group: "anyStaff" },
  stats: { label: "Statistik (30 Tage)", emoji: "📊", group: "anyStaff" },
};

const panelEmbed = (title, description = "") => new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  STAFF-DASHBOARD" }).setTitle(title).setDescription(description || null).setFooter({ text: "GAMBINOS  •  Nur für berechtigte Rollen" }).setTimestamp();
const rel = iso => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
const clip = (text, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text) || "—";
const count = (db, sql, ...params) => db.prepare(sql).get(...params)?.n ?? 0;

/** Öffentliche Panel-Nachricht: nur Zählwerte, keine Namen oder Beträge. */
export function buildPanelPayload(db, guildId, texts = {}) {
  const nowIso = new Date().toISOString();
  const embed = panelEmbed(texts.title || "🧭 Gambinos Staff-Dashboard", texts.description ?? "Wähle unten eine Ansicht. Details erscheinen nur privat für dich und nur, wenn deine Rolle sie freigibt.").addFields(
    { name: "🎫 Offene Tickets", value: `${count(db, "SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'", guildId)} · davon ${count(db, "SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open' AND claimed_by IS NULL", guildId)} ohne Bearbeiter`, inline: true },
    { name: "📨 Offene Anträge", value: String(count(db, "SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status IN ('open','review')", guildId)), inline: true },
    { name: "📅 Kommende Events", value: String(count(db, "SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>?", guildId, nowIso)), inline: true },
    { name: "⚖️ Offene Sanktionen", value: String(count(db, "SELECT COUNT(*) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", guildId)), inline: true },
    { name: "💸 Konten mit Guthaben", value: String(count(db, "SELECT COUNT(*) n FROM accounts WHERE guild_id=? AND balance_cents>0", guildId)), inline: true },
    { name: "🎉 Aktive Giveaways", value: String(count(db, "SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND status='active'", guildId)), inline: true },
    { name: "🔄 Stand", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false },
  );
  const select = new StringSelectMenuBuilder().setCustomId("staffpanel:view").setPlaceholder("📂 Ansicht wählen …")
    .addOptions(Object.entries(VIEWS).map(([value, view]) => ({ label: view.label, value, emoji: { name: view.emoji } })));
  const refresh = new ButtonBuilder().setCustomId("staffpanel:refresh").setLabel("Aktualisieren").setEmoji("🔄").setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(refresh)] };
}

/** Detailansicht (immer privat/ephemeral ausliefern). */
export function buildView(db, guildId, view, { config, finance } = {}) {
  const nowIso = new Date().toISOString();
  if (view === "tickets") {
    const rows = db.prepare("SELECT id,channel_id,user_id,category,claimed_by,created_at FROM tickets WHERE guild_id=? AND status='open' ORDER BY created_at LIMIT 20").all(guildId);
    const label = id => config?.TICKET_CATEGORIES_JSON?.find(category => category.id === id)?.label ?? id;
    return panelEmbed("🎫 Offene Tickets", rows.length ? rows.map(r => `• ${r.channel_id ? `<#${r.channel_id}>` : "Channel fehlt"} · **${label(r.category)}** · <@${r.user_id}> · ${r.claimed_by ? `👤 <@${r.claimed_by}>` : "🟡 ohne Bearbeiter"} · ${rel(r.created_at)}`).join("\n").slice(0, 4000) : "Keine offenen Tickets.");
  }
  if (view === "applications") {
    const rows = db.prepare("SELECT id,user_id,kind,status,reviewer_id,created_at FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at LIMIT 20").all(guildId);
    return panelEmbed("📨 Bewerbungen & Rang-Anträge", rows.length ? rows.map(r => `• ${r.kind === "rang" ? "🏅 Rang-Antrag" : "🤝 Bewerbung"} · <@${r.user_id}> · ${r.status === "review" ? `🔎 <@${r.reviewer_id}>` : "🟡 offen"} · ${rel(r.created_at)} · \`${r.id.slice(0, 8)}\``).join("\n").slice(0, 4000) : "Keine offenen Anträge.");
  }
  if (view === "events") {
    const rows = db.prepare("SELECT e.id,e.name,e.starts_at,e.max_participants,(SELECT COUNT(*) FROM event_participants p WHERE p.event_id=e.id AND p.status IN ('signed_up','present')) AS n FROM events e WHERE e.guild_id=? AND e.status='scheduled' ORDER BY e.starts_at LIMIT 10").all(guildId);
    const embed = panelEmbed("📅 Anstehende Events", rows.length ? "" : "Keine geplanten Events.");
    for (const r of rows) {
      const names = db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at LIMIT 15").all(r.id).map(p => `<@${p.user_id}>`).join(", ");
      embed.addFields({ name: clip(`${r.name} · ${r.n}${r.max_participants ? `/${r.max_participants}` : ""} Teilnehmende`, 256), value: clip(`<t:${Math.floor(new Date(r.starts_at).getTime() / 1000)}:F>${new Date(r.starts_at) < new Date(nowIso) ? " · ⚠️ Startzeit vorbei, noch nicht beendet" : ""}\n${names || "Noch keine Anmeldungen"}`) });
    }
    return embed;
  }
  if (view === "sanctions") {
    const rows = db.prepare("SELECT user_id, COUNT(*) c, SUM(remaining_cents) cents FROM sanctions WHERE guild_id=? AND status IN ('open','partial') GROUP BY user_id ORDER BY cents DESC LIMIT 20").all(guildId);
    const total = count(db, "SELECT COALESCE(SUM(remaining_cents),0) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", guildId);
    return panelEmbed("⚖️ Offene Sanktionen", rows.length ? `**Summe offener Abzüge:** ${formatMoney(total)}\n\n${rows.map(r => `• <@${r.user_id}> · ${r.c} Sanktion(en) · **${formatMoney(r.cents)}** offen`).join("\n")}`.slice(0, 4000) : "Keine offenen Sanktionen.");
  }
  if (view === "payouts") {
    const rows = db.prepare("SELECT user_id,balance_cents FROM accounts WHERE guild_id=? AND balance_cents>0 ORDER BY balance_cents DESC LIMIT 20").all(guildId);
    const minimum = config?.PAYOUT_MINIMUM_CENTS;
    const lines = rows.map(r => {
      const plan = finance.previewPayout(guildId, r.user_id);
      const eligible = minimum == null ? "" : r.balance_cents >= minimum ? " · ✅" : " · ⏳ unter Mindestbetrag";
      return `• <@${r.user_id}> · Brutto **${formatMoney(plan.gross)}**${plan.deduction ? ` · Abzug −${formatMoney(plan.deduction)}` : ""} · Netto **${formatMoney(plan.net)}**${eligible}`;
    });
    return panelEmbed("💸 Ausstehende Familienauszahlungen", rows.length ? `${minimum == null ? "Kein Mindestbetrag konfiguriert – alle Kontostände werden angezeigt." : `Mindestbetrag: ${formatMoney(minimum)}`}\n\n${lines.join("\n")}`.slice(0, 4000) : "Keine Konten mit Guthaben.");
  }
  if (view === "activity") {
    const rows = db.prepare("SELECT action,actor_id,created_at FROM audit_logs WHERE guild_id=? AND action NOT IN ('event.participation','giveaway.entry') ORDER BY created_at DESC LIMIT 15").all(guildId);
    return panelEmbed("🧾 Letzte relevante Aktionen", rows.length ? rows.map(r => `• \`${r.action}\` · <@${r.actor_id}> · ${rel(r.created_at)}`).join("\n") : "Noch keine Aktionen protokolliert.");
  }
  if (view === "stats") return statsEmbed(collectStats(db, guildId, { days: 30 }), { title: "📊 Statistik" });
  return panelEmbed("Unbekannte Ansicht");
}

const statusText = (map, labels) => Object.entries(labels).map(([key, label]) => `${label}: ${map[key] ?? 0}`).join(" · ");

export function statsEmbed(stats, { title = "📊 Gambinos Statistik", memberCount = null } = {}) {
  const period = PERIODS[stats.days] ?? `${stats.days} Tage`;
  const embed = panelEmbed(title, `**Zeitraum:** ${period}\n**Quelle:** Bot-Datenbank (nur Vorgänge, die über den Bot liefen). „aktuell“ = Momentaufnahme.`).setAuthor({ name: "GAMBINOS  •  STATISTIK" });
  embed.addFields(
    { name: "👥 Mitglieder", value: `${memberCount != null ? `Aktuell: **${memberCount}**\n` : ""}Beitritte: ${stats.members.joins} · Austritte: ${stats.members.leaves}`, inline: true },
    { name: "🎫 Tickets", value: `Erstellt: ${stats.tickets.created} · Geschlossen: ${stats.tickets.closed}\nAktuell offen: ${stats.tickets.openNow} (ohne Bearbeiter: ${stats.tickets.unclaimedNow})${stats.tickets.avgCloseHours != null ? `\nØ Bearbeitungszeit: ${stats.tickets.avgCloseHours.toFixed(1)} h` : ""}`, inline: true },
    { name: "📅 Events", value: `${statusText(stats.events.byStatus, { scheduled: "Geplant", ended: "Beendet", cancelled: "Abgesagt" })}\nAnmeldungen: ${stats.events.signups} · Anwesend: ${stats.events.present} · Abwesend: ${stats.events.absent}\nAktuell kommend: ${stats.events.upcomingNow}`, inline: false },
    { name: "🤝 Bewerbungen", value: statusText(stats.applications.bewerbung, { open: "Offen", review: "In Prüfung", accepted: "Angenommen", rejected: "Abgelehnt", withdrawn: "Zurückgezogen" }), inline: false },
    { name: "🏅 Rang-Anträge", value: statusText(stats.applications.rang, { open: "Offen", review: "In Prüfung", accepted: "Angenommen", rejected: "Abgelehnt", withdrawn: "Zurückgezogen" }), inline: false },
    { name: "⚖️ Sanktionen", value: `${statusText(stats.sanctions.byStatus, { open: "Offen", partial: "Teilweise", paid: "Beglichen", void: "Aufgehoben" })}\nVerwarnungen: ${stats.sanctions.warnings} · Aktuell offen: ${stats.sanctions.openCountNow}`, inline: false },
    { name: "🎉 Giveaways", value: `Erstellt: ${stats.giveaways.created} · Ausgelost: ${stats.giveaways.ended} · Teilnahmen: ${stats.giveaways.entries} · Aktiv: ${stats.giveaways.activeNow}`, inline: false },
    { name: "🛡️ AutoMod", value: `Maßnahmen: ${stats.automod}`, inline: true },
    { name: "👔 Aktivste Staff-Mitglieder", value: stats.staffActions.length ? stats.staffActions.map(r => `<@${r.actor_id}>: ${r.n}`).join("\n") : "Keine Staff-Aktionen", inline: true },
  );
  if (stats.finance) {
    const f = stats.finance;
    embed.addFields({ name: "💰 Familienkonto (vertraulich)", value: `Gutschriften: ${formatMoney(f.credited.n)} (${f.credited.c})\nAuszahlungen: ${f.payouts.c} · Brutto ${formatMoney(f.payouts.gross)} · Abzüge ${formatMoney(f.payouts.deduction)} · Netto ${formatMoney(f.payouts.net)}\nKorrekturen +${formatMoney(f.corrections.correction_credit ?? 0)} / −${formatMoney(f.corrections.correction_debit ?? 0)} · Erstattungen ${formatMoney(f.corrections.sanction_refund ?? 0)}\nAktuell ausstehendes Guthaben: **${formatMoney(f.balanceNow)}** · offene Sanktionen: **${formatMoney(f.openSanctionsNow)}**`, inline: false });
  }
  return embed;
}
