import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createTextsService, panelTexts, validateTexts } from "../src/services/texts.js";
import { buildApplicationPanelPayload, buildTicketPanelPayload } from "../src/commands.js";
import { ensurePanels } from "../src/panels.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001";

test("Standardtexte entsprechen dem bisherigen Bewerbungs-Panel", () => {
  const payload = buildApplicationPanelPayload().embeds[0].toJSON();
  assert.equal(payload.title, "📋  Bewerbungen & Rang-Anträge");
  assert.equal(payload.fields.length, 3);
  assert.equal(payload.color, 0xd4af37);
});

test("Panel-Texte werden validiert, gespeichert, angewendet und zurückgesetzt", () => {
  const db = testDb(), texts = createTextsService(db, G);
  assert.throws(() => texts.update({ panel: "application", values: { buttonApply: "" }, actorId: "u" }), /darf nicht leer/);
  assert.throws(() => texts.update({ panel: "application", values: { title: "x".repeat(257) }, actorId: "u" }), /höchstens 256/);
  assert.throws(() => texts.update({ panel: "application", values: { color: "rot" }, actorId: "u" }), /Farbe/);
  assert.throws(() => validateTexts("ticket", { title: "", description: "" }), /Titel oder Beschreibung/);
  texts.update({ panel: "application", values: { ...panelTexts(db, G, "application"), title: "Komm zu den Gambinos", field2Name: "", buttonRank: "Rang-Antrag stellen", color: "#FF0000" }, actorId: "u" });
  const embed = buildApplicationPanelPayload(panelTexts(db, G, "application"));
  const json = embed.embeds[0].toJSON();
  assert.equal(json.title, "Komm zu den Gambinos");
  assert.equal(json.fields.length, 2, "leeres Feld wird ausgeblendet");
  assert.equal(json.color, 0xff0000);
  assert.equal(embed.components[0].components[1].data.label, "Rang-Antrag stellen");
  assert.equal(embed.components[0].components[0].data.custom_id, "application:open:bewerbung", "Funktion der Buttons bleibt gleich");
  texts.update({ panel: "ticket", values: { ...panelTexts(db, G, "ticket"), placeholder: "Worum geht es?" }, actorId: "u" });
  const ticket = buildTicketPanelPayload({ TICKET_CATEGORIES_JSON: [{ id: "support", label: "Support" }] }, panelTexts(db, G, "ticket"));
  assert.equal(ticket.components[0].toJSON().components[0].placeholder, "Worum geht es?");
  texts.reset({ panel: "application", actorId: "u" });
  assert.equal(panelTexts(db, G, "application").title, "📋  Bewerbungen & Rang-Anträge");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='config.changed'").get().n, 3);
});

test("ein bereits gepostetes Panel wird übernommen und aktualisiert statt doppelt gepostet", async () => {
  const db = testDb(), edits = [], sent = [];
  const existing = { id: "old-panel", author: { id: "bot" }, components: [{ components: [{ customId: "application:open:bewerbung" }] }], edit: async payload => edits.push(payload) };
  const other = { id: "chat", author: { id: "user" }, components: [] };
  const channel = { id: "77777777777777777", isTextBased: () => true, send: async payload => { sent.push(payload); return { id: "new" }; },
    messages: { fetch: async arg => (typeof arg === "object" ? new Map([["chat", other], ["old-panel", existing]]) : arg === "old-panel" ? existing : null) } };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel } };
  const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G }), CHANNEL_APPLICATION_PANEL: channel.id };
  createTextsService(db, G).update({ panel: "application", values: { ...panelTexts(db, G, "application"), title: "Neuer Titel" }, actorId: "u" });
  const [result] = await ensurePanels({ db, client, config, series: null, only: ["CHANNEL_APPLICATION_PANEL"] });
  assert.equal(result.status, "adopted");
  assert.equal(sent.length, 0);
  assert.equal(edits[0].embeds[0].toJSON().title, "Neuer Titel");
  assert.equal((await ensurePanels({ db, client, config, series: null, only: ["CHANNEL_APPLICATION_PANEL"] }))[0].status, "ok");
  assert.equal(sent.length, 0);
});
