import test from "node:test";
import assert from "node:assert/strict";
import { applicationDecisionDm, auditLogPayload, presentInteractionPayload } from "../src/presentation.js";

test("private Antragsentscheidung nennt Typ, Referenz und Ablehnungsgrund", () => {
  const payload = applicationDecisionDm({ kind: "rang", status: "rejected", applicationId: "request-123", reason: "Noch zu wenig Erfahrung" });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /abgelehnt/i);
  assert.match(embed.description, /Rang-Antrag/);
  assert.equal(embed.fields.find(field => field.name === "Referenz").value, "`request-123`");
  assert.equal(embed.fields.find(field => field.name === "Begründung").value, "Noch zu wenig Erfahrung");
});

test("Audit-Einträge sind als deutsche, strukturierte Einbettung formatiert", () => {
  const payload = auditLogPayload({
    action: "sanction.created", actor_id: "11111111111111111", target_id: "22222222222222222",
    created_at: "2026-10-11T18:00:00.000Z",
    details: JSON.stringify({ sanctionId: "abc123456789000", cents: 5000000, reason: "Regelverstoß" }),
  });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, "Sanktion vorgemerkt");
  assert.equal(embed.fields.find(field => field.name === "Betroffene Person").value, "<@22222222222222222>");
  assert.equal(embed.fields.find(field => field.name === "Betrag").value, "50 000,00 $");
  assert.ok(embed.fields.some(field => field.name === "Grund" && field.value === "Regelverstoß"));
  assert.equal(embed.description, undefined);
});

test("einfache Befehlsantworten werden gebrandet und behalten Ephemeral-Optionen", () => {
  const payload = presentInteractionPayload({ content: "Sanktion wurde gespeichert.", ephemeral: true });
  assert.equal(payload.ephemeral, true);
  assert.equal(payload.embeds[0].data.author.name, "GAMBINOS  •  BOT");
  assert.equal(payload.embeds[0].data.description, "Sanktion wurde gespeichert.");
});
