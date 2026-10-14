import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { createAccountClosureService } from "../src/services/account-closures.js";

const ctx = () => {
  const db = testDb(), finance = createFinance(db);
  const x = { db, finance, closures: createAccountClosureService(db, finance), g: "guild", user: "member", staff: "staff" };
  finance.openAccount({ guildId: x.g, userId: x.user, actorId: "bot", note: "Test" });
  return x;
};

test("Löschanfrage entsteht nur einmal und nur mit Konto", () => {
  const x = ctx();
  assert.ok(x.closures.request({ guildId: x.g, userId: x.user, reason: "role_removed" }));
  assert.equal(x.closures.request({ guildId: x.g, userId: x.user, reason: "left" }), null);
  assert.equal(x.closures.request({ guildId: x.g, userId: "ohne-konto", reason: "left" }), null);
  assert.equal(x.closures.pending(x.g).length, 1);
});

test("Bestätigen löscht das Konto, bucht Restguthaben aus und hebt offene Sanktionen auf", () => {
  const x = ctx();
  x.finance.credit({ guildId: x.g, userId: x.user, actorId: x.staff, cents: 5000, reason: "Event", key: "c1" });
  const sanctionId = x.finance.sanction({ guildId: x.g, userId: x.user, actorId: x.staff, cents: 2000, reason: "Verstoß" });
  const req = x.closures.request({ guildId: x.g, userId: x.user, reason: "left" });
  const result = x.closures.confirm({ guildId: x.g, id: req.id, actorId: x.staff });
  assert.deepEqual({ balance: result.balance, voided: result.voidedSanctions }, { balance: 5000, voided: 1 });
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM accounts WHERE user_id=?").get(x.user).n, 0);
  assert.equal(x.db.prepare("SELECT status FROM sanctions WHERE id=?").get(typeof sanctionId === "string" ? sanctionId : sanctionId.id).status, "void");
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='correction_debit' AND user_id=?").get(x.user).n, 1);
  assert.equal(x.closures.get(x.g, req.id).status, "confirmed");
  assert.throws(() => x.closures.confirm({ guildId: x.g, id: req.id, actorId: x.staff }), /bereits bearbeitet/);
});

test("Konto behalten schließt die Anfrage ohne Änderung; ohne sicheren Rollenstand wird nicht erneut gefragt", () => {
  const x = ctx();
  const req = x.closures.request({ guildId: x.g, userId: x.user, reason: "role_removed" });
  x.closures.dismiss({ guildId: x.g, id: req.id, actorId: x.staff });
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM accounts WHERE user_id=?").get(x.user).n, 1);
  assert.equal(x.closures.request({ guildId: x.g, userId: x.user, reason: "role_removed", definite: false }), null);
  assert.ok(x.closures.request({ guildId: x.g, userId: x.user, reason: "left" }));
});

test("Rolle zurückerhalten schließt offene Anfragen automatisch", () => {
  const x = ctx();
  x.closures.request({ guildId: x.g, userId: x.user, reason: "role_removed" });
  assert.equal(x.closures.resolveRejoined({ guildId: x.g, userId: x.user }), 1);
  assert.equal(x.closures.pending(x.g).length, 0);
  assert.ok(x.closures.request({ guildId: x.g, userId: x.user, reason: "role_removed", definite: false }));
});
