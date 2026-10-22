import { EmbedBuilder } from "discord.js";
import { audit } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { LOGBOOK_FORUMS, renameLogbook } from "./logbooks.js";
import { buildVerification, createVerificationService } from "./services/verification.js";

export class VerifyError extends Error {}

/**
 * Manuelle Verifizierung durch das Team (z. B. wenn das Panel nicht klappt): gleicher Ablauf wie die Selbst-Verifizierung –
 * Name „Vorname Nachname | ID“ setzen, Verifiziert-Rolle geben, speichern, Logbücher umbenennen, DM ans Mitglied.
 */
export async function verifyMemberManually({ db, client, config, guild, userId, input, actorId }) {
  const verifications = createVerificationService(db);
  let data;
  try { data = buildVerification(input); verifications.assertAvailable(guild.id, userId, data.ingameId); }
  catch (error) { throw new VerifyError(error.message); }
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new VerifyError("Dieses Mitglied ist nicht (mehr) auf dem Server.");
  if (member.user?.bot) throw new VerifyError("Bots kann man nicht verifizieren.");
  const before = verifications.byUser(guild.id, userId);
  const notes = [];
  if (guild.ownerId === userId) notes.push(`Server-Inhaber: Den Namen muss die Person selbst auf **${data.nickname}** setzen.`);
  else if (!(await member.setNickname(data.nickname, `Manuell verifiziert von ${actorId}`).then(() => true).catch(() => false))) {
    audit(db, guild.id, actorId, "member.verification_failed", userId, { name: data.nickname, reason: "Name konnte nicht geändert werden", manual: true });
    throw new VerifyError("Der Name konnte nicht geändert werden – wahrscheinlich steht die Rolle der Person über der Bot-Rolle oder dem Bot fehlt „Spitznamen verwalten“. Nichts gespeichert.");
  }
  const roleIds = config.ROLE_VERIFIED ?? [], failed = [];
  for (const roleId of roleIds) if (!member.roles.cache.has(roleId)) await member.roles.add(roleId, "Manuelle Verifizierung").catch(() => failed.push(roleId));
  if (failed.length) notes.push("Die Verifiziert-Rolle konnte nicht vergeben werden (Rollen-Reihenfolge prüfen).");
  try { verifications.save({ guildId: guild.id, userId, data, roleResult: roleIds.length ? (failed.length ? "teilweise fehlgeschlagen" : "vergeben") : null, actorId, manual: true }); }
  catch (error) { throw new VerifyError(error.message); }
  for (const kind of Object.keys(LOGBOOK_FORUMS)) void renameLogbook({ db, client, guildId: guild.id, userId, title: data.nickname, kind }).catch(() => {});
  void member.send({ embeds: [new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  VERIFIZIERUNG" }).setTitle(before ? "✏️ Dein Name wurde geändert" : "✅ Du wurdest verifiziert")
    .setDescription(`Das Team hat dich ${before ? "umbenannt" : "verifiziert"}. Dein Name lautet jetzt **${data.nickname}**.${before ? `\nVorher: ${before.nickname}` : ""}`).setTimestamp()] }).catch(() => {});
  return { data, before, notes };
}
