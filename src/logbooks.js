import { ChannelType } from "discord.js";
import { audit } from "./database.js";

/**
 * Logbücher: Bekommt jemand die Familienmitglieder-Rolle, legt der Bot im Logbücher-Forum einen Post
 * „Vorname Nachname | ID“ an. Text = Startnachricht des Posts „Vorlage …“ (sonst Standardtext), ganz unten wird
 * die Person markiert, damit ihr der Post angezeigt wird. Bestehende Posts mit Namen bzw. ID werden übernommen, nie doppelt.
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

/** Vorlage für die Person: eigener Titel in der Titel-Zeile, Erwähnung ganz unten (im Wichtig-Block, falls zitiert). */
export function buildLogbookContent(template, title, userId) {
  const lines = String(template || DEFAULT_LOGBOOK_TEMPLATE).replace(/\s+$/, "").split("\n")
    .map(line => (/titel/i.test(line) && /`[^`]*`/.test(line) ? line.replace(/`[^`]*`/, `\`${title.replace(/`/g, "'")}\``) : line));
  const last = lines.at(-1) ?? "";
  lines.push(`${/^>\s?/.test(last) ? "> " : ""}<@${userId}>`);
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
