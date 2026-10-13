import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { createFinance } from "../src/services/finance.js";
import { loadConfig } from "../src/config.js";

const GUILD = "10000000000000001";
const ROLE = { leaders: "20000000000000001", staff: "20000000000000002", finance: "20000000000000003", viewer: "20000000000000004", lead_ticket: "20000000000000005" };
const MEMBER = "30000000000000009", OTHER = "30000000000000008";

function setup() {
  const db = testDb();
  const config = loadConfig({
    DISCORD_TOKEN: "test-only", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: GUILD,
    ROLE_LEADERS: ROLE.leaders, ROLE_STAFF: ROLE.staff, ROLE_FINANCE: ROLE.finance, ROLE_FINANCE_VIEWERS: ROLE.viewer,
    TICKET_CATEGORIES_JSON: JSON.stringify([{ id: "support", label: "Support", roleIds: [] }, { id: "leitung", label: "Leitung", roleIds: [ROLE.lead_ticket] }]),
  });
  const people = new Map([[MEMBER, "Tony"], [OTHER, "Paulie"]]);
  const memberObj = id => (people.has(id) ? { id, displayName: people.get(id), user: { bot: false, username: people.get(id).toLowerCase() } } : null);
  const sent = [];
  const guild = {
    id: GUILD, memberCount: 2,
    members: { cache: new Map(), fetch: async arg => (typeof arg === "string" ? memberObj(arg) : new Map(arg.user.map(id => [id, memberObj(id)]).filter(([, m]) => m))), search: async () => new Map([...people.keys()].map(id => [id, memberObj(id)])) },
    channels: { fetch: async () => null },
    roles: { fetch: async () => new Map() },
  };
  const client = { guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild }, users: { fetch: async () => ({ send: async payload => sent.push(payload) }) } };
  const api = createDashboardApi({ db, client, config });
  const as = (...roles) => ({ id: "40000000000000001", displayName: "Staff", owner: false, roles: roles.map(r => ROLE[r]) });
  const get = (member, path) => api.get(member, new URL(path, "https://dash.example"));
  const post = (member, path, body = {}) => api.post(member, new URL(path, "https://dash.example"), body);
  return { db, finance: createFinance(db), api, as, get, post, sent };
}
const RID = "11111111-2222-4333-8444-555555555555";

test("Finanz-Einsicht darf sehen, aber nicht buchen", async () => {
  const x = setup();
  assert.equal((await x.get(x.as("viewer"), "/api/accounts")).status, 200);
  const credit = await x.post(x.as("viewer"), `/api/accounts/${MEMBER}/credit`, { amount: "100", reason: "Event", requestId: RID });
  assert.equal(credit.status, 403);
  assert.equal(x.finance.balance(GUILD, MEMBER), 0);
  assert.equal((await x.get(x.as("staff"), "/api/accounts")).status, 403);
});

test("Gutschrift über das Webdashboard ist gegen Doppelklick geschützt und zeigt Namen", async () => {
  const x = setup();
  const first = await x.post(x.as("finance"), `/api/accounts/${MEMBER}/credit`, { amount: "2500000", reason: "Event", requestId: RID });
  const second = await x.post(x.as("finance"), `/api/accounts/${MEMBER}/credit`, { amount: "2500000", reason: "Event", requestId: RID });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(x.finance.balance(GUILD, MEMBER), 250_000_000);
  assert.equal((await x.post(x.as("finance"), `/api/accounts/${MEMBER}/credit`, { amount: "abc", reason: "Event", requestId: RID })).status, 400);
  assert.equal((await x.post(x.as("finance"), `/api/accounts/${MEMBER}/credit`, { amount: "1", reason: "Event", requestId: "kein-uuid" })).status, 400);
  const list = await x.get(x.as("finance"), "/api/accounts");
  assert.equal(list.body.names[MEMBER], "Tony");
  assert.equal(list.body.accounts[0].gross, 250_000_000);
});

test("Web-Auszahlung: Vorschau, genau eine Buchung, veraltete Vorschau wird abgelehnt", async () => {
  const x = setup();
  x.finance.credit({ guildId: GUILD, userId: MEMBER, actorId: "s", cents: 250_000_000, reason: "Event", key: "seed" });
  x.finance.sanction({ guildId: GUILD, userId: MEMBER, actorId: "s", cents: 50_000_000, reason: "Verstoß" });
  const preview = await x.post(x.as("finance"), `/api/accounts/${MEMBER}/payout-preview`);
  assert.deepEqual([preview.body.plan.gross, preview.body.plan.deduction, preview.body.plan.net], [250_000_000, 50_000_000, 200_000_000]);
  const body = { requestId: preview.body.requestId, expectedGross: preview.body.plan.gross, expectedDeduction: preview.body.plan.deduction };
  const [a, b] = await Promise.all([x.post(x.as("finance"), `/api/accounts/${MEMBER}/payout`, body), x.post(x.as("finance"), `/api/accounts/${MEMBER}/payout`, body)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='payout'").get().n, 1);
  assert.equal(x.sent.length, 1);
  x.finance.credit({ guildId: GUILD, userId: MEMBER, actorId: "s", cents: 1000, reason: "Event", key: "seed2" });
  const stalePreview = await x.post(x.as("finance"), `/api/accounts/${MEMBER}/payout-preview`);
  x.finance.sanction({ guildId: GUILD, userId: MEMBER, actorId: "s", cents: 500, reason: "neu" });
  const stale = await x.post(x.as("finance"), `/api/accounts/${MEMBER}/payout`, { requestId: stalePreview.body.requestId, expectedGross: 1000, expectedDeduction: 0 });
  assert.equal(stale.status, 409);
  assert.equal(x.finance.balance(GUILD, MEMBER), 1000);
});

test("Sanktionen: Staff erstellt, nur Leitung hebt auf oder korrigiert", async () => {
  const x = setup();
  const created = await x.post(x.as("staff"), "/api/sanctions", { userId: MEMBER, amount: "500", reason: "Regelverstoß" });
  assert.equal(created.status, 200);
  assert.equal((await x.post(x.as("staff"), `/api/sanctions/${created.body.id}/void`, { reason: "Irrtum" })).status, 403);
  assert.equal((await x.post(x.as("leaders"), `/api/sanctions/${created.body.id}/correct`, { amount: "300", reason: "reduziert" })).status, 200);
  assert.equal((await x.post(x.as("leaders"), `/api/sanctions/${created.body.id}/void`, { reason: "Irrtum" })).status, 200);
  assert.equal(x.db.prepare("SELECT status FROM sanctions").get().status, "void");
  assert.equal((await x.post(x.as("staff"), "/api/sanctions", { userId: "123", amount: "5", reason: "xxx" })).status, 400);
  assert.equal((await x.post(x.as("staff"), "/api/warnings", { userId: MEMBER, reason: "Hinweis" })).status, 200);
  assert.equal(x.finance.balance(GUILD, MEMBER), 0);
});

test("Ticket-Kategorierollen sehen nur ihre Tickets; Protokoll blendet Finanzen ohne Recht aus", async () => {
  const x = setup(), now = new Date().toISOString();
  for (const [id, category] of [["t1", "support"], ["t2", "leitung"]]) x.db.prepare("INSERT INTO tickets(id,guild_id,channel_id,user_id,category,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(id, GUILD, `c-${id}`, MEMBER, category, now, now);
  const lead = await x.get(x.as("lead_ticket"), "/api/tickets?status=open");
  assert.deepEqual(lead.body.tickets.map(t => t.id), ["t2"]);
  assert.equal((await x.get(x.as("staff"), "/api/tickets")).body.tickets.length, 2);
  x.finance.credit({ guildId: GUILD, userId: MEMBER, actorId: "s", cents: 100, reason: "x", key: "k" });
  const staffAudit = await x.get(x.as("staff"), "/api/audit");
  assert.ok(!staffAudit.body.entries.some(e => e.action.startsWith("finance.")));
  assert.ok((await x.get(x.as("finance"), "/api/audit")).body.entries.some(e => e.action === "finance.credit"));
  assert.equal((await x.get({ id: "x", owner: false, roles: [] }, "/api/audit")).status, 403);
});

test("Giveaway vorzeitig auslosen und Event bearbeiten werden protokolliert", async () => {
  const x = setup(), now = new Date().toISOString(), later = new Date(Date.now() + 86_400_000).toISOString();
  x.db.prepare("INSERT INTO giveaways(id,guild_id,prize,ends_at,winner_count,conditions,status,created_by,created_at) VALUES('g1',?,'Auto',?,1,'','active','s',?)").run(GUILD, later, now);
  assert.equal((await x.post(x.as("staff"), "/api/giveaways/g1/draw")).status, 200);
  assert.ok(new Date(x.db.prepare("SELECT ends_at FROM giveaways WHERE id='g1'").get().ends_at) <= new Date());
  assert.equal((await x.post(x.as("staff"), "/api/giveaways/g1/cancel", {})).status, 200);
  assert.equal((await x.post(x.as("staff"), "/api/giveaways/g1/draw")).status, 409);
  x.db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES('e1',?,'Treffen','',?,'HQ','h','scheduled',?)").run(GUILD, later, now);
  assert.equal((await x.post(x.as("staff"), "/api/events/e1/update", { name: "Neu" })).status, 403);
  const updated = await x.post(x.as("leaders"), "/api/events/e1/update", { name: "Großes Treffen", maximum: 10 });
  assert.equal(updated.status, 200);
  assert.deepEqual({ ...x.db.prepare("SELECT name,max_participants FROM events WHERE id='e1'").get() }, { name: "Großes Treffen", max_participants: 10 });
  assert.equal((await x.post(x.as("leaders"), "/api/events/e1/attendance", { userId: MEMBER, status: "present" })).status, 200);
  const actions = x.db.prepare("SELECT action FROM audit_logs ORDER BY rowid").all().map(r => r.action);
  for (const action of ["giveaway.draw_requested", "giveaway.cancelled", "event.updated", "event.attendance"]) assert.ok(actions.includes(action), action);
});
