import { EmbedBuilder } from "discord.js";
import { MOD_ACTIONS, createModerationLog } from "./services/moderation-log.js";

export const TIMEOUT_CHOICES = [[10, "10 Minuten"], [30, "30 Minuten"], [60, "1 Stunde"], [360, "6 Stunden"], [720, "12 Stunden"], [1440, "1 Tag"], [4320, "3 Tage"], [10080, "7 Tage"], [40320, "28 Tage"]];
export const BAN_DELETE_CHOICES = [[0, "Nichts löschen"], [3600, "Letzte Stunde"], [86400, "Letzte 24 Stunden"], [604800, "Letzte 7 Tage"]];
export const formatMinutes = minutes => TIMEOUT_CHOICES.find(([value]) => value === minutes)?.[1] ?? `${minutes} Minuten`;

/** Welche Rollengruppe welche Maßnahme ausführen darf. */
export const MOD_PERMISSIONS = {
  timeout: ["moderation", "Moderations- oder Staff-Rolle"],
  untimeout: ["moderation", "Moderations- oder Staff-Rolle"],
  kick: ["staff", "Staff-Rolle"],
  ban: ["leaders", "Leitungsrolle"],
  unban: ["leaders", "Leitungsrolle"],
};

/**
 * Prüft die Discord-Hierarchie: Der Bot muss die Maßnahme ausführen können, und wer sie auslöst, muss
 * (außer Bot-Owner und Server-Inhaber) über der Zielperson stehen.
 */
export function hierarchyProblem({ action, actorMember, targetMember, actorIsOwner = false, guildOwnerId = null }) {
  if (!targetMember) return ["kick", "timeout", "untimeout"].includes(action) ? "Diese Person ist nicht auf dem Server." : null;
  if (targetMember.id === guildOwnerId) return "Der Server-Inhaber kann nicht moderiert werden.";
  const botCan = { timeout: targetMember.moderatable, untimeout: targetMember.moderatable, kick: targetMember.kickable, ban: targetMember.bannable }[action];
  if (botCan === false) return "Der Bot darf diese Person nicht moderieren: Die Bot-Rolle muss über der höchsten Rolle der Person stehen und das passende Recht haben.";
  const mine = actorMember?.roles?.highest, theirs = targetMember.roles?.highest;
  if (!actorIsOwner && actorMember?.id !== guildOwnerId && mine?.comparePositionTo && theirs && mine.comparePositionTo(theirs) <= 0) return "Diese Person steht in der Rollen-Hierarchie gleich hoch oder über dir.";
  return null;
}

/**
 * Führt eine Moderationsmaßnahme aus: zuerst DM (vor Kick/Bann, solange es noch geht), dann die Aktion,
 * zuletzt Eintrag in der Mitgliederhistorie. Fehler werden protokolliert und als Ergebnis zurückgegeben.
 */
export async function performModeration({ db, guild, client, action, userId, targetMember = null, actorId, reason, minutes = null, deleteSeconds = 0 }) {
  const log = createModerationLog(db);
  const meta = MOD_ACTIONS[action];
  let dm = false;
  if (["timeout", "kick", "ban"].includes(action)) {
    const text = { timeout: `Du wurdest für **${formatMinutes(minutes)}** stummgeschaltet.`, kick: "Du wurdest vom Server entfernt (Kick). Du kannst über eine neue Einladung zurückkommen.", ban: "Du wurdest vom Server gebannt." }[action];
    const embed = new EmbedBuilder().setColor(0xe74c3c).setAuthor({ name: "GAMBINOS  •  MODERATION" }).setTitle(`${meta.emoji} ${meta.label}`)
      .setDescription(`${text}\n**Grund:** ${reason}`).setFooter({ text: `GAMBINOS  •  ${guild?.name ?? "Server"}` }).setTimestamp();
    dm = await client.users.fetch(userId).then(user => user.send({ embeds: [embed] })).then(() => true).catch(() => false);
  }
  const auditReason = `${reason} (durch ${actorId})`.slice(0, 500);
  let error = null;
  try {
    if (action === "timeout") await targetMember.timeout(minutes * 60_000, auditReason);
    else if (action === "untimeout") await targetMember.timeout(null, auditReason);
    else if (action === "kick") await targetMember.kick(auditReason);
    else if (action === "ban") await guild.members.ban(userId, { reason: auditReason, deleteMessageSeconds: deleteSeconds });
    else if (action === "unban") await guild.members.unban(userId, auditReason);
  } catch (e) { error = e; }
  log.record({ guildId: guild.id, userId, actorId, action, reason, durationMinutes: action === "timeout" ? minutes : null, result: error ? "failed" : "applied" });
  return { ok: !error, dm, error: error ? (error.code === 10026 ? "Diese Person ist nicht gebannt." : error.message) : null };
}
