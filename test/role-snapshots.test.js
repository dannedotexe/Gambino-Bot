import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createRoleSnapshots, planRestore, restoreSnapshot, runDailySnapshot, takeSnapshot } from "../src/role-snapshots.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", A = "30000000000000001", B = "30000000000000002";
const R = { gambino: "50000000000000001", rang8: "50000000000000008", bot: "50000000000000099", boss: "50000000000000010" };

function fakeGuild(initial) {
  const roles = new Map([[G, { id: G, name: "@everyone", position: 0 }], [R.gambino, { id: R.gambino, name: "| Gambino", position: 1 }], [R.rang8, { id: R.rang8, name: "8 - Leaderschaft", position: 2 }], [R.boss, { id: R.boss, name: "10 - Boss", position: 9 }], [R.bot, { id: R.bot, name: "Bot", position: 5, managed: true }]]);
  const state = new Map(Object.entries(initial).map(([id, list]) => [id, new Set(list)]));
  const member = id => ({ id, user: { bot: false }, roles: {
    get cache() { return new Map([...state.get(id)].map(r => [r, roles.get(r)])); },
    add: async list => list.forEach(r => state.get(id).add(r)), remove: async list => list.forEach(r => state.get(id).delete(r)) } });
  const guild = { id: G, roles: { cache: roles, fetch: async () => roles }, members: { me: { roles: { highest: { position: 6 } } }, fetch: async id => id ? (state.has(id) ? member(id) : null) : new Map([...state.keys()].map(k => [k, member(k)])) } };
  return { guild, state };
}

test("Vorschau: nur fehlende Rollen, exakt auch entfernen; nicht vergebbare Rollen und Ausgetretene übersprungen", () => {
  const assignable = new Set([R.gambino, R.rang8]);
  const snapshot = { [A]: [R.gambino, R.rang8, R.boss], [B]: [R.gambino] };
  const current = { [A]: [R.gambino] };
  assert.deepEqual(planRestore({ snapshot, current, assignable }), { changes: [{ userId: A, add: [R.rang8], remove: [] }], missing: [B] });
  const exact = planRestore({ snapshot: { [A]: [R.gambino] }, current: { [A]: [R.gambino, R.rang8] }, assignable, mode: "exact" });
  assert.deepEqual(exact.changes, [{ userId: A, add: [], remove: [R.rang8] }]);
});

test("Sichern und Wiederherstellen: Rang zurück, Stand davor gesichert, täglich nur einmal", async () => {
  const db = testDb(), config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G });
  const { guild, state } = fakeGuild({ [A]: [R.gambino, R.rang8, R.bot], [B]: [R.gambino] });
  const client = { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, user: { id: "bot" } };
  const snap = await takeSnapshot({ db, client, config, actorId: A });
  assert.equal(snap.members, 2);
  assert.deepEqual(createRoleSnapshots(db).get(G, snap.id).data.members[A], [R.gambino, R.rang8].sort(), "verwaltete Bot-Rolle nicht gesichert");
  state.get(A).delete(R.rang8); state.get(A).delete(R.gambino); state.get(B).add(R.rang8);
  const preview = await restoreSnapshot({ db, client, config, snapshotId: snap.id, actorId: A });
  assert.deepEqual(preview.changes.map(c => [c.userId, c.addNames]), [[A, ["| Gambino", "8 - Leaderschaft"]]]);
  const done = await restoreSnapshot({ db, client, config, snapshotId: snap.id, mode: "exact", actorId: A, dryRun: false });
  assert.equal(done.ok, 2);
  assert.ok(state.get(A).has(R.rang8) && !state.get(B).has(R.rang8));
  assert.ok(createRoleSnapshots(db).list(G).some(s => s.kind === "before_restore"));
  const ref = new Date("2026-10-15T08:00:00Z");
  assert.ok(await runDailySnapshot({ db, client, config, reference: ref }));
  assert.equal(await runDailySnapshot({ db, client, config, reference: new Date(ref.getTime() + 3_600_000) }), null);
});
