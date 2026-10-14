import test from "node:test";
import assert from "node:assert/strict";
import { accessGroups, loadConfig } from "../src/config.js";

test("Voller Zugriff (z. B. ab Rang 8) gilt in allen Bereichen wie die Leitung", () => {
  const config = loadConfig({ DISCORD_TOKEN: "x", DISCORD_CLIENT_ID: "12345678901234567", ROLE_LEADERS: "10000000000000001", ROLE_FULL_ACCESS: "80000000000000008,90000000000000009" });
  const groups = accessGroups(config);
  for (const name of ["leaders", "staff", "finance", "financeView", "reviewers", "events", "moderation", "anyStaff"]) {
    assert.ok(groups[name].includes("80000000000000008") && groups[name].includes("90000000000000009"), name);
  }
  assert.ok(!groups.members.includes("80000000000000008"));
});
