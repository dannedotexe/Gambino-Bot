import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { testDb } from "./helpers.js";
import { createEventService } from "../src/services/events.js";
import { createGiveawayService } from "../src/services/giveaways.js";
import { canHandleTicket, createTicketService } from "../src/services/tickets.js";
import { assignRankRole, createApplicationService, questionsFor } from "../src/services/applications.js";
import { collectStats, recordMemberChange } from "../src/services/stats.js";
import { evaluateMessage, exemptionReason } from "../src/services/automod.js";
import { accessGroups, configWarnings, loadConfig } from "../src/config.js";
import { dueReminder } from "../src/scheduler.js";
import { createFinance } from "../src/services/finance.js";

const now = () => new Date().toISOString();
const future = (minutes = 120) => new Date(Date.now() + minutes * 60_000).toISOString();
const baseConfig = loadConfig({ DISCORD_TOKEN: "test-only", DISCORD_CLIENT_ID: "12345678901234567" });
const actions = db => db.prepare("SELECT action FROM audit_logs ORDER BY rowid").all().map(r => r.action);

function addEvent(db, max = null, status = "scheduled") {
  db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,max_participants,status,created_at) VALUES('e','g','Event','',?,'HQ','host',?,?,?)").run(future(), max, status, now());
}

test("Event-Anmeldung: doppelte Klicks, Warteliste bei vollem Event, Nachrücken", () => {
  const db = testDb(), events = createEventService(db);
  addEvent(db, 1);
  assert.equal(events.join({ guildId: "g", eventId: "e", userId: "a" }).status, "joined");
  assert.equal(events.join({ guildId: "g", eventId: "e", userId: "a" }).status, "already");
  const waiting = events.join({ guildId: "g", eventId: "e", userId: "b" });
  assert.equal(waiting.status, "waitlisted"); assert.equal(waiting.position, 1);
  assert.equal(events.join({ guildId: "g", eventId: "e", userId: "c" }).position, 2);
  assert.equal(events.join({ guildId: "g", eventId: "e", userId: "b" }).status, "already_waiting");
  const left = events.leave({ guildId: "g", eventId: "e", userId: "a" });
  assert.equal(left.status, "left"); assert.deepEqual(left.promoted, ["b"], "Erster auf der Warteliste rückt nach");
  assert.equal(events.leave({ guildId: "g", eventId: "e", userId: "a" }).status, "not_joined");
  assert.deepEqual(events.participants("e").map(p => p.user_id), ["b"]);
  assert.deepEqual(events.waitlist("e"), ["c"]);
  assert.equal(events.leave({ guildId: "g", eventId: "e", userId: "c" }).status, "left_waitlist");
  assert.deepEqual(events.waitlist("e"), []);
  assert.equal(events.join({ guildId: "other-guild", eventId: "e", userId: "d" }).status, "closed");
  assert.ok(actions(db).every(a => a === "event.participation"));
});

test("Anwesenheit kann auch ohne Anmeldung dokumentiert werden und wird protokolliert", () => {
  const db = testDb(), events = createEventService(db);
  addEvent(db);
  const result = events.setAttendance({ guildId: "g", eventId: "e", userId: "x", status: "present", actorId: "staff" });
  assert.equal(result.previous, null);
  assert.equal(db.prepare("SELECT status FROM event_participants WHERE user_id='x'").get().status, "present");
  assert.equal(events.setAttendance({ guildId: "g", eventId: "missing", userId: "x", status: "present", actorId: "staff" }), null);
  assert.deepEqual(actions(db), ["event.attendance"]);
});

test("Giveaway: keine doppelte Teilnahme, Rollenbedingung, Abmeldung", () => {
  const db = testDb(), giveaways = createGiveawayService(db);
  db.prepare("INSERT INTO giveaways(id,guild_id,prize,ends_at,winner_count,conditions,status,created_by,created_at,required_role_id) VALUES('w','g','Auto',?,1,'','active','staff',?,'role-1')").run(future(), now());
  assert.equal(giveaways.join({ guildId: "g", giveawayId: "w", userId: "a", memberRoleIds: [] }).status, "missing_role");
  assert.equal(giveaways.join({ guildId: "g", giveawayId: "w", userId: "a", memberRoleIds: ["role-1"] }).status, "joined");
  assert.equal(giveaways.join({ guildId: "g", giveawayId: "w", userId: "a", memberRoleIds: ["role-1"] }).status, "already");
  assert.equal(giveaways.leave({ guildId: "g", giveawayId: "w", userId: "a" }).status, "left");
  assert.equal(giveaways.entryCount("w"), 0);
});

test("Giveaway wird nach Neustart genau einmal ausgelost; abgebrochene nie", () => {
  const db = testDb();
  db.prepare("INSERT INTO giveaways(id,guild_id,prize,ends_at,winner_count,conditions,status,created_by,created_at) VALUES('w','g','Preis',?,2,'','active','staff',?)").run(future(), now());
  const before = createGiveawayService(db);
  for (const user of ["a", "b", "c"]) before.join({ guildId: "g", giveawayId: "w", userId: user });
  // "Neustart": neue Service-Instanz liest nur aus der Datenbank.
  const restarted = createGiveawayService(db, { random: () => 0 });
  const first = restarted.draw("w");
  assert.equal(first.entries, 3); assert.equal(first.winners.length, 2);
  assert.equal(new Set(first.winners).size, 2);
  assert.equal(restarted.draw("w"), null);
  assert.deepEqual(JSON.parse(db.prepare("SELECT winners FROM giveaways WHERE id='w'").get().winners), first.winners);
  db.prepare("INSERT INTO giveaways(id,guild_id,prize,ends_at,winner_count,conditions,status,created_by,created_at) VALUES('x','g','Preis',?,1,'','active','staff',?)").run(future(), now());
  assert.ok(restarted.cancel({ guildId: "g", giveawayId: "x", actorId: "staff" }));
  assert.equal(restarted.draw("x"), null);
  assert.equal(restarted.cancel({ guildId: "g", giveawayId: "x", actorId: "staff" }), null);
});

test("Ticket-Statusübergänge und Kategorie-Rollen", () => {
  const db = testDb(), tickets = createTicketService(db);
  const config = { TICKET_CATEGORIES_JSON: [{ id: "leitung", label: "Leitung", roleIds: ["lead-role"] }] };
  db.prepare("INSERT INTO tickets(id,guild_id,channel_id,user_id,category,status,created_at,updated_at) VALUES('t','g','c','u','leitung','open',?,?)").run(now(), now());
  const ticket = db.prepare("SELECT * FROM tickets WHERE id='t'").get();
  assert.equal(canHandleTicket({ memberRoleIds: ["lead-role"] }, ticket, config, ["staff-role"]), true);
  assert.equal(canHandleTicket({ memberRoleIds: ["member"] }, ticket, config, ["staff-role"]), false);
  assert.ok(tickets.claim({ guildId: "g", ticketId: "t", actorId: "s1" }));
  assert.equal(tickets.claim({ guildId: "g", ticketId: "t", actorId: "s2" }), null);
  assert.ok(tickets.close({ guildId: "g", ticketId: "t", actorId: "s1", transcript: [{ content: "hi" }] }));
  assert.equal(tickets.close({ guildId: "g", ticketId: "t", actorId: "s1" }), null);
  assert.ok(tickets.reopen({ guildId: "g", ticketId: "t", actorId: "s1" }));
  assert.ok(tickets.markChannelMissing({ ticketId: "t", actorId: "bot" }));
  const row = db.prepare("SELECT status,channel_id,claimed_by,closed_by FROM tickets WHERE id='t'").get();
  assert.deepEqual({ ...row }, { status: "closed", channel_id: null, claimed_by: "s1", closed_by: "bot" });
  assert.equal(tickets.reopen({ guildId: "g", ticketId: "t", actorId: "s1" }), null, "ohne Channel kein Wiederöffnen");
  assert.equal(JSON.parse(db.prepare("SELECT messages FROM ticket_transcripts WHERE ticket_id='t'").get().messages).length, 1);
  assert.deepEqual(actions(db), ["ticket.claimed", "ticket.closed", "ticket.reopened", "ticket.channel_missing"]);
});

test("Antragsfragen sind konfigurierbar und werden validiert", () => {
  const cfg = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", APPLICATION_QUESTIONS_JSON: JSON.stringify({ rang: [{ id: "grund", label: "Warum?", style: "paragraph" }] }) });
  assert.deepEqual(questionsFor("rang", cfg).map(q => q.id), ["grund"]);
  assert.equal(questionsFor("bewerbung", cfg).length, 5);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", APPLICATION_QUESTIONS_JSON: JSON.stringify({ rang: [{ id: "a", label: "x".repeat(46) }] }) }), /APPLICATION_QUESTIONS_JSON/);
});

test("Antragsnotizen werden gespeichert, ohne Inhalt im Audit-Log", () => {
  const db = testDb(), apps = createApplicationService(db);
  db.prepare("INSERT INTO applications(id,guild_id,user_id,kind,answers,status,created_at,updated_at) VALUES('a','g','u','rang','{}','review',?,?)").run(now(), now());
  apps.addNote({ guildId: "g", applicationId: "a", authorId: "r", note: "Geheime Einschätzung" });
  assert.equal(apps.notes("a")[0].note, "Geheime Einschätzung");
  assert.doesNotMatch(db.prepare("SELECT details FROM audit_logs").get().details, /Geheime/);
  assert.throws(() => apps.addNote({ guildId: "g", applicationId: "missing", authorId: "r", note: "xx" }), /nicht gefunden/);
});

function fakeGuild({ rolePermissions = 0n, rolePosition = 1, botPosition = 5, managed = false } = {}) {
  const added = [];
  const has = flag => (rolePermissions & flag) === flag;
  return {
    added, id: "g",
    roles: { fetch: async id => (id === "rank-role" ? { id, managed, position: rolePosition, permissions: { has } } : null) },
    members: {
      me: { permissions: { has: flag => flag === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: botPosition } } },
      fetch: async id => ({ id, roles: { cache: new Map(), add: async role => { added.push(role); } } }),
    },
  };
}

test("Rang-Rollen werden nur ausdrücklich, geprüft und einmalig vergeben", async () => {
  const db = testDb();
  db.prepare("INSERT INTO applications(id,guild_id,user_id,kind,answers,status,created_at,updated_at) VALUES('a','g','u','rang','{}','accepted',?,?)").run(now(), now());
  const off = { ...baseConfig, RANK_ROLE_ASSIGNMENT_ENABLED: false, RANK_ROLES_JSON: [{ label: "Rang 2", roleId: "rank-role" }] };
  const on = { ...off, RANK_ROLE_ASSIGNMENT_ENABLED: true };
  assert.equal((await assignRankRole({ db, config: off, guild: fakeGuild(), applicationId: "a", roleId: "rank-role", actorId: "lead" })).ok, false);
  assert.equal((await assignRankRole({ db, config: on, guild: fakeGuild(), applicationId: "a", roleId: "other", actorId: "lead" })).ok, false);
  const dangerous = await assignRankRole({ db, config: on, guild: fakeGuild({ rolePermissions: PermissionFlagsBits.Administrator }), applicationId: "a", roleId: "rank-role", actorId: "lead" });
  assert.match(dangerous.message, /Adminrechte/);
  const tooHigh = await assignRankRole({ db, config: on, guild: fakeGuild({ rolePosition: 9 }), applicationId: "a", roleId: "rank-role", actorId: "lead" });
  assert.match(tooHigh.message, /Hierarchie/);
  const guild = fakeGuild();
  assert.equal((await assignRankRole({ db, config: on, guild, applicationId: "a", roleId: "rank-role", actorId: "lead" })).ok, true);
  assert.deepEqual(guild.added, ["rank-role"]);
  assert.equal((await assignRankRole({ db, config: on, guild, applicationId: "a", roleId: "rank-role", actorId: "lead" })).ok, false);
  assert.deepEqual(guild.added, ["rank-role"]);
  assert.deepEqual(actions(db), ["application.role_failed", "application.role_failed", "application.role_granted"]);
});

test("Statistik nennt Zeitraum und blendet Finanzen ohne Berechtigung aus", () => {
  const db = testDb(), finance = createFinance(db);
  finance.credit({ guildId: "g", userId: "u", actorId: "s", cents: 5000, reason: "Event", key: "k" });
  recordMemberChange(db, "g", "join", 10); recordMemberChange(db, "g", "leave", 9);
  db.prepare("INSERT INTO tickets(id,guild_id,user_id,category,status,created_at,updated_at) VALUES('t','g','u','support','open',?,?)").run(now(), now());
  const pub = collectStats(db, "g", { days: 7 });
  assert.equal(pub.finance, undefined);
  assert.deepEqual({ ...pub.members }, { joins: 1, leaves: 1 });
  assert.equal(pub.tickets.created, 1);
  assert.equal(collectStats(db, "g", { days: 7, includeFinance: true }).finance.credited.n, 5000);
  assert.equal(collectStats(db, "g", { days: 7, reference: new Date(Date.now() + 30 * 86_400_000) }).tickets.created, 0);
});

test("AutoMod erkennt Spam, Wiederholungen, Begriffe und fremde Links; Staff ist ausgenommen", () => {
  const cfg = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", AUTOMOD_BLOCKED_TERMS: "verboten", AUTOMOD_ALLOWED_DOMAINS: "discord.gg" });
  const at = Date.now();
  assert.equal(evaluateMessage({ content: "hallo", history: [] }, cfg), null);
  assert.equal(evaluateMessage({ content: "x", history: Array.from({ length: 4 }, () => ({ at, content: "y" })) }, cfg), "message_spam");
  assert.equal(evaluateMessage({ content: "Kauf jetzt", history: [{ at, content: "kauf  jetzt" }, { at, content: "KAUF JETZT" }] }, cfg), "duplicate_message");
  assert.equal(evaluateMessage({ content: "das ist VERBOTEN", history: [] }, cfg), "blocked_term");
  assert.equal(evaluateMessage({ content: "https://discord.gg/abc", history: [] }, cfg), null);
  assert.equal(evaluateMessage({ content: "https://evil.example/x", history: [] }, cfg), "unapproved_link");
  assert.equal(exemptionReason({ memberRoleIds: ["staff"] }, cfg, ["staff"]), "staff_role");
  assert.equal(exemptionReason({ canManageMessages: true }, cfg, []), "moderator_permission");
  assert.equal(exemptionReason({ memberRoleIds: [] }, cfg, ["staff"]), null);
  assert.deepEqual(cfg.AUTOMOD_LINK_ACTIONS, ["delete", "warn", "alert"]);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", AUTOMOD_SPAM_ACTIONS: "ban" }), /AUTOMOD_SPAM_ACTIONS/);
});

test("Event-Erinnerungen: richtige Stufe, keine Wiederholung, verpasste Stufen übersprungen", () => {
  const ref = new Date("2026-10-13T18:00:00Z");
  const at = minutes => new Date(ref.getTime() + minutes * 60_000).toISOString();
  assert.equal(dueReminder(at(90), [60, 15], [], ref), null);
  assert.deepEqual(dueReminder(at(50), [60, 15], [], ref), { slot: 60, skipped: [] });
  assert.equal(dueReminder(at(50), [60, 15], [60], ref), null);
  assert.deepEqual(dueReminder(at(10), [60, 15], [], ref), { slot: 15, skipped: [60] });
  assert.equal(dueReminder(at(10), [60, 15], [15], ref), null);
  assert.equal(dueReminder(at(-1), [60, 15], [], ref), null);
});

test("Konfiguration: Rollenstufen, Standardwerte und Hinweise ohne erfundene IDs", () => {
  const cfg = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", ROLE_LEADERS: "11111111111111111", ROLE_FINANCE: "22222222222222222", PAYOUT_MINIMUM_CENTS: "", EVENT_REMINDER_MINUTES: "15,60,15" });
  const groups = accessGroups(cfg);
  assert.deepEqual(groups.finance, ["11111111111111111", "22222222222222222"]);
  assert.deepEqual(groups.staff, ["11111111111111111"]);
  assert.deepEqual(groups.members, []);
  assert.equal(cfg.PAYOUT_MINIMUM_CENTS, undefined, "leerer Mindestbetrag zeigt alle Konten");
  assert.deepEqual(cfg.EVENT_REMINDER_MINUTES, [60, 15]);
  assert.equal(cfg.TIMEZONE, "Europe/Vienna");
  const warnings = configWarnings(cfg);
  assert.ok(warnings.some(w => w.startsWith("ROLE_STAFF")));
  assert.ok(warnings.some(w => w.startsWith("CHANNEL_AUDIT_LOG")));
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", TIMEZONE: "Mars/Base" }), /TIMEZONE/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", RANK_ROLE_ASSIGNMENT_ENABLED: "true" }), /RANK_ROLES_JSON/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", ROLE_STAFF: "123" }), /ROLE_STAFF/);
});
