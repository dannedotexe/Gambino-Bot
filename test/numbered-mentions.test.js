import test from "node:test";
import assert from "node:assert/strict";
import { numberedMentions } from "../src/presentation.js";

test("Teilnehmerliste: nummeriert, eine Person pro Zeile, passt immer ins Embed-Feld", () => {
  assert.equal(numberedMentions(["111", "222"]), "1. <@111>\n2. <@222>");
  assert.equal(numberedMentions([], { empty: "Noch keine Anmeldungen" }), "Noch keine Anmeldungen");
  assert.equal(numberedMentions(["111"], { suffix: () => " (abgemeldet)" }), "1. <@111> (abgemeldet)");
  const many = numberedMentions(Array.from({ length: 80 }, (_, i) => String(300000000000000000n + BigInt(i))));
  assert.ok(many.length <= 1024);
  assert.match(many, /… \+\d+ weitere$/);
});
