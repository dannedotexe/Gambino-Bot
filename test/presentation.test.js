import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { applicationDecisionDm, applicationInReviewDm, applicationSubmittedDm, auditLogPayload, presentInteractionPayload } from "../src/presentation.js";

test("private Antragsentscheidung nennt Typ, Referenz und Ablehnungsgrund", () => {
  const payload = applicationDecisionDm({ kind: "rang", status: "rejected", applicationId: "request-123", reason: "Noch zu wenig Erfahrung" });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /abgelehnt/i);
  assert.match(embed.description, /Rang-Antrag/);
  assert.equal(embed.fields.find(field => field.name === "Referenz").value, "`REQUEST-`");
  assert.equal(embed.fields.find(field => field.name === "Begründung").value, "Noch zu wenig Erfahrung");
});

test("private Eingangsbestätigung nennt Bearbeitungsstatus, Typ und Referenz", () => {
  const payload = applicationInReviewDm({ kind: "rang", applicationId: "request-456", reviewerId: "12345678901234567" });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /bearbeitet/i);
  assert.match(embed.description, /Rang-Antrag/);
  assert.match(embed.description, /in Bearbeitung/);
  assert.equal(embed.fields.find(field => field.name === "Referenz").value, "`REQUEST-`");
  assert.equal(embed.fields.find(field => field.name === "Zuständig").value, "<@12345678901234567>");
});

test("private Eingangsbestätigung informiert klar über Weiterleitung und spätere Updates", () => {
  const payload = applicationSubmittedDm({ kind: "bewerbung", applicationId: "request-789" });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /eingegangen/i);
  assert.match(embed.description, /Familienbewerbung/);
  assert.match(embed.description, /weitergeleitet/i);
  assert.equal(embed.fields.find(field => field.name === "Referenz").value, "`REQUEST-`");
});

test("Audit-Einträge sind als deutsche, strukturierte Einbettung formatiert", () => {
  const payload = auditLogPayload({
    action: "sanction.created", actor_id: "11111111111111111", target_id: "22222222222222222",
    created_at: "2026-10-11T18:00:00.000Z",
    details: JSON.stringify({ sanctionId: "abc123456789000", cents: 5000000, reason: "Regelverstoß" }),
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, "⚖️ Sanktion vorgemerkt");
  assert.equal(embed.fields.find(field => field.name === "🎯 Betroffenes Mitglied").value, "<@22222222222222222>");
  assert.equal(embed.fields.find(field => field.name === "Betrag").value, "50 000,00 $");
  assert.ok(embed.fields.some(field => field.name === "Grund" && field.value === "Regelverstoß"));
  assert.equal(embed.description, undefined);
});

test("einfache Befehlsantworten werden gebrandet und behalten Ephemeral-Optionen", () => {
  const payload = presentInteractionPayload({ content: "Sanktion wurde gespeichert.", ephemeral: true });
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.equal(payload.ephemeral, undefined);
  assert.equal(payload.embeds[0].data.author.name, "GAMBINOS  •  FAMILIENVERWALTUNG");
  assert.match(payload.embeds[0].data.title, /Sanktion/);
  assert.equal(payload.embeds[0].data.description, "Sanktion wurde gespeichert.");
});

test("auch bereits gestaltete private Antworten verwenden die aktuelle Discord-Flag", () => {
  const payload = presentInteractionPayload({ embeds: [{ title: "Test" }], ephemeral: true });
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.equal(payload.ephemeral, undefined);
});

test("bekannte Aktionen bekommen verständliche deutsche Protokolltitel", () => {
  const payload = auditLogPayload({
    action: "application.claimed", actor_id: "11111111111111111", target_id: "request-123",
    created_at: "2026-10-11T18:00:00.000Z", details: JSON.stringify({ kind: "rang", applicantId: "22222222222222222" }),
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, "🔎 Antrag zur Bearbeitung übernommen");
  assert.equal(embed.fields.find(field => field.name === "🎯 Betroffenes Mitglied").value, "<@22222222222222222>");
  assert.equal(embed.fields.find(field => field.name === "🧾 Antragsreferenz").value, "`REQUEST-`");
  assert.ok(embed.fields.some(field => field.name === "Antragstyp" && field.value === "Rang-Antrag"));
  assert.ok(embed.fields.some(field => field.name === "🕒 Zeitpunkt"));
  assert.ok(!embed.fields.some(field => field.name === "action" || field.value.includes("Actor")));
});
