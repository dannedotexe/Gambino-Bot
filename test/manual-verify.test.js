import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { VerifyError, verifyMemberManually } from "../src/manual-verify.js";

const G = "10000000000000001", U = "30000000000000001", V = "30000000000000002", STAFF = "30000000000000009", VERIFIED = "20000000000000007";

test("Manuell verifizieren: Name, Rolle, Speicherung mit Staff als Auslöser, DM; ID-Konflikt und Fehler", async () => {
  const db = testDb(), dms = [], roles = new Set();
  const member = id => ({ id, user: { bot: false }, roles: { cache: roles, add: async r => roles.add(r) }, setNickname: async n => { member.last = n; }, send: async p => dms.push(p) });
  const guild = { id: G, ownerId: "1", members: { fetch: async id => (id === U || id === V ? member(id) : null) } };
  const client = { channels: { fetch: async () => null } };
  const config = { ROLE_VERIFIED: [VERIFIED] };
  const r = await verifyMemberManually({ db, client, config, guild, userId: U, input: { firstName: "tony", lastName: "soprano", ingameId: "#123" }, actorId: STAFF });
  assert.equal(r.data.nickname, "Tony Soprano | 123");
  assert.ok(roles.has(VERIFIED));
  assert.equal(db.prepare("SELECT nickname FROM member_verifications WHERE user_id=?").get(U).nickname, "Tony Soprano | 123");
  const log = db.prepare("SELECT actor_id,details FROM audit_logs WHERE action='member.verified'").get();
  assert.equal(log.actor_id, STAFF); assert.match(log.details, /"manual":true/);
  await new Promise(r => setTimeout(r, 5));
  assert.match(dms[0].embeds[0].data.title, /verifiziert/);
  await assert.rejects(verifyMemberManually({ db, client, config, guild, userId: V, input: { firstName: "Paulie", lastName: "Walnuts", ingameId: "123" }, actorId: STAFF }), e => e instanceof VerifyError && /bereits/.test(e.message), "ID gehört schon jemandem");
  await assert.rejects(verifyMemberManually({ db, client, config, guild, userId: "30000000000000099", input: { firstName: "Paulie", lastName: "Walnuts", ingameId: "456" }, actorId: STAFF }), /nicht \(mehr\) auf dem Server/);
  const again = await verifyMemberManually({ db, client, config, guild, userId: U, input: { firstName: "Tony", lastName: "Gambino", ingameId: "123" }, actorId: STAFF });
  assert.equal(again.before.nickname, "Tony Soprano | 123", "Umbenennen bei schon Verifizierten");
});
