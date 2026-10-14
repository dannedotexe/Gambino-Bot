import { randomUUID } from "node:crypto";
import { audit } from "../database.js";
import { createFinance, FinanceError } from "./finance.js";

export const CLOSURE_REASONS = { role_removed: "Familienrolle entfernt", left: "Server verlassen" };

/**
 * Löschanfragen für Familienkonten. Verliert jemand die Familienrolle oder verlässt den Server, entsteht eine
 * offene Anfrage; gelöscht wird erst, wenn die Finanzverwaltung auf der Website bestätigt.
 */
export function createAccountClosureService(db, finance = createFinance(db)) {
  const latest = (guildId, userId) => db.prepare("SELECT * FROM account_closures WHERE guild_id=? AND user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(guildId, userId);
  const REJOINED = "Familienrolle wieder erhalten";

  /**
   * Legt eine Anfrage an, wenn ein Konto existiert und noch keine offen ist. Ohne `definite` (alter Rollenstand
   * unbekannt) wird nach „Konto behalten“ nicht erneut gefragt, solange niemand die Rolle zurückbekommen hat.
   */
  const request = db.transaction(({ guildId, userId, reason, actorId = "system", definite = true }) => {
    if (!CLOSURE_REASONS[reason]) throw new Error("Unbekannter Anlass.");
    if (!db.prepare("SELECT 1 FROM accounts WHERE guild_id=? AND user_id=?").get(guildId, userId)) return null;
    const last = latest(guildId, userId);
    if (last?.status === "pending") return null;
    if (!definite && last?.status === "dismissed" && last.note !== REJOINED) return null;
    const row = { id: randomUUID(), guildId, userId, reason, ts: new Date().toISOString() };
    db.prepare("INSERT INTO account_closures(id,guild_id,user_id,reason,status,created_at) VALUES(@id,@guildId,@userId,@reason,'pending',@ts)").run(row);
    audit(db, guildId, actorId, "finance.closure_requested", userId, { reason: CLOSURE_REASONS[reason], balance: finance.balance(guildId, userId) });
    return get(guildId, row.id);
  });

  const get = (guildId, id) => db.prepare("SELECT * FROM account_closures WHERE guild_id=? AND id=?").get(guildId, id) ?? null;
  const pendingRow = (guildId, id) => {
    const row = get(guildId, id);
    if (!row) throw new FinanceError("Anfrage nicht gefunden.", "NOT_FOUND");
    if (row.status !== "pending") throw new FinanceError("Diese Anfrage wurde bereits bearbeitet.", "CONFLICT");
    return row;
  };

  /** Bestätigt die Löschung: Konto wird geschlossen (Restguthaben verfällt, offene Sanktionen werden aufgehoben). */
  const confirm = db.transaction(({ guildId, id, actorId, note = null }) => {
    const row = pendingRow(guildId, id);
    const exists = db.prepare("SELECT 1 FROM accounts WHERE guild_id=? AND user_id=?").get(guildId, row.user_id);
    const result = exists
      ? finance.closeAccount({ guildId, userId: row.user_id, actorId, reason: note?.trim() || CLOSURE_REASONS[row.reason], key: `closure:${row.id}` })
      : { balance: 0, voidedSanctions: 0, openCents: 0 };
    db.prepare("UPDATE account_closures SET status='confirmed',decided_at=?,decided_by=?,note=? WHERE id=?").run(new Date().toISOString(), actorId, note?.trim() || null, row.id);
    return { ...result, userId: row.user_id };
  });

  /** Konto behalten: Anfrage wird geschlossen, das Konto bleibt unverändert. */
  const dismiss = db.transaction(({ guildId, id, actorId, note = null }) => {
    const row = pendingRow(guildId, id);
    db.prepare("UPDATE account_closures SET status='dismissed',decided_at=?,decided_by=?,note=? WHERE id=?").run(new Date().toISOString(), actorId, note?.trim() || null, row.id);
    audit(db, guildId, actorId, "finance.closure_dismissed", row.user_id, { reason: note?.trim() || "Konto behalten" });
    return { userId: row.user_id };
  });

  /** Wer die Familienrolle wieder erhält, braucht keine Löschanfrage mehr. Liefert die Anzahl geschlossener Anfragen. */
  const resolveRejoined = ({ guildId, userId, actorId = "system" }) => db.transaction(() => {
    const open = db.prepare("SELECT id FROM account_closures WHERE guild_id=? AND user_id=? AND status='pending'").all(guildId, userId);
    for (const row of open) db.prepare("UPDATE account_closures SET status='dismissed',decided_at=?,decided_by=?,note=? WHERE id=?").run(new Date().toISOString(), actorId, REJOINED, row.id);
    return open.length;
  })();

  const pending = guildId => db.prepare("SELECT * FROM account_closures WHERE guild_id=? AND status='pending' ORDER BY created_at").all(guildId);

  return { request, confirm, dismiss, resolveRejoined, pending, get, latest };
}
