import test from "node:test";
import assert from "node:assert/strict";
import { ensureFamilyRole, rankRoleIds, syncFamilyRoles } from "../src/family-role.js";

const FAM = "20000000000000005", BOSS = "50000000000000010", MEMBER = "50000000000000003", OTHER = "50000000000000099";
const guild = { roles: { cache: new Map([[BOSS, { id: BOSS, name: "| 10 - Boss" }], [MEMBER, { id: MEMBER, name: "| 3 - Member" }], ["s", { id: "s", name: "| 1 -Strafrang" }], [OTHER, { id: OTHER, name: "Gambino Helper" }], [FAM, { id: FAM, name: "| Gambino" }]]) } };
const member = roles => { const cache = new Set(roles), added = []; return { guild, user: { bot: false }, added, roles: { cache, add: async id => { added.push(id); cache.add(id); } } }; };
const config = { ROLE_MEMBERS: [FAM], FAMILY_ROLE_FROM_RANK: true, RANK_ROLES_JSON: [] };

test("Rang-Rollen werden am Namensschema „| 10 - Boss“ erkannt", () => {
  assert.deepEqual([...rankRoleIds(config, guild)].sort(), [MEMBER, BOSS, "s"].sort());
});

test("Rang-Rolle erhalten → Familienrolle; sonst nichts", async () => {
  const m = member([MEMBER]);
  assert.equal(await ensureFamilyRole({ config, member: m }), true);
  assert.deepEqual(m.added, [FAM]);
  assert.equal(await ensureFamilyRole({ config, member: m }), false, "schon da");
  const none = member([OTHER]);
  assert.equal(await ensureFamilyRole({ config, member: none }), false);
  const off = member([BOSS]);
  assert.equal(await ensureFamilyRole({ config: { ...config, FAMILY_ROLE_FROM_RANK: false }, member: off }), false);
  const bot = { ...member([BOSS]), user: { bot: true } };
  assert.equal(await ensureFamilyRole({ config, member: bot }), false);
});

test("Beim Start: fehlende Familienrollen nachziehen", async () => {
  const a = member([BOSS]), b = member([BOSS, FAM]), c = member([]);
  const r = await syncFamilyRoles({ config, guild: { ...guild, members: { cache: new Map([["a", a], ["b", b], ["c", c]]) } }, pauseMs: 0 });
  assert.deepEqual(r, { added: 1, failed: 0 });
  assert.deepEqual(a.added, [FAM]); assert.deepEqual(b.added, []); assert.deepEqual(c.added, []);
});
