import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { CHANNEL_LAYOUT, bindCreatedChannels, loadChannelBindings } from "../src/channel-setup.js";

test("PDF structure contains the five categories and 25 text channels",()=>{
  assert.deepEqual(CHANNEL_LAYOUT.map(x=>x.name),["INFORMATION","EVENTS","COMMUNITY","SUPPORT","STAFF"]);
  assert.equal(CHANNEL_LAYOUT.reduce((n,x)=>n+x.channels.length,0),25);
  assert.equal(CHANNEL_LAYOUT.find(x=>x.name==="SUPPORT").channels.includes("bewerbungen"),true);
  assert.equal(CHANNEL_LAYOUT.find(x=>x.name==="STAFF").channels.includes("bewerbungen"),true);
});

test("channel binding persistence loads stored functional channels at startup",()=>{
  const db=testDb(), config={CHANNEL_STATS:"old"};
  const categories=new Map([["SUPPORT",{id:"support-id"}],["STAFF",{id:"staff-id"}],["EVENTS",{id:"events-id"}]]);
  const channels=new Map([["STAFF/ticket-logs",{id:"ticket-log-id"}],["STAFF/bewerbungen",{id:"review-id"}],["EVENTS/event-ankündigungen",{id:"event-id"}],["STAFF/sanktions-logs",{id:"audit-id"}],["STAFF/server-statistik",{id:"stats-id"}]]);
  bindCreatedChannels(db,"guild-id",config,categories,channels);
  assert.equal(config.CHANNEL_TICKET_CATEGORY,"support-id");
  assert.equal(config.CHANNEL_APPLICATION_REVIEW,"review-id");
  const restarted={};
  loadChannelBindings(db,"guild-id",restarted);
  assert.equal(restarted.CHANNEL_STATS,"stats-id");
});
