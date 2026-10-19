import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createFinance } from "../src/services/finance.js";
import { refreshPayoutList } from "../src/payout-list.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", CH = "60000000000000031", A = "30000000000000001", B = "30000000000000002";

test("Auszahlungsliste: einmal posten, nur bei Änderung bearbeiten, Netto nach Sanktion", async () => {
  const db = testDb(), finance = createFinance(db), sent = [], edits = [];
  const message = { id: "m1", edit: async p => edits.push(p) };
  const channel = { id: CH, send: async p => { sent.push(p); return message; }, messages: { fetch: async () => message } };
  const client = { channels: { fetch: async () => channel } };
  const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G }), CHANNEL_PAYOUT_LIST: CH };
  finance.credit({ guildId: G, userId: A, actorId: "x", cents: 5_000_000, reason: "Event", key: "a" });
  finance.credit({ guildId: G, userId: B, actorId: "x", cents: 1_000_000, reason: "Event", key: "b" });
  finance.sanction({ guildId: G, userId: A, actorId: "x", cents: 500_000, reason: "Zu spät" });
  assert.equal(await refreshPayoutList({ db, client, config }), true);
  const list = sent[0].embeds[1].data.description;
  assert.match(list, new RegExp(`1\\.\\*\\* <@${A}> · \\*\\*\\$45\\.000,00\\*\\* \\(brutto \\$50\\.000,00 − \\$5\\.000,00 Sanktion\\)`));
  assert.match(list, new RegExp(`2\\.\\*\\* <@${B}>`));
  assert.deepEqual(sent[0].allowedMentions, { parse: [] }, "niemand wird gepingt");
  assert.equal(await refreshPayoutList({ db, client, config }), false, "unverändert → nichts tun");
  finance.credit({ guildId: G, userId: B, actorId: "x", cents: 100, reason: "Event", key: "c" });
  assert.equal(await refreshPayoutList({ db, client, config }), true);
  assert.equal(sent.length, 1); assert.equal(edits.length, 1, "bestehende Nachricht bearbeitet");
});
