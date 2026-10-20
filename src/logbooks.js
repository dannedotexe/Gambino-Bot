import { ChannelType, EmbedBuilder } from "discord.js";
import { audit, getSetting, setSetting } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { createAbsenceService, localDay } from "./services/absences.js";

/**
 * Logbücher: Bekommt jemand die Familienrolle, legt der Bot in jedem eingestellten Logbuch-Forum (Aufgaben, Events) einen Post
 * „Vorname Nachname | ID“ an. Text = Startnachricht des Posts „Vorlage …“ (sonst Standardtext), ganz unten wird
 * die Person markiert (unter dem Wichtig-Block, außerhalb des Zitats), damit ihr der Post angezeigt wird. Bestehende Posts mit Namen bzw. ID werden übernommen, nie doppelt.
 */
export const DEFAULT_LOGBOOK_TEMPLATE = [
  "📋 **Aufgaben Logs:**",
  "**Titel des eigenem Logbuch:** `Vorname Nachname | ID`",
  "",
  "• **Invite Log** → `25k normales Mitglied | 50k guter Gambo`",
  "• **Plantage** →",
  "• **Solar Panele** →",
  "",
  "> ⚠️ **Wichtig:**",
  "> **KEINE EVENT-LOGS**",
  "> Es muss der ganze Bildschirm zusehen sein, also auch Datum und Uhrzeit.",
  "> Falls das nicht zusehen ist gilt der Log als **ungültig**.",
].join("\n");

export const DEFAULT_EVENT_LOGBOOK_TEMPLATE = [
  "📋 **Event Logs:**",
  "**Titel des eigenem Logbuchs:** `Vorname Nachname | ID`",
  "",
  "In diesen Post kommt vor und nach jedem Event ein Bild, damit wir nachvollziehen können, ob ihr dabei wart oder nicht.",
  "",
  "> ⚠️ **Wichtig:**",
  "> **Nur EVENT-LOGS**",
  "> Es muss der ganze Bildschirm zusehen sein, also auch Datum und Uhrzeit.",
  "> Falls das nicht zusehen ist gilt der Log als **ungültig**.",
].join("\n");

/** Zwei Logbuch-Foren: Aufgaben (mit Belohnung) und Events (Nachweis vor/nach dem Event). Je Forum eine eigene Tabelle. */
export const LOGBOOK_FORUMS = {
  tasks: { table: "logbooks", key: "CHANNEL_TASK_FORUM", label: "Aufgaben-Logbuch", setting: "„Aufgaben-Logbücher (Forum)“", template: DEFAULT_LOGBOOK_TEMPLATE },
  events: { table: "event_logbooks", key: "CHANNEL_EVENT_FORUM", label: "Event-Logbuch", setting: "„Event-Logbücher (Forum)“", template: DEFAULT_EVENT_LOGBOOK_TEMPLATE },
};
const forumOf = kind => LOGBOOK_FORUMS[kind] ?? LOGBOOK_FORUMS.tasks;
/** Für welche Foren der Bot Logbücher führt (nur eingestellte). */
export const activeLogbookKinds = config => Object.keys(LOGBOOK_FORUMS).filter(kind => config[LOGBOOK_FORUMS[kind].key]);

const norm = text => String(text ?? "").toLocaleLowerCase("de-AT").replace(/\s+/g, " ").trim();
const idPart = title => /\|\s*(\d{3,})\s*$/.exec(String(title ?? ""))?.[1] ?? null;

/** „Vorname Nachname | ID“ aus der Verifizierung, sonst der Server-Name. */
export function logbookTitle(db, guildId, member) {
  const verified = db.prepare("SELECT nickname FROM member_verifications WHERE guild_id=? AND user_id=?").get(guildId, member.id)?.nickname;
  return String(verified || member.displayName || member.user?.username || member.id).slice(0, 100);
}

/** Vorlage für die Person: eigener Titel in der Titel-Zeile, Erwähnung ganz unten außerhalb des Zitats. */
export function buildLogbookContent(template, title, userId) {
  const lines = String(template || DEFAULT_LOGBOOK_TEMPLATE).replace(/\s+$/, "").split("\n")
    .map(line => (/titel/i.test(line) && /`[^`]*`/.test(line) ? line.replace(/`[^`]*`/, `\`${title.replace(/`/g, "'")}\``) : line));
  // Erwähnung als eigene Zeile unter dem Wichtig-Block, außerhalb des Zitat-Strichs.
  lines.push("", `<@${userId}>`);
  return lines.join("\n").slice(0, 2000);
}

async function forumThreads(forum) {
  const active = await forum.threads.fetchActive().catch(() => null);
  const archived = await forum.threads.fetchArchived({ limit: 100 }).catch(() => null);
  return [...(active?.threads?.values?.() ?? []), ...(archived?.threads?.values?.() ?? [])].filter(t => !t.parentId || t.parentId === forum.id);
}

/** Text aus dem Post „Vorlage …“ im Forum; ohne Vorlage der Standardtext. */
async function templateFrom(threads, fallback = DEFAULT_LOGBOOK_TEMPLATE) {
  const thread = threads.find(t => /^\W*vorlage/i.test(t.name));
  const starter = thread ? await thread.fetchStarterMessage().catch(() => null) : null;
  return starter?.content?.trim() || fallback;
}

/**
 * Legt das Logbuch an (einmal pro Person). Ergebnis: { status: "created" | "existing" | "skipped", thread?, reason? }.
 */
export async function ensureLogbook({ db, client, config, member, actorId = null, kind = "tasks" }) {
  const guildId = member.guild?.id ?? config.DISCORD_GUILD_ID, f = forumOf(kind), T = f.table;
  if (!config[f.key]) return { status: "skipped", reason: `Kein Forum für das ${f.label} eingestellt.` };
  if (member.user?.bot) return { status: "skipped", reason: "Bot" };
  // Platzhalter zuerst: parallele Rollen-Events legen so nie zwei Posts an.
  const reserved = db.prepare(`INSERT OR IGNORE INTO ${T}(guild_id,user_id,thread_id,title,source,created_at) VALUES(?,?,NULL,?,'pending',?)`).run(guildId, member.id, logbookTitle(db, guildId, member), new Date().toISOString()).changes;
  if (!reserved) {
    const row = db.prepare(`SELECT * FROM ${T} WHERE guild_id=? AND user_id=?`).get(guildId, member.id);
    return { status: "existing", threadId: row?.thread_id ?? null, reason: row?.source === "pending" ? "Wird gerade angelegt." : "Logbuch existiert bereits." };
  }
  const release = () => db.prepare(`DELETE FROM ${T} WHERE guild_id=? AND user_id=? AND source='pending'`).run(guildId, member.id);
  try {
    const forum = await client.channels.fetch(config[f.key]).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) { release(); return { status: "skipped", reason: `Das Forum für das ${f.label} ist kein Forum oder nicht erreichbar.` }; }
    const title = logbookTitle(db, guildId, member), threads = await forumThreads(forum);
    const id = idPart(title);
    const existing = threads.find(t => !/^\W*vorlage/i.test(t.name) && (norm(t.name) === norm(title) || (id && idPart(t.name) === id)));
    if (existing) {
      db.prepare(`UPDATE ${T} SET thread_id=?,title=?,source='existing' WHERE guild_id=? AND user_id=?`).run(existing.id, existing.name, guildId, member.id);
      return { status: "existing", thread: existing, threadId: existing.id };
    }
    const content = buildLogbookContent(await templateFrom(threads, f.template), title, member.id);
    // Foren mit Pflicht-Tag brauchen einen Tag; dann den ersten verfügbaren nehmen.
    const requireTag = forum.flags?.has?.("RequireTag") && forum.availableTags?.length;
    const thread = await forum.threads.create({ name: title, message: { content, allowedMentions: { users: [member.id] } }, ...(requireTag ? { appliedTags: [forum.availableTags[0].id] } : {}), reason: `${f.label} für Familienmitglied` });
    db.prepare(`UPDATE ${T} SET thread_id=?,title=?,source='created' WHERE guild_id=? AND user_id=?`).run(thread.id, title, guildId, member.id);
    audit(db, guildId, actorId ?? client.user?.id ?? "system", "logbook.created", member.id, { title, threadId: thread.id, kind });
    return { status: "created", thread, threadId: thread.id };
  } catch (error) {
    release();
    throw error;
  }
}

/** Nach der Verifizierung: Titel des automatisch angelegten Logbuchs auf „Vorname Nachname | ID“ ändern. */
export async function renameLogbook({ db, client, guildId, userId, title, kind = "tasks" }) {
  const T = forumOf(kind).table;
  const row = db.prepare(`SELECT * FROM ${T} WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL`).get(guildId, userId);
  if (!row || row.title === title) return false;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.setName) return false;
  const ok = await thread.setName(title.slice(0, 100), "Name nach Verifizierung").then(() => true).catch(() => false);
  if (ok) db.prepare(`UPDATE ${T} SET title=? WHERE guild_id=? AND user_id=?`).run(title, guildId, userId);
  return ok;
}

const FORUM_PERMS = [["ViewChannel", "Kanal ansehen"], ["SendMessages", "Beiträge erstellen"], ["SendMessagesInThreads", "Nachrichten in Beiträgen senden"], ["ReadMessageHistory", "Nachrichtenverlauf lesen"], ["AddReactions", "Reaktionen hinzufügen"], ["ManageMessages", "Nachrichten verwalten"], ["ManageThreads", "Threads verwalten (Archivieren)"]];
// Familie = Familienrolle, eine Rang-Rolle oder Leitung/Voller Zugriff (die Leitung gehört immer zur Familie).
export const familyOf = (config, roleIds) => [...new Set([...(config.ROLE_MEMBERS ?? []), ...(config.RANK_ROLES_JSON ?? []).map(r => r.roleId), ...(config.ROLE_LEADERS ?? []), ...(config.ROLE_FULL_ACCESS ?? [])])].some(id => roleIds.has(id));

/** Warum (nicht) angelegt wird: Forum, Bot-Rechte, Automatik und wer noch kein Logbuch hat. */
export async function logbookStatus({ db, client, config, guild, kind = "tasks" }) {
  const problems = [], f = forumOf(kind);
  const forum = config[f.key] ? await client.channels.fetch(config[f.key]).catch(() => null) : null;
  if (!config[f.key]) problems.push(`Kein Forum eingestellt (Einstellungen → Channels → ${f.setting}).`);
  else if (!forum) problems.push("Das eingestellte Forum gibt es nicht oder der Bot sieht es nicht.");
  else if (forum.type !== ChannelType.GuildForum) problems.push(`#${forum.name} ist kein Forum-Channel.`);
  if (forum?.type === ChannelType.GuildForum && guild.members.me) {
    const perms = forum.permissionsFor?.(guild.members.me);
    const missing = FORUM_PERMS.filter(([flag]) => perms && !perms.has(flag)).map(([, label]) => label);
    if (missing.length) problems.push(`Dem Bot fehlen im Forum die Rechte: ${missing.join(", ")}.`);
  }
  if (!config.LOGBOOK_AUTO_CREATE) problems.push("Automatik ist ausgeschaltet (Einstellungen → „Logbuch automatisch anlegen“).");
  if (!(config.ROLE_MEMBERS ?? []).length) problems.push("Keine Familienmitglieder-Rolle eingestellt.");
  const all = await guild.members.fetch().catch(() => guild.members.cache);
  const family = [...all.values()].filter(m => !m.user?.bot && familyOf(config, m.roles.cache));
  const known = new Set(db.prepare(`SELECT user_id FROM ${f.table} WHERE guild_id=? AND thread_id IS NOT NULL`).all(guild.id).map(r => r.user_id));
  const missing = family.filter(m => !known.has(m.id));
  return { kind, label: f.label, forum: forum ? { id: forum.id, name: forum.name } : null, problems, family: family.length, withLogbook: family.length - missing.length, missing: missing.map(m => ({ id: m.id, name: logbookTitle(db, guild.id, m) })), lastError: (() => { try { return JSON.parse(getSetting(db, guild.id, "LOGBOOK_LAST_ERROR") ?? "null"); } catch { return null; } })() };
}

/**
 * Legt für alle Familienmitglieder ohne Logbuch eines an – bestehende Posts mit Name/ID werden nur verknüpft.
 * Nacheinander mit Pause, damit Discord nicht drosselt.
 */
export async function createMissingLogbooks({ db, client, config, guild, actorId, pauseMs = 1500, kind = "tasks" }) {
  const status = await logbookStatus({ db, client, config, guild, kind });
  const result = { created: 0, linked: 0, failed: 0, errors: [] };
  if (!status.forum) return { ...result, errors: status.problems };
  const all = await guild.members.fetch().catch(() => guild.members.cache);
  for (const { id } of status.missing) {
    const member = all.get(id);
    if (!member) continue;
    try {
      const r = await ensureLogbook({ db, client, config, member, actorId, kind });
      if (r.status === "created") { result.created++; await new Promise(resolve => setTimeout(resolve, pauseMs)); }
      else if (r.status === "existing") result.linked++;
      else { result.failed++; result.errors.push(r.reason); }
    } catch (error) { result.failed++; result.errors.push(`${logbookTitle(db, guild.id, member)}: ${error.message}`); }
  }
  return result;
}

/** Einmalig: In bereits vom Bot angelegten Posts die Erwähnung aus dem Zitat-Strich nach unten holen. */
export async function fixLogbookMentions({ db, client, guildId }) {
  let fixed = 0;
  for (const row of db.prepare("SELECT user_id,thread_id FROM logbooks WHERE guild_id=? AND source='created' AND thread_id IS NOT NULL").all(guildId)) {
    const thread = await client.channels.fetch(row.thread_id).catch(() => null);
    const starter = await thread?.fetchStarterMessage?.().catch(() => null);
    const quoted = `\n> <@${row.user_id}>`;
    if (!starter?.editable && starter?.author?.id !== client.user?.id) continue;
    if (!starter?.content?.endsWith(quoted)) continue;
    const ok = await starter.edit({ content: `${starter.content.slice(0, -quoted.length)}\n\n<@${row.user_id}>`, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
    if (ok) fixed++;
  }
  return fixed;
}

/** Familie verlassen (Rolle weg oder Server verlassen): Logbuch schließen und sperren – nichts wird gelöscht. */
export async function archiveLogbook({ db, client, guildId, userId, reason = "Familie verlassen", kind = "tasks" }) {
  const T = forumOf(kind).table;
  const row = db.prepare(`SELECT * FROM ${T} WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL`).get(guildId, userId);
  if (!row || row.archived_at) return false;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.setArchived) return false;
  await thread.setLocked?.(true, reason).catch(() => {});
  const ok = await thread.setArchived(true, reason).then(() => true).catch(() => false);
  if (ok) { db.prepare(`UPDATE ${T} SET archived_at=? WHERE guild_id=? AND user_id=?`).run(new Date().toISOString(), guildId, userId); audit(db, guildId, client.user?.id ?? "system", "logbook.archived", userId, { threadId: row.thread_id, reason, kind }); }
  return ok;
}

/** Zurück in der Familie: archiviertes Logbuch wieder öffnen. */
export async function reopenLogbook({ db, client, guildId, userId, kind = "tasks" }) {
  const T = forumOf(kind).table;
  const row = db.prepare(`SELECT * FROM ${T} WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL AND archived_at IS NOT NULL`).get(guildId, userId);
  if (!row) return false;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.setArchived) return false;
  const ok = await thread.setArchived(false, "Wieder in der Familie").then(() => true).catch(() => false);
  if (ok) { await thread.setLocked?.(false, "Wieder in der Familie").catch(() => {}); db.prepare(`UPDATE ${T} SET archived_at=NULL WHERE guild_id=? AND user_id=?`).run(guildId, userId); audit(db, guildId, client.user?.id ?? "system", "logbook.reopened", userId, { threadId: row.thread_id, kind }); }
  return ok;
}

/**
 * Tägliche Erinnerung: Wer seit LOGBOOK_REMIND_DAYS Tagen nichts geloggt hat, bekommt einmal eine DM mit Link
 * zum eigenen Logbuch. Abgemeldete und Archivierte nicht; nach dem nächsten Log beginnt die Zählung neu.
 */
export async function remindInactiveLogbooks({ db, client, config, reference = new Date() }) {
  const guildId = config.DISCORD_GUILD_ID, days = config.LOGBOOK_REMIND_DAYS;
  if (!guildId || !days || !config.CHANNEL_TASK_FORUM) return 0;
  const today = localDay(reference, config.TIMEZONE);
  if (getSetting(db, guildId, "LOGBOOK_REMIND_DAY") === today) return 0;
  setSetting(db, guildId, "LOGBOOK_REMIND_DAY", today);
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return 0;
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const absent = createAbsenceService(db).absentUserIds(guildId, today);
  const cutoff = reference.getTime() - days * 86_400_000;
  let sent = 0;
  for (const row of db.prepare("SELECT * FROM logbooks WHERE guild_id=? AND thread_id IS NOT NULL AND archived_at IS NULL").all(guildId)) {
    const member = members.get(row.user_id);
    if (!member || member.user?.bot || !familyOf(config, member.roles.cache) || absent.has(row.user_id)) continue;
    const last = db.prepare("SELECT MAX(created_at) t FROM task_logs WHERE guild_id=? AND user_id=?").get(guildId, row.user_id).t;
    const baseline = last ?? row.created_at;
    if (new Date(baseline).getTime() > cutoff || (row.reminded_at && row.reminded_at > baseline)) continue;
    db.prepare("UPDATE logbooks SET reminded_at=? WHERE guild_id=? AND user_id=?").run(reference.toISOString(), guildId, row.user_id);
    const embed = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  LOGBUCH" }).setTitle("📸 Lange nichts geloggt")
      .setDescription(`${last ? `Dein letztes Log ist **${Math.floor((reference.getTime() - new Date(last).getTime()) / 86_400_000)} Tage** her.` : "Du hast noch kein Log eingereicht."}\n\nErledigte Aufgaben (Invite, Solar …) einfach als Screenshot in dein Logbuch posten – die Belohnung kommt nach der Prüfung automatisch aufs Familienkonto.\n\n➡️ [Zu deinem Logbuch](https://discord.com/channels/${guildId}/${row.thread_id})`)
      .setFooter({ text: "GAMBINOS  •  Automatische Erinnerung" }).setTimestamp(reference);
    if (await member.send({ embeds: [embed] }).then(() => true).catch(() => false)) sent++;
  }
  if (sent) audit(db, guildId, client.user?.id ?? "system", "logbook.reminded", null, { sent, days });
  return sent;
}
