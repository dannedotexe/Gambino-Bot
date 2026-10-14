import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { buildVerification, createVerificationService } from "../src/services/verification.js";
import { buildVerificationPanelPayload, createHandler } from "../src/commands.js";
import { createFinance } from "../src/services/finance.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", VERIFIED = "20000000000000009";

test("Name wird als „Vorname Nachname | ID“ gebaut und geprüft", () => {
  assert.equal(buildVerification({ ingameId: " 12345 ", firstName: "tony", lastName: "di napoli" }).nickname, "Tony Di Napoli | 12345");
  assert.equal(buildVerification({ ingameId: "#7", firstName: "Jürgen", lastName: "Müller-Lüdenscheidt" }).nickname, "Jürgen Müller-Lüdenscheidt | 7");
  assert.throws(() => buildVerification({ ingameId: "12a", firstName: "Tony", lastName: "Gambino" }), /Ziffern/);
  assert.throws(() => buildVerification({ ingameId: "1", firstName: "T0ny", lastName: "Gambino" }), /Vornamen/);
  assert.throws(() => buildVerification({ ingameId: "1234567890", firstName: "Maximilianaaaa", lastName: "Mustermannnnnn" }), /zu lang/);
  assert.deepEqual(buildVerificationPanelPayload().components[0].components.map(b => b.data.custom_id), ["verify:open", "verify:rename"]);
});

test("eine Ingame-ID gehört nur einem Discord-Konto; Neu-Verifizierung aktualisiert", () => {
  const db = testDb(), service = createVerificationService(db);
  const data = buildVerification({ ingameId: "555", firstName: "Tony", lastName: "Soprano" });
  service.save({ guildId: G, userId: "u1", data });
  assert.throws(() => service.save({ guildId: G, userId: "u2", data }), /bereits/);
  service.save({ guildId: G, userId: "u1", data: buildVerification({ ingameId: "556", firstName: "Tony", lastName: "Soprano" }) });
  assert.equal(service.byUser(G, "u1").ingame_id, "556");
  service.save({ guildId: G, userId: "u2", data });
  assert.deepEqual(db.prepare("SELECT action FROM audit_logs ORDER BY rowid").all().map(r => r.action), ["member.verified", "member.verification_updated", "member.verified"]);
});

function setup({ ownerId = "owner", nicknameFails = false } = {}) {
  const db = testDb(), config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_VERIFIED: VERIFIED });
  const client = { ws: { ping: 1 }, user: { id: "bot" }, users: { fetch: async () => ({ send: async () => {} }) } };
  const handler = createHandler({ db, finance: createFinance(db), config, client });
  const member = { nickname: null, roles: { cache: new Map(), add: async id => member.roles.cache.set(id, true) }, setNickname: async name => { if (nicknameFails) throw new Error("Missing Permissions"); member.nickname = name; } };
  const replies = [];
  const modal = (userId, values) => ({
    customId: "verify:submit", guildId: G, user: { id: userId }, inGuild: () => true, isModalSubmit: () => true,
    guild: { ownerId, members: { fetch: async () => member } },
    fields: { getTextInputValue: key => values[key] },
    reply: async p => replies.push(p), deferReply: async () => {}, editReply: async p => replies.push(p),
  });
  return { db, handler, member, replies, modal };
}
const text = payload => JSON.stringify(payload.embeds?.map(e => e.data ?? e));

test("Verifizierung setzt Namen und Rolle und speichert erst danach", async () => {
  const x = setup();
  await x.handler.modal(x.modal("30000000000000001", { ingame_id: "4711", first_name: "paulie", last_name: "walnuts" }));
  assert.equal(x.member.nickname, "Paulie Walnuts | 4711");
  assert.ok(x.member.roles.cache.has(VERIFIED));
  assert.equal(createVerificationService(x.db).byUser(G, "30000000000000001").nickname, "Paulie Walnuts | 4711");
  assert.match(text(x.replies.at(-1)), /Verifizierung abgeschlossen/);
});

test("ungültige Eingaben und fehlende Rechte speichern nichts", async () => {
  const bad = setup();
  await bad.handler.modal(bad.modal("30000000000000001", { ingame_id: "abc", first_name: "Paulie", last_name: "Walnuts" }));
  assert.match(text(bad.replies[0]), /Ziffern/);
  const denied = setup({ nicknameFails: true });
  await denied.handler.modal(denied.modal("30000000000000001", { ingame_id: "1", first_name: "Paulie", last_name: "Walnuts" }));
  assert.match(text(denied.replies.at(-1)), /nicht geändert/);
  assert.equal(denied.db.prepare("SELECT COUNT(*) n FROM member_verifications").get().n, 0);
  assert.ok(!denied.member.roles.cache.has(VERIFIED));
});

test("Server-Inhaber wird verifiziert und bekommt den Namen als Hinweis", async () => {
  const x = setup({ ownerId: "30000000000000001" });
  await x.handler.modal(x.modal("30000000000000001", { ingame_id: "1", first_name: "Danne", last_name: "Gambino" }));
  assert.equal(x.member.nickname, null);
  assert.match(text(x.replies.at(-1)), /Server-Inhaber/);
  assert.ok(x.member.roles.cache.has(VERIFIED));
});

test("Name ändern: nur für Verifizierte, aktualisiert Namen und protokolliert den alten", async () => {
  const x = setup();
  const notVerified = [];
  await x.handler.button({ customId: "verify:rename", guildId: G, user: { id: "30000000000000001" }, inGuild: () => true, reply: async p => notVerified.push(p) });
  assert.match(text(notVerified[0]), /noch nicht verifiziert/);
  await x.handler.modal(x.modal("30000000000000001", { ingame_id: "4711", first_name: "Paulie", last_name: "Walnuts" }));
  let shown = null;
  await x.handler.button({ customId: "verify:rename", guildId: G, user: { id: "30000000000000001" }, inGuild: () => true, showModal: async m => { shown = m; } });
  assert.equal(shown.data.title, "Namen ändern (ID 4711)");
  assert.deepEqual(shown.components.map(row => row.components[0].data.custom_id), ["first_name", "last_name"], "ID ist nicht änderbar");
  assert.equal(shown.components[0].components[0].data.value, "Paulie", "bisherige Angaben vorausgefüllt");
  const again = [];
  await x.handler.button({ customId: "verify:open", guildId: G, user: { id: "30000000000000001" }, inGuild: () => true, reply: async p => again.push(p) });
  assert.match(text(again[0]), /bereits verifiziert/);
  const rename = x.modal("30000000000000001", { ingame_id: "9999", first_name: "Paul", last_name: "Gualtieri" });
  rename.customId = "verify:rename-submit";
  await x.handler.modal(rename);
  assert.equal(x.member.nickname, "Paul Gualtieri | 4711");
  assert.match(text(x.replies.at(-1)), /Name geändert[\s\S]*Vorher: Paulie Walnuts \| 4711/);
  const log = x.db.prepare("SELECT details FROM audit_logs WHERE action='member.verification_updated'").get();
  assert.match(log.details, /Paulie Walnuts/);
});

test("Bestehende Namen werden einmalig auf „Vorname Nachname | ID“ umgestellt, eigene Namen bleiben", async () => {
  const { migrateNicknameFormat } = await import("../src/nickname-migration.js");
  const { testDb } = await import("./helpers.js");
  const db = testDb(), now = new Date().toISOString();
  const insert = (userId, id, first, last) => db.prepare("INSERT INTO member_verifications(guild_id,user_id,ingame_id,first_name,last_name,nickname,verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(G, userId, id, first, last, `${id} | ${first} ${last}`, now, now);
  insert("30000000000000001", "12", "Tony", "Soprano");
  insert("30000000000000002", "13", "Paulie", "Walnuts");
  const renamed = [];
  const member = (id, nickname) => ({ id, nickname, setNickname: async n => { renamed.push([id, n]); } });
  const guild = { ownerId: "1", members: { fetch: async id => id === "30000000000000001" ? member(id, "12 | Tony Soprano") : member(id, "Paulie (eigener Name)") } };
  const client = { user: { id: "bot" }, guilds: { cache: new Map([[G, guild]]) } };
  const config = { DISCORD_GUILD_ID: G };
  const result = await migrateNicknameFormat({ db, client, config, delayMs: 0 });
  assert.deepEqual(renamed, [["30000000000000001", "Tony Soprano | 12"]]);
  assert.equal(result.renamed, 1);
  assert.equal(db.prepare("SELECT nickname FROM member_verifications WHERE user_id='30000000000000002'").get().nickname, "Paulie Walnuts | 13", "gespeicherter Name immer aktualisiert");
  assert.equal(await migrateNicknameFormat({ db, client, config, delayMs: 0 }), null, "läuft nur einmal");
});
