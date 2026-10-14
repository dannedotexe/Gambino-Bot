import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { closeDuePolls, createPollService, pollPayload, validatePoll } from "../src/polls.js";
import { createHandler } from "../src/commands.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { toCsv } from "../src/csv-export.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", TZ = "Europe/Vienna", CH = "50000000000000001";
const ROLE = { leaders: "20000000000000001", staff: "20000000000000002", finance: "20000000000000003", family: "20000000000000004" };
const STAFF = "30000000000000001", A = "30000000000000002", B = "30000000000000003";
const config = () => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_LEADERS: ROLE.leaders, ROLE_STAFF: ROLE.staff, ROLE_FINANCE: ROLE.finance, CHANNEL_POLLS: CH });

function fakeClient() {
  const sent = [], edits = [], replies = [];
  const message = { id: "m1", edit: async p => { edits.push(p); }, reply: async p => { replies.push(p); } };
  const channel = { id: CH, isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: () => true }), send: async p => { sent.push(p); return message; }, messages: { fetch: async () => message } };
  const guild = { id: G, members: { me: {}, cache: new Map(), fetch: async () => null }, channels: { fetch: async () => channel }, roles: { fetch: async id => ({ id }) } };
  return { sent, edits, replies, client: { channels: { fetch: async () => channel }, guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { fetch: async () => null }, ws: { ping: 1 }, user: { id: "bot" } } };
}

test("Abstimmung: Prüfung, eine Stimme pro Person, ändern/zurückziehen, anonym", () => {
  assert.throws(() => validatePoll({ question: "Wann?", options: "Nur eine", channelId: CH, hours: 24 }), /mindestens 2/);
  assert.throws(() => validatePoll({ question: "Wann?", options: "A;a", channelId: CH, hours: 24 }), /nur einmal/);
  assert.throws(() => validatePoll({ question: "Wann?", options: "A;B", channelId: CH, hours: 0.01 }), /5 Minuten/);
  assert.equal(validatePoll({ question: "Wann?", options: "A;B", channelId: CH, endsAt: "2026-10-20T18:00" }, { reference: new Date("2026-10-14T10:00:00Z"), timezone: TZ }).endsAt, "2026-10-20T16:00:00.000Z");
  const db = testDb(), polls = createPollService(db);
  const poll = polls.create({ guildId: G, actorId: STAFF, data: validatePoll({ question: "Treffen?", options: ["Fr", "Sa", "So"], channelId: CH, hours: 24, anonymous: true }) });
  assert.equal(polls.vote({ pollId: poll.id, userId: A, optionIndex: 0 }).status, "voted");
  assert.equal(polls.vote({ pollId: poll.id, userId: A, optionIndex: 0 }).status, "same");
  assert.equal(polls.vote({ pollId: poll.id, userId: A, optionIndex: 1 }).status, "changed");
  assert.equal(polls.vote({ pollId: poll.id, userId: B, optionIndex: 1 }).status, "voted");
  assert.equal(polls.vote({ pollId: poll.id, userId: B, optionIndex: 9 }).status, "invalid");
  assert.deepEqual(polls.results(poll.id), { counts: [0, 2, 0], total: 2 });
  assert.equal(polls.voters(poll.id), null, "anonym: niemand sieht Namen");
  assert.equal(polls.unvote({ pollId: poll.id, userId: B }).status, "removed");
  assert.equal(polls.results(poll.id).total, 1);
  assert.ok(polls.close({ guildId: G, id: poll.id }));
  assert.equal(polls.close({ guildId: G, id: poll.id }), null, "nur einmal");
  assert.equal(polls.vote({ pollId: poll.id, userId: B, optionIndex: 0 }).status, "closed");
});

test("Discord: Buttons, Zwischenstand verdeckt, Rollenbeschränkung, automatisches Ende mit Ergebnis", async () => {
  const db = testDb(), f = fakeClient(), cfg = config();
  const handler = createHandler({ db, finance: createFinance(db), config: cfg, client: f.client });
  const polls = createPollService(db);
  const poll = polls.create({ guildId: G, actorId: STAFF, data: validatePoll({ question: "Treffen?", options: "Fr;Sa", channelId: CH, hours: 1, hideResults: true, requiredRoleId: ROLE.family }) });
  polls.setMessage(poll.id, "m1");
  const payload = pollPayload(polls.byId(poll.id), polls.results(poll.id));
  assert.doesNotMatch(payload.embeds[0].data.description, /%/, "Zwischenstand verdeckt");
  assert.equal(payload.components.length, 2);
  const click = (userId, roles, customId) => { const replies = [], updates = [], follow = []; return { replies, updates, follow, customId, guildId: G, user: { id: userId }, member: { roles: { cache: new Map(roles.map(r => [r, true])) } }, inGuild: () => true, isButton: () => true, reply: async p => { replies.push(p); }, update: async p => { updates.push(p); }, followUp: async p => { follow.push(p); } }; };
  const outsider = click(A, [], `poll:vote:${poll.id}:0`);
  await handler.button(outsider);
  assert.match(JSON.stringify(outsider.replies[0]), /dürfen nur Mitglieder/);
  const member = click(A, [ROLE.family], `poll:vote:${poll.id}:1`);
  await handler.button(member);
  assert.equal(member.updates.length, 1); assert.match(JSON.stringify(member.follow[0]), /Deine Stimme/);
  assert.equal(polls.results(poll.id).counts[1], 1);
  assert.equal(await closeDuePolls({ db, client: f.client, reference: new Date(Date.now() + 2 * 3_600_000) }), 1);
  assert.match(f.replies[0].content, /Gewonnen hat \*\*Sa\*\*/);
  assert.equal(f.edits.at(-1).components.length, 0, "Buttons entfernt");
  assert.match(f.edits.at(-1).embeds[0].data.description, /100 %/, "am Ende sichtbar");
});

test("Website: Abstimmung starten und CSV-Export mit Rechten, BOM, Semikolon und Formelschutz", async () => {
  const db = testDb(), f = fakeClient(), cfg = config(), finance = createFinance(db);
  finance.credit({ guildId: G, userId: A, actorId: STAFF, cents: 250000050, reason: "=HYPERLINK(\"x\")", key: "k1" });
  finance.sanction({ guildId: G, userId: A, actorId: STAFF, cents: 10000, reason: "Zu spät; Funk aus" });
  const api = createDashboardApi({ db, client: f.client, config: cfg });
  const as = (...roles) => ({ id: STAFF, owner: false, roles: roles.map(r => ROLE[r]) });
  const get = (m, p) => api.get(m, new URL(p, "https://x"));
  const post = (m, p, b) => api.post(m, new URL(p, "https://x"), b);
  assert.equal((await post(as(), "/api/polls", { question: "Treffen?", options: ["Fr", "Sa"], hours: 24 })).status, 403);
  assert.equal((await post(as("staff"), "/api/polls", { question: "Treffen?", options: ["Fr", "Sa"], hours: 24 })).status, 200);
  assert.equal(f.sent.length, 1);
  assert.equal((await get(as("staff"), "/api/export/accounts.csv")).status, 403, "Konten nur mit Finanz-Einsicht");
  const accounts = await get(as("finance"), "/api/export/accounts.csv");
  assert.equal(accounts.status, 200);
  assert.equal(accounts.type, "text/csv; charset=utf-8");
  assert.match(accounts.headers["Content-Disposition"], /attachment; filename="gambinos-accounts-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.ok(accounts.body.startsWith("﻿Mitglied;Discord-ID;"));
  assert.match(accounts.body, /2500000,50/);
  const tx = (await get(as("finance"), "/api/export/transactions.csv")).body;
  assert.match(tx, /'=HYPERLINK/, "Formeln werden entschärft");
  const sanctions = (await get(as("staff"), "/api/export/sanctions.csv")).body;
  assert.match(sanctions, /"Zu spät; Funk aus"/);
  assert.equal((await get(as("staff"), "/api/export/unbekannt.csv")).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='admin.export'").get().n, 3);
  assert.equal(toCsv(["a", "b"], [["-5,50", "-A1"]]), "\uFEFFa;b\r\n-5,50;'-A1\r\n", "negative Zahlen bleiben Zahlen");
});
