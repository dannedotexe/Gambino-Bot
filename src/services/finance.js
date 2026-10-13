import { randomUUID } from "node:crypto";
import { WarningError, createWarningService } from "./warnings.js";
import { audit } from "../database.js";

/*
 * Fachliche Bedeutung (verbindlich):
 * - accounts.balance_cents: Gambinos-Familienguthaben = Geld, das die Familie dem Mitglied für Grand-RP-Events
 *   oder Familienaktivitäten schuldet und noch nicht ausgezahlt hat. Keine Discord-Spielwährung.
 * - transactions: unveränderliches Journal (DB-Trigger verhindern UPDATE/DELETE). amount_cents ist immer der
 *   Betrag, um den sich das Familienguthaben ändert; die Richtung ergibt sich aus dem Typ:
 *   credit, correction_credit, sanction_refund = Erhöhung; payout, correction_debit = Verringerung.
 *   Bei payout gilt: gross_cents = vom Guthaben abgebuchter Bruttobetrag, deduction_cents = jetzt verrechnete
 *   Sanktionen, net_cents = tatsächlich an das Mitglied ausgezahlter Betrag (gross - deduction).
 * - sanctions: Auszahlungsabzüge. amount_cents = festgesetzter Gesamtbetrag, remaining_cents = noch offener Rest.
 *   Status: open (nichts verrechnet), partial (teilweise verrechnet), paid (vollständig verrechnet), void (aufgehoben).
 *   Eine Sanktion belastet das Familienguthaben nie direkt, sondern reduziert nur den Nettobetrag einer Auszahlung.
 * - payout_allocations: je verrechnetem Teilbetrag eine Zeile mit Auszahlungs- und Sanktions-ID.
 * - sanction_changes: Historie jeder Statusänderung oder Korrektur einer Sanktion.
 */

const now = () => new Date().toISOString();
const amount = (n) => Number.isSafeInteger(n) && n > 0;
const ACTIVE = "('open','partial')";

export class FinanceError extends Error {
  constructor(message, code = "FINANCE_ERROR") { super(message); this.code = code; }
}

export function createFinance(db) {
  const warnings = createWarningService(db);
  const balance = (guildId, userId) =>
    db.prepare("SELECT balance_cents FROM accounts WHERE guild_id=? AND user_id=?").get(guildId, userId)?.balance_cents ?? 0;
  const openSanctionTotal = (guildId, userId) =>
    db.prepare(`SELECT COALESCE(SUM(remaining_cents),0) n FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ${ACTIVE}`).get(guildId, userId).n;
  const priorByKey = key => db.prepare("SELECT * FROM transactions WHERE idempotency_key=?").get(key);
  const ensureAccount = (guildId, userId, ts) =>
    db.prepare("INSERT INTO accounts(guild_id,user_id,balance_cents,updated_at) VALUES(?,?,0,?) ON CONFLICT(guild_id,user_id) DO NOTHING").run(guildId, userId, ts);
  const recordChange = (row, actorId, changeType, { oldAmount = row.amount_cents, newAmount = row.amount_cents, oldRemaining = row.remaining_cents, newRemaining, referenceId = null, reason = "", ts }) =>
    db.prepare("INSERT INTO sanction_changes(id,sanction_id,guild_id,actor_id,change_type,old_amount_cents,new_amount_cents,old_remaining_cents,new_remaining_cents,reference_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), row.id, row.guild_id, actorId, changeType, oldAmount, newAmount, oldRemaining, newRemaining, referenceId, reason, ts);
  const collected = sanctionId => db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payout_allocations WHERE sanction_id=?").get(sanctionId).n;
  const refunded = sanctionId => db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM sanction_refunds WHERE sanction_id=?").get(sanctionId).n;

  /** Berechnet die Verrechnung (FIFO nach Erstellzeit) ohne zu schreiben. */
  function previewPayout(guildId, userId) {
    const gross = balance(guildId, userId);
    const open = db.prepare(`SELECT id,remaining_cents FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ${ACTIVE} AND remaining_cents>0 ORDER BY created_at,rowid`).all(guildId, userId);
    const openCents = open.reduce((sum, row) => sum + row.remaining_cents, 0);
    let left = gross;
    const allocations = [];
    for (const row of open) {
      const part = Math.min(left, row.remaining_cents);
      if (!part) break;
      allocations.push({ id: row.id, cents: part, remainingAfter: row.remaining_cents - part });
      left -= part;
    }
    const deduction = gross - left;
    return { gross, openCents, deduction, net: gross - deduction, remainingAfter: openCents - deduction, allocations };
  }

  // Schreibt fehlgeschlagene Buchungsversuche außerhalb der zurückgerollten Transaktion ins Audit-Log.
  const withFailureAudit = (operation, tx) => (args) => {
    try { return tx(args); }
    catch (error) {
      try { audit(db, args.guildId, args.actorId ?? "system", "finance.failed", args.userId ?? args.sanctionId ?? null, { operation, reason: String(error.message).slice(0, 300), code: error.code ?? null }); }
      catch (logError) { console.error("Fehlgeschlagene Buchung konnte nicht protokolliert werden:", logError.message); }
      throw error;
    }
  };

  const credit = db.transaction(({ guildId, userId, actorId, cents, reason, key }) => {
    if (!amount(cents) || !reason?.trim()) throw new FinanceError("Betrag und Buchungsgrund sind erforderlich.", "INVALID_INPUT");
    const prior = priorByKey(key); if (prior) return prior;
    const ts = now(), txId = randomUUID();
    ensureAccount(guildId, userId, ts);
    db.prepare("UPDATE accounts SET balance_cents=balance_cents+?,updated_at=? WHERE guild_id=? AND user_id=?").run(cents, ts, guildId, userId);
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(txId, guildId, userId, actorId, "credit", cents, reason.trim(), key, ts);
    audit(db, guildId, actorId, "finance.credit", userId, { cents, reason: reason.trim(), transactionId: txId });
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });

  /** Korrekturbuchung (Leitung). direction=credit erhöht, direction=debit verringert das Familienguthaben. */
  const correction = db.transaction(({ guildId, userId, actorId, cents, direction, reason, key }) => {
    if (!amount(cents) || !reason?.trim()) throw new FinanceError("Betrag und Korrekturgrund sind erforderlich.", "INVALID_INPUT");
    if (!["credit", "debit"].includes(direction)) throw new FinanceError("Ungültige Korrekturrichtung.", "INVALID_INPUT");
    const prior = priorByKey(key); if (prior) return prior;
    const ts = now(), txId = randomUUID();
    ensureAccount(guildId, userId, ts);
    if (direction === "debit") {
      const changed = db.prepare("UPDATE accounts SET balance_cents=balance_cents-?,updated_at=? WHERE guild_id=? AND user_id=? AND balance_cents>=?").run(cents, ts, guildId, userId, cents).changes;
      if (changed !== 1) throw new FinanceError("Die Korrektur würde das Familienguthaben unter 0 senken.", "INSUFFICIENT_BALANCE");
    } else db.prepare("UPDATE accounts SET balance_cents=balance_cents+?,updated_at=? WHERE guild_id=? AND user_id=?").run(cents, ts, guildId, userId);
    const type = direction === "debit" ? "correction_debit" : "correction_credit";
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(txId, guildId, userId, actorId, type, cents, reason.trim(), key, ts);
    audit(db, guildId, actorId, "finance.correction", userId, { cents, direction, reason: reason.trim(), transactionId: txId });
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });

  /** Legt ein leeres Familienkonto an (Guthaben 0). Bereits vorhandene Konten bleiben unverändert. */
  const openAccount = db.transaction(({ guildId, userId, actorId, note = "" }) => {
    const created = db.prepare("INSERT INTO accounts(guild_id,user_id,balance_cents,updated_at) VALUES(?,?,0,?) ON CONFLICT(guild_id,user_id) DO NOTHING").run(guildId, userId, now()).changes === 1;
    if (created) audit(db, guildId, actorId, "finance.account_opened", userId, { reason: String(note).trim().slice(0, 300) });
    return { created, balance: balance(guildId, userId) };
  });

  const sanction = db.transaction(({ guildId, userId, actorId, cents, reason, caseRef = null }) => {
    if (!amount(cents) || !reason?.trim()) throw new FinanceError("Sanktionsbetrag und Grund sind erforderlich.", "INVALID_INPUT");
    const ts = now(), id = randomUUID();
    db.prepare("INSERT INTO sanctions(id,guild_id,user_id,actor_id,amount_cents,remaining_cents,reason,status,case_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'open',?,?,?)").run(id, guildId, userId, actorId, cents, cents, reason.trim(), caseRef, ts, ts);
    const row = db.prepare("SELECT * FROM sanctions WHERE id=?").get(id);
    recordChange(row, actorId, "created", { oldAmount: null, oldRemaining: null, newRemaining: cents, reason: reason.trim(), ts });
    audit(db, guildId, actorId, "sanction.created", userId, { sanctionId: id, cents, reason: reason.trim(), caseRef });
    return id;
  });

  /**
   * Bucht eine Auszahlung atomar: Guthaben -> 0, Sanktionen (FIFO) bis maximal zum Brutto verrechnen,
   * eine Transaktion mit Brutto/Abzug/Netto und je Sanktion eine Allocation anlegen. Wird ein
   * expectedGross/expectedDeduction übergeben (Vorschau), muss der aktuelle Stand exakt übereinstimmen.
   * Gleicher idempotency key => bereits gebuchte Transaktion wird zurückgegeben, nichts doppelt gebucht.
   */
  const payout = db.transaction(({ guildId, userId, actorId, key, reason = "Familienauszahlung", allowZero = false, minimumCents, expectedGross, expectedDeduction }) => {
    const prior = priorByKey(key);
    if (prior) return prior;
    const plan = previewPayout(guildId, userId);
    if ((expectedGross != null && plan.gross !== expectedGross) || (expectedDeduction != null && plan.deduction !== expectedDeduction))
      throw new FinanceError("Kontostand oder offene Sanktionen haben sich seit der Vorschau geändert.", "PREVIEW_MISMATCH");
    if (plan.gross <= 0 && !allowZero) throw new FinanceError("Kein Guthaben für eine Auszahlung vorhanden.", "NO_BALANCE");
    if (minimumCents != null && plan.gross < minimumCents) throw new FinanceError("Das Guthaben liegt unter dem konfigurierten Auszahlungs-Mindestbetrag.", "BELOW_MINIMUM");
    const ts = now(), txId = randomUUID();
    ensureAccount(guildId, userId, ts);
    const debited = db.prepare("UPDATE accounts SET balance_cents=balance_cents-?,updated_at=? WHERE guild_id=? AND user_id=? AND balance_cents=?").run(plan.gross, ts, guildId, userId, plan.gross).changes;
    if (debited !== 1) throw new FinanceError("Das Familienguthaben hat sich während der Buchung geändert.", "CONCURRENT_CHANGE");
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,gross_cents,deduction_cents,net_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(txId, guildId, userId, actorId, "payout", plan.gross, plan.gross, plan.deduction, plan.net, reason, key, ts);
    for (const item of plan.allocations) {
      const before = db.prepare("SELECT * FROM sanctions WHERE id=?").get(item.id);
      db.prepare("INSERT INTO payout_allocations(id,payout_id,sanction_id,amount_cents,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), txId, item.id, item.cents, ts);
      const updated = db.prepare(`UPDATE sanctions SET remaining_cents=remaining_cents-?,status=CASE WHEN remaining_cents-?=0 THEN 'paid' ELSE 'partial' END,updated_at=? WHERE id=? AND status IN ${ACTIVE} AND remaining_cents>=?`).run(item.cents, item.cents, ts, item.id, item.cents).changes;
      if (updated !== 1) throw new FinanceError("Eine Sanktion konnte nicht konsistent verrechnet werden.", "SANCTION_CONFLICT");
      recordChange(before, actorId, "allocated", { newRemaining: item.remainingAfter, referenceId: txId, ts });
      audit(db, guildId, actorId, item.remainingAfter === 0 ? "sanction.settled" : "sanction.applied", userId, { sanctionId: item.id, payoutId: txId, cents: item.cents, remainingCents: item.remainingAfter });
    }
    audit(db, guildId, actorId, "finance.payout", userId, { transactionId: txId, grossCents: plan.gross, deductionCents: plan.deduction, netCents: plan.net, remainingCents: plan.remainingAfter, reason });
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });

  const voidSanction = db.transaction(({ guildId, sanctionId, actorId, reason }) => {
    if (!reason?.trim()) throw new FinanceError("Für die Aufhebung ist ein Grund erforderlich.", "INVALID_INPUT");
    const row = db.prepare("SELECT * FROM sanctions WHERE id=? AND guild_id=?").get(sanctionId, guildId);
    if (!row || !["open", "partial"].includes(row.status)) throw new FinanceError("Offene Sanktion nicht gefunden.", "NOT_FOUND");
    if (collected(sanctionId) > 0) throw new FinanceError("Von dieser Sanktion wurde bereits Geld abgezogen. Nutze /sanktion rueckerstatten, damit der bereits belastete Betrag gutgeschrieben und die Sanktion aufgehoben wird.", "ALREADY_COLLECTED");
    const ts = now();
    db.prepare("UPDATE sanctions SET status='void',remaining_cents=0,updated_at=? WHERE id=? AND status IN ('open','partial')").run(ts, sanctionId);
    recordChange(row, actorId, "voided", { newRemaining: 0, reason: reason.trim(), ts });
    audit(db, guildId, actorId, "sanction.void", row.user_id, { sanctionId, remainingCents: row.remaining_cents, reason: reason.trim() });
    return row;
  });

  const refundSanction = db.transaction(({ guildId, sanctionId, actorId, reason, key }) => {
    if (!reason?.trim()) throw new FinanceError("Für eine Rückerstattung ist ein Grund erforderlich.", "INVALID_INPUT");
    const prior = priorByKey(key); if (prior) return prior;
    const row = db.prepare("SELECT * FROM sanctions WHERE id=? AND guild_id=?").get(sanctionId, guildId);
    if (!row) throw new FinanceError("Sanktion nicht gefunden.", "NOT_FOUND");
    const cents = collected(sanctionId) - refunded(sanctionId);
    if (cents <= 0) throw new FinanceError("Für diese Sanktion gibt es keinen noch nicht erstatteten Abzug.", "NOTHING_TO_REFUND");
    const ts = now(), txId = randomUUID();
    ensureAccount(guildId, row.user_id, ts);
    db.prepare("UPDATE accounts SET balance_cents=balance_cents+?,updated_at=? WHERE guild_id=? AND user_id=?").run(cents, ts, guildId, row.user_id);
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(txId, guildId, row.user_id, actorId, "sanction_refund", cents, reason.trim(), key, ts);
    db.prepare("INSERT INTO sanction_refunds(id,sanction_id,transaction_id,amount_cents,reason,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), sanctionId, txId, cents, reason.trim(), ts);
    if (row.status !== "void") db.prepare("UPDATE sanctions SET status='void',remaining_cents=0,updated_at=? WHERE id=?").run(ts, sanctionId);
    recordChange(row, actorId, "refunded", { newRemaining: 0, referenceId: txId, reason: reason.trim(), ts });
    audit(db, guildId, actorId, "sanction.refunded", row.user_id, { sanctionId, transactionId: txId, cents, reason: reason.trim() });
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });

  /**
   * Korrigiert den Gesamtbetrag einer nicht aufgehobenen Sanktion. Bereits verrechnete Teilbeträge bleiben
   * unangetastet; der neue Betrag darf sie nicht unterschreiten (dafür gibt es die Rückerstattung).
   */
  const correctSanction = db.transaction(({ guildId, sanctionId, actorId, cents, reason }) => {
    if (!amount(cents) || !reason?.trim()) throw new FinanceError("Neuer Betrag und Korrekturgrund sind erforderlich.", "INVALID_INPUT");
    const row = db.prepare("SELECT * FROM sanctions WHERE id=? AND guild_id=?").get(sanctionId, guildId);
    if (!row || row.status === "void") throw new FinanceError("Nicht aufgehobene Sanktion nicht gefunden.", "NOT_FOUND");
    const settled = collected(sanctionId);
    if (cents < settled) throw new FinanceError(`Es wurden bereits ${formatMoney(settled)} verrechnet. Der neue Betrag darf das nicht unterschreiten; nutze sonst die Rückerstattung.`, "BELOW_COLLECTED");
    if (cents === row.amount_cents) throw new FinanceError("Der neue Betrag entspricht dem bisherigen Betrag.", "NO_CHANGE");
    const remaining = cents - settled;
    const status = remaining === 0 ? "paid" : settled > 0 ? "partial" : "open";
    const ts = now();
    db.prepare("UPDATE sanctions SET amount_cents=?,remaining_cents=?,status=?,updated_at=? WHERE id=? AND status<>'void'").run(cents, remaining, status, ts, sanctionId);
    recordChange(row, actorId, "corrected", { newAmount: cents, newRemaining: remaining, reason: reason.trim(), ts });
    audit(db, guildId, actorId, "sanction.corrected", row.user_id, { sanctionId, oldAmountCents: row.amount_cents, newAmountCents: cents, remainingCents: remaining, status, reason: reason.trim() });
    return db.prepare("SELECT * FROM sanctions WHERE id=?").get(sanctionId);
  });

  /** Nicht-monetäre Verwarnung (siehe services/warnings.js). Beeinflusst die Geldverrechnung nie. */
  const warn = (input) => {
    try { return warnings.add(input).id; }
    catch (error) { throw error instanceof WarningError ? new FinanceError(error.message, error.code) : error; }
  };

  /** Sanktionsübersicht mit offenen, verrechneten und erstatteten Beträgen. */
  function sanctionDetails(guildId, userId, { limit = 15 } = {}) {
    return db.prepare(`SELECT s.*, COALESCE((SELECT SUM(amount_cents) FROM payout_allocations p WHERE p.sanction_id=s.id),0) AS collected_cents,
      COALESCE((SELECT SUM(amount_cents) FROM sanction_refunds r WHERE r.sanction_id=s.id),0) AS refunded_cents
      FROM sanctions s WHERE s.guild_id=? AND s.user_id=? ORDER BY s.created_at DESC LIMIT ?`).all(guildId, userId, limit);
  }

  return {
    balance, openSanctionTotal, previewPayout, sanctionDetails, openAccount,
    credit: withFailureAudit("credit", credit),
    correction: withFailureAudit("correction", correction),
    sanction, warn,
    payout: withFailureAudit("payout", payout),
    voidSanction, correctSanction,
    refundSanction: withFailureAudit("sanction_refund", refundSanction),
  };
}

export const formatMoney = (cents) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const parseMoney = (value) => {
  const match = /^(\d{1,12})(?:[,.](\d{1,2}))?$/.exec(String(value ?? "").trim().replace(/^\$/, ""));
  if (!match) throw new Error("Betrag bitte als positive Zahl eingeben (z. B. 2500000 oder 12,50).");
  const cents=Number(match[1])*100+Number((match[2]??"").padEnd(2,"0"));
  if (!amount(cents)) throw new Error("Betrag muss größer als 0 sein.");
  return cents;
};
