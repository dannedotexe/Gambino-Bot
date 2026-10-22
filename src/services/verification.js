import { audit } from "../database.js";

const NAME = /^[A-Za-zÀ-ÖØ-öø-ÿĀ-žẞ' -]{2,20}$/u;
export const MAX_NICKNAME = 32;

/** Prüft die Angaben und baut den Discord-Namen „Vorname Nachname | ID“. Wirft verständliche Fehler. */
export function buildVerification({ ingameId, firstName, lastName }) {
  const id = String(ingameId ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,10}$/.test(id)) throw new Error("Die Ingame-ID darf nur aus Ziffern bestehen (z. B. 12345).");
  const clean = value => String(value ?? "").trim().replace(/\s+/g, " ");
  const first = clean(firstName), last = clean(lastName);
  if (!NAME.test(first)) throw new Error("Bitte einen gültigen Vornamen angeben (2–20 Buchstaben, keine Zahlen oder Sonderzeichen).");
  if (!NAME.test(last)) throw new Error("Bitte einen gültigen Nachnamen angeben (2–20 Buchstaben, keine Zahlen oder Sonderzeichen).");
  const capitalize = name => name.split(/([ -])/).map(part => (part.length > 1 ? part.charAt(0).toLocaleUpperCase("de-AT") + part.slice(1) : part)).join("");
  const nickname = `${capitalize(first)} ${capitalize(last)} | ${id}`;
  if (nickname.length > MAX_NICKNAME) throw new Error(`Der Name „${nickname}“ ist zu lang (Discord erlaubt höchstens ${MAX_NICKNAME} Zeichen). Bitte kürze den Vor- oder Nachnamen.`);
  return { ingameId: id, firstName: capitalize(first), lastName: capitalize(last), nickname };
}

export function createVerificationService(db) {
  const byIngameId = (guildId, ingameId) => db.prepare("SELECT * FROM member_verifications WHERE guild_id=? AND ingame_id=?").get(guildId, ingameId);
  const byUser = (guildId, userId) => db.prepare("SELECT * FROM member_verifications WHERE guild_id=? AND user_id=?").get(guildId, userId);

  /** Ingame-ID darf nur einem Discord-Konto gehören. */
  function assertAvailable(guildId, userId, ingameId) {
    const owner = byIngameId(guildId, ingameId);
    if (owner && owner.user_id !== userId) throw new Error("Diese Ingame-ID ist bereits mit einem anderen Discord-Konto verifiziert. Bitte wende dich per Ticket an das Team.");
  }

  /** Speichert die Verifizierung erst, nachdem Discord den Namen übernommen hat. */
  const save = db.transaction(({ guildId, userId, data, roleResult = null, actorId = null, manual = false }) => {
    assertAvailable(guildId, userId, data.ingameId);
    const previous = byUser(guildId, userId), ts = new Date().toISOString();
    db.prepare("INSERT INTO member_verifications(guild_id,user_id,ingame_id,first_name,last_name,nickname,verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET ingame_id=excluded.ingame_id,first_name=excluded.first_name,last_name=excluded.last_name,nickname=excluded.nickname,updated_at=excluded.updated_at")
      .run(guildId, userId, data.ingameId, data.firstName, data.lastName, data.nickname, ts, ts);
    audit(db, guildId, actorId ?? userId, previous ? "member.verification_updated" : "member.verified", userId, { name: data.nickname, previous: previous?.nickname ?? null, roleResult, ...(manual ? { manual: true } : {}) });
    return { previous };
  });

  const list = (guildId, limit = 200) => db.prepare("SELECT * FROM member_verifications WHERE guild_id=? ORDER BY updated_at DESC LIMIT ?").all(guildId, limit);
  const remove = db.transaction(({ guildId, userId, actorId }) => {
    const row = byUser(guildId, userId);
    if (!row) return null;
    db.prepare("DELETE FROM member_verifications WHERE guild_id=? AND user_id=?").run(guildId, userId);
    audit(db, guildId, actorId, "member.verification_reset", userId, { name: row.nickname });
    return row;
  });
  return { assertAvailable, save, byUser, list, remove };
}
