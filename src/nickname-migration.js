import { audit, getSetting, setSetting } from "./database.js";
import { buildVerification } from "./services/verification.js";

const DONE_KEY = "NICKNAME_FORMAT_V2";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Einmalige Umstellung „ID | Vorname Nachname“ → „Vorname Nachname | ID“. Gespeicherte Namen werden immer
 * angepasst; in Discord umbenannt wird nur, wer noch genau den alten Bot-Namen trägt (eigene Änderungen bleiben).
 */
export async function migrateNicknameFormat({ db, client, config, delayMs = 1200 }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId || getSetting(db, guildId, DONE_KEY)) return null;
  setSetting(db, guildId, DONE_KEY, new Date().toISOString());
  const guild = client.guilds?.cache?.get(guildId) ?? await client.guilds?.fetch?.(guildId).catch(() => null);
  const rows = db.prepare("SELECT * FROM member_verifications WHERE guild_id=?").all(guildId);
  const result = { total: rows.length, renamed: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    let next;
    try { next = buildVerification({ ingameId: row.ingame_id, firstName: row.first_name, lastName: row.last_name }).nickname; }
    catch { result.skipped++; continue; }
    if (next === row.nickname) { result.skipped++; continue; }
    const member = guild ? await guild.members.fetch(row.user_id).catch(() => null) : null;
    if (member && member.nickname === row.nickname && member.id !== guild.ownerId) {
      const ok = await member.setNickname(next, "Gambinos: neues Namensformat „Vorname Nachname | ID“").then(() => true).catch(() => false);
      if (ok) result.renamed++; else result.failed++;
      if (delayMs) await pause(delayMs);
    } else result.skipped++;
    db.prepare("UPDATE member_verifications SET nickname=? WHERE guild_id=? AND user_id=?").run(next, guildId, row.user_id);
  }
  audit(db, guildId, client.user?.id ?? "system", "member.nickname_format", null, { value: "Vorname Nachname | ID", changed: `${result.renamed} umbenannt, ${result.skipped} übersprungen, ${result.failed} fehlgeschlagen` });
  return result;
}
