import test from "node:test";
import assert from "node:assert/strict";
import { applicationQuestions, buildApplicationPanelPayload, buildApplicationReviewPayload, buildTicketPanelPayload } from "../src/commands.js";

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

test("Staff-Anträge zeigen verständliche Feldnamen statt technischer Schlüssel",()=>{
  const payload=buildApplicationReviewPayload("rang","12345678901234567",{name:"Danne",aktueller_rang:"Member",ziel_rang:"Leader",begruendung:"Aktiv"});
  assert.deepEqual(payload.embeds[0].data.fields.map(field=>field.name),["Dein Ingame-Name","Dein aktueller Familienrang","Welchen Rang beantragst du?","Warum sollst du den Rang erhalten?"]);
});

test("Ticket-Panel bleibt kurz und enthält keine Bewerbungsoption",()=>{
  const payload=buildTicketPanelPayload({TICKET_CATEGORIES_JSON:[{id:"support",label:"Support"},{id:"beschwerde",label:"Beschwerde"},{id:"leitung",label:"Leitung"}]});
  assert.equal(payload.embeds[0].data.fields,undefined);
  assert.deepEqual(payload.components[0].toJSON().components[0].options.map(option=>option.value),["support","beschwerde","leitung"]);
});
