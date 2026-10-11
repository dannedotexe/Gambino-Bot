import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function createDashboard({ db, client, config }) {
  if (!config.DASHBOARD_ENABLED) return { close: async () => {} };
  const state = new Map();
  const cookieName = "gambino_staff";
  const secret = config.DASHBOARD_SESSION_SECRET;
  const staffRoleIds = [...new Set([...(config.ROLE_LEADERS ?? []), ...(config.ROLE_STAFF ?? []), ...(config.ROLE_FINANCE ?? []), ...(config.ROLE_EVENT_TEAM ?? []), ...(config.ROLE_REVIEWERS ?? [])])];
  const sign = value => createHmac("sha256", secret).update(value).digest("base64url");
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  const send = (res, status, body, type = "application/json; charset=utf-8", headers = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:", ...headers });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
  };
  const memberFor = async userId => {
    const guild = client.guilds.cache.get(config.DISCORD_GUILD_ID) ?? await client.guilds.fetch(config.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    const roles = staffRoleIds.filter(id => member.roles.cache.has(id));
    const owner = config.BOT_OWNER_IDS?.includes(userId) ?? false;
    return roles.length || owner ? { id: member.id, tag: member.user.tag, displayName: member.displayName, roles, owner } : null;
  };
  const sessionFor = async req => {
    const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw) return null;
    const [payload, signature] = raw.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    let session;
    try { session = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
    if (session.exp < Date.now()) return null;
    return memberFor(session.sub);
  };
  const summary = (includeFinance = false) => {
    const count = (sql, ...params) => db.prepare(sql).get(...params)?.n ?? 0;
    return {
      members: client.guilds.cache.get(config.DISCORD_GUILD_ID)?.memberCount ?? null,
      tickets: count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'", config.DISCORD_GUILD_ID),
      applications: count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status IN ('open','review')", config.DISCORD_GUILD_ID),
      events: count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>?", config.DISCORD_GUILD_ID, new Date().toISOString()),
      giveaways: count("SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND status='active'", config.DISCORD_GUILD_ID),
      ...(includeFinance ? { sanctions: count("SELECT COUNT(*) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')", config.DISCORD_GUILD_ID) } : {}),
    };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, config.DASHBOARD_PUBLIC_URL);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
      if (req.method === "GET" && url.pathname === "/login") {
        for (const [key, expires] of state) if (expires < Date.now()) state.delete(key);
        const nonce = randomBytes(24).toString("base64url");
        state.set(nonce, Date.now() + 5 * 60_000);
        const redirect = new URL("https://discord.com/oauth2/authorize");
        redirect.search = new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, response_type: "code", scope: "identify", state: nonce, redirect_uri: `${config.DASHBOARD_PUBLIC_URL}/oauth/callback` }).toString();
        res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" }); return res.end();
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const loginFailure = message => { res.writeHead(302, { Location: `/?error=${encodeURIComponent(message)}`, "Cache-Control": "no-store" }); res.end(); };
        const nonce = url.searchParams.get("state"), expiry = state.get(nonce);
        state.delete(nonce);
        if (!url.searchParams.get("code") || !expiry || expiry < Date.now()) return loginFailure("Anmeldung abgelaufen. Bitte erneut versuchen.");
        const tokenResponse = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, client_secret: config.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: `${config.DASHBOARD_PUBLIC_URL}/oauth/callback` }) });
        const token = await tokenResponse.json();
        if (!tokenResponse.ok) return loginFailure("Discord-Anmeldung fehlgeschlagen. Bitte erneut versuchen.");
        const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } });
        const user = await userResponse.json();
        if (!userResponse.ok || !await memberFor(user.id)) return loginFailure("Dieses Dashboard ist nur für berechtigte Gambinos-Staffmitglieder.");
        const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + 8 * 60 * 60_000 })).toString("base64url");
        res.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": cookie(`${payload}.${sign(payload)}`, 8 * 60 * 60) }); return res.end();
      }
      if (req.method === "POST" && url.pathname === "/logout") {
        res.writeHead(204, { "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" }); return res.end();
      }
      if (url.pathname.startsWith("/api/")) {
        const member = await sessionFor(req);
        if (!member) return send(res, 401, { error: "Bitte melde dich mit Discord an." });
        if (req.method === "GET" && url.pathname === "/api/overview") {
          const events = db.prepare("SELECT name,starts_at,location FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>? ORDER BY starts_at LIMIT 5").all(config.DISCORD_GUILD_ID, new Date().toISOString());
          const applications = db.prepare("SELECT id,kind,status,created_at FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at LIMIT 8").all(config.DISCORD_GUILD_ID);
          const activity = db.prepare("SELECT action,target_id,actor_id,created_at FROM audit_logs WHERE guild_id=? ORDER BY created_at DESC LIMIT 8").all(config.DISCORD_GUILD_ID);
          const canSeeFinance = member.owner || member.roles.some(id => (config.ROLE_FINANCE ?? []).includes(id) || (config.ROLE_LEADERS ?? []).includes(id));
          const data = { member: { name: member.displayName, roles: member.roles.length, owner: member.owner }, stats: summary(canSeeFinance), events, applications, activity };
          if (canSeeFinance) {
            data.finance = { balances: db.prepare("SELECT COUNT(*) n FROM accounts WHERE guild_id=?").get(config.DISCORD_GUILD_ID).n, openSanctions: db.prepare("SELECT COALESCE(SUM(remaining_cents),0) cents FROM sanctions WHERE guild_id=? AND status IN ('open','partial')").get(config.DISCORD_GUILD_ID).cents };
          }
          return send(res, 200, data);
        }
        return send(res, 404, { error: "Nicht gefunden." });
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice("/assets/".length);
        if (relative.includes("..") || relative.includes("\\")) return send(res, 400, { error: "Ungültiger Pfad." });
        const file = path.join(root, relative);
        const body = await readFile(file);
        return send(res, 200, body, mime[path.extname(file)] ?? "application/octet-stream");
      }
      return send(res, 404, { error: "Nicht gefunden." });
    } catch (error) {
      console.error("Dashboard request failed:", error.message);
      return send(res, 500, { error: "Die Anfrage konnte nicht verarbeitet werden." });
    }
  });
  server.on("error", error => console.error("Staff-Dashboard konnte nicht starten:", error.message));
  server.listen(config.DASHBOARD_PORT, config.DASHBOARD_BIND, () => console.log(`Gambinos Staff-Dashboard lauscht auf ${config.DASHBOARD_BIND}:${config.DASHBOARD_PORT}.`));
  return { close: () => new Promise(resolve => server.close(resolve)) };
}
