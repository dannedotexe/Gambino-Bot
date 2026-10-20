import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { testDb } from "./helpers.js";
import { buildLogbookContent, ensureLogbook, renameLogbook } from "../src/logbooks.js";

const G = "10000000000000001", U = "30000000000000001", FORUM = "60000000000000051";
const TEMPLATE = "📋 **Aufgaben Logs:**\n**Titel des eigenem Logbuch:** `Daniel Dachsberg | 237407`\n\n• **Invite Log** → `25k`\n\n> ⚠️ **Wichtig:**\n> Falls das nicht zusehen ist gilt der Log als **ungültig**.";

function forumMock(threads = []) {
  const created = [];
  const all = [{ id: "t0", name: "Vorlage + Info:", parentId: FORUM, fetchStarterMessage: async () => ({ content: TEMPLATE }) }, ...threads];
  const forum = { id: FORUM, type: ChannelType.GuildForum, flags: { has: () => false }, availableTags: [],
    threads: { fetchActive: async () => ({ threads: new Map(all.map(t => [t.id, t])) }), fetchArchived: async () => ({ threads: new Map() }),
      create: async opts => { const t = { id: `n${created.length}`, name: opts.name, setName: async n => { t.name = n; } }; created.push({ opts, t }); return t; } } };
  const client = { user: { id: "bot" }, channels: { fetch: async id => (id === FORUM ? forum : created.find(c => c.t.id === id)?.t ?? null) } };
  return { forum, client, created };
}
const member = (name = "Tony Soprano | 123456") => ({ id: U, displayName: name, user: { bot: false }, guild: { id: G } });

test("Vorlage: eigener Titel in der Titel-Zeile, Erwähnung ganz unten außerhalb des Zitats", () => {
  const text = buildLogbookContent(TEMPLATE, "Tony Soprano | 123456", U);
  assert.match(text, /\*\*Titel des eigenem Logbuch:\*\* `Tony Soprano \| 123456`/);
  assert.ok(text.endsWith(`ungültig**.\n\n<@${U}>`), "nicht im Zitat-Strich");
});

test("Logbuch wird mit Vorlage aus dem Forum angelegt – genau einmal, Person wird markiert", async () => {
  const db = testDb(), m = forumMock(), config = { DISCORD_GUILD_ID: G, CHANNEL_TASK_FORUM: FORUM };
  db.prepare("INSERT INTO member_verifications(guild_id,user_id,ingame_id,first_name,last_name,nickname,verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(G, U, "123456", "Tony", "Soprano", "Tony Soprano | 123456", "x", "x");
  const [a, b] = await Promise.all([ensureLogbook({ db, client: m.client, config, member: member("tony") }), ensureLogbook({ db, client: m.client, config, member: member("tony") })]);
  assert.deepEqual([a.status, b.status].sort(), ["created", "existing"]);
  assert.equal(m.created.length, 1);
  const { opts } = m.created[0];
  assert.equal(opts.name, "Tony Soprano | 123456", "Titel aus der Verifizierung");
  assert.match(opts.message.content, /`Tony Soprano \| 123456`/);
  assert.ok(opts.message.content.endsWith(`\n\n<@${U}>`));
  assert.deepEqual(opts.message.allowedMentions, { users: [U] });
  assert.equal((await ensureLogbook({ db, client: m.client, config, member: member() })).status, "existing");
});

test("Bestehender Post mit gleicher ID wird übernommen statt doppelt angelegt; Umbenennung nach Verifizierung", async () => {
  const db = testDb(), m = forumMock([{ id: "t9", name: "Tony Soprano | 123456", parentId: FORUM }]), config = { DISCORD_GUILD_ID: G, CHANNEL_TASK_FORUM: FORUM };
  const r = await ensureLogbook({ db, client: m.client, config, member: member("T. Soprano | 123456") });
  assert.equal(r.status, "existing"); assert.equal(r.threadId, "t9"); assert.equal(m.created.length, 0);
  const db2 = testDb(), m2 = forumMock();
  await ensureLogbook({ db: db2, client: m2.client, config, member: member("tony") });
  assert.equal(await renameLogbook({ db: db2, client: m2.client, guildId: G, userId: U, title: "Tony Soprano | 123456" }), true);
  assert.equal(m2.created[0].t.name, "Tony Soprano | 123456");
  assert.equal((await ensureLogbook({ db: testDb(), client: m.client, config: { DISCORD_GUILD_ID: G }, member: member() })).status, "skipped", "ohne Forum passiert nichts");
});

test("Status nennt fehlende Bot-Rechte; „Fehlende anlegen“ legt für alle Familienmitglieder ohne Logbuch an", async () => {
  const { createMissingLogbooks, logbookStatus } = await import("../src/logbooks.js");
  const db = testDb(), m = forumMock([{ id: "t9", name: "Paulie Walnuts | 222222", parentId: FORUM }]);
  const FAM = "20000000000000005", A = "30000000000000011", B = "30000000000000012", C = "30000000000000013";
  const mk = (id, name, roles) => ({ id, displayName: name, user: { bot: false }, guild: { id: G }, roles: { cache: new Map(roles.map(r => [r, true])) } });
  const members = new Map([[A, mk(A, "Tony Soprano | 111111", [FAM])], [B, mk(B, "Paulie Walnuts | 222222", [FAM])], [C, mk(C, "Gast", [])]]);
  let allowed = false;
  m.forum.permissionsFor = () => ({ has: () => allowed });
  const guild = { id: G, members: { me: { id: "bot" }, fetch: async () => members, cache: members } };
  const config = { DISCORD_GUILD_ID: G, CHANNEL_TASK_FORUM: FORUM, ROLE_MEMBERS: [FAM], LOGBOOK_AUTO_CREATE: true };
  let status = await logbookStatus({ db, client: m.client, config, guild });
  assert.match(status.problems[0], /Beiträge erstellen/);
  assert.equal(status.family, 2); assert.equal(status.missing.length, 2);
  allowed = true;
  status = await logbookStatus({ db, client: m.client, config, guild });
  assert.deepEqual(status.problems, []);
  const r = await createMissingLogbooks({ db, client: m.client, config, guild, actorId: "x", pauseMs: 0 });
  assert.deepEqual([r.created, r.linked, r.failed], [1, 1, 0], "Tony neu, Paulie verknüpft, Gast ignoriert");
  assert.equal((await logbookStatus({ db, client: m.client, config, guild })).missing.length, 0);
});

test("Bestehende Bot-Posts: Markierung wird aus dem Zitat nach unten verschoben", async () => {
  const { fixLogbookMentions } = await import("../src/logbooks.js");
  const db = testDb(), edits = [];
  db.prepare("INSERT INTO logbooks(guild_id,user_id,thread_id,title,source,created_at) VALUES(?,?,?,?,'created','x')").run(G, U, "t1", "Tony");
  const starter = { author: { id: "bot" }, editable: true, content: `> Wichtig\n> <@${U}>`, edit: async p => edits.push(p) };
  const client = { user: { id: "bot" }, channels: { fetch: async () => ({ fetchStarterMessage: async () => starter }) } };
  assert.equal(await fixLogbookMentions({ db, client, guildId: G }), 1);
  assert.equal(edits[0].content, `> Wichtig\n\n<@${U}>`);
});

test("Archivieren beim Verlassen, wieder öffnen bei Rückkehr", async () => {
  const { archiveLogbook, reopenLogbook } = await import("../src/logbooks.js");
  const db = testDb(), calls = [];
  db.prepare("INSERT INTO logbooks(guild_id,user_id,thread_id,title,source,created_at) VALUES(?,?,?,?,'created','x')").run(G, U, "t1", "Tony");
  const thread = { setLocked: async v => calls.push(`lock:${v}`), setArchived: async v => calls.push(`archive:${v}`) };
  const client = { user: { id: "bot" }, channels: { fetch: async () => thread } };
  assert.equal(await archiveLogbook({ db, client, guildId: G, userId: U }), true);
  assert.equal(await archiveLogbook({ db, client, guildId: G, userId: U }), false, "nur einmal");
  assert.ok(db.prepare("SELECT archived_at FROM logbooks").get().archived_at);
  assert.equal(await reopenLogbook({ db, client, guildId: G, userId: U }), true);
  assert.deepEqual(calls, ["lock:true", "archive:true", "archive:false", "lock:false"]);
  assert.equal(db.prepare("SELECT archived_at FROM logbooks").get().archived_at, null);
});

test("Erinnerung: einmal nach X Tagen ohne Log, nicht bei Abgemeldeten, neu nach dem nächsten Log", async () => {
  const { remindInactiveLogbooks } = await import("../src/logbooks.js");
  const db = testDb(), FAM = "20000000000000005", B = "30000000000000002", dms = [];
  const mk = id => ({ id, user: { bot: false }, roles: { cache: new Map([[FAM, true]]) }, send: async p => dms.push([id, p]) });
  const members = new Map([[U, mk(U)], [B, mk(B)]]);
  const guild = { id: G, members: { fetch: async () => members, cache: members } };
  const client = { user: { id: "bot" }, guilds: { cache: new Map([[G, guild]]) } };
  const config = { DISCORD_GUILD_ID: G, CHANNEL_TASK_FORUM: FORUM, ROLE_MEMBERS: [FAM], LOGBOOK_REMIND_DAYS: 7, TIMEZONE: "Europe/Vienna" };
  for (const id of [U, B]) db.prepare("INSERT INTO logbooks(guild_id,user_id,thread_id,title,source,created_at) VALUES(?,?,?,?,'created',?)").run(G, id, `t${id}`, id, "2026-10-01T10:00:00.000Z");
  db.prepare("INSERT INTO member_absences(id,guild_id,user_id,starts_on,ends_on,reason,created_by,created_at) VALUES('a1',?,?,?,?,?,?,?)").run(G, B, "2026-10-15", "2026-10-30", "Urlaub", B, "x");
  assert.equal(await remindInactiveLogbooks({ db, client, config, reference: new Date("2026-10-20T18:00:00Z") }), 1);
  assert.equal(dms[0][0], U, "Abgemeldete werden nicht erinnert");
  assert.match(dms[0][1].embeds[0].data.description, new RegExp(`channels/${G}/t${U}`));
  assert.equal(await remindInactiveLogbooks({ db, client, config, reference: new Date("2026-10-21T18:00:00Z") }), 0, "nicht jeden Tag erneut");
});
