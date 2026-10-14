import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { createAbsenceService, parseDay } from "../src/services/absences.js";
import { createActivityService, periodStart } from "../src/services/activity.js";
import { createHandler } from "../src/commands.js";
import { createDashboardApi } from "../src/dashboard-api.js";
import { hierarchyProblem } from "../src/member-moderation.js";
import { welcomePayload, sendWelcome } from "../src/welcome.js";
import { syncAbsenceRoles } from "../src/absence-posts.js";
import { auditChannelFor } from "../src/scheduler.js";
import { loadConfig } from "../src/config.js";
import { defaultsFor } from "../src/services/texts.js";

const GUILD = "10000000000000001", TZ = "Europe/Vienna";
const ROLE = { leaders: "20000000000000001", staff: "20000000000000002", mods: "20000000000000003", members: "20000000000000005", absent: "20000000000000006" };
const LEADER = "30000000000000001", STAFF = "30000000000000002", MOD = "30000000000000003", MEMBER = "30000000000000004", OTHER = "30000000000000005";
const REF = new Date("2026-10-14T10:00:00Z");

test("Datumseingaben: heute, morgen, ohne Jahr, ISO; Unsinn wird abgelehnt", () => {
  assert.equal(parseDay("heute", TZ, REF), "2026-10-14");
  assert.equal(parseDay("morgen", TZ, REF), "2026-10-15");
  assert.equal(parseDay("20.10.", TZ, REF), "2026-10-20");
  assert.equal(parseDay("3.1.", TZ, REF), "2027-01-03", "vergangene Daten ohne Jahr meinen das nächste Jahr");
  assert.equal(parseDay("20.10.26", TZ, REF), "2026-10-20");
  assert.equal(parseDay("2026-11-02", TZ, REF), "2026-11-02");
  assert.throws(() => parseDay("31.02.2026", TZ, REF), /kein gültiges Datum/);
  assert.throws(() => parseDay("bald", TZ, REF), /kein gültiges Datum/);
});

test("Abmeldungen: Überschneidung, Höchstdauer, Beenden ohne Löschen, entschuldigtes Fehlen", () => {
  const db = testDb(), a = createAbsenceService(db);
  const row = a.create({ guildId: GUILD, userId: MEMBER, actorId: MEMBER, startsOn: "2026-10-14", endsOn: "2026-10-20", reason: "Urlaub", timezone: TZ, reference: REF });
  assert.throws(() => a.create({ guildId: GUILD, userId: MEMBER, actorId: MEMBER, startsOn: "2026-10-18", endsOn: "2026-10-25", reason: "Urlaub", timezone: TZ, reference: REF }), /schon eine Abmeldung/);
  assert.throws(() => a.create({ guildId: GUILD, userId: OTHER, actorId: OTHER, startsOn: "2026-10-14", endsOn: "2027-03-01", reason: "lang", timezone: TZ, maxDays: 60, reference: REF }), /höchstens 60 Tage/);
  assert.throws(() => a.create({ guildId: GUILD, userId: OTHER, actorId: OTHER, startsOn: "2026-10-01", endsOn: "2026-10-05", reason: "alt", timezone: TZ, reference: REF }), /Vergangenheit/);
  assert.ok(a.wasAbsent(GUILD, MEMBER, "2026-10-16T18:00:00Z", TZ));
  assert.ok(!a.wasAbsent(GUILD, MEMBER, "2026-10-22T18:00:00Z", TZ));
  assert.deepEqual([...a.absentUserIds(GUILD, "2026-10-15")], [MEMBER]);
  a.end({ guildId: GUILD, absenceId: row.id, actorId: MEMBER });
  assert.equal(a.absentUserIds(GUILD, "2026-10-15").size, 0);
  assert.throws(() => a.end({ guildId: GUILD, absenceId: row.id, actorId: MEMBER }), /bereits beendet/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM member_absences").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'absence.%'").get().n, 2);
});

function eventWith(db, { id, startsAt, status = "ended", participants }) {
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, GUILD, `Event ${id}`, "-", startsAt, "-", STAFF, status, startsAt);
  for (const [userId, state] of participants) db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,?,?)").run(id, userId, state, startsAt);
}

test("Rangliste zählt Woche/Monat; Abwesende und abgesagte Events zählen nicht", () => {
  const db = testDb(), act = createActivityService(db);
  eventWith(db, { id: "e1", startsAt: "2026-10-13T18:00:00Z", participants: [[MEMBER, "present"], [OTHER, "absent"]] });
  eventWith(db, { id: "e2", startsAt: "2026-10-12T18:00:00Z", participants: [[MEMBER, "signed_up"], [OTHER, "present"]] });
  eventWith(db, { id: "e3", startsAt: "2026-10-02T18:00:00Z", participants: [[OTHER, "present"]] });
  eventWith(db, { id: "e4", startsAt: "2026-10-13T20:00:00Z", status: "cancelled", participants: [[OTHER, "signed_up"]] });
  eventWith(db, { id: "e5", startsAt: "2026-10-20T18:00:00Z", status: "scheduled", participants: [[OTHER, "signed_up"]] });
  assert.equal(periodStart("week", TZ, REF).toISOString(), "2026-10-11T22:00:00.000Z", "Montag 00:00 Wiener Zeit");
  assert.deepEqual(act.leaderboard(GUILD, { period: "week", timezone: TZ, reference: REF }).map(r => [r.userId, r.count]), [[MEMBER, 2], [OTHER, 1]]);
  assert.deepEqual(act.leaderboard(GUILD, { period: "month", timezone: TZ, reference: REF }).map(r => [r.userId, r.count]), [[OTHER, 2], [MEMBER, 2]], "Gleichstand: mehr bestätigte Anwesenheiten zuerst");
});

test("Inaktivität: Nachrichten und Events zählen, Abgemeldete nie, Erfassungsbeginn schützt vor Fehlalarm", () => {
  const db = testDb(), act = createActivityService(db);
  act.trackingSince(GUILD, new Date("2026-08-01T00:00:00Z"));
  act.recordMessage(GUILD, MEMBER, new Date("2026-10-12T10:00:00Z"));
  assert.equal(act.recordMessage(GUILD, MEMBER, new Date("2026-10-12T10:00:30Z")), false, "Drosselung");
  eventWith(db, { id: "e1", startsAt: "2026-10-10T18:00:00Z", participants: [[OTHER, "present"]] });
  const members = [MEMBER, OTHER, STAFF, LEADER].map(id => ({ id, joinedAt: "2026-01-01T00:00:00Z" }));
  const report = act.inactivityReport(GUILD, members, { days: 14, absentIds: new Set([LEADER]), reference: REF });
  const byId = Object.fromEntries(report.map(r => [r.userId, r]));
  assert.equal(byId[MEMBER].inactive, false);
  assert.equal(byId[OTHER].inactive, false);
  assert.equal(byId[STAFF].inactive, true);
  assert.equal(byId[LEADER].inactive, false, "abgemeldet");
  assert.equal(byId[LEADER].absent, true);
  const fresh = createActivityService(testDb());
  assert.equal(fresh.inactivityReport(GUILD, [{ id: STAFF, joinedAt: "2026-01-01T00:00:00Z" }], { days: 14, reference: REF })[0].inactive, false, "Erfassung startet gerade erst");
});

function setup(extra = {}) {
  const db = testDb();
  const config = loadConfig({ DISCORD_TOKEN: "test-only", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: GUILD, ROLE_LEADERS: ROLE.leaders, ROLE_STAFF: ROLE.staff, ROLE_MODERATORS: ROLE.mods, ROLE_MEMBERS: ROLE.members, ...extra });
  const roleOf = { [LEADER]: [ROLE.leaders], [STAFF]: [ROLE.staff], [MOD]: [ROLE.mods], [MEMBER]: [ROLE.members], [OTHER]: [ROLE.members] };
  const level = { [LEADER]: 30, [STAFF]: 20, [MOD]: 10, [MEMBER]: 1, [OTHER]: 1 };
  const log = { dms: [], timeouts: [], kicks: [], bans: [], unbans: [], posts: [], roleAdds: [], roleRemoves: [] };
  const roleHigh = id => ({ position: level[id] ?? 0, comparePositionTo: other => (level[id] ?? 0) - other.position });
  const gm = id => ({
    id, user: { id, bot: false, username: `u${id.slice(-1)}` }, displayName: `User${id.slice(-1)}`, joinedAt: new Date("2026-01-01T00:00:00Z"),
    roles: { highest: roleHigh(id), cache: new Map((roleOf[id] ?? []).map(r => [r, { id: r, name: r, position: 1 }])), add: async r => { log.roleAdds.push([id, r]); }, remove: async r => { log.roleRemoves.push([id, r]); } },
    moderatable: true, kickable: true, bannable: true,
    timeout: async (ms, reason) => { log.timeouts.push({ id, ms, reason }); }, kick: async reason => { log.kicks.push({ id, reason }); },
  });
  const guild = { id: GUILD, name: "Gambinos", ownerId: "99999999999999999", memberCount: 5,
    members: { cache: new Map(), fetch: async arg => (typeof arg === "string" ? (roleOf[arg] ? gm(arg) : null) : new Map(Object.keys(roleOf).map(id => [id, gm(id)]))), ban: async (id, opts) => { log.bans.push({ id, opts }); }, unban: async id => { log.unbans.push(id); } },
    channels: { fetch: async () => null }, roles: { fetch: async () => new Map() } };
  const client = { ws: { ping: 12, status: 0 }, readyAt: new Date(), user: { id: "bot", tag: "Bot#0001" }, guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => guild },
    users: { fetch: async id => ({ id, username: `u${id.slice(-1)}`, send: async payload => { log.dms.push({ id, payload }); } }) },
    channels: { fetch: async id => ({ id, send: async payload => { log.posts.push({ id, payload }); } }) } };
  const handler = createHandler({ db, finance: createFinance(db), config, client });
  return { db, config, handler, log, guild, client, roleOf, gm };
}

function interaction(x, { userId, command, sub = null, options = {}, customId = null, fields = {} }) {
  const replies = [], updates = [], modals = [];
  return {
    id: String(Math.floor(Math.random() * 1e12)), replies, updates, modals, commandName: command, customId, guildId: GUILD, guild: x.guild, user: { id: userId, bot: false },
    member: x.gm(userId), inGuild: () => true, isChatInputCommand: () => !customId, isButton: () => Boolean(customId), isModalSubmit: () => false,
    options: { getSubcommand: () => sub, getUser: name => options[name] ? { id: options[name], bot: false } : null, getString: name => options[name] ?? null, getInteger: name => options[name] ?? null },
    fields: { getTextInputValue: key => fields[key] },
    reply: async payload => { replies.push(payload); return payload; }, update: async payload => { updates.push(payload); }, showModal: async m => { modals.push(m); },
  };
}
const text = payload => JSON.stringify(payload?.embeds?.map(e => e.data ?? e) ?? payload?.content);

test("/abwesend: melden, Doppelte ablehnen, beenden; Nicht-Mitglieder ausgeschlossen", async () => {
  const x = setup({ CHANNEL_ABSENCES: "50000000000000001" });
  const ok = interaction(x, { userId: MEMBER, command: "abwesend", sub: "melden", options: { von: "heute", bis: "in", grund: "Urlaub" } });
  await x.handler.command(ok);
  assert.match(text(ok.replies[0]), /kein gültiges Datum/);
  const good = interaction(x, { userId: MEMBER, command: "abwesend", sub: "melden", options: { von: "heute", bis: "morgen", grund: "Urlaub" } });
  await x.handler.command(good);
  assert.match(text(good.replies[0]), /Abmeldung eingetragen/);
  assert.equal(x.log.posts.length, 1, "öffentliche Meldung");
  assert.doesNotMatch(JSON.stringify(x.log.posts[0].payload), /Urlaub/, "Grund bleibt privat");
  const outsider = { ...interaction(x, { userId: "30000000000000099", command: "abwesend", sub: "melden", options: { von: "heute", bis: "morgen", grund: "x y" } }), member: { roles: { cache: new Map() } } };
  await x.handler.command(outsider);
  assert.match(text(outsider.replies[0]), /nur für Mitglieder/);
  const back = interaction(x, { userId: MEMBER, customId: "absence:back" });
  await x.handler.button(back);
  assert.match(text(back.replies[0]), /Willkommen zurück/);
  const list = interaction(x, { userId: STAFF, command: "abwesend", sub: "liste" });
  await x.handler.command(list);
  assert.match(text(list.replies[0]), /Gerade abgemeldet \(0\)/);
});

test("Abmelde-Rolle wird während der Abmeldung vergeben und danach entfernt", async () => {
  const x = setup({ ROLE_ABSENT: ROLE.absent });
  const a = createAbsenceService(x.db);
  const row = a.create({ guildId: GUILD, userId: MEMBER, actorId: MEMBER, startsOn: "2026-10-14", endsOn: "2026-10-15", reason: "Urlaub", timezone: TZ, reference: REF });
  await syncAbsenceRoles({ db: x.db, client: x.client, config: x.config, reference: REF });
  assert.deepEqual(x.log.roleAdds, [[MEMBER, ROLE.absent]]);
  await syncAbsenceRoles({ db: x.db, client: x.client, config: x.config, reference: REF });
  assert.equal(x.log.roleAdds.length, 1, "kein doppeltes Vergeben");
  a.end({ guildId: GUILD, absenceId: row.id, actorId: MEMBER });
  x.gm = x.gm; // Rolle im Fake-Cache vorhanden machen
  const original = x.guild.members.fetch;
  x.guild.members.fetch = async id => { const m = await original(id); m.roles.cache.set(ROLE.absent, { id: ROLE.absent }); return m; };
  await syncAbsenceRoles({ db: x.db, client: x.client, config: x.config, reference: REF });
  assert.deepEqual(x.log.roleRemoves, [[MEMBER, ROLE.absent]]);
});

test("Moderation: Timeout direkt, Kick/Bann nur nach Bestätigung, Rechte und Hierarchie", async () => {
  const x = setup();
  const t = interaction(x, { userId: MOD, command: "timeout", options: { mitglied: MEMBER, dauer: 60, grund: "Spam im Chat" } });
  await x.handler.command(t);
  assert.equal(x.log.timeouts[0].ms, 3_600_000);
  assert.equal(x.log.dms.length, 1);
  assert.match(text(t.replies[0]), /Timeout ausgeführt/);
  const modKick = interaction(x, { userId: MOD, command: "kick", options: { mitglied: MEMBER, grund: "Regelbruch" } });
  await x.handler.command(modKick);
  assert.match(text(modKick.replies[0]), /Staff-Rolle/);
  const kick = interaction(x, { userId: STAFF, command: "kick", options: { mitglied: MEMBER, grund: "Regelbruch" } });
  await x.handler.command(kick);
  assert.equal(x.log.kicks.length, 0, "erst nach Bestätigung");
  const confirmId = kick.replies[0].components[0].components[0].data.custom_id;
  const stranger = interaction(x, { userId: LEADER, customId: confirmId });
  await x.handler.button(stranger);
  assert.match(text(stranger.replies[0]), /Nur wer die Aktion gestartet hat/);
  const confirm = interaction(x, { userId: STAFF, customId: confirmId });
  await x.handler.button(confirm);
  assert.equal(x.log.kicks.length, 1);
  assert.match(text(confirm.updates[0]), /Kick ausgeführt/);
  await x.handler.button(interaction(x, { userId: STAFF, customId: confirmId }));
  assert.equal(x.log.kicks.length, 1, "Bestätigung nur einmal gültig");
  const staffBan = interaction(x, { userId: STAFF, command: "ban", options: { mitglied: MEMBER, grund: "Regelbruch" } });
  await x.handler.command(staffBan);
  assert.match(text(staffBan.replies[0]), /Leitungsrolle/);
  const modOnStaff = interaction(x, { userId: MOD, command: "timeout", options: { mitglied: STAFF, dauer: 10, grund: "Test" } });
  await x.handler.command(modOnStaff);
  assert.match(text(modOnStaff.replies[0]), /Leitung/);
  const self = interaction(x, { userId: MOD, command: "timeout", options: { mitglied: MOD, dauer: 10, grund: "Test" } });
  await x.handler.command(self);
  assert.match(text(self.replies[0]), /selbst/);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM moderation_actions").get().n, 2);
  assert.throws(() => x.db.prepare("DELETE FROM moderation_actions").run(), /dürfen nicht gelöscht werden/);
  assert.equal(auditChannelFor("moderation.kick", { CHANNEL_SANCTION_LOG: "5" }), "5");
  assert.match(hierarchyProblem({ action: "kick", actorMember: x.gm(MOD), targetMember: x.gm(STAFF) }), /über dir/);
  assert.match(hierarchyProblem({ action: "kick", actorMember: x.gm(LEADER), targetMember: { ...x.gm(MEMBER), kickable: false } }), /Bot-Rolle/);
});

test("Willkommensnachricht mit Platzhaltern, Link-Button und optionaler DM", async () => {
  const x = setup({ CHANNEL_WELCOME: "50000000000000002", CHANNEL_VERIFICATION_PANEL: "50000000000000003", WELCOME_DM_ENABLED: "true" });
  const dms = [];
  const member = { ...x.gm(OTHER), guild: x.guild, send: async p => { dms.push(p); } };
  const payload = welcomePayload({ member, config: x.config, texts: defaultsFor("welcome") });
  assert.equal(payload.content, `<@${OTHER}>`);
  assert.match(payload.embeds[0].data.description, /<#50000000000000003>/);
  assert.equal(payload.components[0].components[0].data.url, `https://discord.com/channels/${GUILD}/50000000000000003`);
  const result = await sendWelcome({ db: x.db, client: x.client, config: x.config, member });
  assert.deepEqual(result, { channel: true, dm: true });
  assert.equal((await sendWelcome({ db: x.db, client: x.client, config: x.config, member: { ...member, user: { bot: true } } })).channel, false);
});

test("Website: Aktivität, Profil mit Rechten, Status, Abmeldung eintragen und Erinnerung", async () => {
  const x = setup();
  const api = createDashboardApi({ db: x.db, client: x.client, config: x.config });
  const as = (id, ...roles) => ({ id, displayName: "Web", owner: false, roles: roles.map(r => ROLE[r]) });
  const get = (m, p) => api.get(m, new URL(p, "https://dash.example"));
  const post = (m, p, b) => api.post(m, new URL(p, "https://dash.example"), b);
  assert.equal((await post(as(MOD, "mods"), "/api/absences", { userId: MEMBER, from: "heute", until: "morgen", reason: "Krank" })).status, 403);
  assert.equal((await post(as(STAFF, "staff"), "/api/absences", { userId: MEMBER, from: "heute", until: "morgen", reason: "Krank" })).status, 200);
  assert.equal((await post(as(STAFF, "staff"), "/api/absences", { userId: MEMBER, from: "heute", until: "morgen", reason: "Krank" })).status, 409);
  const activity = await get(as(STAFF, "staff"), "/api/activity");
  assert.equal(activity.status, 200);
  assert.equal(activity.body.current.length, 1);
  assert.equal(activity.body.population, 2, "nur Familienmitglieder-Rolle");
  const profileMod = await get(as(MOD, "mods"), `/api/members/${MEMBER}/profile`);
  assert.equal(profileMod.status, 200);
  assert.equal(profileMod.body.profile.absentNow, true);
  assert.equal(profileMod.body.profile.finance, null, "keine Finanzdaten ohne Finanzrolle");
  assert.ok(profileMod.body.profile.warnings, "Moderation sieht Verwarnungen");
  assert.equal(profileMod.body.profile.tickets, null);
  assert.equal((await get(as(OTHER), `/api/members/${MEMBER}/profile`)).status, 403);
  const leaderProfile = await get(as(LEADER, "leaders"), `/api/members/${MEMBER}/profile`);
  assert.ok(leaderProfile.body.profile.finance);
  assert.equal((await get(as(LEADER, "leaders"), "/api/status")).status, 403, "Status nur für Bot-Owner");
  const status = await get({ ...as(STAFF), owner: true }, "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.bot.online, true);
  assert.equal(typeof status.body.database.schema, "number");
  const remind = await post(as(STAFF, "staff"), `/api/activity/${MEMBER}/remind`, { days: 20 });
  assert.equal(remind.status, 200);
  assert.ok(x.log.dms.some(d => d.id === MEMBER));
  const id = x.db.prepare("SELECT id FROM member_absences").get().id;
  assert.equal((await post(as(STAFF, "staff"), `/api/absences/${id}/end`, {})).status, 200);
});

test("Mein Bereich: nur eigene Daten, eigene Abmeldung und DM-Erinnerung; Team-Bereiche bleiben gesperrt", async () => {
  const x = setup();
  const api = createDashboardApi({ db: x.db, client: x.client, config: x.config });
  const me = { id: MEMBER, displayName: "Web", owner: false, roles: [], family: true, team: false };
  const get = p => api.get(me, new URL(p, "https://dash.example"));
  const post = (p, b) => api.post(me, new URL(p, "https://dash.example"), b);
  createFinance(x.db).credit({ guildId: GUILD, userId: MEMBER, actorId: LEADER, cents: 12_345, reason: "Event", key: "my-1" });
  createFinance(x.db).credit({ guildId: GUILD, userId: OTHER, actorId: LEADER, cents: 99_999, reason: "Event", key: "my-2" });
  const mine = await get("/api/my");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.account.gross, 12_345);
  assert.equal(mine.body.account.transactions.length, 1);
  assert.ok(!JSON.stringify(mine.body).includes("99999"), "keine fremden Kontodaten");
  assert.equal((await get("/api/me")).body.capabilities.team, false);
  for (const p of ["/api/accounts", "/api/sanctions", "/api/activity", "/api/status", `/api/members/${OTHER}/profile`]) assert.equal((await get(p)).status, 403, p);
  assert.equal((await post("/api/my/absence", { from: "heute", until: "morgen", reason: "Urlaub" })).status, 200);
  assert.equal((await get("/api/my")).body.absences.open.reason, "Urlaub");
  assert.equal((await post("/api/my/absence/end", {})).status, 200);
  assert.equal((await post("/api/my/reminders", { dm: true })).status, 200);
  assert.equal((await get("/api/my")).body.reminders.dm, true);
  assert.equal((await post("/api/absences", { userId: OTHER, from: "heute", until: "morgen", reason: "x" })).status, 403);
});
