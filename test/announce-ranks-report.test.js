import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { announcementPayload, createAnnouncementService, sendDueAnnouncements, validateAnnouncement } from "../src/announcements.js";
import { createRankHistory, rankChange, rankFor } from "../src/services/ranks.js";
import { trackRankChange } from "../src/rank-tracking.js";
import { buildSanctionList } from "../src/sanction-list.js";
import { previousWeek, sendWeeklyReport, weeklyNumbers } from "../src/weekly-report.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", TZ = "Europe/Vienna";
const ROLE = { leaders: "20000000000000001", staff: "20000000000000002", r1: "20000000000000011", r2: "20000000000000012" };
const U = "30000000000000001", V = "30000000000000002", STAFF = "30000000000000003";
const REF = new Date("2026-10-14T10:00:00Z");
const base = extra => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_LEADERS: ROLE.leaders, ROLE_STAFF: ROLE.staff, ...extra });

test("Ankündigung: Prüfung, Planung in Server-Zeit, @everyone nur Leitung", () => {
  const ok = validateAnnouncement({ channelId: "50000000000000001", title: "Treffen", description: "Freitag", pingRoleIds: [ROLE.staff], scheduledAt: "2026-10-20T18:00" }, { reference: REF, timezone: TZ });
  assert.equal(ok.scheduledAt, "2026-10-20T16:00:00.000Z", "18:00 Wiener Sommerzeit");
  assert.throws(() => validateAnnouncement({ channelId: "50000000000000001" }, { reference: REF }), /Text oder Titel/);
  assert.throws(() => validateAnnouncement({ channelId: "50000000000000001", content: "x", pingEveryone: true }, { reference: REF }), /nur die Leitung/);
  assert.throws(() => validateAnnouncement({ channelId: "50000000000000001", content: "Hallo @everyone" }, { reference: REF }), /nur die Leitung/);
  assert.throws(() => validateAnnouncement({ channelId: "50000000000000001", content: "x", scheduledAt: "2026-10-01T10:00" }, { reference: REF, timezone: TZ }), /Zukunft/);
  assert.throws(() => validateAnnouncement({ channelId: "50000000000000001", content: "x", imageUrl: "http://bild" }, { reference: REF }), /https/);
  const payload = announcementPayload({ content: "Hallo", embed: JSON.stringify(ok.embed), ping_role_ids: ROLE.staff, ping_everyone: 0 });
  assert.equal(payload.content, `<@&${ROLE.staff}>\nHallo`);
  assert.deepEqual(payload.allowedMentions, { parse: [], roles: [ROLE.staff] });
});

test("Geplante Ankündigung wird genau einmal gesendet", async () => {
  const db = testDb(), service = createAnnouncementService(db), sent = [];
  const client = { channels: { fetch: async () => ({ send: async p => { sent.push(p); return { id: "m1" }; } }) } };
  const data = validateAnnouncement({ channelId: "50000000000000001", content: "Bald", scheduledAt: "2026-10-14T13:00" }, { reference: REF, timezone: TZ });
  service.create({ guildId: G, actorId: STAFF, data });
  assert.equal(await sendDueAnnouncements({ db, client, reference: REF }), 0, "noch nicht fällig");
  const later = new Date("2026-10-14T11:01:00Z");
  const [a, b] = await Promise.all([sendDueAnnouncements({ db, client, reference: later }), sendDueAnnouncements({ db, client, reference: later })]);
  assert.equal(a + b, 1);
  assert.equal(sent.length, 1);
  assert.equal(service.list(G)[0].status, "sent");
});

test("Rang: höhere Discord-Rolle = Beförderung; Historie ist unveränderlich", async () => {
  const ranks = [{ label: "Anwärter", roleId: ROLE.r1 }, { label: "Soldat", roleId: ROLE.r2 }];
  assert.deepEqual(rankChange(rankFor([ROLE.r1], ranks), rankFor([ROLE.r2], ranks)), { from: "Anwärter", to: "Soldat", kind: "promotion" });
  assert.deepEqual(rankChange(rankFor([ROLE.r2], ranks), rankFor([ROLE.r1], ranks)).kind, "demotion");
  assert.equal(rankChange(rankFor([ROLE.r1], ranks), rankFor([ROLE.r1, "x"], ranks)), null);
  const db = testDb(), config = base({ RANK_ROLES_JSON: JSON.stringify(ranks) });
  const positions = new Map([[ROLE.r1, { position: 3 }], [ROLE.r2, { position: 5 }]]);
  const guild = { id: G, roles: { cache: positions }, fetchAuditLogs: async () => ({ entries: [{ target: { id: U }, executor: { id: STAFF }, createdTimestamp: Date.now(), reason: "Gute Arbeit" }] }) };
  const member = roles => ({ id: U, user: { bot: false }, guild, client: { user: { id: "bot" } }, roles: { cache: new Map(roles.map(r => [r, true])) } });
  const change = await trackRankChange({ db, config, oldMember: member([ROLE.r1]), newMember: member([ROLE.r2]) });
  assert.equal(change.kind, "promotion");
  const [row] = createRankHistory(db).forUser(G, U);
  assert.equal(row.actor_id, STAFF); assert.equal(row.reason, "Gute Arbeit"); assert.equal(row.to_label, "Soldat");
  assert.equal(await trackRankChange({ db, config, oldMember: member([ROLE.r2]), newMember: member([ROLE.r2, "99999999999999999"]) }), null, "andere Rollen ändern nichts");
  assert.throws(() => db.prepare("DELETE FROM rank_changes").run(), /dürfen nicht gelöscht werden/);
});

test("Öffentliche Sanktionsliste: gruppiert, Beträge/Gründe abschaltbar, keine Pings", () => {
  const db = testDb(), finance = createFinance(db);
  finance.sanction({ guildId: G, userId: U, actorId: STAFF, cents: 50000, reason: "Zu spät" });
  finance.sanction({ guildId: G, userId: U, actorId: STAFF, cents: 25000, reason: "Funk ignoriert" });
  finance.sanction({ guildId: G, userId: V, actorId: STAFF, cents: 10000, reason: "Spam" });
  const full = buildSanctionList({ db, guildId: G, config: base() });
  const desc = full.embeds[0].data.description;
  assert.match(desc, new RegExp(`<@${U}> · 2 offene Sanktionen · \\*\\*\\$750,00`));
  assert.match(desc, /Funk ignoriert/);
  assert.ok(desc.indexOf(U) < desc.indexOf(V), "höchster Betrag zuerst");
  assert.deepEqual(full.allowedMentions, { parse: [] });
  const hidden = buildSanctionList({ db, guildId: G, config: base({ SANCTION_LIST_SHOW_AMOUNTS: "false", SANCTION_LIST_SHOW_REASONS: "false" }) }).embeds[0].data;
  assert.doesNotMatch(hidden.description, /\$|Funk/);
  assert.equal(buildSanctionList({ db: testDb(), guildId: G, config: base() }).embeds[0].data.description.includes("keine offenen Sanktionen"), true);
});

test("Wochenbericht: Vorwoche Mo–So, nur montags ab Uhrzeit, genau einmal", async () => {
  const week = previousWeek(new Date("2026-10-19T08:00:00Z"), TZ);
  assert.equal(week.fromDay, "2026-10-12"); assert.equal(week.toDay, "2026-10-18");
  assert.equal(week.from, "2026-10-11T22:00:00.000Z");
  const db = testDb(), finance = createFinance(db);
  finance.credit({ guildId: G, userId: U, actorId: STAFF, cents: 100000, reason: "Event", key: "k" });
  // Woche, in der „jetzt“ liegt: Bericht von nächster Woche aus betrachtet.
  const numbers = weeklyNumbers(db, G, previousWeek(new Date(Date.now() + 7 * 86_400_000), TZ));
  assert.equal(numbers.finance.credits.n, 1);
  const sent = [];
  const client = { channels: { fetch: async () => ({ send: async p => { sent.push(p); } }) }, guilds: { cache: new Map(), fetch: async () => null } };
  const config = base({ CHANNEL_WEEKLY_REPORT: "50000000000000009", WEEKLY_REPORT_HOUR: "9" });
  assert.equal((await sendWeeklyReport({ db, client, config, reference: new Date("2026-10-19T06:00:00Z") })).reason, "not_due", "Montag 8:00 < 9 Uhr");
  assert.equal((await sendWeeklyReport({ db, client, config, reference: new Date("2026-10-19T07:30:00Z") })).sent, true);
  assert.equal((await sendWeeklyReport({ db, client, config, reference: new Date("2026-10-19T09:00:00Z") })).reason, "already_sent");
  assert.equal((await sendWeeklyReport({ db, client, config, reference: new Date("2026-10-20T09:00:00Z") })).reason, "not_due", "Dienstag");
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.title, /12\.10\.2026 – 18\.10\.2026/);
});

test("Website: Ankündigung senden/planen, Rang manuell, Rechte", async () => {
  const db = testDb(), config = base({ CHANNEL_ANNOUNCEMENTS: "50000000000000001" }), sent = [];
  const channel = { id: "50000000000000001", isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: () => true }), send: async p => { sent.push(p); return { id: "m" }; } };
  const guild = { id: G, members: { me: {}, cache: new Map(), fetch: async () => null }, channels: { fetch: async () => channel }, roles: { fetch: async id => (id === ROLE.staff ? { id } : null) } };
  const client = { guilds: { cache: new Map([[G, guild]]), fetch: async () => guild }, channels: { fetch: async () => channel }, users: { fetch: async () => null } };
  const api = createDashboardApi({ db, client, config });
  const as = (...roles) => ({ id: STAFF, owner: false, roles: roles.map(r => ROLE[r]) });
  const post = (m, p, b) => api.post(m, new URL(p, "https://x"), b);
  assert.equal((await post(as(), "/api/announcements", { channelId: channel.id, content: "Hi" })).status, 403);
  assert.equal((await post(as("staff"), "/api/announcements", { channelId: channel.id, content: "Hi", pingEveryone: true })).status, 400);
  assert.equal((await post(as("staff"), "/api/announcements", { channelId: channel.id, content: "Hi", pingRoleIds: [ROLE.staff] })).status, 200);
  assert.equal(sent.length, 1);
  assert.equal((await post(as("staff"), "/api/announcements", { channelId: channel.id, content: "Später", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 200);
  const list = await api.get(as("staff"), new URL("/api/announcements", "https://x"));
  const planned = list.body.announcements.find(a => a.status === "scheduled");
  assert.ok(planned);
  assert.equal((await post(as("staff"), `/api/announcements/${planned.id}/cancel`, {})).status, 200);
  assert.equal((await post(as("staff"), `/api/members/${U}/rank`, { kind: "promotion", to: "Soldat" })).status, 403);
  assert.equal((await post(as("leaders"), `/api/members/${U}/rank`, { kind: "promotion", from: "Anwärter", to: "Soldat", reason: "Bewährt" })).status, 200);
  assert.equal(createRankHistory(db).forUser(G, U)[0].source, "website");
});
