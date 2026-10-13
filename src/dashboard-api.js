import { randomUUID } from "node:crypto";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { audit } from "./database.js";
import { accessGroups } from "./config.js";
import { BRAND_COLOR, logEmbed } from "./presentation.js";
import { FinanceError, createFinance, formatMoney, parseMoney } from "./services/finance.js";
import { createEventService } from "./services/events.js";
import { createGiveawayService } from "./services/giveaways.js";
import { canHandleTicket, createTicketService } from "./services/tickets.js";
import { assignRankRole, createApplicationService } from "./services/applications.js";
import { collectStats } from "./services/stats.js";
import { createSeriesService, describeSchedule, nextOccurrence } from "./services/event-series.js";
import { publishActivityBoard, refreshActivityBoard } from "./activity-board.js";
import { PANEL_CHANNEL_KEYS, ensurePanels, postEventResult } from "./panels.js";
import { checkChannels } from "./channel-check.js";
import { moveTicketToOpen } from "./ticket-channels.js";
import { PANEL_TEXTS, createTextsService } from "./services/texts.js";
import { eventButtons, eventEmbed, giveawayButtons, giveawayCard, parseEventDate, ticketActions, ticketCard } from "./commands.js";

/** Fehler mit HTTP-Status und einer für Staff verständlichen Meldung. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SNOWFLAKE = /^\d{17,20}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, { min = 0, max = 1000, label = "Eingabe" } = {}) => {
  const result = String(value ?? "").trim();
  if (result.length < min) throw new HttpError(400, min > 1 ? `${label}: bitte mindestens ${min} Zeichen angeben.` : `${label} ist erforderlich.`);
  if (result.length > max) throw new HttpError(400, `${label}: höchstens ${max} Zeichen.`);
  return result;
};
const money = value => { try { return parseMoney(String(value ?? "").replace(/\s/g, "")); } catch (error) { throw new HttpError(400, error.message); } };
const snowflake = (value, label = "Mitglied") => { if (!SNOWFLAKE.test(String(value ?? ""))) throw new HttpError(400, `${label}: bitte aus der Liste auswählen.`); return String(value); };
const requestId = value => { if (!REQUEST_ID.test(String(value ?? ""))) throw new HttpError(400, "Ungültige Anfrage-ID. Bitte Seite neu laden."); return String(value); };
const nowIso = () => new Date().toISOString();

/**
 * Erweiterte Staff-API für das Webdashboard. Jede Route prüft die aktuelle Discord-Rolle des angemeldeten
 * Mitglieds serverseitig, nutzt dieselben Services wie der Bot und protokolliert jede Änderung.
 */
export function createDashboardApi({ db, client, config, settings = null, series = null }) {
  const guildId = config.DISCORD_GUILD_ID;
  series = series ?? createSeriesService(db);
  const texts = guildId ? createTextsService(db, guildId) : null;
  const groups = new Proxy({}, { get: (_, key) => accessGroups(config)[key] });
  const finance = createFinance(db), events = createEventService(db), giveaways = createGiveawayService(db);
  const tickets = createTicketService(db), applications = createApplicationService(db);
  const names = new Map();

  const guild = async () => client.guilds.cache.get(guildId) ?? client.guilds.fetch(guildId);
  const channel = async id => (id ? (await guild()).channels.fetch(id).catch(() => null) : null);
  const can = (member, group) => member.owner || (groups[group] ?? []).some(id => member.roles.includes(id));
  const need = (member, group, label) => {
    if ((groups[group] ?? []).some(id => member.roles.includes(id))) return;
    if (member.owner) { audit(db, guildId, member.id, "admin.override", null, { command: "webdashboard", group }); return; }
    throw new HttpError(403, `Dafür brauchst du die ${label}.`);
  };
  const ticketAllowed = (member, ticket) => canHandleTicket({ memberRoleIds: member.roles, isOwner: member.owner }, ticket, config, groups.staff);
  const categoryLabel = id => (config.TICKET_CATEGORIES_JSON ?? []).find(category => category.id === id)?.label ?? id;

  /** Anzeigenamen statt nackter IDs; bis zu 100 Mitglieder pro Abruf, Ergebnis wird zwischengespeichert. */
  async function resolveNames(ids) {
    const unique = [...new Set(ids.filter(id => SNOWFLAKE.test(String(id ?? ""))))];
    const g = await guild().catch(() => null);
    const missing = unique.filter(id => !names.has(id) && !g?.members?.cache?.has?.(id));
    if (g && missing.length) {
      const fetched = await g.members.fetch({ user: missing.slice(0, 100) }).catch(() => null);
      if (fetched?.forEach) fetched.forEach(m => names.set(m.id, m.displayName ?? m.user?.username));
    }
    return Object.fromEntries(unique.map(id => [id, g?.members?.cache?.get?.(id)?.displayName ?? names.get(id) ?? client.users?.cache?.get?.(id)?.username ?? null]));
  }
  const withNames = async (payload, ids) => ({ ...payload, names: await resolveNames(ids) });

  async function requireGuildMember(userId) {
    const g = await guild();
    const target = await g.members.fetch(userId).catch(() => null);
    if (!target) throw new HttpError(404, "Dieses Mitglied ist nicht auf dem Server.");
    if (target.user?.bot) throw new HttpError(400, "Bots können kein Familienkonto oder Sanktionen haben.");
    return target;
  }
  async function refreshEventMessage(event, { closedTitle = null } = {}) {
    const ch = await channel(event.channel_id);
    const message = ch && event.message_id ? await ch.messages.fetch(event.message_id).catch(() => null) : null;
    if (!message) return false;
    const participants = events.participants(event.id);
    const payload = closedTitle
      ? { embeds: [eventEmbed({ ...event, name: `${closedTitle} · ${event.name}` }, participants.length, participants)], components: [] }
      : { embeds: [eventEmbed(event, participants.length, participants)], components: [eventButtons(event.id)] };
    return message.edit(payload).then(() => true).catch(() => false);
  }

  // ---------------------------------------------------------------- Lesen
  const getRoutes = [
    [/^\/api\/me$/, async member => ({
      member: { id: member.id, name: member.displayName, owner: member.owner },
      capabilities: {
        applications: can(member, "reviewers"), tickets: can(member, "staff") || (config.TICKET_CATEGORIES_JSON ?? []).some(c => c.roleIds.some(id => member.roles.includes(id))),
        events: can(member, "events"), finance: can(member, "finance"), financeView: can(member, "financeView"), leaders: can(member, "leaders"),
        sanctions: can(member, "staff"), sanctionsView: can(member, "staff") || can(member, "financeView"), giveaways: can(member, "staff"), staff: can(member, "anyStaff"),
        settings: Boolean(settings) && can(member, "leaders"),
      },
      settings: {
        timezone: config.TIMEZONE, minimumCents: config.PAYOUT_MINIMUM_CENTS ?? null,
        ticketCategories: (config.TICKET_CATEGORIES_JSON ?? []).map(({ id, label }) => ({ id, label })),
        rankRoles: config.RANK_ROLE_ASSIGNMENT_ENABLED ? config.RANK_ROLES_JSON : [],
        giveawayChannel: config.CHANNEL_GIVEAWAYS ?? null,
      },
    })],
    [/^\/api\/members$/, async (member, url) => {
      need(member, "anyStaff", "Staff-Rolle");
      const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 50);
      if (q.length < 2) return { members: [] };
      const g = await guild();
      const found = SNOWFLAKE.test(q) ? [await g.members.fetch(q).catch(() => null)].filter(Boolean) : [...((await g.members.search({ query: q, limit: 10 }).catch(() => null))?.values() ?? [])];
      return { members: found.filter(m => !m.user?.bot).map(m => ({ id: m.id, name: m.displayName, tag: m.user?.username ?? "" })) };
    }],
    [/^\/api\/roles$/, async member => {
      need(member, "staff", "Staff-Rolle");
      const g = await guild();
      const roles = [...(await g.roles.fetch()).values()].filter(role => !role.managed && role.id !== g.id).sort((a, b) => b.position - a.position);
      return { roles: roles.map(role => ({ id: role.id, name: role.name })) };
    }],
    [/^\/api\/channels$/, async member => {
      need(member, "staff", "Staff-Rolle");
      const g = await guild();
      const me = g.members.me;
      const all = [...(await g.channels.fetch()).values()].filter(Boolean);
      const text = all.filter(ch => ch.isTextBased?.() && !ch.isThread?.() && (!me || ch.permissionsFor?.(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) !== false));
      const categories = all.filter(ch => ch.type === 4);
      const sort = list => list.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
      return { channels: sort(text).map(ch => ({ id: ch.id, name: ch.name, parent: ch.parent?.name ?? "" })), categories: sort(categories).map(ch => ({ id: ch.id, name: ch.name })) };
    }],
    [/^\/api\/applications$/, async (member, url) => {
      need(member, "reviewers", "Reviewer- oder Leitungsrolle");
      const closed = url.searchParams.get("status") === "closed";
      const rows = db.prepare(`SELECT a.*, g.role_id AS granted_role, g.result AS grant_result FROM applications a LEFT JOIN application_role_grants g ON g.application_id=a.id WHERE a.guild_id=? AND a.status ${closed ? "NOT IN ('open','review')" : "IN ('open','review')"} ORDER BY ${closed ? "a.updated_at DESC LIMIT 40" : "a.created_at"}`).all(guildId);
      const items = rows.map(row => ({ ...row, notes: applications.notes(row.id, 10) }));
      return withNames({ applications: items }, items.flatMap(a => [a.user_id, a.reviewer_id, ...a.notes.map(n => n.author_id)]));
    }],
    [/^\/api\/tickets$/, async (member, url) => {
      const closed = url.searchParams.get("status") === "closed";
      const rows = db.prepare(`SELECT id,channel_id,user_id,category,status,claimed_by,closed_by,created_at,closed_at,(SELECT 1 FROM ticket_transcripts t WHERE t.ticket_id=tickets.id) AS has_transcript FROM tickets WHERE guild_id=? AND status=? ORDER BY ${closed ? "closed_at DESC LIMIT 40" : "created_at"}`).all(guildId, closed ? "closed" : "open").filter(t => ticketAllowed(member, t));
      if (!rows.length && !can(member, "staff") && !(config.TICKET_CATEGORIES_JSON ?? []).some(c => c.roleIds.some(id => member.roles.includes(id)))) throw new HttpError(403, "Dafür brauchst du die Staff-Rolle.");
      const items = rows.map(t => ({ ...t, category_label: categoryLabel(t.category) }));
      return withNames({ tickets: items }, items.flatMap(t => [t.user_id, t.claimed_by, t.closed_by]));
    }],
    [/^\/api\/tickets\/([\w-]+)\/transcript$/, async (member, url, [, id]) => {
      const ticket = db.prepare("SELECT * FROM tickets WHERE id=? AND guild_id=?").get(id, guildId);
      if (!ticket || !ticketAllowed(member, ticket)) throw new HttpError(404, "Ticket nicht gefunden.");
      const stored = db.prepare("SELECT messages,created_at FROM ticket_transcripts WHERE ticket_id=?").get(id);
      return { ticket: { id, category: categoryLabel(ticket.category) }, createdAt: stored?.created_at ?? null, messages: stored ? JSON.parse(stored.messages).map(m => ({ author: m.author, createdAt: m.createdAt, content: m.content, attachments: (m.attachments ?? []).map(a => a.name) })) : [] };
    }],
    [/^\/api\/events$/, async (member, url) => {
      need(member, "anyStaff", "Staff-Rolle");
      const past = url.searchParams.get("scope") === "past";
      const rows = past
        ? db.prepare("SELECT * FROM events WHERE guild_id=? AND status IN ('ended','cancelled') ORDER BY starts_at DESC LIMIT 30").all(guildId)
        : db.prepare("SELECT * FROM events WHERE guild_id=? AND status='scheduled' ORDER BY starts_at").all(guildId);
      const items = rows.map(e => ({ ...e, participants: db.prepare("SELECT user_id,status FROM event_participants WHERE event_id=? AND status<>'left' ORDER BY updated_at").all(e.id) }));
      return withNames({ events: items }, items.flatMap(e => [e.host_id, ...e.participants.map(p => p.user_id)]));
    }],
    [/^\/api\/accounts$/, async member => {
      need(member, "financeView", "Finanzrolle");
      const rows = db.prepare("SELECT user_id,balance_cents,updated_at FROM accounts WHERE guild_id=? ORDER BY balance_cents DESC,user_id LIMIT 500").all(guildId);
      const withOpen = db.prepare("SELECT DISTINCT user_id FROM sanctions WHERE guild_id=? AND status IN ('open','partial')").all(guildId).map(r => r.user_id);
      const ids = [...new Set([...rows.map(r => r.user_id), ...withOpen])];
      const minimum = config.PAYOUT_MINIMUM_CENTS ?? null;
      const accounts = ids.map(userId => {
        const plan = finance.previewPayout(guildId, userId);
        return { userId, gross: plan.gross, openSanctions: plan.openCents, deduction: plan.deduction, net: plan.net, remainingAfter: plan.remainingAfter, eligible: plan.gross > 0 && (minimum == null || plan.gross >= minimum) };
      }).sort((a, b) => b.gross - a.gross);
      const totals = accounts.reduce((sum, a) => ({ gross: sum.gross + a.gross, open: sum.open + a.openSanctions, net: sum.net + a.net }), { gross: 0, open: 0, net: 0 });
      return withNames({ accounts, totals, minimumCents: minimum }, ids);
    }],
    [/^\/api\/accounts\/(\d{17,20})$/, async (member, url, [, userId]) => {
      need(member, "financeView", "Finanzrolle");
      const plan = finance.previewPayout(guildId, userId);
      const transactions = db.prepare("SELECT id,type,amount_cents,gross_cents,deduction_cents,net_cents,reason,actor_id,created_at FROM transactions WHERE guild_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50").all(guildId, userId);
      const sanctions = finance.sanctionDetails(guildId, userId, { limit: 50 });
      const warnings = db.prepare("SELECT id,reason,case_ref,actor_id,created_at FROM member_warnings WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20").all(guildId, userId);
      return withNames({ userId, plan, transactions, sanctions, warnings }, [userId, ...transactions.map(t => t.actor_id), ...sanctions.map(s => s.actor_id), ...warnings.map(w => w.actor_id)]);
    }],
    [/^\/api\/sanctions$/, async (member, url) => {
      if (!can(member, "staff") && !can(member, "financeView")) throw new HttpError(403, "Dafür brauchst du die Staff- oder Finanzrolle.");
      const all = url.searchParams.get("status") === "all";
      const rows = db.prepare(`SELECT s.*, COALESCE((SELECT SUM(amount_cents) FROM payout_allocations p WHERE p.sanction_id=s.id),0) AS collected_cents,
        COALESCE((SELECT SUM(amount_cents) FROM sanction_refunds r WHERE r.sanction_id=s.id),0) AS refunded_cents
        FROM sanctions s WHERE s.guild_id=? ${all ? "" : "AND s.status IN ('open','partial')"} ORDER BY s.created_at DESC LIMIT 200`).all(guildId);
      const warnings = db.prepare("SELECT id,user_id,reason,case_ref,actor_id,created_at FROM member_warnings WHERE guild_id=? ORDER BY created_at DESC LIMIT 30").all(guildId);
      const openTotal = db.prepare("SELECT COALESCE(SUM(remaining_cents),0) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')").get(guildId).n;
      return withNames({ sanctions: rows, warnings, openTotal }, [...rows.flatMap(s => [s.user_id, s.actor_id]), ...warnings.flatMap(w => [w.user_id, w.actor_id])]);
    }],
    [/^\/api\/giveaways$/, async member => {
      need(member, "staff", "Staff-Rolle");
      const rows = db.prepare("SELECT g.*,(SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id=g.id) AS entries FROM giveaways g WHERE g.guild_id=? AND (g.status='active' OR g.created_at>=?) ORDER BY g.status='active' DESC, g.ends_at DESC LIMIT 40").all(guildId, new Date(Date.now() - 60 * 86_400_000).toISOString());
      const items = rows.map(row => ({ ...row, winners: JSON.parse(row.winners ?? "[]") }));
      return withNames({ giveaways: items }, items.flatMap(g => [g.created_by, ...g.winners]));
    }],
    [/^\/api\/stats$/, async (member, url) => {
      need(member, "anyStaff", "Staff-Rolle");
      const days = [7, 30, 90, 365, 0].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
      const stats = collectStats(db, guildId, { days, includeFinance: can(member, "financeView") });
      return withNames({ stats, memberCount: (await guild().catch(() => null))?.memberCount ?? null }, stats.staffActions.map(s => s.actor_id));
    }],
    [/^\/api\/audit$/, async (member, url) => {
      need(member, "anyStaff", "Staff-Rolle");
      const prefix = String(url.searchParams.get("action") ?? "").replace(/[^a-z_.]/g, "").slice(0, 30);
      const financeAllowed = can(member, "financeView");
      const rows = db.prepare(`SELECT id,action,actor_id,target_id,details,created_at FROM audit_logs WHERE guild_id=? ${prefix ? "AND action LIKE ?" : "AND action NOT IN ('event.participation','giveaway.entry')"} ${financeAllowed ? "" : "AND action NOT LIKE 'finance.%'"} ORDER BY created_at DESC, rowid DESC LIMIT 150`)
        .all(...[guildId, ...(prefix ? [`${prefix}%`] : [])]);
      const items = rows.map(row => ({ ...row, details: JSON.parse(row.details || "{}") }));
      return withNames({ entries: items }, items.flatMap(r => [r.actor_id, r.target_id, r.details.applicantId]));
    }],
    [/^\/api\/settings$/, async member => {
      if (!settings) throw new HttpError(409, "Einstellungen über die Website brauchen DISCORD_GUILD_ID in der .env.");
      need(member, "leaders", "Leitungsrolle");
      return { settings: settings.describe() };
    }],
    [/^\/api\/texts$/, async member => {
      if (!texts) throw new HttpError(409, "Panel-Texte brauchen DISCORD_GUILD_ID in der .env.");
      need(member, "leaders", "Leitungsrolle");
      return { panels: texts.describe().map(panel => ({ ...panel, channelSet: Boolean(config[panel.channelKey]) })) };
    }],
    [/^\/api\/channel-check$/, async member => {
      need(member, "leaders", "Leitungsrolle");
      return checkChannels({ guild: await guild(), config });
    }],
    [/^\/api\/series$/, async member => {
      need(member, "anyStaff", "Staff-Rolle");
      if (!series) return { series: [] };
      const list = series.list(guildId).map(item => {
        const next = item.kind === "scheduled" ? nextOccurrence(item, config.TIMEZONE) : null;
        return { ...item, active: Boolean(item.active), schedule: describeSchedule(item), next: next?.toISOString() ?? null };
      });
      return { series: list, announcementChannel: config.CHANNEL_EVENT_ANNOUNCEMENTS ?? null };
    }],
  ];

  // ---------------------------------------------------------------- Schreiben
  const postRoutes = [
    [/^\/api\/applications\/([\w-]+)\/note$/, async (member, body, [, id]) => {
      need(member, "reviewers", "Reviewer- oder Leitungsrolle");
      const note = text(body.note, { min: 2, max: 1000, label: "Notiz" });
      let result;
      try { result = applications.addNote({ guildId, applicationId: id, authorId: member.id, note }); } catch (error) { throw new HttpError(400, error.message); }
      const ch = await channel(result.application.kind === "rang" ? config.CHANNEL_RANK_REVIEW : config.CHANNEL_APPLICATION_REVIEW);
      if (ch) await ch.send({ embeds: [logEmbed("💬 Interne Notiz (Webdashboard)", `**Antrag:** \`${id.slice(0, 8)}\` · <@${result.application.user_id}>\n**Von:** <@${member.id}>\n\n${note}`)], allowedMentions: { parse: [] } }).catch(() => {});
      return { message: "Notiz gespeichert. Sie ist nur für das Team sichtbar." };
    }],
    [/^\/api\/applications\/([\w-]+)\/role$/, async (member, body, [, id]) => {
      need(member, "leaders", "Leitungsrolle");
      const result = await assignRankRole({ db, config, guild: await guild(), applicationId: id, roleId: snowflake(body.roleId, "Rolle"), actorId: member.id });
      if (!result.ok) throw new HttpError(409, result.message.replace(/\*\*/g, ""));
      return { message: result.message.replace(/\*\*|<@\d+>/g, "").trim() };
    }],
    [/^\/api\/tickets\/([\w-]+)\/reopen$/, async (member, body, [, id]) => {
      const ticket = db.prepare("SELECT * FROM tickets WHERE id=? AND guild_id=?").get(id, guildId);
      if (!ticket || !ticketAllowed(member, ticket)) throw new HttpError(404, "Ticket nicht gefunden.");
      const row = tickets.reopen({ guildId, ticketId: id, actorId: member.id });
      if (!row) throw new HttpError(409, "Das Ticket ist nicht geschlossen oder sein Channel existiert nicht mehr.");
      const ch = await channel(row.channel_id);
      if (ch) {
        await ch.permissionOverwrites.edit(row.user_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
        await ch.setName(`ticket-${row.category}-${row.user_id.slice(-4)}`.slice(0, 90)).catch(() => {});
        await moveTicketToOpen(ch, config);
        const message = row.message_id ? await ch.messages.fetch(row.message_id).catch(() => null) : null;
        await message?.edit({ embeds: [ticketCard(categoryLabel(row.category), row.user_id, row.claimed_by)], components: ticketActions(row.id, Boolean(row.claimed_by)) }).catch(() => {});
      }
      return { message: "Ticket wieder geöffnet." };
    }],
    [/^\/api\/events\/([\w-]+)\/update$/, async (member, body, [, id]) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      const old = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(id, guildId);
      if (!old) throw new HttpError(404, "Das Event ist nicht mehr geplant.");
      const start = body.startsAt ? parseEventDate(body.startsAt, config.TIMEZONE) : new Date(old.starts_at);
      if (!start || (body.startsAt && start.getTime() < Date.now() + 60_000)) throw new HttpError(400, `Bitte ein gültiges zukünftiges Datum angeben (${config.TIMEZONE}).`);
      const maximum = body.maximum === "" || body.maximum == null ? null : Number(body.maximum);
      if (maximum !== null && (!Number.isInteger(maximum) || maximum < 1 || maximum > 500)) throw new HttpError(400, "Teilnehmerlimit zwischen 1 und 500 oder leer lassen.");
      const next = { name: text(body.name ?? old.name, { min: 3, max: 100, label: "Name" }), description: text(body.description ?? old.description, { max: 1000, label: "Beschreibung" }), location: text(body.location ?? old.location, { min: 2, max: 100, label: "Treffpunkt" }), starts_at: start.toISOString(), max_participants: maximum, equipment: text(body.equipment ?? old.equipment, { max: 500, label: "Ausrüstung" }), notes: text(body.notes ?? old.notes, { max: 500, label: "Hinweise" }) };
      const changed = Object.keys(next).filter(key => next[key] !== old[key]);
      if (!changed.length) return { message: "Keine Änderung." };
      db.transaction(() => {
        db.prepare("UPDATE events SET name=?,description=?,location=?,starts_at=?,max_participants=?,equipment=?,notes=? WHERE id=? AND status='scheduled'").run(next.name, next.description, next.location, next.starts_at, next.max_participants, next.equipment, next.notes, id);
        if (changed.includes("starts_at")) db.prepare("DELETE FROM event_reminders WHERE event_id=?").run(id);
        audit(db, guildId, member.id, "event.updated", id, { name: next.name, startsAt: next.starts_at, changed: changed.join(", ") });
      })();
      const refreshed = await refreshEventMessage(db.prepare("SELECT * FROM events WHERE id=?").get(id));
      return { message: refreshed ? "Event gespeichert und Ankündigung aktualisiert." : "Event gespeichert; die Discord-Ankündigung war nicht erreichbar." };
    }],
    [/^\/api\/events\/([\w-]+)\/end$/, async (member, body, [, id]) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      const row = db.transaction(() => {
        const changed = db.prepare("UPDATE events SET status='ended' WHERE id=? AND guild_id=? AND status='scheduled' RETURNING *").get(id, guildId);
        if (changed) audit(db, guildId, member.id, "event.ended", id, { name: changed.name });
        return changed;
      })();
      if (!row) throw new HttpError(409, "Das Event ist nicht mehr geplant.");
      await refreshEventMessage(row, { closedTitle: "BEENDET" });
      await postEventResult({ db, client, config, event: row }).catch(() => {});
      return { message: "Event beendet. Anwesenheit kann weiterhin dokumentiert werden." };
    }],
    [/^\/api\/events\/([\w-]+)\/attendance$/, async (member, body, [, id]) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      if (!["present", "absent"].includes(body.status)) throw new HttpError(400, "Ungültiger Anwesenheitsstatus.");
      const result = events.setAttendance({ guildId, eventId: id, userId: snowflake(body.userId), status: body.status, actorId: member.id });
      if (!result) throw new HttpError(404, "Event nicht gefunden oder abgesagt.");
      return { message: body.status === "present" ? "Als anwesend dokumentiert." : "Als abwesend dokumentiert." };
    }],
    [/^\/api\/accounts\/(\d{17,20})\/credit$/, async (member, body, [, userId]) => {
      need(member, "finance", "Finanzrolle");
      await requireGuildMember(userId);
      const cents = money(body.amount), reason = text(body.reason, { min: 3, max: 300, label: "Buchungsgrund" });
      const tx = finance.credit({ guildId, userId, actorId: member.id, cents, reason, key: `web-credit:${requestId(body.requestId)}` });
      return { message: `Gutschrift über ${formatMoney(tx.amount_cents)} verbucht.`, transactionId: tx.id };
    }],
    [/^\/api\/accounts\/(\d{17,20})\/correction$/, async (member, body, [, userId]) => {
      need(member, "leaders", "Leitungsrolle");
      if (!["credit", "debit"].includes(body.direction)) throw new HttpError(400, "Bitte die Richtung der Korrektur wählen.");
      const cents = money(body.amount), reason = text(body.reason, { min: 3, max: 300, label: "Korrekturgrund" });
      const tx = finance.correction({ guildId, userId, actorId: member.id, cents, direction: body.direction, reason, key: `web-correction:${requestId(body.requestId)}` });
      return { message: `Korrektur ${body.direction === "debit" ? "−" : "+"}${formatMoney(tx.amount_cents)} verbucht.`, transactionId: tx.id };
    }],
    [/^\/api\/accounts\/(\d{17,20})\/payout-preview$/, async (member, body, [, userId]) => {
      need(member, "finance", "Finanzrolle");
      const plan = finance.previewPayout(guildId, userId);
      const minimum = config.PAYOUT_MINIMUM_CENTS;
      return { plan: { ...plan, allocations: plan.allocations.map(a => ({ ...a, reason: db.prepare("SELECT reason FROM sanctions WHERE id=?").get(a.id)?.reason ?? "" })) }, belowMinimum: minimum != null && plan.gross < minimum, minimumCents: minimum ?? null, requestId: randomUUID() };
    }],
    [/^\/api\/accounts\/(\d{17,20})\/payout$/, async (member, body, [, userId]) => {
      need(member, "finance", "Finanzrolle");
      const key = `web-payout:${requestId(body.requestId)}`;
      const existing = db.prepare("SELECT * FROM transactions WHERE idempotency_key=?").get(key);
      const tx = existing ?? finance.payout({ guildId, userId, actorId: member.id, key, minimumCents: config.PAYOUT_MINIMUM_CENTS, expectedGross: Number(body.expectedGross), expectedDeduction: Number(body.expectedDeduction) });
      if (!existing) {
        const dm = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  FAMILIENKONTO" }).setTitle("💸 Auszahlung verbucht")
          .addFields({ name: "Brutto", value: formatMoney(tx.gross_cents), inline: true }, { name: "Sanktionsabzug", value: formatMoney(tx.deduction_cents), inline: true }, { name: "Auszahlung", value: `**${formatMoney(tx.net_cents)}**`, inline: true }, { name: "Referenz", value: `\`${tx.id.slice(0, 8)}\``, inline: true })
          .setFooter({ text: "GAMBINOS  •  Private Nachricht" }).setTimestamp();
        await client.users.fetch(userId).then(user => user.send({ embeds: [dm] })).catch(() => {});
      }
      return { message: existing ? "Diese Auszahlung war bereits verbucht; es wurde nichts doppelt gebucht." : `Auszahlung verbucht: ${formatMoney(tx.net_cents)} netto (Abzug ${formatMoney(tx.deduction_cents)}). Bitte jetzt im Spiel auszahlen.`, transaction: { id: tx.id, gross: tx.gross_cents, deduction: tx.deduction_cents, net: tx.net_cents } };
    }],
    [/^\/api\/sanctions$/, async (member, body) => {
      need(member, "staff", "Staff-Rolle");
      const userId = snowflake(body.userId);
      await requireGuildMember(userId);
      const id = finance.sanction({ guildId, userId, actorId: member.id, cents: money(body.amount), reason: text(body.reason, { min: 3, max: 300, label: "Grund" }), caseRef: text(body.caseRef, { max: 100, label: "Fallbezug" }) || null });
      return { message: "Sanktion vorgemerkt. Sie wird erst bei der nächsten Auszahlung verrechnet.", id };
    }],
    [/^\/api\/warnings$/, async (member, body) => {
      need(member, "staff", "Staff-Rolle");
      const userId = snowflake(body.userId);
      await requireGuildMember(userId);
      finance.warn({ guildId, userId, actorId: member.id, reason: text(body.reason, { min: 3, max: 300, label: "Grund" }), caseRef: text(body.caseRef, { max: 100, label: "Fallbezug" }) || null });
      return { message: "Verwarnung eingetragen (ohne Geldabzug)." };
    }],
    [/^\/api\/sanctions\/([\w-]+)\/void$/, async (member, body, [, id]) => {
      need(member, "leaders", "Leitungsrolle");
      finance.voidSanction({ guildId, sanctionId: id, actorId: member.id, reason: text(body.reason, { min: 3, max: 300, label: "Grund" }) });
      return { message: "Sanktion aufgehoben. Sie wird nicht mehr verrechnet." };
    }],
    [/^\/api\/sanctions\/([\w-]+)\/correct$/, async (member, body, [, id]) => {
      need(member, "leaders", "Leitungsrolle");
      const row = finance.correctSanction({ guildId, sanctionId: id, actorId: member.id, cents: money(body.amount), reason: text(body.reason, { min: 3, max: 300, label: "Grund" }) });
      return { message: `Sanktion korrigiert: ${formatMoney(row.amount_cents)}, davon offen ${formatMoney(row.remaining_cents)}.` };
    }],
    [/^\/api\/sanctions\/([\w-]+)\/refund$/, async (member, body, [, id]) => {
      need(member, "leaders", "Leitungsrolle");
      const tx = finance.refundSanction({ guildId, sanctionId: id, actorId: member.id, reason: text(body.reason, { min: 3, max: 300, label: "Grund" }), key: `web-refund:${requestId(body.requestId)}` });
      return { message: `${formatMoney(tx.amount_cents)} wurden dem Familienkonto erstattet; die Sanktion ist aufgehoben.` };
    }],
    [/^\/api\/giveaways$/, async (member, body) => {
      need(member, "staff", "Staff-Rolle");
      const minutes = Number(body.minutes), winners = Number(body.winners);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) throw new HttpError(400, "Dauer: 1 bis 43.200 Minuten.");
      if (!Number.isInteger(winners) || winners < 1 || winners > 20) throw new HttpError(400, "Gewinnerzahl: 1 bis 20.");
      const target = await channel(snowflake(body.channelId, "Channel"));
      if (!target?.isTextBased?.()) throw new HttpError(400, "Der Channel ist nicht erreichbar.");
      const roleId = body.roleId ? snowflake(body.roleId, "Rolle") : null;
      const row = { id: randomUUID(), guild_id: guildId, prize: text(body.prize, { min: 2, max: 200, label: "Preis" }), ends_at: new Date(Date.now() + minutes * 60_000).toISOString(), winner_count: winners, conditions: text(body.conditions, { max: 500, label: "Bedingungen" }) || "Keine weiteren Bedingungen", required_role_id: roleId, created_by: member.id };
      db.transaction(() => {
        db.prepare("INSERT INTO giveaways(id,guild_id,channel_id,prize,ends_at,winner_count,conditions,status,created_by,created_at,required_role_id) VALUES(?,?,?,?,?,?,?,'active',?,?,?)").run(row.id, guildId, target.id, row.prize, row.ends_at, row.winner_count, row.conditions, member.id, nowIso(), roleId);
        audit(db, guildId, member.id, "giveaway.created", row.id, { prize: row.prize, endsAt: row.ends_at, winners, channelId: target.id });
      })();
      const sent = await target.send({ embeds: [giveawayCard(row)], components: [giveawayButtons(row.id)] }).catch(() => null);
      if (!sent) { giveaways.cancel({ guildId, giveawayId: row.id, actorId: member.id, reason: "Veröffentlichung fehlgeschlagen" }); throw new HttpError(502, "Discord hat die Nachricht abgelehnt. Das Giveaway wurde abgebrochen; bitte Bot-Rechte im Channel prüfen."); }
      db.prepare("UPDATE giveaways SET message_id=? WHERE id=?").run(sent.id, row.id);
      return { message: "Giveaway veröffentlicht." };
    }],
    [/^\/api\/giveaways\/([\w-]+)\/cancel$/, async (member, body, [, id]) => {
      need(member, "staff", "Staff-Rolle");
      const row = giveaways.cancel({ guildId, giveawayId: id, actorId: member.id, reason: text(body.reason, { max: 300, label: "Grund" }) });
      if (!row) throw new HttpError(409, "Das Giveaway ist nicht mehr aktiv.");
      const ch = await channel(row.channel_id);
      const message = ch && row.message_id ? await ch.messages.fetch(row.message_id).catch(() => null) : null;
      await message?.edit({ embeds: [logEmbed("🚫 Giveaway abgebrochen", `**${row.prize}** wird nicht mehr verlost.`, "warning")], components: [] }).catch(() => {});
      return { message: "Giveaway abgebrochen." };
    }],
    [/^\/api\/giveaways\/([\w-]+)\/draw$/, async (member, body, [, id]) => {
      need(member, "staff", "Staff-Rolle");
      // Nur das Ende wird vorgezogen; die eigentliche Ziehung erledigt der Scheduler genau einmal.
      const changed = db.transaction(() => {
        const row = db.prepare("UPDATE giveaways SET ends_at=? WHERE id=? AND guild_id=? AND status='active' RETURNING prize").get(nowIso(), id, guildId);
        if (row) audit(db, guildId, member.id, "giveaway.draw_requested", id, { prize: row.prize });
        return row;
      })();
      if (!changed) throw new HttpError(409, "Das Giveaway ist nicht mehr aktiv.");
      return { message: "Giveaway wird in wenigen Sekunden ausgelost und in Discord verkündet." };
    }],
    [/^\/api\/settings$/, async (member, body) => {
      if (!settings) throw new HttpError(409, "Einstellungen über die Website brauchen DISCORD_GUILD_ID in der .env.");
      need(member, "leaders", "Leitungsrolle");
      try { settings.update({ key: String(body.key ?? ""), value: body.value, actorId: member.id, actorRoleIds: member.roles, actorIsOwner: member.owner }); }
      catch (error) { throw new HttpError(400, error.message); }
      const key = String(body.key);
      let note = "";
      if (PANEL_CHANNEL_KEYS.includes(key) || key === "TICKET_CATEGORIES_JSON" || key === "TIMEZONE") {
        const panels = await ensurePanels({ db, client, config, series, only: key === "TICKET_CATEGORIES_JSON" ? ["CHANNEL_TICKET_PANEL"] : key === "TIMEZONE" ? ["CHANNEL_ACTIVITY_BOARD"] : [key] }).catch(() => []);
        if (panels.some(p => p.status === "posted")) note = " Das Panel wurde im Channel gepostet.";
        if (panels.some(p => p.status === "failed" || p.status === "channel_unavailable")) note = " Das Panel konnte nicht gepostet werden – bitte Bot-Rechte im Channel prüfen.";
      }
      return { message: `Gespeichert. Die Änderung gilt sofort.${note}`, settings: settings.describe() };
    }],
    [/^\/api\/settings\/reset$/, async (member, body) => {
      if (!settings) throw new HttpError(409, "Einstellungen über die Website brauchen DISCORD_GUILD_ID in der .env.");
      need(member, "leaders", "Leitungsrolle");
      try { settings.reset({ key: String(body.key ?? ""), actorId: member.id, actorRoleIds: member.roles, actorIsOwner: member.owner }); }
      catch (error) { throw new HttpError(400, error.message); }
      return { message: "Zurückgesetzt auf den Wert aus der .env bzw. den Standard.", settings: settings.describe() };
    }],
    [/^\/api\/texts(\/reset)?$/, async (member, body, [, reset]) => {
      if (!texts) throw new HttpError(409, "Panel-Texte brauchen DISCORD_GUILD_ID in der .env.");
      need(member, "leaders", "Leitungsrolle");
      const panel = String(body.panel ?? "");
      if (!PANEL_TEXTS[panel]) throw new HttpError(400, "Unbekanntes Panel.");
      try { reset ? texts.reset({ panel, actorId: member.id }) : texts.update({ panel, values: body.values ?? {}, actorId: member.id }); }
      catch (error) { throw new HttpError(400, error.message); }
      const channelKey = PANEL_TEXTS[panel].channelKey;
      let note = " Das Panel wird angepasst, sobald ein Channel dafür eingestellt ist.";
      if (config[channelKey]) {
        const [result] = await ensurePanels({ db, client, config, series, only: [channelKey] }).catch(() => []);
        note = ["ok", "adopted"].includes(result?.status) ? " Das Panel in Discord wurde aktualisiert." : result?.status === "posted" ? " Das Panel wurde neu im Channel gepostet." : " Das Panel konnte in Discord nicht aktualisiert werden – bitte Channel-Prüfung ansehen.";
      }
      return { message: `${reset ? "Standardtexte wiederhergestellt." : "Texte gespeichert."}${note}`, panels: texts.describe().map(p => ({ ...p, channelSet: Boolean(config[p.channelKey]) })) };
    }],
    [/^\/api\/series$/, async (member, body) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      try { series.create({ guildId, actorId: member.id, input: body }); } catch (error) { throw new HttpError(400, error.message); }
      await refreshActivityBoard({ db, client, config, series }).catch(() => {});
      return { message: "Aktivität angelegt." };
    }],
    [/^\/api\/series\/([\w-]+)\/update$/, async (member, body, [, id]) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      try { series.update({ guildId, id, actorId: member.id, input: body }); } catch (error) { throw new HttpError(400, error.message); }
      await refreshActivityBoard({ db, client, config, series }).catch(() => {});
      return { message: "Aktivität gespeichert. Bereits angekündigte Termine bleiben unverändert." };
    }],
    [/^\/api\/series\/([\w-]+)\/toggle$/, async (member, body, [, id]) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      const row = series.setActive({ guildId, id, actorId: member.id, active: Boolean(body.active) });
      if (!row) throw new HttpError(404, "Aktivität nicht gefunden.");
      await refreshActivityBoard({ db, client, config, series }).catch(() => {});
      const hint = row.active && row.kind === "scheduled" && !config.CHANNEL_EVENT_ANNOUNCEMENTS ? " Achtung: Kein Event-Ankündigungs-Channel eingestellt." : "";
      return { message: `${row.name} ist jetzt ${row.active ? "aktiv" : "inaktiv"}.${hint}` };
    }],
    [/^\/api\/series\/([\w-]+)\/delete$/, async (member, body, [, id]) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      const row = series.remove({ guildId, id, actorId: member.id });
      if (!row) throw new HttpError(404, "Aktivität nicht gefunden.");
      await refreshActivityBoard({ db, client, config, series }).catch(() => {});
      return { message: `${row.name} wurde gelöscht. Bereits erstellte Events bleiben in der Historie.` };
    }],
    [/^\/api\/series\/board$/, async (member, body) => {
      need(member, "events", "Event-Team- oder Leitungsrolle");
      const target = await channel(snowflake(body.channelId, "Channel"));
      if (!target?.isTextBased?.()) throw new HttpError(400, "Der Channel ist nicht erreichbar.");
      await publishActivityBoard({ db, channel: target, config, series, actorId: member.id }).catch(() => { throw new HttpError(502, "Discord hat die Nachricht abgelehnt. Bitte Bot-Rechte im Channel prüfen."); });
      return { message: "Aktivitäten-Übersicht veröffentlicht. Sie aktualisiert sich automatisch." };
    }],
  ];

  async function dispatch(routes, member, ...args) {
    const pathname = args[0].pathname ?? args[0];
    for (const [pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      try { return { status: 200, body: await handler(member, ...args.slice(1), match) }; }
      catch (error) {
        if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
        if (error instanceof FinanceError) return { status: ["PREVIEW_MISMATCH", "CONCURRENT_CHANGE", "SANCTION_CONFLICT"].includes(error.code) ? 409 : 400, body: { error: error.message, code: error.code } };
        throw error;
      }
    }
    return null;
  }

  return {
    get: (member, url) => dispatch(getRoutes, member, url, url),
    post: (member, url, body) => dispatch(postRoutes, member, url, body),
  };
}
