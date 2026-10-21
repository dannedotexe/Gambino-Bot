import test from "node:test";
import assert from "node:assert/strict";
import { giveawayResultPayload, giveawayWinnerPayload, prizeLabel } from "../src/giveaway-cards.js";

test("Preis: Beträge werden lesbar, Text bleibt", () => {
  assert.equal(prizeLabel("100000"), "$100.000");
  assert.equal(prizeLabel("100k"), "$100.000");
  assert.equal(prizeLabel("1,5k"), "$1.500");
  assert.equal(prizeLabel("$1.500.000"), "$1.500.000");
  assert.equal(prizeLabel("2 Mio"), "$2.000.000");
  assert.equal(prizeLabel("Sportwagen"), "Sportwagen");
  assert.equal(prizeLabel("10 Westen"), "10 Westen");
});

test("Ergebnis-Karte und Glückwunsch", () => {
  const row = { id: "g", prize: "100000", winners: JSON.stringify(["30000000000000001"]), ends_at: "2026-10-21T19:54:00Z", ended_at: "2026-10-21T19:54:10Z" };
  const card = giveawayResultPayload(row, { entries: 12 }).embeds[0].data;
  assert.equal(card.title, "🎉 $100.000");
  assert.deepEqual(card.fields.map(f => f.name), ["🏆 Gewinner", "🎁 Preis", "🙋 Teilnahmen", "🕒 Beendet"]);
  assert.equal(card.fields[2].value, "12");
  const win = giveawayWinnerPayload(row);
  assert.equal(win.content, "<@30000000000000001>");
  assert.match(win.embeds[0].data.description, /Du hast \*\*\$100\.000\*\* gewonnen/);
  assert.match(giveawayResultPayload({ ...row, winners: "[]" }).embeds[0].data.description, /keine Teilnahmen/);
});
