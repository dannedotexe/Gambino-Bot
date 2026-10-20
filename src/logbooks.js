import { ChannelType } from "discord.js";
import { audit, getSetting } from "./database.js";

/**
 * Logbücher: Bekommt jemand die Familienmitglieder-Rolle, legt der Bot im Logbücher-Forum einen Post
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
async function templateFrom(threads) {
  const thread = threads.find(t => /^\W*vorlage/i.test(t.name));
  const starter = thread ? await thread.fetchStarterMessage().catch(() => null) : null;
  return starter?.content?.trim() || DEFAULT_LOGBOOK_TEMPLATE;
}

/**
 * Legt das Logbuch an (einmal pro Person). Ergebnis: { status: "created" | "existing" | "skipped", thread?, reason? }.
 */
export async function ensureLogbook({ db, client, config, member, actorId = null }) {
  const guildId = member.guild?.id ?? config.DISCORD_GUILD_ID;
  if (!config.CHANNEL_TASK_FORUM) return { status: "skipped", reason: "Kein Logbücher-Forum eingestellt." };
  if (member.user?.bot) return { status: "skipped", reason: "Bot" };
  // Platzhalter zuerst: parallele Rollen-Events legen so nie zwei Posts an.
  const reserved = db.prepare("INSERT OR IGNORE INTO logbooks(guild_id,user_id,thread_id,title,source,created_at) VALUES(?,?,NULL,?,'pending',?)").run(guildId, member.id, logbookTitle(db, guildId, member), new Date().toISOString()).changes;
  if (!reserved) {
    const row = db.prepare("SELECT * FROM logbooks WHERE guild_id=? AND user_id=?").get(guildId, member.id);
    return { status: "existing", threadId: row?.thread_id ?? null, reason: row?.source === "pending" ? "Wird gerade angelegt." : "Logbuch existiert bereits." };
  }
  const release = () => db.prepare("DELETE FROM logbooks WHERE guild_id=? AND user_id=? AND source='pending'").run(guildId, member.id);
  try {
    const forum = await client.channels.fetch(config.CHANNEL_TASK_FORUM).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) { release(); return { status: "skipped", reason: "Das eingestellte Logbücher-Forum ist kein Forum oder nicht erreichbar." }; }
    const title = logbookTitle(db, guildId, member), threads = await forumThreads(forum);
    const id = idPart(title);
    const existing = threads.find(t => !/^\W*vorlage/i.test(t.name) && (norm(t.name) === norm(title) || (id && idPart(t.name) === id)));
    if (existing) {
      db.prepare("UPDATE logbooks SET thread_id=?,title=?,source='existing' WHERE guild_id=? AND user_id=?").run(existing.id, existing.name, guildId, member.id);
      return { status: "existing", thread: existing, threadId: existing.id };
    }
    const content = buildLogbookContent(await templateFrom(threads), title, member.id);
    // Foren mit Pflicht-Tag brauchen einen Tag; dann den ersten verfügbaren nehmen.
    const requireTag = forum.flags?.has?.("RequireTag") && forum.availableTags?.length;
    const thread = await forum.threads.create({ name: title, message: { content, allowedMentions: { users: [member.id] } }, ...(requireTag ? { appliedTags: [forum.availableTags[0].id] } : {}), reason: "Logbuch für neues Familienmitglied" });
    db.prepare("UPDATE logbooks SET thread_id=?,title=?,source='created' WHERE guild_id=? AND user_id=?").run(thread.id, title, guildId, member.id);
    audit(db, guildId, actorId ?? client.user?.id ?? "system", "logbook.created", member.id, { title, threadId: thread.id });
    return { status: "created", thread, threadId: thread.id };
  } catch (error) {
    release();
    throw error;
  }
}

/** Nach der Verifizierung: Titel des automatisch angelegten Logbuchs auf „Vorname Nachname | ID“ ändern. */
export async function renameLogbook({ db, client, guildId, userId, title }) {
  const row = db.prepare("SELECT * FROM logbooks WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL").get(guildId, userId);
  if (!row || row.title === title) return false;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.setName) return false;
  const ok = await thread.setName(title.slice(0, 100), "Name nach Verifizierung").then(() => true).catch(() => false);
  if (ok) db.prepare("UPDATE logbooks SET title=? WHERE guild_id=? AND user_id=?").run(title, guildId, userId);
  return ok;
}

const FORUM_PERMS = [["ViewChannel", "Kanal ansehen"], ["SendMessages", "Beiträge erstellen"], ["SendMessagesInThreads", "Nachrichten in Beiträgen senden"], ["ReadMessageHistory", "Nachrichtenverlauf lesen"], ["AddReactions", "Reaktionen hinzufügen"], ["ManageMessages", "Nachrichten verwalten"]];
export const familyOf = (config, roleIds) => [...new Set([...(config.ROLE_MEMBERS ?? []), ...(config.RANK_ROLES_JSON ?? []).map(r => r.roleId)])].some(id => roleIds.has(id));

/** Warum (nicht) angelegt wird: Forum, Bot-Rechte, Automatik und wer noch kein Logbuch hat. */
export async function logbookStatus({ db, client, config, guild }) {
  const problems = [];
  const forum = config.CHANNEL_TASK_FORUM ? await client.channels.fetch(config.CHANNEL_TASK_FORUM).catch(() => null) : null;
  if (!config.CHANNEL_TASK_FORUM) problems.push("Kein Logbücher-Forum eingestellt (Einstellungen → Channels → „Logbücher (Forum)“).");
  else if (!forum) problems.push("Das eingestellte Logbücher-Forum gibt es nicht oder der Bot sieht es nicht.");
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
  const known = new Set(db.prepare("SELECT user_id FROM logbooks WHERE guild_id=? AND thread_id IS NOT NULL").all(guild.id).map(r => r.user_id));
  const missing = family.filter(m => !known.has(m.id));
  return { forum: forum ? { id: forum.id, name: forum.name } : null, problems, family: family.length, withLogbook: family.length - missing.length, missing: missing.map(m => ({ id: m.id, name: logbookTitle(db, guild.id, m) })), lastError: (() => { try { return JSON.parse(getSetting(db, guild.id, "LOGBOOK_LAST_ERROR") ?? "null"); } catch { return null; } })() };
}

/**
 * Legt für alle Familienmitglieder ohne Logbuch eines an – bestehende Posts mit Name/ID werden nur verknüpft.
 * Nacheinander mit Pause, damit Discord nicht drosselt.
 */
export async function createMissingLogbooks({ db, client, config, guild, actorId, pauseMs = 1500 }) {
  const status = await logbookStatus({ db, client, config, guild });
  const result = { created: 0, linked: 0, failed: 0, errors: [] };
  if (!status.forum) return { ...result, errors: status.problems };
  const all = await guild.members.fetch().catch(() => guild.members.cache);
  for (const { id } of status.missing) {
    const member = all.get(id);
    if (!member) continue;
    try {
      const r = await ensureLogbook({ db, client, config, member, actorId });
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
