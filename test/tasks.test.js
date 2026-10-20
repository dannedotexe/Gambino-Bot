import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { TaskError, createTaskService, levelFor, streakOf, weekStart } from "../src/services/tasks.js";
import { buildTaskBoard, handleTaskInteraction, refreshTaskBoard, submitTaskLog } from "../src/task-logs.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", U = "30000000000000001", R = "30000000000000002", FIN = "20000000000000003", REV = "20000000000000004", CH = "60000000000000041", BOARD = "60000000000000042";
const baseConfig = (extra = {}) => ({ ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_FINANCE: FIN, ROLE_TASK_REVIEWERS: REV }), ...extra });
const service = db => createTaskService(db, { timezone: "Europe/Vienna" });
const typeNamed = (db, name) => service(db).listTypes(G, { all: true }).find(t => t.name.startsWith(name));

test("Standard-Aufgaben werden genau einmal angelegt und nie wieder aufgefüllt", () => {
  const db = testDb(), tasks = service(db);
  const types = tasks.listTypes(G);
  assert.deepEqual(types.map(t => t.name), ["Invite – normales Mitglied", "Invite – guter Gambo", "Plantage", "Solar Panele"]);
  assert.equal(types[0].reward_cents, 2_500_000);
  db.prepare("DELETE FROM task_types").run();
  assert.equal(tasks.listTypes(G).length, 0, "gelöschte Vorlagen kommen nicht zurück");
});

test("Bestätigen bucht genau einmal; Menge korrigierbar; eigene Logs gesperrt", () => {
  const db = testDb(), tasks = service(db), finance = createFinance(db);
  const plantage = tasks.saveType(G, R, { id: typeNamed(db, "Plantage").id, name: "Plantage", emoji: "🌿", unit: "Ernte", rewardCents: 1_000_000, perUnit: true });
  const log = tasks.submit({ guildId: G, userId: U, typeId: plantage.id, quantity: 5 });
  assert.equal(log.reward_cents, 5_000_000);
  assert.throws(() => tasks.approve({ guildId: G, id: log.id, actorId: U, finance }), e => e instanceof TaskError && e.code === "SELF");
  const done = tasks.approve({ guildId: G, id: log.id, actorId: R, finance, quantity: 3 });
  assert.equal(done.status, "approved"); assert.equal(done.quantity, 3); assert.equal(done.reward_cents, 3_000_000);
  assert.equal(finance.balance(G, U), 3_000_000);
  assert.throws(() => tasks.approve({ guildId: G, id: log.id, actorId: R, finance }), e => e.code === "CONFLICT");
  assert.equal(finance.balance(G, U), 3_000_000, "kein zweites Mal gebucht");
  assert.match(db.prepare("SELECT reason FROM transactions WHERE idempotency_key=?").get(`task-log:${log.id}`).reason, /Plantage ×3 Ernte/);
  // Feste Belohnung ignoriert die Menge.
  const invite = tasks.submit({ guildId: G, userId: U, typeId: typeNamed(db, "Invite – normales").id, quantity: 7 });
  assert.equal(invite.quantity, 1); assert.equal(invite.reward_cents, 2_500_000);
  assert.throws(() => tasks.reject({ guildId: G, id: invite.id, actorId: R, reason: "x" }), /Grund/);
  assert.equal(tasks.reject({ guildId: G, id: invite.id, actorId: R, reason: "Uhrzeit fehlt" }).status, "rejected");
  assert.equal(finance.balance(G, U), 3_000_000);
});

test("Tageslimit und Erkennung doppelter Screenshots", () => {
  const db = testDb(), tasks = service(db);
  const solar = tasks.saveType(G, R, { id: typeNamed(db, "Solar").id, name: "Solar Panele", emoji: "☀️", unit: "Panel", rewardCents: 0, perUnit: true, dailyLimit: 2 });
  const day = new Date("2026-10-20T10:00:00Z");
  const first = tasks.submit({ guildId: G, userId: U, typeId: solar.id, proofKey: "1920x1080:5000", reference: day });
  assert.equal(first.duplicate_of, null);
  const second = tasks.submit({ guildId: G, userId: R, typeId: solar.id, proofKey: "1920x1080:5000", reference: day });
  assert.equal(second.duplicate_of, first.id, "gleicher Screenshot wird markiert");
  tasks.submit({ guildId: G, userId: U, typeId: solar.id, reference: day });
  assert.throws(() => tasks.submit({ guildId: G, userId: U, typeId: solar.id, reference: day }), e => e.code === "LIMIT");
  assert.ok(tasks.submit({ guildId: G, userId: U, typeId: solar.id, reference: new Date("2026-10-21T10:00:00Z") }), "am nächsten Tag wieder möglich");
});

test("Stufen, Serie und Wochenbeginn", () => {
  assert.equal(levelFor(0).name, "Neuling");
  assert.equal(levelFor(16).name, "Fleißig");
  assert.equal(levelFor(16).next.missing, 14);
  assert.equal(levelFor(500).next, null);
  assert.equal(streakOf(["2026-10-18", "2026-10-19", "2026-10-20"], "2026-10-20"), 3);
  assert.equal(streakOf(["2026-10-18", "2026-10-19"], "2026-10-20"), 2, "gestern zählt noch");
  assert.equal(streakOf(["2026-10-17"], "2026-10-20"), 0);
  assert.equal(weekStart("2026-10-25"), "2026-10-19");
  assert.equal(weekStart("2026-10-19"), "2026-10-19");
});

function discordMocks() {
  const sent = [], edits = [], dms = [];
  const reviewMessage = { id: "rm1", channel: { id: CH }, embeds: [{ image: { url: "https://cdn.discordapp.com/x.png?ex=ffffffff" } }], attachments: { first: () => ({ name: "beweis.png", url: "https://cdn.discordapp.com/x.png?ex=ffffffff" }), size: 1 }, edit: async p => { edits.push(p); return reviewMessage; } };
  const channel = { id: CH, send: async p => { sent.push(p); return reviewMessage; }, messages: { fetch: async () => reviewMessage } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async () => ({ send: async p => dms.push(p) }) } };
  return { sent, edits, dms, client };
}

test("/log postet Prüf-Karte mit Screenshot; Bestätigen per Button bucht, aktualisiert Karte und schickt DM", async () => {
  const db = testDb(), m = discordMocks(), config = baseConfig({ CHANNEL_TASK_REVIEW: CH });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  const replies = [];
  const typeId = typeNamed(db, "Invite – guter").id;
  const i = { guildId: G, user: { id: U }, options: { getAttachment: () => ({ url: "https://cdn.discordapp.com/a.png", contentType: "image/png", name: "a.png", size: 8, width: 10, height: 10 }), getString: k => (k === "aufgabe" ? typeId : "Max eingeladen"), getInteger: () => null },
    deferReply: async () => {}, editReply: async p => replies.push(p), reply: async p => replies.push(p) };
  try { await submitTaskLog({ i, db, client: m.client, config }); } finally { globalThis.fetch = realFetch; }
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].files.length, 1, "Screenshot wird dauerhaft angehängt");
  assert.equal(m.sent[0].embeds[0].data.image.url, "attachment://beweis.png");
  assert.match(m.sent[0].components[0].components[0].data.custom_id, /^task:ok:/);
  const log = service(db).list(G, { status: "pending" })[0];
  assert.equal(log.message_id, "rm1");
  assert.match(replies[0].embeds[0].data.title, /eingereicht/);

  const denied = [];
  await handleTaskInteraction({ i: { customId: `task:ok:${log.id}`, guildId: G, user: { id: "99999999999999999" }, member: { roles: { cache: new Map() } }, reply: async p => denied.push(p) }, db, client: m.client, config });
  assert.match(denied[0].content, /nur Aufgaben-Prüfer/);
  const ok = [];
  await handleTaskInteraction({ i: { customId: `task:ok:${log.id}`, guildId: G, user: { id: R }, member: { roles: { cache: new Map([[REV, {}]]) } }, deferReply: async () => { ok.deferred = true; }, editReply: async p => ok.push(p), reply: async p => ok.push(p) }, db, client: m.client, config });
  assert.match(ok[0].content, /Bestätigt/);
  assert.equal(createFinance(db).balance(G, U), 5_000_000);
  assert.equal(m.edits.at(-1).components.length, 0, "Buttons entfernt");
  assert.match(m.edits.at(-1).embeds[0].data.title, /^✅/);
  assert.match(m.dms[0].embeds[0].data.description, /\+\$50\.000,00/);
});

test("Board: Preisliste, Top-Farmer, nur bei Änderung bearbeitet", async () => {
  const db = testDb(), m = discordMocks(), config = baseConfig({ CHANNEL_TASK_BOARD: BOARD });
  const tasks = service(db), finance = createFinance(db);
  const log = tasks.submit({ guildId: G, userId: U, typeId: typeNamed(db, "Invite – normales").id });
  tasks.approve({ guildId: G, id: log.id, actorId: R, finance });
  const board = buildTaskBoard(db, config, G);
  assert.match(board.embeds[0].data.description, /Invite – normales Mitglied\*\* · \$25\.000,00/);
  assert.match(board.embeds[0].data.fields[0].value, new RegExp(`🥇 <@${U}> · 1 Log`));
  assert.equal(await refreshTaskBoard({ db, client: m.client, config }), true);
  assert.equal(await refreshTaskBoard({ db, client: m.client, config }), false);
  assert.equal(m.sent.length, 1);
});

test("Website: Rechte, Bestätigen, Aufgabe mit „25k“ anlegen, Mein Bereich", async () => {
  const db = testDb(), config = baseConfig();
  const guild = { id: G, members: { cache: new Map(), fetch: async () => null }, roles: { cache: new Map() }, channels: { fetch: async () => null } };
  const client = { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, users: { cache: new Map(), fetch: async () => ({ send: async () => {} }) }, channels: { fetch: async () => null } };
  const api = createDashboardApi({ db, client, config });
  const nobody = { id: "1", owner: false, roles: [] }, reviewer = { id: R, owner: false, roles: [REV] }, fin = { id: "40000000000000001", owner: false, roles: [FIN] };
  assert.equal((await api.get(nobody, new URL("/api/tasks", "https://x"))).status, 403);
  const tasks = service(db), log = tasks.submit({ guildId: G, userId: U, typeId: typeNamed(db, "Invite – normales").id });
  const list = await api.get(reviewer, new URL("/api/tasks", "https://x"));
  assert.equal(list.status, 200); assert.equal(list.body.pending.length, 1); assert.equal(list.body.summary.pending, 1);
  assert.equal((await api.post(reviewer, new URL(`/api/tasks/${log.id}/approve`, "https://x"), {})).status, 200);
  assert.equal((await api.post(reviewer, new URL(`/api/tasks/${log.id}/approve`, "https://x"), {})).status, 409);
  assert.equal(createFinance(db).balance(G, U), 2_500_000);
  assert.equal((await api.post(reviewer, new URL("/api/task-types", "https://x"), { name: "Autoklau", reward: "25k" })).status, 403, "Preise festlegen nur Finanzen/Leitung");
  const created = await api.post(fin, new URL("/api/task-types", "https://x"), { name: "Autoklau", emoji: "🚗", reward: "25k", perUnit: "true", unit: "Auto", dailyLimit: "3" });
  assert.equal(created.status, 200); assert.equal(created.body.type.reward_cents, 2_500_000); assert.equal(created.body.type.daily_limit, 3);
  const mine = await api.get({ id: U, owner: false, roles: [], family: true, team: false }, new URL("/api/my", "https://x"));
  assert.equal(mine.body.tasks.profile.total.logs, 1);
  assert.equal(mine.body.tasks.recent[0].status, "approved");
});

test("Logbuch: Screenshot posten → Menü → Menge → Prüf-Karte; Bestätigen setzt ✅ im Logbuch", async () => {
  const { handleLogbookMessage } = await import("../src/task-logs.js");
  const db = testDb(), m = discordMocks(), FORUM = "60000000000000051", THREAD = "60000000000000052";
  const config = baseConfig({ CHANNEL_TASK_REVIEW: CH, CHANNEL_TASK_FORUM: FORUM });
  const tasks = service(db), plant = typeNamed(db, "Plantage");
  tasks.saveType(G, R, { id: plant.id, name: "Plantage", emoji: "🌿", unit: "Ernte", rewardCents: 1_000_000, perUnit: true });
  const replies = [], reactions = [], promptEdits = [];
  const prompt = { id: "p1", edit: async p => promptEdits.push(p) };
  const source = { id: "s1", guildId: G, channelId: THREAD, author: { id: U, bot: false }, attachments: new Map([["a", { url: "https://cdn.discordapp.com/s.png", contentType: "image/png", name: "s.png", size: 9, width: 5, height: 5 }]]),
    reply: async p => { replies.push(p); return prompt; }, react: async e => reactions.push(e) };
  const thread = { id: THREAD, parentId: FORUM, name: "Tony Soprano | 111111", isThread: () => true, messages: { fetch: async id => (id === "s1" ? source : prompt) } };
  source.channel = thread;
  assert.equal(await handleLogbookMessage({ db, config, message: { ...source, channel: { ...thread, name: "Vorlage + Info:" } } }), false, "Vorlage wird ignoriert");
  assert.equal(await handleLogbookMessage({ db, config, message: source }), true);
  assert.equal(replies[0].components[0].components[0].data.custom_id, "task:pick:s1:0");
  const realFetch = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  const client = { ...m.client, channels: { fetch: async id => (id === THREAD ? thread : { id: CH, send: async p => { m.sent.push(p); return { id: "rm1", channel: { id: CH }, embeds: [], attachments: { first: () => null } }; }, messages: { fetch: async () => null } }) } };
  const base = { guildId: G, channel: thread, channelId: THREAD, message: { id: "p1" }, member: { roles: { cache: new Map() } } };
  try {
    const stranger = [];
    await handleTaskInteraction({ i: { ...base, customId: "task:pick:s1", user: { id: R }, values: [plant.id], reply: async p => stranger.push(p) }, db, client, config });
    assert.match(stranger[0].content, /nur die Person/);
    let modal;
    await handleTaskInteraction({ i: { ...base, customId: "task:pick:s1", user: { id: U }, values: [plant.id], showModal: async x => { modal = x; } }, db, client, config });
    assert.equal(modal.data.custom_id, `task:pickq:s1:${plant.id}:0`);
    const updates = [];
    await handleTaskInteraction({ i: { ...base, customId: `task:pickq:s1:${plant.id}`, user: { id: U }, fields: { getTextInputValue: () => "3" }, update: async p => updates.push(p) }, db, client, config });
    assert.match(updates[0].content, /Plantage ×3 Ernte\*\* eingereicht · \$30\.000,00/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(m.sent.length, 1, "Prüf-Karte gepostet");
  const log = tasks.list(G, { status: "pending" })[0];
  assert.equal(log.user_id, U); assert.equal(log.quantity, 3);
  const again = [];
  await handleTaskInteraction({ i: { ...base, customId: `task:pickq:s1:${plant.id}`, user: { id: U }, fields: { getTextInputValue: () => "3" }, update: async p => again.push(p) }, db, client, config });
  assert.equal(tasks.list(G, {}).length, 1, "kein zweites Log für dasselbe Bild");
  assert.equal(again[0].components.length, 0);
  const { decideTask } = await import("../src/task-logs.js");
  await decideTask({ db, client, config, guildId: G, id: log.id, actorId: R, approve: true });
  assert.deepEqual(reactions, ["✅"]);
  assert.match(promptEdits.at(-1).content, /bestätigt · \*\*\+\$30\.000,00\*\*/);
});

test("Logbuch: Text ohne Bild von Mitgliedern wird gelöscht, Team darf schreiben", async () => {
  const { handleLogbookMessage } = await import("../src/task-logs.js");
  const db = testDb(), FORUM = "60000000000000051", config = baseConfig({ CHANNEL_TASK_FORUM: FORUM });
  const sent = [];
  const make = roles => { const msg = { deleted: false, guildId: G, author: { id: U }, member: { roles: { cache: new Map(roles.map(r => [r, true])) } }, attachments: new Map(),
    channel: { parentId: FORUM, name: "Tony | 1", isThread: () => true, send: async p => { sent.push(p); return { delete: async () => {} }; } }, delete: async () => { msg.deleted = true; } }; return msg; };
  const member = make([]), reviewer = make([REV]);
  await handleLogbookMessage({ db, config, message: member });
  await handleLogbookMessage({ db, config, message: reviewer });
  assert.equal(member.deleted, true); assert.equal(reviewer.deleted, false);
  assert.match(sent[0].content, /nur Screenshots/);
  const off = make([]);
  await handleLogbookMessage({ db, config: { ...config, LOGBOOK_IMAGES_ONLY: false }, message: off });
  assert.equal(off.deleted, false, "abschaltbar");
});

test("Logbuch: mehrere Screenshots in einer Nachricht → ein Menü pro Bild, jedes wird einzeln eingereicht", async () => {
  const { handleLogbookMessage } = await import("../src/task-logs.js");
  const db = testDb(), FORUM = "60000000000000051", THREAD = "60000000000000052";
  const config = baseConfig({ CHANNEL_TASK_FORUM: FORUM });
  const img = n => [`a${n}`, { url: `https://cdn.discordapp.com/${n}.png`, contentType: "image/png", name: `${n}.png`, size: 10 + n, width: 5, height: 5 }];
  const replies = [];
  const source = { id: "s2", guildId: G, channelId: THREAD, author: { id: U }, attachments: new Map([img(1), img(2), img(3)]), reply: async p => { replies.push(p); return { id: "p2" }; } };
  const thread = { id: THREAD, parentId: FORUM, name: "Tony | 1", isThread: () => true, messages: { fetch: async () => source } };
  source.channel = thread;
  await handleLogbookMessage({ db, config, message: source });
  assert.match(replies[0].content, /3 Screenshots erkannt/);
  assert.deepEqual(replies[0].components.slice(0, 3).map(r => r.components[0].data.custom_id), ["task:pick:s2:0", "task:pick:s2:1", "task:pick:s2:2"]);
  const invite = typeNamed(db, "Invite – normales").id, updates = [];
  const realFetch = globalThis.fetch; globalThis.fetch = async () => ({ ok: false });
  const client = { channels: { fetch: async () => null }, users: { fetch: async () => ({ send: async () => {} }) } };
  try {
    await handleTaskInteraction({ i: { guildId: G, channel: thread, channelId: THREAD, message: { id: "p2" }, member: { roles: { cache: new Map() } }, customId: "task:pick:s2:1", user: { id: U }, values: [invite], update: async p => updates.push(p) }, db, client, config });
  } finally { globalThis.fetch = realFetch; }
  assert.match(updates[0].content, /Bild 2: ⏳ \*\*🤝 Invite – normales Mitglied\*\* eingereicht/);
  assert.deepEqual(updates[0].components.map(r => r.components[0].data.custom_id), ["task:pick:s2:0", "task:pick:s2:2"], "nur noch offene Bilder, kein „Kein Log“ mehr");
  assert.equal(db.prepare("SELECT source_index FROM task_logs").get().source_index, 1);
});

test("Excel: Monatsabrechnung pro Mitglied und Monat", async () => {
  const { buildTable } = await import("../src/export.js");
  const db = testDb(), tasks = service(db), finance = createFinance(db);
  const invite = typeNamed(db, "Invite – normales").id;
  for (let n = 0; n < 2; n++) { const l = tasks.submit({ guildId: G, userId: U, typeId: invite, reference: new Date(`2026-10-1${n}T10:00:00Z`) }); tasks.approve({ guildId: G, id: l.id, actorId: R, finance }); }
  tasks.reject({ guildId: G, id: tasks.submit({ guildId: G, userId: U, typeId: invite, reference: new Date("2026-10-15T10:00:00Z") }).id, actorId: R, reason: "Uhrzeit fehlt" });
  const t = buildTable("taskmonths", { db, guildId: G, name: id => (id === U ? "Tony" : id) });
  const row = t.rows.find(r => r[0] === "10/2026");
  assert.deepEqual(row.slice(1, 7), ["Tony", 2, 2, 50000, 1, 0]);
  assert.equal(buildTable("tasks", { db, guildId: G, name: id => id }).rows.length, 3);
});

test("Event-Forum: Bilder bleiben ohne Aufgaben-Menü, Text wird gelöscht", async () => {
  const { handleLogbookMessage } = await import("../src/task-logs.js");
  const db = testDb(), EV = "60000000000000061", config = baseConfig({ CHANNEL_EVENT_FORUM: EV });
  const replies = [];
  const msg = (attachments) => { const m = { deleted: false, guildId: G, author: { id: U }, member: { roles: { cache: new Map() } }, attachments, reply: async p => replies.push(p),
    channel: { parentId: EV, name: "Tony | 1", isThread: () => true, send: async () => ({ delete: async () => {} }) }, delete: async () => { m.deleted = true; } }; return m; };
  const image = msg(new Map([["a", { contentType: "image/png", name: "a.png" }]])), text = msg(new Map());
  assert.equal(await handleLogbookMessage({ db, config, message: image }), false);
  assert.equal(replies.length, 0, "kein Aufgaben-Menü im Event-Forum");
  assert.equal(image.deleted, false);
  await handleLogbookMessage({ db, config, message: text });
  assert.equal(text.deleted, true);
});
