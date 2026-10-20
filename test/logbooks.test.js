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

test("Vorlage: eigener Titel in der Titel-Zeile, Erwähnung ganz unten im Wichtig-Block", () => {
  const text = buildLogbookContent(TEMPLATE, "Tony Soprano | 123456", U);
  assert.match(text, /\*\*Titel des eigenem Logbuch:\*\* `Tony Soprano \| 123456`/);
  assert.ok(text.endsWith(`\n> <@${U}>`));
  assert.ok(buildLogbookContent("Hallo", "X", U).endsWith(`\n<@${U}>`), "ohne Zitat: Erwähnung als eigene Zeile");
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
  assert.ok(opts.message.content.endsWith(`> <@${U}>`));
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
