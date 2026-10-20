import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { CHANNEL_BINDINGS } from "./channel-setup.js";

/**
 * Welche Funktion jeder Channel hat und welche Eigenschaften er dafür braucht.
 * audience: staff = darf für @everyone nicht sichtbar sein; public = Mitglieder müssen ihn sehen.
 * expect: Namensbestandteile, die zur Funktion passen; avoid: Namen, die auf eine andere Funktion hindeuten.
 */
export const CHANNEL_FUNCTIONS = [
  { key: "CHANNEL_ANNOUNCEMENTS", label: "Ankündigungen", audience: "public", expect: ["ankünd", "news", "info"], avoid: ["log", "event"], perms: ["SendMessages", "EmbedLinks", "MentionEveryone"] },
  { key: "CHANNEL_POLLS", label: "Abstimmungen", audience: "public", expect: ["abstimm", "umfrage", "vote", "poll"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks", "ReadMessageHistory"] },
  { key: "CHANNEL_SANCTION_LIST", label: "Öffentliche Sanktionsliste", audience: "public", expect: ["sanktion"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_WEEKLY_REPORT", label: "Wochenbericht (Leitung)", audience: "staff", expect: ["leitung", "bericht", "staff", "report", "dashboard"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_WELCOME", label: "Willkommensnachricht", audience: "public", expect: ["willkommen", "welcome", "neu", "spieler"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_ABSENCES", label: "Abmeldungen", audience: "public", expect: ["abmeld", "abwes", "urlaub"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_ACTIVITY_LOG", label: "Abmeldungs-/Inaktivitäts-Log", audience: "staff", expect: ["log", "abmeld", "aktiv", "abwes"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_LEADERBOARD", label: "Rangliste", audience: "public", expect: ["rang", "leader", "top", "ergebnis", "bestenliste"], avoid: ["log", "anträge"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_VERIFICATION_PANEL", label: "Verifizierungs-Panel", audience: "public", expect: ["neu", "verif", "willkommen", "spieler"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_ACCOUNT_PANEL", label: "„Mein Konto“-Panel", audience: "public", expect: ["konto", "geld", "bank", "auszahl"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_TICKET_PANEL", label: "Ticket-Panel", audience: "public", expect: ["ticket", "support"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_TICKET_CATEGORY", label: "Ticket-Kategorie", type: "category", audience: "any", perms: ["ManageChannels"], important: true },
  { key: "CHANNEL_TICKET_CLOSED_CATEGORY", label: "Kategorie geschlossene Tickets", type: "category", audience: "staff", expect: ["closed", "geschlossen", "archiv"], perms: ["ManageChannels"] },
  { key: "CHANNEL_TICKET_LOG", label: "Ticket-Log", audience: "staff", expect: ["ticket"], perms: ["SendMessages", "EmbedLinks", "AttachFiles"], important: true },
  { key: "CHANNEL_APPLICATION_PANEL", label: "Bewerbungs-Panel", audience: "public", expect: ["bewerb", "antrag", "anträge"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_APPLICATION_REVIEW", label: "Bewerbungen prüfen", audience: "staff", expect: ["bewerb"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_RANK_REVIEW", label: "Rang-Anträge prüfen", audience: "staff", expect: ["rang"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_EVENT_ANNOUNCEMENTS", label: "Event-Ankündigungen", audience: "public", expect: ["event", "ankünd", "anmeld"], avoid: ["log", "ergebnis"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_EVENT_SIGNUP", label: "Event-Anmeldung", audience: "public", expect: ["anmeld", "event", "signup"], avoid: ["log", "ergebnis"], perms: ["SendMessages", "EmbedLinks", "ReadMessageHistory"] },
  { key: "CHANNEL_ACTIVITY_BOARD", label: "Aktivitäten-Übersicht", audience: "public", expect: ["event", "info", "aktiv", "plan"], avoid: ["log"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_EVENT_RESULTS", label: "Event-Ergebnisse", audience: "public", expect: ["ergebnis", "result"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_BOT_COMMANDS", label: "Befehls-Channel (Mitglieder)", audience: "public", expect: ["befehl", "command", "bot"], perms: ["SendMessages", "ManageMessages"] },
  { key: "CHANNEL_PAYOUT_LIST", label: "Auszahlungsliste", audience: "any", expect: ["auszahl", "liste", "konto"], perms: ["SendMessages", "EmbedLinks", "ReadMessageHistory"] },
  { key: "CHANNEL_TASK_REVIEW", label: "Aufgaben-Logs prüfen", audience: "staff", expect: ["aufgabe", "log", "prüf", "task"], perms: ["SendMessages", "EmbedLinks", "AttachFiles"] },
  { key: "CHANNEL_TASK_BOARD", label: "Aufgaben-Board", audience: "public", expect: ["aufgabe", "task", "board", "log"], perms: ["SendMessages", "EmbedLinks", "ReadMessageHistory"] },
  { key: "CHANNEL_TASK_FORUM", label: "Logbücher (Forum)", type: "forum", audience: "any", expect: ["aufgabe", "log"], perms: ["SendMessages", "SendMessagesInThreads", "ReadMessageHistory"] },
  { key: "CHANNEL_EVENT_CHECK", label: "Event-Check (Anwesenheit)", audience: "staff", expect: ["check", "anwesen", "event"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_EVENT_LOG", label: "Event-Log", audience: "any", expect: ["log"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_GIVEAWAYS", label: "Giveaways", audience: "public", expect: ["giveaway", "gewinn"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_STAFF_DASHBOARD", label: "Staff-Dashboard-Panel", audience: "staff", expect: ["dashboard", "staff"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_SANCTION_LOG", label: "Sanktions-Log", audience: "staff", expect: ["sanktion"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_FINANCE_LOG", label: "Auszahlungs-Log", audience: "staff", expect: ["auszahl", "finanz", "konto", "geld"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_STATS", label: "Statistik", audience: "any", expect: ["statist"], perms: ["SendMessages", "EmbedLinks"] },
  { key: "CHANNEL_AUDIT_LOG", label: "Allgemeines Audit-Log", audience: "staff", expect: ["log", "audit", "protokoll"], avoid: ["sanktion", "ticket", "auszahl", "event"], perms: ["SendMessages", "EmbedLinks"], important: true },
  { key: "CHANNEL_AUTOMOD_LOG", label: "AutoMod-/Raid-Log", audience: "staff", expect: ["log", "mod", "raid", "sicher"], avoid: ["ticket", "auszahl", "event"], perms: ["SendMessages", "EmbedLinks"] },
];
const PERMISSION_LABELS = { ViewChannel: "Kanal ansehen", SendMessages: "Nachrichten senden", EmbedLinks: "Links einbetten", AttachFiles: "Dateien anhängen", ReadMessageHistory: "Nachrichtenverlauf lesen", ManageChannels: "Kanäle verwalten", MentionEveryone: "Erwähnungen (für Teilnehmer-Pings)", ManageMessages: "Nachrichten verwalten", ModerateMembers: "Mitglieder moderieren (Timeout)", ManageRoles: "Rollen verwalten", ManageGuild: "Server verwalten", ManageNicknames: "Spitznamen verwalten" };
const plainName = name => String(name ?? "").toLocaleLowerCase("de-AT").replace(/^[^a-z0-9äöüß]+/i, "");
const recommended = key => { const [category, channel] = CHANNEL_BINDINGS[key] ?? []; return category ? `${category}${channel ? `・${channel}` : ""}` : null; };

/** Prüft alle Funktions-Channels und die Server-Berechtigungen des Bots. Nur lesende Discord-Zugriffe. */
export async function checkChannels({ guild, config }) {
  const me = guild.members.me ?? await guild.members.fetchMe();
  const everyone = guild.roles.everyone;
  const memberRoles = (config.ROLE_MEMBERS ?? []).map(id => guild.roles.cache.get(id)).filter(Boolean);
  const results = [];
  const used = new Map();
  for (const fn of CHANNEL_FUNCTIONS) {
    const id = config[fn.key];
    const result = { key: fn.key, label: fn.label, recommended: recommended(fn.key), channel: null, issues: [] };
    const add = (level, text) => result.issues.push({ level, text });
    if (!id) {
      add(fn.important ? "warn" : "info", `Nicht gesetzt${result.recommended ? ` – empfohlen: ${result.recommended}` : ""}.`);
      results.push(result); continue;
    }
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel) { add("error", "Channel existiert nicht mehr (gelöscht?) oder der Bot sieht ihn nicht."); results.push(result); continue; }
    result.channel = { id, name: channel.name, parent: channel.parent?.name ?? null, category: channel.type === ChannelType.GuildCategory };
    used.set(id, [...(used.get(id) ?? []), fn.label]);
    const isCategory = channel.type === ChannelType.GuildCategory;
    if (fn.type === "category" && !isCategory) add("error", "Hier muss eine Kategorie ausgewählt sein, kein Text-Channel.");
    if (fn.type === "forum" && channel.type !== ChannelType.GuildForum) add("error", "Hier muss ein Forum-Channel ausgewählt sein.");
    if (!["category", "forum"].includes(fn.type) && (isCategory || !channel.isTextBased?.())) add("error", "Hier muss ein Text-Channel ausgewählt sein.");
    const botPerms = channel.permissionsFor?.(me);
    const missing = ["ViewChannel", ...(isCategory ? [] : ["ReadMessageHistory"]), ...fn.perms].filter(flag => !botPerms?.has(P[flag]));
    if (missing.length) add(missing.includes("ViewChannel") || missing.includes("SendMessages") || missing.includes("ManageChannels") ? "error" : "warn", `Bot fehlt: ${missing.map(flag => PERMISSION_LABELS[flag] ?? flag).join(", ")}.`);
    const everyoneCanView = channel.permissionsFor?.(everyone)?.has(P.ViewChannel) ?? false;
    if (fn.audience === "staff" && everyoneCanView) add("error", "Für alle sichtbar! Dieser Channel enthält Staff-Informationen und sollte privat sein.");
    if (fn.audience === "public") {
      const visible = memberRoles.length ? memberRoles.some(role => channel.permissionsFor?.(role)?.has(P.ViewChannel)) || everyoneCanView : everyoneCanView;
      if (!visible) add("warn", memberRoles.length ? "Familienmitglieder können diesen Channel nicht sehen." : "@everyone kann diesen Channel nicht sehen – Mitglieder sehen Panel/Ankündigungen evtl. nicht.");
    }
    if (fn.type === "category" && isCategory && everyoneCanView) add("info", "Kategorie ist öffentlich – das ist ok, Tickets bekommen eigene private Rechte.");
    const name = plainName(channel.name);
    if (fn.expect && !fn.expect.some(word => name.includes(word))) add("warn", `Name „${channel.name}“ passt nicht zur Funktion${result.recommended ? ` (empfohlen: ${result.recommended})` : ""}.`);
    else if (fn.avoid?.some(word => name.includes(word))) add("warn", `„${channel.name}“ klingt nach einer anderen Funktion${result.recommended ? ` (empfohlen: ${result.recommended})` : ""}.`);
    results.push(result);
  }
  // Mehrfachbelegung ist erlaubt, wird aber angezeigt (z. B. Audit- und AutoMod-Log im selben Channel).
  for (const result of results) {
    const shared = result.channel ? used.get(result.channel.id).filter(label => label !== result.label) : [];
    if (shared.length) result.issues.push({ level: "info", text: `Wird auch genutzt für: ${shared.join(", ")}.` });
    result.status = result.issues.some(i => i.level === "error") ? "error" : result.issues.some(i => i.level === "warn") ? "warn" : "ok";
  }
  const actions = [...config.AUTOMOD_SPAM_ACTIONS, ...config.AUTOMOD_DUPLICATE_ACTIONS, ...config.AUTOMOD_LINK_ACTIONS, ...config.AUTOMOD_TERM_ACTIONS];
  const guildPerms = [
    { flag: "ManageChannels", reason: "Ticket-Channels anlegen", needed: true },
    { flag: "ManageMessages", reason: "AutoMod löscht Nachrichten", needed: config.AUTOMOD_ENABLED && actions.includes("delete") },
    { flag: "ModerateMembers", reason: "Timeouts durch AutoMod/Raid-Schutz", needed: (config.AUTOMOD_ENABLED && actions.includes("timeout")) || config.RAID_ACTIONS.includes("timeout") || config.AUTOMOD_ESCALATION_COUNT > 0 },
    { flag: "ManageNicknames", reason: "Namen bei der Verifizierung setzen", needed: Boolean(config.CHANNEL_VERIFICATION_PANEL) },
    { flag: "ManageRoles", reason: "Rang-Rollen bzw. Verifiziert-Rolle vergeben", needed: config.RANK_ROLE_ASSIGNMENT_ENABLED || Boolean(config.ROLE_VERIFIED?.length) },
    { flag: "ManageGuild", reason: "Native Discord-AutoMod-Regel (/automod sync)", needed: false },
  ].map(item => ({ ...item, label: PERMISSION_LABELS[item.flag], has: me.permissions.has(P[item.flag]) }));
  const administrator = me.permissions.has(P.Administrator);
  return {
    channels: results, guildPermissions: guildPerms, administrator,
    summary: { ok: results.filter(r => r.status === "ok").length, warn: results.filter(r => r.status === "warn").length, error: results.filter(r => r.status === "error").length + guildPerms.filter(p => p.needed && !p.has).length },
  };
}
