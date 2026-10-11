import test from "node:test";
import assert from "node:assert/strict";
import { applicationQuestions, buildApplicationPanelPayload } from "../src/commands.js";

test("Bewerbung und Rang-Antrag zeigen unterschiedliche gezielte Fragen",()=>{
  const application=applicationQuestions("bewerbung").map(question=>question.id);
  const rank=applicationQuestions("rang").map(question=>question.id);
  assert.deepEqual(application,["name","alter","erfahrung","motivation","aktivitaet"]);
  assert.deepEqual(rank,["name","aktueller_rang","ziel_rang","begruendung"]);
  assert.notDeepEqual(application,rank);
});

test("Bewerbungs-Panel enthält zwei getrennte Antragsbuttons",()=>{
  const payload=buildApplicationPanelPayload();
  assert.equal(payload.embeds[0].data.color,0xd4af37);
  assert.deepEqual(payload.components[0].components.map(button=>button.data.custom_id),["application:open:bewerbung","application:open:rang"]);
});
