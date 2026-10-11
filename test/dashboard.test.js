import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createDashboard } from "../src/dashboard.js";
import { testDb } from "./helpers.js";

const nativeFetch = globalThis.fetch;

async function unusedPort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test("Staff-Dashboard prüft Rollen und protokolliert Antrag-Übernahme und Ablehnung", async () => {
  const port = await unusedPort();
  const guildId = "12345678901234567", reviewerRole = "22345678901234567", staffRole = "32345678901234567", eventRole = "92345678901234567";
  const reviewerId = "42345678901234567", outsiderId = "52345678901234567", applicantId = "62345678901234567", eventUserId = "72345678901234567";
  const reviewChannelId = "82345678901234567", eventChannelId = "92345678901234568", ticketChannelId = "92345678901234569", guildMembers = new Map();
  let currentOAuthUser = reviewerId;
  const sentDms = [], edits = [], discordMessages = new Map();
  const reviewMessage = { edit: async payload => { edits.push(payload); } };
  discordMessages.set("message-1", reviewMessage);
  const channel = { id: reviewChannelId, isTextBased: () => true, messages: { fetch: async id => discordMessages.get(id) ?? reviewMessage } };
  const announcementChannel = {
    id: eventChannelId, isTextBased: () => true,
    messages: { fetch: async id => discordMessages.get(id) ?? null },
    send: async () => { const msg = { id: `event-message-${discordMessages.size}`, edit: async payload => { edits.push(payload); } }; discordMessages.set(msg.id, msg); return msg; },
  };
  const ticketMessage = { edit: async payload => { edits.push(payload); } };
  discordMessages.set("ticket-message", ticketMessage);
  const ticketChannel = {
    id: ticketChannelId, isTextBased: () => true,
    messages: { fetch: async selector => typeof selector === "string" ? ticketMessage : new Map([["m1", { author: { tag: "Member", id: applicantId }, content: "Support-Anfrage", createdAt: new Date(), createdTimestamp: Date.now(), attachments: new Map() }]]) },
    permissionOverwrites: { edit: async () => {} }, setName: async () => {},
  };
  const channels = new Map([[reviewChannelId, channel], [eventChannelId, announcementChannel], [ticketChannelId, ticketChannel]]);
  const guild = {
    memberCount: 3,
    members: { fetch: async id => ({ id, user: { tag: `test-${id}` }, displayName: `Member ${id}`, roles: { cache: guildMembers.get(id) ?? new Map() } }) },
    channels: { fetch: async id => channels.get(id) ?? null },
  };
  const client = {
    guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild },
    users: { fetch: async id => ({ send: async payload => { sentDms.push({ id, payload }); } }) },
  };
  guildMembers.set(reviewerId, new Map([[reviewerRole, true]]));
  guildMembers.set(outsiderId, new Map([[staffRole, true]]));
  guildMembers.set(eventUserId, new Map([[eventRole, true]]));
  const config = {
    DASHBOARD_ENABLED: true, DASHBOARD_BIND: "127.0.0.1", DASHBOARD_PORT: port,
    DASHBOARD_PUBLIC_URL: "https://dashboard.example", DASHBOARD_SESSION_SECRET: "test-session-secret-which-is-long-enough-123",
    DISCORD_CLIENT_ID: "82345678901234567", DISCORD_CLIENT_SECRET: "not-a-real-secret", DISCORD_GUILD_ID: guildId,
    BOT_OWNER_IDS: [], ROLE_LEADERS: [], ROLE_STAFF: [staffRole], ROLE_FINANCE: [], ROLE_EVENT_TEAM: [eventRole], ROLE_REVIEWERS: [reviewerRole], CHANNEL_RANK_REVIEW: reviewChannelId, CHANNEL_EVENT_ANNOUNCEMENTS: eventChannelId,
  };
  const db = testDb(), now = new Date().toISOString(), applicationId = "rank-application-1";
  db.prepare("INSERT INTO applications(id,guild_id,user_id,kind,answers,status,created_at,updated_at,message_id) VALUES(?,?,?,'rang',?,'open',?,?,?)")
    .run(applicationId, guildId, applicantId, JSON.stringify({ name: "Test", ziel_rang: "Rang 3" }), now, now, "message-1");
  db.prepare("INSERT INTO tickets(id,guild_id,channel_id,user_id,category,status,message_id,created_at,updated_at) VALUES('ticket-1',?,? ,?,'support','open','ticket-message',?,?)").run(guildId, ticketChannelId, applicantId, now, now);
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("/oauth2/token")) return { ok: true, json: async () => ({ access_token: "fake" }) };
    if (url.includes("/users/@me")) return { ok: true, json: async () => ({ id: currentOAuthUser }) };
    throw new Error(`Unerwarteter externer Aufruf: ${url}`);
  };
  const service = createDashboard({ db, client, config });
  const request = async (path, options = {}) => nativeFetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...options });
  const loginAs = async userId => {
    currentOAuthUser = userId;
    const start = await request("/login");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const callback = await request(`/oauth/callback?code=test&state=${state}`);
    assert.equal(callback.status, 302);
    return callback.headers.get("set-cookie").split(";", 1)[0];
  };
  try {
    let cookie;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { const health = await request("/health"); if (health.ok) break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    cookie = await loginAs(outsiderId);
    let response = await request("/api/applications", { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 404);
    response = await request(`/api/applications/${applicationId}/claim`, { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);
    response = await request(`/api/applications/${applicationId}/claim`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);

    cookie = await loginAs(reviewerId);
    response = await request("/api/manage", { headers: { Cookie: cookie } });
    const queue = await response.json();
    assert.equal(queue.capabilities.applications, true);
    assert.equal(queue.capabilities.tickets, false);
    assert.equal(queue.applications.length, 1);
    response = await request(`/api/applications/${applicationId}/claim`, { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(db.prepare("SELECT status FROM applications WHERE id=?").get(applicationId).status, "review");
    assert.equal(sentDms[0].id, applicantId);
    assert.match(sentDms[0].payload.embeds[0].data.title, /wird bearbeitet/i);

    response = await request(`/api/applications/${applicationId}/decision`, { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected", reason: " " }) });
    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT status FROM applications WHERE id=?").get(applicationId).status, "review");
    response = await request(`/api/applications/${applicationId}/decision`, { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected", reason: "Bitte sammle noch mehr Erfahrung." }) });
    assert.equal(response.status, 200);
    const stored = db.prepare("SELECT status,reviewer_id,review_note FROM applications WHERE id=?").get(applicationId);
    assert.deepEqual({ ...stored }, { status: "rejected", reviewer_id: reviewerId, review_note: "Bitte sammle noch mehr Erfahrung." });
    assert.equal(sentDms.length, 2);
    assert.match(sentDms[1].payload.embeds[0].data.fields[1].value, /mehr Erfahrung/);
    assert.deepEqual(db.prepare("SELECT action FROM audit_logs ORDER BY rowid").all().map(row => row.action), ["application.claimed", "application.rejected"]);
    assert.equal(edits.length, 2);

    cookie = await loginAs(outsiderId);
    response = await request("/api/manage", { headers: { Cookie: cookie } });
    const staffQueue = await response.json();
    assert.equal(staffQueue.capabilities.tickets, true);
    assert.equal(staffQueue.capabilities.applications, false);
    response = await request("/api/tickets/ticket-1/claim", { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    response = await request("/api/tickets/ticket-1/close", { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(db.prepare("SELECT status FROM tickets WHERE id='ticket-1'").get().status, "closed");
    assert.equal(JSON.parse(db.prepare("SELECT messages FROM ticket_transcripts WHERE ticket_id='ticket-1'").get().messages).length, 1);

    cookie = await loginAs(eventUserId);
    response = await request("/api/events", { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ungültiges Event", location: "HQ", startsAt: "31.12.2035 19:00", maximum: 501 }) });
    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
    response = await request("/api/events", { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Familien-Event", description: "Gemeinsam in Grand-RP", location: "Hauptquartier", startsAt: "31.12.2035 19:00", maximum: 12 }) });
    assert.equal(response.status, 201);
    const createdEvent = db.prepare("SELECT id,status,channel_id,message_id FROM events WHERE name='Familien-Event'").get();
    assert.equal(createdEvent.status, "scheduled");
    assert.equal(createdEvent.channel_id, eventChannelId);
    response = await request(`/api/events/${createdEvent.id}/cancel`, { method: "POST", headers: { Cookie: cookie, Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(db.prepare("SELECT status FROM events WHERE id=?").get(createdEvent.id).status, "cancelled");

    const page = await request("/");
    assert.match(await page.text(), /gambinos-banner\.gif/);
    assert.equal((await request("/assets/app.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await request("/assets/style.css")).headers.get("content-type"), "text/css; charset=utf-8");
    const gif = await request("/assets/gambinos-profile.gif");
    assert.equal(gif.headers.get("content-type"), "image/gif");
    assert.deepEqual([...new Uint8Array(await gif.arrayBuffer()).slice(0, 3)], [0x47, 0x49, 0x46]);
  } finally {
    globalThis.fetch = nativeFetch;
    await service.close();
    db.close?.();
  }
});
