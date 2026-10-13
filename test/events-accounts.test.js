import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { eventCardPayload, fillTemplate, publishEvent, refreshEventPosts, sendEventReminder } from "../src/event-posts.js";
import { createFinance } from "../src/services/finance.js";
import { createHandler, buildAccountPanelPayload } from "../src/commands.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001";
const base = extra => ({ ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G }), ...extra });
const event = (extra = {}) => ({ id: "e1", guild_id: G, name: "Bizwar", description: "", starts_at: "2026-10-14T17:05:00.000Z", location: "", host_id: "bot", equipment: "", notes: "", max_participants: null, status: "scheduled", series_id: "s1", ...extra });

test("Event-Karte zeigt nur ausgefüllte Angaben und keinen Bot als Veranstalter", () => {
  const card = eventCardPayload({ event: event(), botId: "bot" }).embeds[0].toJSON();
  assert.deepEqual(card.fields.map(f => f.name), ["🕒 Beginn", "🙋 Teilnehmende (0)"]);
  assert.equal(card.author.name, "GAMBINOS  •  EVENTS");
  const full = eventCardPayload({ event: event({ series_id: null, host_id: "30000000000000001", location: "HQ", equipment: "Weste" }), participants: [{ user_id: "30000000000000002" }], botId: "bot" }).embeds[0].toJSON();
  assert.deepEqual(full.fields.map(f => f.name), ["🕒 Beginn", "📍 Treffpunkt", "👤 Veranstalter", "🧰 Ausrüstung", "🙋 Teilnehmende (1)"]);
  const ended = eventCardPayload({ event: event(), state: "ended" });
  assert.match(ended.embeds[0].toJSON().title, /Beendet/); assert.equal(ended.components.length, 0);
  assert.equal(fillTemplate("**{name}** {relativ}", event()), `**Bizwar** <t:${Date.parse("2026-10-14T17:05:00.000Z") / 1000}:R>`);
});

function channels() {
  const store = {};
  const make = id => {
    const msgs = new Map();
    const ch = { id, guildId: G, isTextBased: () => true, sent: [], send: async payload => { const m = { id: `${id}-m${ch.sent.length}`, channelId: id, guildId: G, content: payload.content, edits: [], replies: [], edit: async p => m.edits.push(p), reply: async p => m.replies.push(p), delete: async () => { m.deleted = true; } }; ch.sent.push(payload); msgs.set(m.id, m); return m; },
      messages: { fetch: async mid => msgs.get(mid) ?? null } };
    store[id] = ch; return ch;
  };
  make("60000000000000001"); make("60000000000000002");
  return { store, client: { user: { id: "bot" }, channels: { fetch: async id => store[id] ?? null } } };
}

test("Karte im Anmelde-Channel, Ankündigung mit Link und Rollen-Ping, Erinnerung als Antwort", async () => {
  const db = testDb(), { store, client } = channels();
  const config = base({ CHANNEL_EVENT_ANNOUNCEMENTS: "60000000000000001", CHANNEL_EVENT_SIGNUP: "60000000000000002", EVENT_PING_ROLES: ["20000000000000007"] });
  const ev = event({ series_id: null });
  const posted = await publishEvent({ db, client, config, event: ev });
  assert.equal(posted.channelId, "60000000000000002");
  const announcement = store["60000000000000001"].sent[0];
  assert.equal(announcement.content, "<@&20000000000000007>");
  assert.deepEqual(announcement.allowedMentions.roles, ["20000000000000007"]);
  assert.equal(announcement.components[0].components[0].data.url, `https://discord.com/channels/${G}/60000000000000002/${posted.messageId}`);
  db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,announce_channel_id,announce_message_id,name,description,starts_at,location,host_id,status,created_at) VALUES('e1',?,?,?,?,?,'Bizwar','',?,'','bot','scheduled',?)").run(G, posted.channelId, posted.messageId, posted.announceChannelId, posted.announceMessageId, ev.starts_at, ev.starts_at);
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e1','30000000000000005','signed_up',?)").run(ev.starts_at);
  const stored = db.prepare("SELECT * FROM events").get();
  assert.equal(await sendEventReminder({ db, client, config, event: stored }), true);
  const card = await store["60000000000000002"].messages.fetch(posted.messageId);
  assert.equal(card.replies[0].content, "<@30000000000000005>");
  await refreshEventPosts({ db, client, config, event: stored, state: "cancelled" });
  assert.match(card.edits.at(-1).embeds[0].toJSON().title, /Abgesagt/);
  const ann = await store["60000000000000001"].messages.fetch(posted.announceMessageId);
  assert.equal(ann.edits.at(-1).components.length, 0, "Ankündigung verliert den Anmelde-Link nach Absage");
});

test("beendete Aktivitäts-Posts werden auf Wunsch gelöscht, Daten bleiben", async () => {
  const db = testDb(), { store, client } = channels();
  const config = base({ CHANNEL_EVENT_ANNOUNCEMENTS: "60000000000000001", EVENT_SERIES_DELETE_ENDED: true });
  const posted = await publishEvent({ db, client, config, event: event() });
  assert.equal(posted.announceMessageId, null, "nur ein Channel: keine doppelte Ankündigung");
  await refreshEventPosts({ db, client, config, event: { ...event(), channel_id: posted.channelId, message_id: posted.messageId }, state: "ended" });
  assert.equal((await store["60000000000000001"].messages.fetch(posted.messageId)).deleted, true);
});

test("Familienkonto anlegen: Finanzrolle, idempotent, eigenes Konto per Panel", async () => {
  const db = testDb(), finance = createFinance(db);
  assert.equal(finance.openAccount({ guildId: G, userId: "u1", actorId: "f" }).created, true);
  assert.equal(finance.openAccount({ guildId: G, userId: "u1", actorId: "f" }).created, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='finance.account_opened'").get().n, 1);
  const config = base({ ROLE_FINANCE: "20000000000000003" });
  const client = { ws: { ping: 1 }, user: { id: "bot" }, users: { fetch: async () => ({ send: async () => {} }) } };
  const handler = createHandler({ db, finance, config, client });
  const replies = [];
  const cmd = roles => ({ id: "i1", commandName: "konto", guildId: G, user: { id: "30000000000000001" }, member: { roles: { cache: new Map(roles.map(r => [r, true])) } }, inGuild: () => true, isChatInputCommand: () => true,
    options: { getSubcommand: () => "anlegen", getUser: () => ({ id: "30000000000000002", bot: false }), getString: () => null, getInteger: () => null }, reply: async p => replies.push(p) });
  await handler.command(cmd([]));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts WHERE user_id='30000000000000002'").get().n, 0);
  await handler.command(cmd(["20000000000000003"]));
  assert.equal(db.prepare("SELECT balance_cents FROM accounts WHERE user_id='30000000000000002'").get().balance_cents, 0);
  // „Mein Konto“-Panel zeigt immer nur das eigene Konto.
  finance.credit({ guildId: G, userId: "30000000000000002", actorId: "f", cents: 5000, reason: "Event", key: "k" });
  const panel = buildAccountPanelPayload();
  assert.deepEqual(panel.components[0].components.map(b => b.data.custom_id), ["account:balance", "account:history", "account:sanctions"]);
  const own = [];
  await handler.button({ customId: "account:balance", guildId: G, user: { id: "30000000000000002" }, inGuild: () => true, reply: async p => own.push(p) });
  assert.match(JSON.stringify(own[0].embeds[0].data), /\$50,00/);
  assert.match(JSON.stringify(own[0].embeds[0].data), /30000000000000002/);
  assert.equal(own[0].flags, 64, "nur für die Person sichtbar");
});

test("Verifizierung legt kein Familienkonto an, angenommene Familienbewerbung schon", async () => {
  const db = testDb(), finance = createFinance(db);
  const config = base({ ROLE_REVIEWERS: "20000000000000004", ROLE_VERIFIED: "20000000000000009" });
  const client = { ws: { ping: 1 }, user: { id: "bot" }, users: { fetch: async () => ({ send: async () => {} }) } };
  const handler = createHandler({ db, finance, config, client });
  const member = { roles: { cache: new Map(), add: async id => member.roles.cache.set(id, true) }, setNickname: async () => {} };
  await handler.modal({ customId: "verify:submit", guildId: G, user: { id: "30000000000000001" }, inGuild: () => true, guild: { ownerId: "x", members: { fetch: async () => member } },
    fields: { getTextInputValue: k => ({ ingame_id: "12", first_name: "Max", last_name: "Muster" })[k] }, reply: async () => {}, deferReply: async () => {}, editReply: async () => {} });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM member_verifications").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts").get().n, 0, "Verifizierung ist keine Familienaufnahme");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO applications(id,guild_id,user_id,kind,answers,status,created_at,updated_at) VALUES('a1',?,'30000000000000001','bewerbung','{}','review',?,?)").run(G, now, now);
  const updates = [];
  await handler.reviewButton({ customId: "application:accept:a1", guildId: G, user: { id: "40000000000000001" }, member: { roles: { cache: new Map([["20000000000000004", true]]) } }, inGuild: () => true,
    guild: { channels: { fetch: async () => null } }, message: { id: "m" }, update: async p => updates.push(p), followUp: async () => {}, reply: async () => {} });
  assert.equal(db.prepare("SELECT status FROM applications").get().status, "accepted");
  assert.equal(db.prepare("SELECT balance_cents FROM accounts WHERE user_id='30000000000000001'").get()?.balance_cents, 0);
});
