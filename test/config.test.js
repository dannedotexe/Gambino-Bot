import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, requireRole } from "../src/config.js";

const ids={DISCORD_TOKEN:"test-only",DISCORD_CLIENT_ID:"12345678901234567"};
test("configuration requires token and valid application id",()=>{assert.throws(()=>loadConfig({}),/Ungültige Konfiguration/);assert.throws(()=>loadConfig({...ids,DISCORD_CLIENT_ID:"bad"}),/DISCORD_CLIENT_ID/);});
test("missing staff roles fail closed and role strings are parsed",()=>{const cfg=loadConfig({...ids,ROLE_FINANCE:"12345678901234567,12345678901234568"});assert.equal(cfg.ROLE_FINANCE.length,2);assert.match(requireRole({inGuild:()=>true,member:{roles:{cache:new Map()}}},[]),/nicht konfiguriert/);});
