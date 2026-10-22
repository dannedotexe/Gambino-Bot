import { createHash } from "node:crypto";
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
  "• **Invite Log** → `50k gute Leute` *(mind. 2 Tage bleiben & bei 4 Events beteiligt sein)*",
  "• **Plantage** →",
  "• **Solar Panele** →",
  "",
  "> ⚠️ **Wichtig:**",
  "> **KEINE EVENT-LOGS**",
  "> Es muss der ganze Bildschirm zusehen sein, also auch Datum und Uhrzeit.",
  "> Falls das nicht zusehen ist gilt der Log als **ungültig**.",
].join("\n");

export const DEFAULT_EVENT_LOGBOOK_TEMPLATE = [
  "## 📋 **Event Logs:**",
  "",
  "In diesen Post kommt während jedem Event ein Bild, damit wir nachvollziehen können, ob ihr dabei wart oder nicht.",
  "Wenn ihr Kills bei einem Event mit Kill Auszahlung macht ein Bild von der Kill Nachricht.",
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

/** true nur, wenn Discord den Post sicher nicht mehr kennt (Unknown Channel) – bei anderen Fehlern nichts verwerfen. */
async function threadGone(client, threadId) {
  try { return !(await client.channels.fetch(threadId)); }
  catch (error) { return error?.code === 10003 || error?.status === 404; }
}

async function forumThreads(forum) {
  const active = await forum.threads.fetchActive().catch(() => null);
  const archived = await forum.threads.fetchArchived({ limit: 100 }).catch(() => null);
  return [...(active?.threads?.values?.() ?? []), ...(archived?.threads?.values?.() ?? [])].filter(t => !t.parentId || t.parentId === forum.id);
}

/** Text aus dem Post „Vorlage …“ im Forum; ohne Vorlage der Standardtext. */
async function templateFrom(threads, fallback = DEFAULT_LOGBOOK_TEMPLATE) {
  const thread = threads.find(t => /^\W*vorlage/i.test(t.name));
  // force: immer frisch von Discord holen – eine gerade bearbeitete Vorlage soll sofort zählen.
  const starter = thread ? await Promise.resolve(thread.fetchStarterMessage?.({ force: true })).catch(() => null) : null;
  return starter?.content?.trim() || fallback;
}

/**
 * Legt das Logbuch an (einmal pro Person). Ergebnis: { status: "created" | "existing" | "skipped", thread?, reason? }.
 */
export async function ensureLogbook({ db, client, config, member, actorId = null, kind = "tasks", retried = false }) {
  const guildId = member.guild?.id ?? config.DISCORD_GUILD_ID, f = forumOf(kind), T = f.table;
  if (!config[f.key]) return { status: "skipped", reason: `Kein Forum für das ${f.label} eingestellt.` };
  if (member.user?.bot) return { status: "skipped", reason: "Bot" };
  // Platzhalter zuerst: parallele Rollen-Events legen so nie zwei Posts an.
  const reserved = db.prepare(`INSERT OR IGNORE INTO ${T}(guild_id,user_id,thread_id,title,source,created_at) VALUES(?,?,NULL,?,'pending',?)`).run(guildId, member.id, logbookTitle(db, guildId, member), new Date().toISOString()).changes;
  if (!reserved) {
    const row = db.prepare(`SELECT * FROM ${T} WHERE guild_id=? AND user_id=?`).get(guildId, member.id);
    // Gespeicherter Post wurde gelöscht (oder ein Anlegen ist hängen geblieben): Verweis verwerfen und neu anlegen.
    const stalePending = row?.source === "pending" && Date.now() - new Date(row.created_at).getTime() > 5 * 60_000;
    const gone = row?.thread_id ? await threadGone(client, row.thread_id) : false;
    if (row && (gone || stalePending) && !retried) {
      db.prepare(`DELETE FROM ${T} WHERE guild_id=? AND user_id=?`).run(guildId, member.id);
      audit(db, guildId, actorId ?? client.user?.id ?? "system", "logbook.relinked", member.id, { kind, oldThreadId: row.thread_id, reason: gone ? "Post gelöscht" : "Anlegen hing" });
      return ensureLogbook({ db, client, config, member, actorId, kind, retried: true });
    }
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
  const f = forumOf(kind), T = f.table, name = String(title).slice(0, 100);
  const row = db.prepare(`SELECT * FROM ${T} WHERE guild_id=? AND user_id=? AND thread_id IS NOT NULL`).get(guildId, userId);
  if (!row || row.title === name) return false;
  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.setName) return false;
  // Erst speichern, dann umbenennen – sonst hielte der Umbenennungs-Schutz (guardLogbookName) den Bot selbst für einen Fremden.
  db.prepare(`UPDATE ${T} SET title=? WHERE guild_id=? AND user_id=?`).run(name, guildId, userId);
  const ok = await thread.setName(name, "Name geändert").then(() => true).catch(() => false);
  if (!ok) { db.prepare(`UPDATE ${T} SET title=? WHERE guild_id=? AND user_id=?`).run(row.title, guildId, userId); return false; }
  // Titel steht auch im Text des Posts („Titel des eigenen Logbuchs: …“).
  const starter = await Promise.resolve(thread.fetchStarterMessage?.({ force: true })).catch(() => null);
  if (starter && starter.author?.id === client.user?.id) {
    const forum = thread.parent ?? await client.channels.fetch(thread.parentId).catch(() => null);
    const template = forum?.threads ? await templateFrom(await forumThreads(forum), f.template) : f.template;
    await starter.edit({ content: buildLogbookContent(template, name, userId), allowedMentions: { parse: [] } }).catch(() => {});
  }
  return true;
}

/**
 * Logbuch-Post wurde umbenannt: Titel verwaltet nur der Bot – fremde Änderungen werden sofort zurückgesetzt.
 * Gibt true zurück, wenn zurückgesetzt wurde.
 */
export async function guardLogbookName({ db, oldThread, thread }) {
  if (!thread?.setName || oldThread?.name === thread.name || /^\W*vorlage/i.test(thread.name ?? "")) return false;
  for (const kind of Object.keys(LOGBOOK_FORUMS)) {
    const row = db.prepare(`SELECT title FROM ${forumOf(kind).table} WHERE thread_id=?`).get(thread.id);
    if (!row) continue;
    if (row.title === thread.name) return false;
    return thread.setName(row.title.slice(0, 100), "Logbuch-Titel wird vom Bot verwaltet").then(() => true).catch(() => false);
  }
  return false;
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


/**
 * Vorlage geändert (neuer Standardtext oder Post „Vorlage …“ bearbeitet): Startnachrichten der vom Bot angelegten
 * Logbücher auf den neuen Text bringen – mit eigenem Titel und Markierung, ohne erneuten Ping. Läuft nur bei Änderung.
 */
const syncing = new Set();
export async function syncLogbookTemplates({ db, client, config, guildId, kind = "tasks", pauseMs = 1200 }) {
  const f = forumOf(kind);
  if (!config[f.key] || syncing.has(kind)) return 0;
  syncing.add(kind);
  try { return await syncTemplates({ db, client, config, guildId, kind, f, pauseMs }); } finally { syncing.delete(kind); }
}

async function syncTemplates({ db, client, config, guildId, kind, f, pauseMs }) {
  const forum = await client.channels.fetch(config[f.key]).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return 0;
  const template = await templateFrom(await forumThreads(forum), f.template);
  const hash = createHash("sha256").update(template).digest("hex"), key = `LOGBOOK_TEMPLATE_${kind.toUpperCase()}`;
  const previous = getSetting(db, guildId, key);
  if (!previous) { setSetting(db, guildId, key, hash); return 0; } // erster Lauf: nur merken, nichts umschreiben
  if (previous === hash) return 0;
  let updated = 0, failed = 0;
  for (const row of db.prepare(`SELECT user_id,thread_id,title FROM ${f.table} WHERE guild_id=? AND source='created' AND thread_id IS NOT NULL AND archived_at IS NULL`).all(guildId)) {
    const thread = await client.channels.fetch(row.thread_id).catch(() => null);
    const starter = await thread?.fetchStarterMessage?.({ force: true }).catch(() => null);
    if (!thread) continue;
    if (!starter) { failed++; continue; }
    if (starter.author?.id !== client.user?.id) continue;
    const content = buildLogbookContent(template, row.title, row.user_id);
    if (starter.content === content) continue;
    if (await starter.edit({ content, allowedMentions: { parse: [] } }).then(() => true).catch(() => false)) { updated++; await new Promise(r => setTimeout(r, pauseMs)); }
    else failed++;
  }
  // Erst merken, wenn alle Posts durch sind – sonst beim nächsten Lauf die übrigen nachziehen.
  if (!failed) setSetting(db, guildId, key, hash);
  if (updated) audit(db, guildId, client.user?.id ?? "system", "logbook.template_synced", null, { kind, updated });
  return updated;
}

/** Alle Posts eines Forums (aktiv + archiviert, seitenweise). */
async function allForumThreads(forum) {
  const threads = new Map();
  const active = await forum.threads.fetchActive().catch(() => null);
  active?.threads?.forEach?.(t => { if (!t.parentId || t.parentId === forum.id) threads.set(t.id, t); });
  let before;
  for (let page = 0; page < 20; page++) {
    const archived = await forum.threads.fetchArchived({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    const list = [...(archived?.threads?.values?.() ?? [])];
    list.forEach(t => threads.set(t.id, t));
    if (!archived?.hasMore || !list.length) break;
    before = list.at(-1).id;
  }
  return [...threads.values()];
}

/**
 * Forum neu aufsetzen: alle Posts außer „Vorlage …“ löschen, Verknüpfungen leeren und für jedes Familienmitglied
 * frisch anlegen. Bilder in den alten Posts gehen dabei verloren – nur nach ausdrücklicher Bestätigung aufrufen.
 */
export async function resetLogbookForum({ db, client, config, guild, actorId, kind = "events", pauseMs = 1200 }) {
  const f = forumOf(kind);
  const forum = config[f.key] ? await client.channels.fetch(config[f.key]).catch(() => null) : null;
  if (!forum || forum.type !== ChannelType.GuildForum) throw new Error(`Kein Forum für das ${f.label} eingestellt.`);
  let deleted = 0, failed = 0;
  for (const thread of await allForumThreads(forum)) {
    if (/^\W*vorlage/i.test(thread.name)) continue;
    if (await thread.delete(`${f.label}: Forum neu aufgesetzt`).then(() => true).catch(() => false)) { deleted++; await new Promise(r => setTimeout(r, pauseMs / 2)); }
    else failed++;
  }
  db.prepare(`DELETE FROM ${f.table} WHERE guild_id=?`).run(guild.id);
  audit(db, guild.id, actorId, "logbook.reset", null, { kind, deleted, failed });
  const created = await createMissingLogbooks({ db, client, config, guild, actorId, kind, pauseMs });
  return { deleted, failedDeletes: failed, ...created };
}

/** Bearbeitete Nachricht = Startnachricht eines „Vorlage …“-Posts in einem Logbuch-Forum? Dann die Art (tasks/events). */
export function templateKindOf(config, message) {
  const thread = message.channel;
  if (!thread?.isThread?.() || message.id !== thread.id || !/^\W*vorlage/i.test(thread.name ?? "")) return null;
  return Object.entries(LOGBOOK_FORUMS).find(([, f]) => config[f.key] && config[f.key] === thread.parentId)?.[0] ?? null;
}
