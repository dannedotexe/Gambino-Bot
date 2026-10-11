import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, requireRole } from "../src/config.js";

const ids={DISCORD_TOKEN:"test-only",DISCORD_CLIENT_ID:"12345678901234567"};
test("configuration requires token and valid application id",()=>{assert.throws(()=>loadConfig({}),/Ungültige Konfiguration/);assert.throws(()=>loadConfig({...ids,DISCORD_CLIENT_ID:"bad"}),/DISCORD_CLIENT_ID/);});
test("Bewerbungen laufen über ihr eigenes Panel statt als Ticket-Kategorie",()=>{const cfg=loadConfig({...ids});assert.deepEqual(cfg.TICKET_CATEGORIES_JSON.map(x=>x.id),["support","beschwerde","leitung"]);const custom=loadConfig({...ids,TICKET_CATEGORIES_JSON:JSON.stringify([{id:"bewerbung",label:"Bewerbung",roleIds:[]},{id:"support",label:"Support",roleIds:[]}])});assert.deepEqual(custom.TICKET_CATEGORIES_JSON.map(x=>x.id),["support"]);});
test("missing staff roles fail closed and role strings are parsed",()=>{const cfg=loadConfig({...ids,ROLE_FINANCE:"12345678901234567,12345678901234568"});assert.equal(cfg.ROLE_FINANCE.length,2);assert.match(requireRole({inGuild:()=>true,member:{roles:{cache:new Map()}}},[]),/nicht konfiguriert/);});
test("configured bot owner can use role-restricted commands without a Discord role",()=>{const owner=ids.DISCORD_CLIENT_ID,cfg=loadConfig({...ids,BOT_OWNER_IDS:owner});assert.deepEqual(cfg.BOT_OWNER_IDS,[owner]);const interaction={inGuild:()=>true,user:{id:owner},client:{gambinoOwnerIds:cfg.BOT_OWNER_IDS},member:{roles:{cache:new Map()}}};assert.equal(requireRole(interaction,[],"Finanzrolle"),null);interaction.user.id="different-user";assert.match(requireRole(interaction,[],"Finanzrolle"),/nicht konfiguriert/);});
