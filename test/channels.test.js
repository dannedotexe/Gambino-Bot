import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { testDb } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { checkChannels, CHANNEL_FUNCTIONS } from "../src/channel-check.js";
import { auditChannelFor } from "../src/scheduler.js";
import { ensurePanels, postEventResult } from "../src/panels.js";
import { CHANNEL_BINDINGS } from "../src/channel-setup.js";
import { SETTINGS } from "../src/services/settings.js";

const G = "10000000000000001";
const base = () => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G });

test("jede Channel-Funktion ist einstellbar, geprüft und hat eine Layout-Empfehlung", () => {
  const settingKeys = SETTINGS.filter(s => s.group === "Channels").map(s => s.key).sort();
  assert.deepEqual(CHANNEL_FUNCTIONS.map(f => f.key).sort(), settingKeys);
  assert.deepEqual(Object.keys(CHANNEL_BINDINGS).sort(), settingKeys);
  assert.deepEqual(CHANNEL_BINDINGS.CHANNEL_RANK_REVIEW, ["STAFF", "rang-anträge"]);
  assert.notDeepEqual(CHANNEL_BINDINGS.CHANNEL_AUDIT_LOG, CHANNEL_BINDINGS.CHANNEL_SANCTION_LOG, "Audit-Log ist nicht mehr der Sanktions-Channel");
});

test("Audit-Einträge landen im passenden Bereichs-Log, sonst im Audit-Log", () => {
  const config = { ...base(), CHANNEL_AUDIT_LOG: "1", CHANNEL_SANCTION_LOG: "2", CHANNEL_FINANCE_LOG: "3", CHANNEL_EVENT_LOG: "4" };
  assert.equal(auditChannelFor("sanction.created", config), "2");
  assert.equal(auditChannelFor("finance.payout", config), "3");
  assert.equal(auditChannelFor("event.updated", config), "4");
  assert.equal(auditChannelFor("ticket.closed", config), "1");
  assert.equal(auditChannelFor("finance.credit", { ...config, CHANNEL_FINANCE_LOG: undefined }), "1");
});

function perms(...flags) { const set = new Set(flags); return { has: wanted => (Array.isArray(wanted) ? wanted : [wanted]).every(f => set.has(f)) }; }
function fakeGuild(channels, botFlags = [P.ManageChannels]) {
  const everyone = { id: G };
  return {
    id: G, roles: { everyone, cache: new Map() },
    members: { me: { permissions: perms(...botFlags) } },
    channels: { fetch: async id => channels[id] ?? null },
  };
}
const textChannel = (name, { publicView = false, bot = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles] } = {}) => ({
  name, type: ChannelType.GuildText, isTextBased: () => true, parent: { name: "STAFF" },
  permissionsFor: target => (target?.id === G ? perms(...(publicView ? [P.ViewChannel] : [])) : perms(...bot)),
});

test("Channel-Prüfung erkennt öffentliche Staff-Channels, falsche Namen, fehlende Rechte und gelöschte Channels", async () => {
  const config = { ...base(), CHANNEL_TICKET_LOG: "11111111111111111", CHANNEL_AUDIT_LOG: "22222222222222222", CHANNEL_RANK_REVIEW: "33333333333333333", CHANNEL_FINANCE_LOG: "44444444444444444", CHANNEL_EVENT_ANNOUNCEMENTS: "55555555555555555", CHANNEL_TICKET_CATEGORY: "66666666666666666" };
  const guild = fakeGuild({
    "11111111111111111": textChannel("🗂️・ticket-logs"),
    "22222222222222222": textChannel("⚠️・sanktions-logs"),
    "33333333333333333": textChannel("📝・rang-anträge", { publicView: true }),
    "44444444444444444": textChannel("💰・auszahlungen", { bot: [P.ViewChannel, P.ReadMessageHistory] }),
    "55555555555555555": textChannel("📢・event-ankündigungen", { publicView: true }),
    "66666666666666666": textChannel("support-text"),
  });
  const report = await checkChannels({ guild, config });
  const by = key => report.channels.find(r => r.key === key);
  assert.equal(by("CHANNEL_TICKET_LOG").status, "ok");
  assert.equal(by("CHANNEL_EVENT_ANNOUNCEMENTS").status, "ok");
  assert.match(by("CHANNEL_AUDIT_LOG").issues.map(i => i.text).join(), /anderen Funktion/);
  assert.equal(by("CHANNEL_RANK_REVIEW").status, "error");
  assert.match(by("CHANNEL_RANK_REVIEW").issues[0].text, /Für alle sichtbar/);
  assert.match(by("CHANNEL_FINANCE_LOG").issues.map(i => i.text).join(), /Nachrichten senden/);
  assert.match(by("CHANNEL_TICKET_CATEGORY").issues.map(i => i.text).join(), /Kategorie/);
  assert.match(by("CHANNEL_STATS").issues[0].text, /Nicht gesetzt.*server-statistik/);
  const deleted = await checkChannels({ guild: fakeGuild({}), config: { ...base(), CHANNEL_TICKET_LOG: "99999999999999999" } });
  assert.equal(deleted.channels.find(r => r.key === "CHANNEL_TICKET_LOG").status, "error");
});

function panelClient() {
  const messages = new Map(); let counter = 0; const sent = [];
  const channel = { id: "77777777777777777", isTextBased: () => true, send: async payload => { const msg = { id: `p${++counter}`, edit: async () => {}, delete: async () => messages.delete(msg.id) }; messages.set(msg.id, msg); sent.push(payload); return msg; },
    messages: { fetch: async id => { if (messages.has(id)) return messages.get(id); const error = new Error("Unknown Message"); error.code = 10008; throw error; } } };
  return { channel, messages, sent, client: { channels: { fetch: async id => (id === channel.id ? channel : null) } } };
}

test("Panels werden genau einmal gepostet und nur nach Löschung neu gepostet", async () => {
  const db = testDb(), { client, sent, messages } = panelClient();
  const config = { ...base(), CHANNEL_TICKET_PANEL: "77777777777777777" };
  assert.deepEqual((await ensurePanels({ db, client, config, series: null })).map(r => r.status), ["posted"]);
  assert.deepEqual((await ensurePanels({ db, client, config, series: null })).map(r => r.status), ["ok"]);
  assert.equal(sent.length, 1);
  messages.clear();
  assert.deepEqual((await ensurePanels({ db, client, config, series: null })).map(r => r.status), ["posted"]);
  assert.equal(sent.length, 2);
});

test("Event-Ergebnis listet Anwesende, Angemeldete und Abwesende ohne Pings", async () => {
  const db = testDb(), { client, sent } = panelClient(), now = new Date().toISOString();
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES('e','g','Bizwar','',?,'HQ','h','ended',?)").run(now, now);
  for (const [user, status] of [["30000000000000001", "present"], ["30000000000000002", "signed_up"], ["30000000000000003", "left"]]) db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e',?,?,?)").run(user, status, now);
  assert.equal(await postEventResult({ db, client, config: { ...base(), CHANNEL_EVENT_RESULTS: "77777777777777777" }, event: db.prepare("SELECT * FROM events").get() }), true);
  const fields = sent[0].embeds[0].toJSON().fields;
  assert.match(fields[0].name, /Anwesend \(1\)/); assert.match(fields[1].name, /Angemeldet \(1\)/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(await postEventResult({ db, client, config: base(), event: { id: "e" } }), false, "ohne Channel nichts senden");
});
