import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { createHandler } from "../src/commands.js";
import { createFinance } from "../src/services/finance.js";
import { loadConfig } from "../src/config.js";

const G = "10000000000000001", CMD = "1561749617119461517", OTHER = "60000000000000005", STAFF = "20000000000000002";
const config = { ...loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", DISCORD_GUILD_ID: G, ROLE_STAFF: STAFF }), CHANNEL_BOT_COMMANDS: CMD };
const run = async (channelId, roles = []) => {
  const db = testDb(), replies = [];
  const handler = createHandler({ db, finance: createFinance(db), config, client: { ws: { ping: 7 }, user: { id: "bot" } } });
  await handler.command({ id: "1", commandName: "ping", channelId, guildId: G, user: { id: "30000000000000001" }, member: { roles: { cache: new Map(roles.map(r => [r, true])) } },
    inGuild: () => true, isChatInputCommand: () => true, options: { getSubcommand: () => null }, reply: async p => { replies.push(p); } });
  return JSON.stringify(replies[0]);
};

test("Befehls-Channel: Mitglieder nur dort, Staff überall", async () => {
  assert.match(await run(OTHER), new RegExp(`<#${CMD}>`));
  assert.match(await run(CMD), /Pong/);
  assert.match(await run(OTHER, [STAFF]), /Pong/);
});
