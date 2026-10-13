import { randomUUID } from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import { audit } from "../database.js";

export const APPLICATION_KINDS = ["bewerbung", "rang"];

export const DEFAULT_QUESTIONS = {
  rang: [
    { id: "name", label: "Dein Ingame-Name", style: "short", maxLength: 60 },
    { id: "aktueller_rang", label: "Dein aktueller Familienrang", style: "short", maxLength: 60 },
    { id: "ziel_rang", label: "Welchen Rang beantragst du?", style: "short", maxLength: 60 },
    { id: "begruendung", label: "Warum sollst du den Rang erhalten?", style: "paragraph", maxLength: 1000 },
  ],
  bewerbung: [
    { id: "name", label: "Dein Ingame-Name", style: "short", maxLength: 60 },
    { id: "alter", label: "Wie alt bist du?", style: "short", maxLength: 30 },
    { id: "erfahrung", label: "Deine Grand-RP-Erfahrung", style: "paragraph", maxLength: 1000 },
    { id: "motivation", label: "Warum möchtest du zu Gambinos?", style: "paragraph", maxLength: 1000 },
    { id: "aktivitaet", label: "Wann bist du normalerweise aktiv?", style: "paragraph", maxLength: 500 },
  ],
};

/** Fragen je Antragstyp: APPLICATION_QUESTIONS_JSON überschreibt die Standardfragen (max. 5, Discord-Modal-Limit). */
export function questionsFor(kind, config = {}) {
  const configured = config.APPLICATION_QUESTIONS_JSON?.[kind];
  return (configured?.length ? configured : DEFAULT_QUESTIONS[kind] ?? DEFAULT_QUESTIONS.bewerbung)
    .map(question => ({ required: true, ...question }));
}

export function createApplicationService(db) {
  const addNote = db.transaction(({ guildId, applicationId, authorId, note }) => {
    const text = String(note ?? "").trim();
    if (text.length < 2 || text.length > 1000) throw new Error("Die Notiz muss zwischen 2 und 1.000 Zeichen lang sein.");
    const application = db.prepare("SELECT id,user_id,kind,status FROM applications WHERE id=? AND guild_id=?").get(applicationId, guildId);
    if (!application) throw new Error("Antrag nicht gefunden.");
    const id = randomUUID();
    db.prepare("INSERT INTO application_notes(id,application_id,guild_id,author_id,note,created_at) VALUES(?,?,?,?,?,?)").run(id, applicationId, guildId, authorId, text, new Date().toISOString());
    // Notizinhalt bleibt in der Datenbank; das Audit-Log vermerkt nur, dass kommentiert wurde.
    audit(db, guildId, authorId, "application.commented", applicationId, { kind: application.kind, applicantId: application.user_id, noteId: id });
    return { id, application };
  });

  const notes = (applicationId, limit = 5) =>
    db.prepare("SELECT author_id,note,created_at FROM application_notes WHERE application_id=? ORDER BY created_at DESC LIMIT ?").all(applicationId, limit);

  return { addNote, notes };
}

const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages,
];

/**
 * Vergibt nach angenommenem Rang-Antrag eine ausdrücklich konfigurierte Rolle. Prüft Konfiguration, Guild,
 * Rollenhierarchie, Bot-Berechtigung und gefährliche Rollenrechte. Jede Vergabe ist pro Antrag einmalig.
 */
export async function assignRankRole({ db, config, guild, applicationId, roleId, actorId }) {
  if (!config.RANK_ROLE_ASSIGNMENT_ENABLED) return { ok: false, message: "Die automatische Rollenvergabe ist nicht aktiviert." };
  const configured = config.RANK_ROLES_JSON.find(item => item.roleId === roleId);
  if (!configured) return { ok: false, message: "Diese Rolle ist nicht als Rang-Rolle freigegeben." };
  const application = db.prepare("SELECT * FROM applications WHERE id=? AND guild_id=?").get(applicationId, guild.id);
  if (!application || application.kind !== "rang" || application.status !== "accepted") return { ok: false, message: "Nur angenommene Rang-Anträge können eine Rolle erhalten." };
  if (db.prepare("SELECT 1 FROM application_role_grants WHERE application_id=?").get(applicationId)) return { ok: false, message: "Für diesen Antrag wurde bereits eine Rollenvergabe protokolliert." };
  const fail = (message, reason) => {
    audit(db, guild.id, actorId, "application.role_failed", applicationId, { applicantId: application.user_id, roleId, reason });
    return { ok: false, message };
  };
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return fail("Die konfigurierte Rolle existiert auf diesem Server nicht.", "role_missing");
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return fail("Dem Bot fehlt die Berechtigung „Rollen verwalten“.", "bot_missing_permission");
  if (role.managed || role.id === guild.id) return fail("Diese Rolle kann nicht vergeben werden.", "role_managed");
  if (DANGEROUS_PERMISSIONS.some(flag => role.permissions.has(flag))) return fail("Die Rolle hat Moderations- oder Adminrechte und wird aus Sicherheitsgründen nicht automatisch vergeben.", "role_dangerous");
  if (role.position >= me.roles.highest.position) return fail("Die Rolle steht in der Hierarchie über der Bot-Rolle.", "role_hierarchy");
  const member = await guild.members.fetch(application.user_id).catch(() => null);
  if (!member) return fail("Der Antragsteller ist nicht mehr auf dem Server.", "member_missing");
  // Vor dem Discord-Aufruf reservieren, damit ein Doppelklick nicht zweimal vergibt.
  const reserved = db.prepare("INSERT OR IGNORE INTO application_role_grants(application_id,guild_id,user_id,role_id,actor_id,result,created_at) VALUES(?,?,?,?,?,'pending',?)").run(applicationId, guild.id, application.user_id, roleId, actorId, new Date().toISOString()).changes;
  if (!reserved) return { ok: false, message: "Für diesen Antrag läuft bereits eine Rollenvergabe." };
  try {
    if (!member.roles.cache.has(roleId)) await member.roles.add(roleId, `Rang-Antrag ${applicationId} angenommen`);
  } catch (error) {
    db.prepare("DELETE FROM application_role_grants WHERE application_id=? AND result='pending'").run(applicationId);
    return fail(`Discord hat die Rollenvergabe abgelehnt: ${error.message}`, "discord_error");
  }
  db.prepare("UPDATE application_role_grants SET result='granted' WHERE application_id=?").run(applicationId);
  audit(db, guild.id, actorId, "application.role_granted", applicationId, { applicantId: application.user_id, roleId, label: configured.label });
  return { ok: true, message: `Rolle **${configured.label}** wurde <@${application.user_id}> vergeben.`, member, role };
}
