import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance, formatMoney } from "../src/services/finance.js";
import { initializeSchema } from "../src/database.js";

const ctx = () => { const db = testDb(); return { db, finance: createFinance(db), g: "guild", user: "member", staff: "staff" }; };
const credit = (x, cents, key = `c-${Math.random()}`) => x.finance.credit({ guildId: x.g, userId: x.user, actorId: x.staff, cents, reason: "Event", key });
const sanction = (x, cents) => x.finance.sanction({ guildId: x.g, userId: x.user, actorId: x.staff, cents, reason: "Verstoß" });
const payout = (x, key, extra = {}) => x.finance.payout({ guildId: x.g, userId: x.user, actorId: x.staff, key, ...extra });
const sanctionRow = (x, id) => ({ ...x.db.prepare("SELECT status,remaining_cents,amount_cents FROM sanctions WHERE id=?").get(id) });

test("Beispiel aus der Vorgabe: 2.500.000 brutto, 500.000 Sanktion, 2.000.000 netto", () => {
  const x = ctx();
  credit(x, 250_000_000); sanction(x, 50_000_000);
  const plan = x.finance.previewPayout(x.g, x.user);
  assert.deepEqual({ gross: plan.gross, open: plan.openCents, deduction: plan.deduction, net: plan.net, rest: plan.remainingAfter }, { gross: 250_000_000, open: 50_000_000, deduction: 50_000_000, net: 200_000_000, rest: 0 });
  assert.equal(formatMoney(plan.gross), "$2.500.000,00");
  const tx = payout(x, "p1", { expectedGross: plan.gross, expectedDeduction: plan.deduction });
  assert.equal(tx.net_cents, 200_000_000);
});

test("mehrere Sanktionen werden FIFO verrechnet; nur der Rest bleibt offen", () => {
  const x = ctx();
  const first = sanction(x, 3000); const second = sanction(x, 5000);
  credit(x, 6000);
  const tx = payout(x, "p");
  assert.equal(tx.deduction_cents, 6000); assert.equal(tx.net_cents, 0);
  assert.deepEqual(sanctionRow(x, first), { status: "paid", remaining_cents: 0, amount_cents: 3000 });
  assert.deepEqual(sanctionRow(x, second), { status: "partial", remaining_cents: 2000, amount_cents: 5000 });
  const allocations = x.db.prepare("SELECT sanction_id,amount_cents FROM payout_allocations WHERE payout_id=? ORDER BY rowid").all(tx.id).map(r => ({ ...r }));
  assert.deepEqual(allocations, [{ sanction_id: first, amount_cents: 3000 }, { sanction_id: second, amount_cents: 3000 }]);
  // Beglichene Sanktion wird später nicht erneut abgezogen.
  credit(x, 10000);
  const next = payout(x, "p2");
  assert.equal(next.deduction_cents, 2000);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM payout_allocations WHERE sanction_id=?").get(first).n, 1);
  assert.equal(x.finance.openSanctionTotal(x.g, x.user), 0);
});

test("Gesamtverrechnung einer Sanktion übersteigt nie ihren Betrag", () => {
  const x = ctx();
  const id = sanction(x, 7000);
  for (let n = 0; n < 5; n++) { credit(x, 2000); payout(x, `p${n}`); }
  assert.equal(x.db.prepare("SELECT SUM(amount_cents) s FROM payout_allocations WHERE sanction_id=?").get(id).s, 7000);
  assert.equal(sanctionRow(x, id).status, "paid");
});

test("veraltete Vorschau bucht nichts und wird als fehlgeschlagener Versuch protokolliert", () => {
  const x = ctx();
  credit(x, 10000);
  const plan = x.finance.previewPayout(x.g, x.user);
  sanction(x, 4000);
  assert.throws(() => payout(x, "stale", { expectedGross: plan.gross, expectedDeduction: plan.deduction }), err => err.code === "PREVIEW_MISMATCH");
  assert.equal(x.finance.balance(x.g, x.user), 10000);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='payout'").get().n, 0);
  const failed = x.db.prepare("SELECT details FROM audit_logs WHERE action='finance.failed'").get();
  assert.match(failed.details, /PREVIEW_MISMATCH/);
});

test("zweiter Klick mit neuer Interaktions-ID nach erfolgter Auszahlung bucht nicht erneut", () => {
  const x = ctx();
  credit(x, 5000); sanction(x, 1000);
  payout(x, "click-1");
  assert.throws(() => payout(x, "click-2"), err => err.code === "NO_BALANCE");
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='payout'").get().n, 1);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM payout_allocations").get().n, 1);
});

test("Sanktion höher als Guthaben: Auszahlung 0 mit dokumentierter Verrechnung", () => {
  const x = ctx();
  credit(x, 1000); const id = sanction(x, 2500);
  const tx = payout(x, "zero");
  assert.deepEqual([tx.gross_cents, tx.deduction_cents, tx.net_cents], [1000, 1000, 0]);
  assert.deepEqual(sanctionRow(x, id), { status: "partial", remaining_cents: 1500, amount_cents: 2500 });
  assert.equal(x.db.prepare("SELECT change_type FROM sanction_changes WHERE sanction_id=? ORDER BY created_at DESC,rowid DESC").get(id).change_type, "allocated");
});

test("Sanktionen und Verwarnungen belasten das Konto nie sofort", () => {
  const x = ctx();
  credit(x, 9000); sanction(x, 4000);
  x.finance.warn({ guildId: x.g, userId: x.user, actorId: x.staff, reason: "Hinweis" });
  assert.equal(x.finance.balance(x.g, x.user), 9000);
  assert.equal(x.finance.previewPayout(x.g, x.user).deduction, 4000);
});

test("aufgehobene Sanktion wird später nicht abgezogen", () => {
  const x = ctx();
  const id = sanction(x, 4000);
  x.finance.voidSanction({ guildId: x.g, sanctionId: id, actorId: x.staff, reason: "Irrtum" });
  credit(x, 5000);
  assert.equal(payout(x, "after-void").deduction_cents, 0);
  assert.deepEqual(x.db.prepare("SELECT change_type FROM sanction_changes WHERE sanction_id=? ORDER BY rowid").all(id).map(r => r.change_type), ["created", "voided"]);
});

test("Sanktionskorrektur respektiert bereits verrechnete Beträge", () => {
  const x = ctx();
  const id = sanction(x, 6000); credit(x, 2000); payout(x, "p");
  assert.throws(() => x.finance.correctSanction({ guildId: x.g, sanctionId: id, actorId: x.staff, cents: 1000, reason: "zu hoch" }), /bereits/);
  assert.deepEqual(sanctionRow(x, id), { status: "partial", remaining_cents: 4000, amount_cents: 6000 });
  x.finance.correctSanction({ guildId: x.g, sanctionId: id, actorId: x.staff, cents: 2000, reason: "reduziert" });
  assert.deepEqual(sanctionRow(x, id), { status: "paid", remaining_cents: 0, amount_cents: 2000 });
  x.finance.correctSanction({ guildId: x.g, sanctionId: id, actorId: x.staff, cents: 3000, reason: "nachträglich erhöht" });
  assert.deepEqual(sanctionRow(x, id), { status: "partial", remaining_cents: 1000, amount_cents: 3000 });
});

test("Korrekturbuchung kann Guthaben nicht negativ machen und ist idempotent", () => {
  const x = ctx();
  credit(x, 1000);
  assert.throws(() => x.finance.correction({ guildId: x.g, userId: x.user, actorId: x.staff, cents: 2000, direction: "debit", reason: "Fehler", key: "k1" }), err => err.code === "INSUFFICIENT_BALANCE");
  assert.equal(x.finance.balance(x.g, x.user), 1000);
  const a = x.finance.correction({ guildId: x.g, userId: x.user, actorId: x.staff, cents: 500, direction: "debit", reason: "Fehler", key: "k2" });
  const b = x.finance.correction({ guildId: x.g, userId: x.user, actorId: x.staff, cents: 500, direction: "debit", reason: "Fehler", key: "k2" });
  assert.equal(a.id, b.id); assert.equal(x.finance.balance(x.g, x.user), 500);
  assert.equal(a.type, "correction_debit");
});

test("Transaktionen, Verrechnungen und Audit-Logs sind unveränderlich", () => {
  const x = ctx();
  credit(x, 1000);
  assert.throws(() => x.db.prepare("UPDATE transactions SET amount_cents=1").run(), /unveränderlich/);
  assert.throws(() => x.db.prepare("DELETE FROM transactions").run(), /gelöscht/);
  assert.throws(() => x.db.prepare("DELETE FROM audit_logs").run(), /gelöscht/);
});

test("ein Fehler beim Sanktionsupdate rollt Auszahlung, Guthaben und Allocation zurück", () => {
  const x = ctx();
  credit(x, 5000); const id = sanction(x, 2000);
  x.db.exec("CREATE TRIGGER fail_sanction BEFORE UPDATE OF remaining_cents ON sanctions BEGIN SELECT RAISE(ABORT,'forced'); END;");
  assert.throws(() => payout(x, "boom"), /forced/);
  assert.equal(x.finance.balance(x.g, x.user), 5000);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM payout_allocations").get().n, 0);
  assert.deepEqual(sanctionRow(x, id), { status: "open", remaining_cents: 2000, amount_cents: 2000 });
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='finance.failed'").get().n, 1);
  x.db.exec("DROP TRIGGER fail_sanction");
  assert.equal(payout(x, "boom").deduction_cents, 2000, "derselbe Vorgang ist nach dem Fehler sicher wiederholbar");
});

test("Migrationen sind wiederholbar und alte Datenbanken erhalten Version 2", () => {
  const db = testDb();
  initializeSchema(db); initializeSchema(db);
  assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(r => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  db.exec("DELETE FROM schema_migrations WHERE version=2; DROP TABLE sanction_changes;");
  initializeSchema(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='sanction_changes'").get());
  assert.ok(db.prepare("PRAGMA table_info(giveaways)").all().some(c => c.name === "required_role_id"));
});
