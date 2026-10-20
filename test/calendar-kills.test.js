import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers.js";
import { killLeaderboard, killsOf, weekCalendar } from "../src/services/calendar.js";
import { buildCommands } from "../src/commands.js";

const G = "10000000000000001", TZ = "Europe/Vienna";
const addEvent = (db, id, startsAt, extra = {}) => db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,status,created_at,series_id,max_participants) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
  .run(id, G, extra.name ?? id, "", startsAt, extra.location ?? "HQ", "h", extra.status ?? "scheduled", startsAt, extra.series ?? null, extra.max ?? null);

test("Kalender: Woche Mo–So mit Events, Staatlicher Kontrolle und noch nicht angelegten Aktivitäts-Terminen", () => {
  const db = testDb(), ref = new Date("2026-10-21T10:00:00Z"); // Mittwoch
  addEvent(db, "e1", "2026-10-22T18:00:00Z", { name: "Familientreffen", max: 2 });
  addEvent(db, "c1", "2026-10-21T14:00:00Z", { name: "🛡️ Kontrolle", location: "Staatliche Kontrolle" });
  addEvent(db, "old", "2026-10-15T18:00:00Z");
  db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES('e1','u1','signed_up','x')").run();
  db.prepare("INSERT INTO event_waitlist(event_id,user_id,created_at) VALUES('e1','u2','x')").run();
  db.prepare("INSERT INTO event_series(id,guild_id,name,kind,weekdays,times,active,created_by,created_at,updated_at) VALUES('s1',?,'Cayo Perico','scheduled','3','20:20',1,'x','x','x')").run(G);
  const cal = weekCalendar(db, { guildId: G, timezone: TZ, reference: ref });
  assert.equal(cal.from, "2026-10-19"); assert.equal(cal.until, "2026-10-25"); assert.equal(cal.today, "2026-10-21");
  const wed = cal.days[2].items, thu = cal.days[3].items;
  assert.deepEqual(wed.map(i => [i.name, i.kind, i.status]), [["🛡️ Kontrolle", "control", "scheduled"], ["Cayo Perico", "series", "planned"]]);
  assert.deepEqual([thu[0].participants, thu[0].max, thu[0].waiting], [1, 2, 1]);
  assert.equal(cal.days.flatMap(d => d.items).some(i => i.name === "old"), false, "Vorwoche nicht enthalten");
  addEvent(db, "s1e", "2026-10-21T18:20:00Z", { name: "Cayo Perico", series: "s1" });
  assert.equal(weekCalendar(db, { guildId: G, timezone: TZ, reference: ref }).days[2].items.filter(i => i.name === "Cayo Perico").length, 1, "angelegter Termin ersetzt den geplanten");
  assert.equal(weekCalendar(db, { guildId: G, timezone: TZ, reference: ref, offset: -1 }).days[3].items[0].name, "old");
});

test("Kill-Bestenliste: Woche, Monat, gesamt; eigener Wert", () => {
  const db = testDb(), ref = new Date("2026-10-21T10:00:00Z");
  addEvent(db, "a", "2026-10-20T18:00:00Z"); addEvent(db, "b", "2026-10-05T18:00:00Z"); addEvent(db, "c", "2026-09-10T18:00:00Z");
  const k = (e, u, n) => db.prepare("INSERT INTO event_kills(event_id,user_id,kills,updated_at) VALUES(?,?,?,'x')").run(e, u, n);
  k("a", "u1", 3); k("a", "u2", 5); k("b", "u1", 4); k("c", "u1", 10); k("c", "u3", 0);
  assert.deepEqual(killLeaderboard(db, { guildId: G, timezone: TZ, reference: ref, period: "week" }).map(r => [r.userId, r.kills]), [["u2", 5], ["u1", 3]]);
  assert.deepEqual(killLeaderboard(db, { guildId: G, timezone: TZ, reference: ref, period: "month" }).map(r => [r.userId, r.kills]), [["u1", 7], ["u2", 5]]);
  assert.deepEqual(killLeaderboard(db, { guildId: G, timezone: TZ, reference: ref, period: "all" })[0], { userId: "u1", kills: 17, events: 3, best: 10 });
  assert.deepEqual(killsOf(db, G, "u1"), { kills: 17, best: 10 });
  assert.ok(buildCommands().some(c => c.name === "kills"));
});
