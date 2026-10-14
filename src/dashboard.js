import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit } from "./database.js";
import { AttachmentBuilder } from "discord.js";
import { applicationReviewComponents, eventButtons, eventEmbed, fetchTranscript, parseEventDate, ticketActions, ticketCard, ticketClosedActions, ticketClosedCard, buildApplicationReviewPayload } from "./commands.js";
import { applicationDecisionDm, applicationInReviewDm, logEmbed } from "./presentation.js";
import { accessGroups } from "./config.js";
import { canHandleTicket, createTicketService } from "./services/tickets.js";
import { createDashboardApi } from "./dashboard-api.js";
import { createFinance } from "./services/finance.js";
import { moveTicketToClosed } from "./ticket-channels.js";
import { deleteEventPosts, publishEvent, refreshEventPosts } from "./event-posts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".gif": "image/gif" };
const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function createDashboard({ db, client, config, settings = null, series = null }) {
  if (!config.DASHBOARD_ENABLED) return { close: async () => {} };
  const state = new Map();
  const cookieName = "gambino_staff";
  const secret = config.DASHBOARD_SESSION_SECRET;
  const groups = new Proxy({}, { get: (_, key) => accessGroups(config)[key] });
  // Login: alle Staff-Stufen, reine Finanz-Einsicht und für Ticket-Kategorien zuständige Rollen (live, damit Rollenänderungen sofort gelten).
  const staffRoleIds = () => [...new Set([...groups.anyStaff, ...groups.financeView, ...(config.TICKET_CATEGORIES_JSON ?? []).flatMap(category => category.roleIds)])];
  const extendedApi = createDashboardApi({ db, client, config, settings, series });
  const ticketService = createTicketService(db);
  const categoryLabel = id => (config.TICKET_CATEGORIES_JSON ?? []).find(category => category.id === id)?.label ?? id;
  const sign = value => createHmac("sha256", secret).update(value).digest("base64url");
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const send = (res, status, body, type = "application/json; charset=utf-8", headers = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https://cdn.discordapp.com", ...headers });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
  };
  const memberFor = async userId => {
    const guild = client.guilds.cache.get(config.DISCORD_GUILD_ID) ?? await client.guilds.fetch(config.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    const roles = staffRoleIds().filter(id => member.roles.cache.has(id));
    const owner = config.BOT_OWNER_IDS?.includes(userId) ?? false;
    // Server-Profilbild bevorzugt, sonst globales Discord-Profilbild (nur Bilder von cdn.discordapp.com).
    const avatar = typeof member.displayAvatarURL === "function" ? member.displayAvatarURL({ size: 64, extension: "png" }) : null;
    return roles.length || owner ? { id: member.id, tag: member.user.tag, displayName: member.displayName, roles, owner, avatar } : null;
  };
  const can = (member, group) => member.owner || (config[group] ?? []).some(id => member.roles.includes(id));
  const readBody = req => new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 20_000) { reject(new Error("Anfrage ist zu groß.")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Ungültige Anfrage.")); } });
    req.on("error", reject);
  });
  const ensureGuildChannel = async channelId => {
    if (!channelId) return null;
    const guild = client.guilds.cache.get(config.DISCORD_GUILD_ID) ?? await client.guilds.fetch(config.DISCORD_GUILD_ID);
    return guild.channels.fetch(channelId).catch(() => null);
  };
  const applicationChannel = async kind => {
    const channelId = kind === "rang" ? config.CHANNEL_RANK_REVIEW : config.CHANNEL_APPLICATION_REVIEW;
    return ensureGuildChannel(channelId);
  };
  const refreshApplication = async row => {
    const channel = await applicationChannel(row.kind);
    const message = channel && row.message_id ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
    if (!message) return;
    if (["open", "review"].includes(row.status)) {
      await message.edit({ ...buildApplicationReviewPayload(row.kind, row.user_id, JSON.parse(row.answers), row.status === "review" ? "review" : null, row.review_note ?? "", row.reviewer_id), components: applicationReviewComponents(row.id, row.status) }).catch(() => {});
    } else await message.edit({ ...buildApplicationReviewPayload(row.kind, row.user_id, JSON.parse(row.answers), row.status, row.review_note ?? ""), components: [] }).catch(() => {});
  };
  const sessionFor = async req => {
    const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw) return null;
    const [payload, signature] = raw.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    let session;
    try { session = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
    if (session.exp < Date.now()) return null;
    return memberFor(session.sub);
  };
  const count = (sql, ...params) => db.prepare(sql).get(...params)?.n ?? 0;
  const summary = (includeFinance = false) => {
    return {
      members: client.guilds.cache.get(config.DISCORD_GUILD_ID)?.memberCount ?? null,
      tickets: count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'", config.DISCORD_GUILD_ID),
      applications: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status IN ('open','review')", config.DISCORD_GUILD_ID),
      events: count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>?", config.DISCORD_GUILD_ID, new Date().toISOString()),
      giveaways: count("SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND status='active'", config.DISCORD_GUILD_ID),
      ...(includeFinance ? { sanctions: count("SELECT COUNT(*) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", config.DISCORD_GUILD_ID) } : {}),
    };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, config.DASHBOARD_PUBLIC_URL);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
      if (req.method === "GET" && url.pathname === "/login") {
        for (const [key, expires] of state) if (expires < Date.now()) state.delete(key);
        const nonce = randomBytes(24).toString("base64url");
        state.set(nonce, Date.now() + 5 * 60_000);
        const redirect = new URL("https://discord.com/oauth2/authorize");
        redirect.search = new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, response_type: "code", scope: "identify", state: nonce, redirect_uri: `${config.DASHBOARD_PUBLIC_URL}/oauth/callback` }).toString();
        res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" }); return res.end();
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const loginFailure = message => { res.writeHead(302, { Location: `/?error=${encodeURIComponent(message)}`, "Cache-Control": "no-store" }); res.end(); };
        const nonce = url.searchParams.get("state"), expiry = state.get(nonce);
        state.delete(nonce);
        if (!url.searchParams.get("code") || !expiry || expiry < Date.now()) return loginFailure("Anmeldung abgelaufen. Bitte erneut versuchen.");
        const tokenResponse = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, client_secret: config.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: `${config.DASHBOARD_PUBLIC_URL}/oauth/callback` }) });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok) return loginFailure("Discord-Anmeldung fehlgeschlagen. Bitte erneut versuchen.");
        const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } });
        const user = await userResponse.json();
        if (!userResponse.ok || !await memberFor(user.id)) return loginFailure("Dieses Dashboard ist nur für berechtigte Gambinos-Staffmitglieder.");
        const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + 8 * 60 * 60_000 })).toString("base64url");
        res.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": cookie(`${payload}.${sign(payload)}`, 8 * 60 * 60) }); return res.end();
      }
      if (req.method === "POST" && url.pathname === "/logout") {
        res.writeHead(204, { "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" }); return res.end();
      }
      if (url.pathname.startsWith("/api/")) {
        const member = await sessionFor(req);
        if (!member) return send(res, 401, { error: "Bitte melde dich mit Discord an." });
        if (req.method === "POST" && req.headers.origin !== new URL(config.DASHBOARD_PUBLIC_URL).origin) return send(res, 403, { error: "Ungültige Anfragequelle." });
        if (req.method === "GET" && url.pathname === "/api/manage") {
          const canReview = can(member, "ROLE_REVIEWERS") || can(member, "ROLE_LEADERS");
          const canStaff = can(member, "ROLE_STAFF") || can(member, "ROLE_LEADERS");
          const canEvents = can(member, "ROLE_EVENT_TEAM") || can(member, "ROLE_LEADERS");
          const data = { capabilities: { applications: canReview, tickets: canStaff, events: canEvents }, applications: [], tickets: [], events: [] };
          if (canReview) data.applications = db.prepare("SELECT id,user_id,kind,status,reviewer_id,created_at,answers FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at").all(config.DISCORD_GUILD_ID);
          if (canStaff) data.tickets = db.prepare("SELECT id,channel_id,user_id,category,status,claimed_by,created_at FROM tickets WHERE guild_id=? AND status='open' ORDER BY created_at").all(config.DISCORD_GUILD_ID);
          if (canEvents) data.events = db.prepare("SELECT e.id,e.name,e.description,e.starts_at,e.location,e.host_id,e.channel_id,e.message_id,(SELECT COUNT(*) FROM event_participants p WHERE p.event_id=e.id AND p.status IN ('signed_up','present')) AS participants FROM events e WHERE e.guild_id=? AND e.status='scheduled' ORDER BY e.starts_at LIMIT 25").all(config.DISCORD_GUILD_ID);
          return send(res, 200, data);
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/")) {
          const body = await readBody(req);
          const now = new Date().toISOString();
          let match;
          if ((match = /^\/api\/applications\/([\w-]+)\/(claim|decision)$/.exec(url.pathname))) {
            if (!can(member, "ROLE_REVIEWERS") && !can(member, "ROLE_LEADERS")) return send(res, 403, { error: "Dafür brauchst du die Reviewer- oder Leitungsrolle." });
            const [, id, action] = match;
            const current = db.prepare("SELECT * FROM applications WHERE id=? AND guild_id=? AND status IN ('open','review')").get(id, config.DISCORD_GUILD_ID);
            if (!current) return send(res, 404, { error: "Der Antrag ist nicht mehr offen." });
            if (action === "claim") {
              if (current.status === "review" && current.reviewer_id !== member.id) return send(res, 409, { error: "Der Antrag wird bereits von einem anderen Staffmitglied bearbeitet." });
              const row = db.transaction(() => {
                const claimed = db.prepare("UPDATE applications SET status='review',reviewer_id=?,updated_at=? WHERE id=? AND guild_id=? AND status IN ('open','review') AND (status='open' OR reviewer_id=?)").run(member.id, now, id, config.DISCORD_GUILD_ID, member.id);
                if (!claimed.changes) return null;
                const application = db.prepare("SELECT * FROM applications WHERE id=?").get(id);
                audit(db, config.DISCORD_GUILD_ID, member.id, "application.claimed", id, { kind: application.kind, applicantId: application.user_id, reviewerId: member.id });
                return application;
              })();
              if (!row) return send(res, 409, { error: "Der Antrag wurde parallel bereits übernommen." });
              await refreshApplication(row);
              const dmSent = await client.users.fetch(row.user_id).then(user => user.send(applicationInReviewDm({ kind: row.kind, applicationId: id, reviewerId: member.id })).then(() => true)).catch(() => false);
              return send(res, 200, { ok: true, message: dmSent ? "Antrag übernommen. Der Antragsteller wurde privat benachrichtigt." : "Antrag übernommen. Eine private Nachricht konnte nicht zugestellt werden; der Status ist gespeichert." });
            }
            const status = body.status;
            const reason = String(body.reason ?? "").trim();
            if (!['accepted', 'rejected'].includes(status)) return send(res, 400, { error: "Ungültige Entscheidung." });
            if (status === "rejected" && reason.length < 3) return send(res, 400, { error: "Bitte gib einen nachvollziehbaren Ablehnungsgrund an." });
            if (reason.length > 1000) return send(res, 400, { error: "Der Grund darf höchstens 1.000 Zeichen enthalten." });
            const changed = db.transaction(() => {
              const application = db.prepare("UPDATE applications SET status=?,reviewer_id=?,review_note=?,updated_at=? WHERE id=? AND guild_id=? AND status IN ('open','review') RETURNING *").get(status, member.id, reason, now, id, config.DISCORD_GUILD_ID);
              if (application) audit(db, config.DISCORD_GUILD_ID, member.id, `application.${status}`, id, { kind: application.kind, applicantId: application.user_id, reason, reviewerId: member.id });
              return application;
            })();
            if (!changed) return send(res, 409, { error: "Der Antrag wurde parallel bereits bearbeitet." });
            if (status === "accepted" && changed.kind === "bewerbung" && config.ACCOUNT_AUTO_OPEN_FOR_MEMBERS) createFinance(db).openAccount({ guildId: config.DISCORD_GUILD_ID, userId: changed.user_id, actorId: member.id, note: "Familienbewerbung angenommen" });
            await refreshApplication(changed);
            const dmSent = await client.users.fetch(changed.user_id).then(user => user.send(applicationDecisionDm({ kind: changed.kind, status, applicationId: id, reason })).then(() => true)).catch(() => false);
            return send(res, 200, { ok: true, message: status === "accepted" ? (dmSent ? "Antrag angenommen und Antragsteller privat benachrichtigt." : "Antrag angenommen. Eine private Nachricht konnte nicht zugestellt werden.") : (dmSent ? "Antrag mit Begründung abgelehnt; die Rückmeldung wurde privat gesendet." : "Antrag mit Begründung abgelehnt. Eine private Nachricht konnte nicht zugestellt werden.") });
          }
          if ((match = /^\/api\/tickets\/([\w-]+)\/(claim|close)$/.exec(url.pathname))) {
            const [, id, action] = match;
            const ticket = db.prepare("SELECT * FROM tickets WHERE id=? AND guild_id=? AND status='open'").get(id, config.DISCORD_GUILD_ID);
            if (!ticket) return send(res, 404, { error: "Das Ticket ist nicht mehr offen." });
            if (!canHandleTicket({ memberRoleIds: member.roles, isOwner: member.owner }, ticket, config, groups.staff)) return send(res, 403, { error: "Dafür brauchst du die Staff- oder eine zuständige Ticket-Rolle." });
            const channel = await ensureGuildChannel(ticket.channel_id);
            if (!channel?.isTextBased()) return send(res, 409, { error: "Der Ticket-Channel ist nicht erreichbar." });
            if (action === "claim") {
              if (ticket.claimed_by && ticket.claimed_by !== member.id) return send(res, 409, { error: "Das Ticket wurde bereits von jemand anderem übernommen." });
              const claimed = db.transaction(() => {
                const changed = db.prepare("UPDATE tickets SET claimed_by=?,updated_at=? WHERE id=? AND status='open' AND (claimed_by IS NULL OR claimed_by=?)").run(member.id, now, id, member.id);
                if (changed.changes) audit(db, config.DISCORD_GUILD_ID, member.id, "ticket.claimed", ticket.user_id, { ticketId: id, category: ticket.category });
                return changed.changes;
              })();
              if (!claimed) return send(res, 409, { error: "Das Ticket wurde parallel übernommen." });
              const message = ticket.message_id ? await channel.messages.fetch(ticket.message_id).catch(() => null) : null;
              if (message) await message.edit({ embeds: [ticketCard(categoryLabel(ticket.category), ticket.user_id, member.id)], components: ticketActions(id, true) }).catch(() => {});
              return send(res, 200, { ok: true, message: "Ticket übernommen und im Discord aktualisiert." });
            }
            let transcript;
            try { transcript = await fetchTranscript(channel, config.TICKET_TRANSCRIPT_LIMIT ?? 500); }
            catch { return send(res, 503, { error: "Der Ticketverlauf konnte nicht geladen werden. Das Ticket bleibt offen; bitte prüfe die Discord-Berechtigungen und versuche es erneut." }); }
            const closed = ticketService.close({ guildId: config.DISCORD_GUILD_ID, ticketId: id, actorId: member.id, transcript });
            if (!closed) return send(res, 409, { error: "Das Ticket wurde parallel geschlossen." });
            await channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false }).catch(() => {});
            await channel.setName(`closed-${ticket.category}-${ticket.user_id.slice(-4)}`.slice(0, 100)).catch(() => {});
            await moveTicketToClosed(channel, config);
            const message = ticket.message_id ? await channel.messages.fetch(ticket.message_id).catch(() => null) : null;
            if (message) await message.edit({ embeds: [ticketClosedCard(categoryLabel(ticket.category), ticket.user_id)], components: ticketClosedActions(id) }).catch(() => {});
            const log = await ensureGuildChannel(config.CHANNEL_TICKET_LOG);
            const textLog = transcript.map(m => `[${m.createdAt}] ${m.author}: ${m.content}${m.attachments?.length ? ` [Anhänge: ${m.attachments.map(a => a.name).join(", ")}]` : ""}`).join("\n");
            if (log) await log.send({ embeds: [logEmbed("🔒 Ticket geschlossen (Webdashboard)", `**Kategorie:** ${categoryLabel(ticket.category)}\n**Mitglied:** <@${ticket.user_id}>\n**Geschlossen von:** <@${member.id}>\n**Nachrichten im Transkript:** ${transcript.length}`)], files: [new AttachmentBuilder(Buffer.from(textLog || "(keine Nachrichten)", "utf8"), { name: `ticket-${id.slice(0, 8)}.txt` })] }).catch(() => {});
            return send(res, 200, { ok: true, message: "Ticket geschlossen. Der Verlauf wurde gespeichert." });
          }
          if (url.pathname === "/api/events" && req.method === "POST") {
            if (!can(member, "ROLE_EVENT_TEAM") && !can(member, "ROLE_LEADERS")) return send(res, 403, { error: "Dafür brauchst du die Event-Team- oder Leitungsrolle." });
            const name = String(body.name ?? "").trim(), description = String(body.description ?? "").trim(), location = String(body.location ?? "").trim();
            const starts = parseEventDate(body.startsAt, config.TIMEZONE);
            const maximum = body.maximum == null || body.maximum === "" ? null : Number(body.maximum);
            if (name.length < 3 || name.length > 100 || description.length > 1000 || location.length < 2 || location.length > 100 || !starts || starts.getTime() < Date.now() + 60_000 || (maximum !== null && (!Number.isInteger(maximum) || maximum < 1 || maximum > 500))) return send(res, 400, { error: `Bitte Name, Treffpunkt, ein gültiges zukünftiges Datum${maximum !== null ? " sowie ein Teilnehmerlimit zwischen 1 und 500" : ""} eintragen (${config.TIMEZONE}).` });
            const target = await ensureGuildChannel(config.CHANNEL_EVENT_SIGNUP || config.CHANNEL_EVENT_ANNOUNCEMENTS);
            if (!target?.isTextBased()) return send(res, 409, { error: "Kein Event-Channel eingestellt oder erreichbar (Einstellungen → Channels → Event-Anmeldung / Event-Ankündigungen)." });
            const id = randomUUID();
            const event = { id, guild_id: config.DISCORD_GUILD_ID, name, description, starts_at: starts.toISOString(), location, host_id: member.id, equipment: String(body.equipment ?? "").slice(0, 500), notes: String(body.notes ?? "").slice(0, 500), max_participants: maximum };
            const posted = await publishEvent({ db, client, config, event: { ...event, status: "scheduled" }, fallbackChannel: target });
            try {
              db.transaction(() => {
                db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,announce_channel_id,announce_message_id,name,description,starts_at,location,host_id,equipment,notes,max_participants,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled',?)").run(id, event.guild_id, posted.channelId, posted.messageId, posted.announceChannelId, posted.announceMessageId, event.name, event.description, event.starts_at, event.location, event.host_id, event.equipment, event.notes, event.max_participants, now);
                audit(db, config.DISCORD_GUILD_ID, member.id, "event.created", id, { name, startsAt: event.starts_at, channelId: posted.channelId });
              })();
            } catch (error) { await deleteEventPosts({ client, posted }); throw error; }
            return send(res, 201, { ok: true, message: "Event veröffentlicht und zur Übersicht hinzugefügt." });
          }
          if ((match = /^\/api\/events\/([\w-]+)\/cancel$/.exec(url.pathname))) {
            if (!can(member, "ROLE_EVENT_TEAM") && !can(member, "ROLE_LEADERS")) return send(res, 403, { error: "Dafür brauchst du die Event-Team- oder Leitungsrolle." });
            const id = match[1], event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(id, config.DISCORD_GUILD_ID);
            if (!event) return send(res, 404, { error: "Das Event ist nicht mehr geplant." });
            const cancelled = db.transaction(() => {
              const changed = db.prepare("UPDATE events SET status='cancelled' WHERE id=? AND status='scheduled'").run(id);
              if (changed.changes) audit(db, config.DISCORD_GUILD_ID, member.id, "event.cancelled", id, { name: event.name });
              return changed.changes;
            })();
            if (!cancelled) return send(res, 409, { error: "Das Event wurde parallel geändert." });
            await refreshEventPosts({ db, client, config, event: { ...event, status: "cancelled" }, state: "cancelled" });
            return send(res, 200, { ok: true, message: "Event abgesagt und Anmeldung geschlossen." });
          }
          const extended = await extendedApi.post(member, url, body);
          if (extended) return send(res, extended.status, extended.body);
          return send(res, 404, { error: "Nicht gefunden." });
        }
        if (req.method === "GET" && url.pathname === "/api/overview") {
          const events = db.prepare("SELECT name,starts_at,location FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>? ORDER BY starts_at LIMIT 5").all(config.DISCORD_GUILD_ID, new Date().toISOString());
          const applications = db.prepare("SELECT id,kind,status,created_at FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at LIMIT 8").all(config.DISCORD_GUILD_ID);
          const activity = db.prepare("SELECT action,target_id,actor_id,created_at FROM audit_logs WHERE guild_id=? ORDER BY created_at DESC LIMIT 8").all(config.DISCORD_GUILD_ID);
          const canSeeFinance = member.owner || member.roles.some(id => (config.ROLE_FINANCE ?? []).includes(id) || (config.ROLE_LEADERS ?? []).includes(id));
          const data = { member: { name: member.displayName, roles: member.roles.length, owner: member.owner }, stats: summary(canSeeFinance), events, applications, activity };
          const nowIso = new Date().toISOString(), in24h = new Date(Date.now() + 86_400_000).toISOString();
          const g = config.DISCORD_GUILD_ID;
          data.todo = {
            unclaimedTickets: count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open' AND claimed_by IS NULL", g),
            openApplications: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status='open'", g),
            reviewApplications: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status='review'", g),
            eventsNext24h: count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>? AND starts_at<=?", g, nowIso, in24h),
            overdueEvents: count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND series_id IS NULL AND starts_at<?", g, new Date(Date.now() - 3 * 3_600_000).toISOString()),
            activeSeries: count("SELECT COUNT(*) n FROM event_series WHERE guild_id=? AND active=1", g),
            ...(canSeeFinance ? { payoutsDue: count("SELECT COUNT(*) n FROM accounts WHERE guild_id=? AND balance_cents>0 AND balance_cents>=?", g, config.PAYOUT_MINIMUM_CENTS ?? 1) } : {}),
          };
          if (canSeeFinance) {
            data.finance = { balances: db.prepare("SELECT COUNT(*) n FROM accounts WHERE guild_id=?").get(config.DISCORD_GUILD_ID).n, openSanctions: db.prepare("SELECT COALESCE(SUM(remaining_cents),0) cents FROM sanctions WHERE guild_id=? AND status IN ('open','partial')").get(config.DISCORD_GUILD_ID).cents };
          }
          return send(res, 200, data);
        }
        if (req.method === "GET") {
          const extended = await extendedApi.get(member, url);
          if (extended) return send(res, extended.status, extended.body, extended.type, extended.headers);
        }
        return send(res, 404, { error: "Nicht gefunden." });
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice("/assets/".length);
        if (relative.includes("..") || relative.includes("\\")) return send(res, 400, { error: "Ungültiger Pfad." });
        const file = url.pathname === "/" ? path.join(root, relative) : path.join(root, "assets", relative);
        const body = await readFile(file);
        return send(res, 200, body, mime[path.extname(file)] ?? "application/octet-stream");
      }
      return send(res, 404, { error: "Nicht gefunden." });
    } catch (error) {
      console.error("Dashboard request failed:", error.message);
      return send(res, 500, { error: "Die Anfrage konnte nicht verarbeitet werden." });
    }
  });
  server.on("error", error => console.error("Staff-Dashboard konnte nicht starten:", error.message));
  server.listen(config.DASHBOARD_PORT, config.DASHBOARD_BIND, () => console.log(`Gambinos Staff-Dashboard lauscht auf ${config.DASHBOARD_BIND}:${config.DASHBOARD_PORT}.`));
  return { close: () => new Promise(resolve => server.close(resolve)) };
}
