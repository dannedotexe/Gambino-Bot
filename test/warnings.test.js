import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { createWarningService, warnBlockReason, warningEscalation } from "../src/services/warnings.js";
import { createHandler } from "../src/commands.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { loadConfig } from "../src/config.js";

const GUILD = "10000000000000001";
const ROLE = { leaders: "20000000000000001", staff: "20000000000000002", mods: "20000000000000003", finance: "20000000000000004" };
const MOD = "30000000000000001", STAFF = "30000000000000002", LEADER = "30000000000000003", MEMBER = "30000000000000004";

function setup(extra = {}) {
  const db = testDb();
  const config = loadConfig({ DISCORD_TOKEN: "test-only", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: GUILD, ROLE_LEADERS: ROLE.leaders, ROLE_STAFF: ROLE.staff, ROLE_MODERATORS: ROLE.mods, ROLE_FINANCE: ROLE.finance, ...extra });
  const roleOf = { [MOD]: [ROLE.mods], [STAFF]: [ROLE.staff], [LEADER]: [ROLE.leaders], [MEMBER]: [] };
  const dms = [], timeouts = [], channelPosts = [];
  const guildMember = id => ({ id, user: { bot: false }, displayName: `User${id.slice(-1)}`, roles: { cache: new Map((roleOf[id] ?? []).map(r => [r, true])) }, moderatable: true, timeout: async (ms, reason) => { timeouts.push({ id, ms, reason }); } });
  const guild = { id: GUILD, members: { cache: new Map(), fetch: async id => (typeof id === "string" ? guildMember(id) : new Map()) }, channels: { fetch: async () => null }, roles: { fetch: async () => new Map() } };
  const client = {
    ws: { ping: 1 }, user: { id: "bot" }, guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild },
    users: { fetch: async id => ({ send: async payload => { dms.push({ id, payload }); } }) },
    channels: { fetch: async id => ({ id, send: async payload => { channelPosts.push(payload); } }) },
  };
  const handler = createHandler({ db, finance: createFinance(db), config, client });
  return { db, config, handler, dms, timeouts, channelPosts, guild, client, roleOf };
}

function interaction(x, { userId, command, options = {}, sub = null }) {
  const replies = [], edits = [];
  return {
    id: String(Math.random()), replies, edits, commandName: command, guildId: GUILD, guild: x.guild, user: { id: userId, bot: false },
    member: { roles: { cache: new Map((x.roleOf[userId] ?? []).map(r => [r, true])) } },
    inGuild: () => true, isChatInputCommand: () => true,
    options: {
      getSubcommand: () => sub,
      getUser: name => options[name] ? { id: options[name], bot: options[name] === "bot" } : null,
      getString: name => options[name] ?? null, getInteger: () => null,
    },
    reply: async payload => { replies.push(payload); return payload; },
    editReply: async payload => { edits.push(payload); return payload; },
  };
}
const text = payload => JSON.stringify(payload?.embeds?.map(e => e.data ?? e) ?? payload?.content);
const count = db => db.prepare("SELECT COUNT(*) n FROM member_warnings").get().n;

test("Schutzregeln: kein Selbst-Warn, keine Bots, Team nur durch Leitung", () => {
  assert.match(warnBlockReason({ actorId: "a", targetId: "a" }), /selbst/);
  assert.match(warnBlockReason({ actorId: "a", targetId: "b", targetIsBot: true }), /Bots/);
  assert.match(warnBlockReason({ actorId: "a", targetId: "b", targetRoleIds: ["s"], staffRoleIds: ["s"] }), /Leitung/);
  assert.equal(warnBlockReason({ actorId: "a", targetId: "b", targetRoleIds: ["s"], staffRoleIds: ["s"], actorIsLeader: true }), null);
  assert.deepEqual(warningEscalation({ WARN_TIMEOUT_AT: 3, WARN_ALERT_AT: 0 }, 3), { timeout: true, alert: false });
  assert.deepEqual(warningEscalation({ WARN_TIMEOUT_AT: 0, WARN_ALERT_AT: 5 }, 4), { timeout: false, alert: false });
});

test("Service: aktive Zählung, Ablauf und Rücknahme ohne Löschen", () => {
  const db = testDb(), w = createWarningService(db);
  const first = w.add({ guildId: GUILD, userId: MEMBER, actorId: MOD, reason: "Spam" });
  assert.equal(first.active, 1);
  db.prepare("UPDATE member_warnings SET created_at=? WHERE id=?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), first.id);
  const second = w.add({ guildId: GUILD, userId: MEMBER, actorId: MOD, reason: "Beleidigung", expireDays: 30 });
  assert.equal(second.active, 1, "abgelaufene Verwarnung zählt nicht");
  assert.equal(w.activeCount(GUILD, MEMBER), 2, "ohne Ablauf zählen beide");
  assert.deepEqual(w.list(GUILD, MEMBER, { expireDays: 30 }).map(r => r.state), ["active", "expired"]);
  assert.throws(() => w.revoke({ guildId: GUILD, warningId: second.id, actorId: MEMBER, reason: "eigene" }), /anderes/);
  w.revoke({ guildId: GUILD, warningId: second.id, actorId: STAFF, reason: "Irrtum" });
  assert.throws(() => w.revoke({ guildId: GUILD, warningId: second.id, actorId: STAFF, reason: "nochmal" }), /bereits/);
  assert.equal(w.activeCount(GUILD, MEMBER, { expireDays: 30 }), 0);
  assert.equal(count(db), 2, "nichts wird gelöscht");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='sanction.warning_revoked'").get().n, 1);
  assert.throws(() => w.add({ guildId: GUILD, userId: MEMBER, actorId: MOD, reason: "  " }), /Grund/);
});

test("/warn: Moderation darf verwarnen, Person bekommt DM, Konto bleibt unberührt", async () => {
  const x = setup();
  const i = interaction(x, { userId: MOD, command: "warn", options: { mitglied: MEMBER, grund: "Spam im Chat" } });
  await x.handler.command(i);
  assert.match(text(i.replies[0]), /Verwarnung eingetragen/);
  assert.equal(count(x.db), 1);
  assert.equal(x.dms.length, 1);
  assert.match(text(x.dms[0].payload), /Spam im Chat/);
  assert.match(text(i.edits[0]), /DM informiert/);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM transactions").get().n, 0);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM sanctions").get().n, 0);
});

test("/warn: normale Mitglieder, Selbst-Warn und Team-Verwarnung durch Moderation werden abgelehnt", async () => {
  const x = setup();
  for (const [userId, target, pattern] of [[MEMBER, MOD, /Moderations- oder Staff-Rolle/], [MOD, MOD, /selbst/], [MOD, STAFF, /Leitung/], [MOD, "bot", /Bots/]]) {
    const i = interaction(x, { userId, command: "warn", options: { mitglied: target, grund: "Test" } });
    await x.handler.command(i);
    assert.match(text(i.replies[0]), pattern);
  }
  assert.equal(count(x.db), 0);
  const leader = interaction(x, { userId: LEADER, command: "warn", options: { mitglied: STAFF, grund: "Teamregel" } });
  await x.handler.command(leader);
  assert.equal(count(x.db), 1);
});

test("Eskalation: Timeout und Leitungsmeldung ab Grenzwert", async () => {
  const x = setup({ WARN_TIMEOUT_AT: "2", WARN_TIMEOUT_MINUTES: "30", WARN_ALERT_AT: "3", CHANNEL_SANCTION_LOG: "50000000000000001" });
  for (let n = 1; n <= 3; n++) await x.handler.command(interaction(x, { userId: STAFF, command: "warn", options: { mitglied: MEMBER, grund: `Verstoß ${n}` } }));
  assert.equal(x.timeouts.length, 2, "Timeout ab der 2. Verwarnung");
  assert.equal(x.timeouts[0].ms, 30 * 60_000);
  assert.equal(x.channelPosts.length, 1, "Meldung ab der 3. Verwarnung");
  assert.match(x.channelPosts[0].content, new RegExp(ROLE.leaders));
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='sanction.warning_timeout'").get().n, 2);
});

test("/warnings und /unwarn: eigene Ansicht für alle, Rücknahme nur durch Moderation", async () => {
  const x = setup();
  await x.handler.command(interaction(x, { userId: MOD, command: "warn", options: { mitglied: MEMBER, grund: "Spam" } }));
  const id = x.db.prepare("SELECT id FROM member_warnings").get().id;
  const own = interaction(x, { userId: MEMBER, command: "warnings" });
  await x.handler.command(own);
  assert.match(text(own.replies[0]), /1 aktiv/);
  const foreign = interaction(x, { userId: MEMBER, command: "warnings", options: { mitglied: MOD } });
  await x.handler.command(foreign);
  assert.match(text(foreign.replies[0]), /Moderation/);
  const denied = interaction(x, { userId: MEMBER, command: "unwarn", options: { mitglied: MEMBER, warnung: id, grund: "bitte" } });
  await x.handler.command(denied);
  assert.match(text(denied.replies[0]), /Moderations- oder Staff-Rolle/);
  const ok = interaction(x, { userId: MOD, command: "unwarn", options: { mitglied: MEMBER, grund: "Missverständnis" } });
  await x.handler.command(ok);
  assert.match(text(ok.replies[0]), /zurückgenommen/);
  assert.ok(x.db.prepare("SELECT revoked_at FROM member_warnings WHERE id=?").get(id).revoked_at);
});

test("/sanktion verwarnung nutzt dasselbe System", async () => {
  const x = setup();
  const i = interaction(x, { userId: STAFF, command: "sanktion", sub: "verwarnung", options: { mitglied: MEMBER, grund: "Regel 3" } });
  await x.handler.command(i);
  assert.equal(count(x.db), 1);
  assert.equal(x.dms.length, 1);
});

test("Website: verwarnen und zurücknehmen mit Rechteprüfung", async () => {
  const x = setup();
  const api = createDashboardApi({ db: x.db, client: x.client, config: x.config });
  const as = (id, ...roles) => ({ id, displayName: "Web", owner: false, roles: roles.map(r => ROLE[r]) });
  const post = (member, path, body) => api.post(member, new URL(path, "https://dash.example"), body);
  assert.equal((await post(as(MEMBER, "finance"), "/api/warnings", { userId: MOD, reason: "Test" })).status, 403);
  assert.equal((await post(as(MOD, "mods"), "/api/warnings", { userId: STAFF, reason: "Teamregel" })).status, 403);
  const created = await post(as(MOD, "mods"), "/api/warnings", { userId: MEMBER, reason: "Spam im Chat" });
  assert.equal(created.status, 200);
  assert.match(created.body.message, /1 aktiv/);
  const list = await api.get(as(MOD, "mods"), new URL("/api/sanctions", "https://dash.example"));
  assert.equal(list.status, 200);
  const w = list.body.warnings[0];
  assert.equal(w.state, "active"); assert.equal(w.activeCount, 1);
  assert.equal((await post(as(LEADER, "leaders"), `/api/warnings/${w.id}/revoke`, { reason: "Irrtum" })).status, 200);
  assert.equal((await post(as(LEADER, "leaders"), `/api/warnings/${w.id}/revoke`, { reason: "Irrtum" })).status, 409);
});

test("/unwarn findet die Verwarnung auch ohne Auswahl, per Referenz oder Grund", async () => {
  const x = setup();
  for (const grund of ["Spam im Chat", "Beleidigung"]) await x.handler.command(interaction(x, { userId: MOD, command: "warn", options: { mitglied: MEMBER, grund } }));
  const rows = x.db.prepare("SELECT id,reason FROM member_warnings ORDER BY rowid").all();
  const typed = interaction(x, { userId: STAFF, command: "unwarn", options: { mitglied: MEMBER, warnung: "Tony", grund: "Test" } });
  await x.handler.command(typed);
  assert.match(text(typed.replies[0]), /nicht gefunden/, "eingetippter Name ohne Treffer");
  const byReason = interaction(x, { userId: STAFF, command: "unwarn", options: { mitglied: MEMBER, warnung: "spam", grund: "Irrtum" } });
  await x.handler.command(byReason);
  assert.ok(x.db.prepare("SELECT revoked_at FROM member_warnings WHERE id=?").get(rows[0].id).revoked_at);
  const byRef = interaction(x, { userId: STAFF, command: "unwarn", options: { mitglied: MEMBER, warnung: rows[1].id.slice(0, 8), grund: "Irrtum" } });
  await x.handler.command(byRef);
  assert.ok(x.db.prepare("SELECT revoked_at FROM member_warnings WHERE id=?").get(rows[1].id).revoked_at);
  const none = interaction(x, { userId: STAFF, command: "unwarn", options: { mitglied: MEMBER, grund: "nochmal" } });
  await x.handler.command(none);
  assert.match(text(none.replies[0]), /keine aktiven Verwarnungen/);
  const wrongPerson = interaction(x, { userId: STAFF, command: "unwarn", options: { mitglied: LEADER, warnung: rows[0].id, grund: "x y z" } });
  await x.handler.command(wrongPerson);
  assert.match(text(wrongPerson.replies[0]), /gehört nicht/);
});

test("/unwarn-Vorschläge zeigen die Verwarnungen des gewählten Mitglieds", async () => {
  const x = setup();
  await x.handler.command(interaction(x, { userId: MOD, command: "warn", options: { mitglied: MEMBER, grund: "Spam im Chat" } }));
  let choices = null;
  await x.handler.autocomplete({ guildId: GUILD, guild: x.guild, commandName: "unwarn", user: { id: STAFF }, member: { roles: { cache: new Map([[ROLE.staff, true]]) } }, inGuild: () => true,
    options: { getSubcommand: () => null, getFocused: () => ({ name: "warnung", value: "" }), get: name => name === "mitglied" ? { value: MEMBER } : null }, respond: async c => { choices = c; } });
  assert.equal(choices.length, 1);
  assert.match(choices[0].name, /Spam im Chat/);
});

test("Website: Verwarnung endgültig löschen nur durch die Leitung, Vorgang bleibt im Protokoll", async () => {
  const x = setup();
  const api = createDashboardApi({ db: x.db, client: x.client, config: x.config });
  const as = (id, ...roles) => ({ id, displayName: "Web", owner: false, roles: roles.map(r => ROLE[r]) });
  const post = (member, path, body) => api.post(member, new URL(path, "https://dash.example"), body);
  await post(as(MOD, "mods"), "/api/warnings", { userId: MEMBER, reason: "Testeintrag" });
  const id = x.db.prepare("SELECT id FROM member_warnings").get().id;
  assert.equal((await post(as(STAFF, "staff"), `/api/warnings/${id}/delete`, { reason: "Fehleintrag" })).status, 403);
  assert.equal((await post(as(LEADER, "leaders"), `/api/warnings/${id}/delete`, { reason: "" })).status, 400);
  const ok = await post(as(LEADER, "leaders"), `/api/warnings/${id}/delete`, { reason: "Fehleintrag" });
  assert.equal(ok.status, 200);
  assert.equal(count(x.db), 0);
  assert.match(x.db.prepare("SELECT details FROM audit_logs WHERE action='sanction.warning_deleted'").get().details, /Testeintrag/);
  assert.equal((await post(as(LEADER, "leaders"), `/api/warnings/${id}/delete`, { reason: "nochmal" })).status, 404);
});
