import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { canManageSignups, handleEventManageInteraction } from "../src/event-manage.js";

const G = "10000000000000001", A = "30000000000000001", B = "30000000000000002", C = "30000000000000003", TL = "50000000000000007", MEMBER = "50000000000000003", TEAM = "20000000000000004";
const roleNames = { [TL]: "| 7 - Turf Leader", [MEMBER]: "| 3 - Member", "50000000000000010": "| 10 - Boss" };
const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_EVENT_TEAM: TEAM }) };

test("Verwalten ab Turf Leader (Rang 7+), Event-Team immer, Member nicht", () => {
  const can = roles => canManageSignups(config, { userId: "1", roleIds: roles, roleName: id => roleNames[id] });
  assert.equal(can([TL]), true); assert.equal(can(["50000000000000010"]), true);
  assert.equal(can([MEMBER]), false); assert.equal(can([TEAM]), true); assert.equal(can([]), false);
  assert.equal(canManageSignups({ ...config, EVENT_MANAGE_MIN_RANK: 0 }, { userId: "1", roleIds: [TL], roleName: id => roleNames[id] }), false, "0 = nur Team");
});

test("Discord: Turf Leader nimmt jemanden raus (Nachrücker rückt nach) und trägt jemanden ein", async () => {
  const db = testDb(), dms = [];
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at,max_participants) VALUES('e1',?,'Bizwar','',?,'HQ','h','scheduled','x',1)").run(G, new Date(Date.now() + 3600e3).toISOString());
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e1',?,'signed_up','x')").run(A);
  db.prepare("INSERT INTO event_waitlist(event_id,user_id,created_at) VALUES('e1',?,'x')").run(B);
  const client = { channels: { fetch: async () => null }, users: { fetch: async id => ({ send: async p => dms.push([id, p.embeds[0].data.title]) }) } };
  const base = (customId, roles, extra = {}) => { const out = {}; return { out, customId, guildId: G, user: { id: "40000000000000001" }, client, member: { roles: { cache: new Map(roles.map(r => [r, true])) } }, guild: { roles: { cache: new Map(Object.entries(roleNames).map(([id, name]) => [id, { name }])) }, members: { cache: new Map() } }, reply: async p => { out.reply = p; }, update: async p => { out.update = p; }, ...extra }; };
  const member = base("evm:open:e1", [MEMBER]);
  await handleEventManageInteraction({ i: member, db, client, config });
  assert.match(member.out.reply.content, /nur Turf Leader/);
  const open = base("evm:open:e1", [TL]);
  await handleEventManageInteraction({ i: open, db, client, config });
  assert.match(open.out.reply.content, /Angemeldet \(1\/1\)/);
  const remove = base("evm:remove:e1", [TL], { values: [A] });
  await handleEventManageInteraction({ i: remove, db, client, config });
  assert.match(remove.out.update.content, /1 rausgenommen · 1 nachgerückt/);
  assert.deepEqual(db.prepare("SELECT user_id FROM event_participants WHERE event_id='e1' AND status='signed_up'").all().map(r => r.user_id), [B]);
  const add = base("evm:add:e1", [TL], { values: [C] });
  await handleEventManageInteraction({ i: add, db, client, config });
  assert.match(add.out.update.content, /0 eingetragen · 1 auf die Warteliste/, "voll → Warteliste");
  await new Promise(r => setTimeout(r, 10));
  assert.ok(dms.some(([id, t]) => id === A && /genommen/.test(t)), "Rausgenommener bekommt DM");
  assert.ok(dms.some(([id, t]) => id === B && /nachgerückt/.test(t)));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='event.participant_removed'").get().n, 1);
});
