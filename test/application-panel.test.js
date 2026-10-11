import test from "node:test";
import assert from "node:assert/strict";
import { applicationQuestions, applicationReviewChannelKey, buildApplicationPanelPayload, buildApplicationReviewPayload, buildTicketPanelPayload } from "../src/commands.js";

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

test("Eine abgelehnte Bewerbung zeigt den Status und den gespeicherten Grund",()=>{
  const payload=buildApplicationReviewPayload("rang","12345678901234567",{name:"Danne",aktueller_rang:"Member",ziel_rang:"Leader",begruendung:"Aktiv"},"rejected","Es fehlen noch aktive Event-Teilnahmen.");
  assert.match(payload.embeds[0].data.description,/Abgelehnt/);
  assert.match(payload.embeds[0].data.footer.text,/Es fehlen noch aktive Event-Teilnahmen/);
  assert.equal(payload.embeds[0].data.color,0xe74c3c);
});

test("Übernommene Anträge zeigen den Bearbeiter und den Prüfstatus",()=>{
  const payload=buildApplicationReviewPayload("rang","12345678901234567",{name:"Danne",aktueller_rang:"Member",ziel_rang:"Leader",begruendung:"Aktiv"},"review","","98765432109876543");
  assert.match(payload.embeds[0].data.description,/In Prüfung/);
  assert.match(payload.embeds[0].data.description,/<@98765432109876543>/);
  assert.match(payload.embeds[0].data.footer.text,/Bearbeitung übernommen/);
});

test("Familienbewerbung und Rang-Antrag werden an getrennte Staff-Channels geroutet",()=>{
  assert.equal(applicationReviewChannelKey("bewerbung"),"CHANNEL_APPLICATION_REVIEW");
  assert.equal(applicationReviewChannelKey("rang"),"CHANNEL_RANK_REVIEW");
});

test("Ticket-Panel bleibt kurz und enthält keine Bewerbungsoption",()=>{
  const payload=buildTicketPanelPayload({TICKET_CATEGORIES_JSON:[{id:"support",label:"Support"},{id:"beschwerde",label:"Beschwerde"},{id:"leitung",label:"Leitung"}]});
  assert.equal(payload.embeds[0].data.fields,undefined);
  assert.deepEqual(payload.components[0].toJSON().components[0].options.map(option=>option.value),["support","beschwerde","leitung"]);
});
