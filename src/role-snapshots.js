import { randomUUID } from "node:crypto";
import { audit, getSetting, setSetting } from "./database.js";
import { localDay } from "./services/absences.js";

/**
 * Rollen-Sicherungen: wer welche Rollen hat. Täglich automatisch, manuell auf Knopfdruck und vor jeder
 * Wiederherstellung (damit sich auch die Wiederherstellung rückgängig machen lässt).
 */
const LAST_DAY_KEY = "ROLE_SNAPSHOT_LAST_DAY";

export function createRoleSnapshots(db) {
  function save({ guildId, kind, actorId = null, members, roleNames = {} }) {
    const id = randomUUID();
    db.prepare("INSERT INTO role_snapshots(id,guild_id,kind,actor_id,member_count,data,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, guildId, kind, actorId, Object.keys(members).length, JSON.stringify({ members, roles: roleNames }), new Date().toISOString());
    return id;
  }
  const list = guildId => db.prepare("SELECT id,kind,actor_id,member_count,created_at FROM role_snapshots WHERE guild_id=? ORDER BY created_at DESC LIMIT 100").all(guildId);
  function get(guildId, id) {
    const row = db.prepare("SELECT * FROM role_snapshots WHERE guild_id=? AND id=?").get(guildId, id);
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  }
  /** Behält nur die neuesten `keep` automatischen Sicherungen (und Sicherungen vor Wiederherstellungen 30 Tage). */
  function prune(guildId, keep) {
    db.prepare("DELETE FROM role_snapshots WHERE guild_id=? AND kind='auto' AND id NOT IN (SELECT id FROM role_snapshots WHERE guild_id=? AND kind='auto' ORDER BY created_at DESC LIMIT ?)").run(guildId, guildId, keep);
    db.prepare("DELETE FROM role_snapshots WHERE guild_id=? AND kind='before_restore' AND created_at<?").run(guildId, new Date(Date.now() - 30 * 86_400_000).toISOString());
  }
  return { save, list, get, prune };
}

/** Aktueller Rollenstand aller Mitglieder (ohne Bots, ohne @everyone und ohne verwaltete Integrations-Rollen). */
export async function currentRoles(guild) {
  const members = await guild.members.fetch();
  const result = {};
  for (const member of members.values()) {
    if (member.user?.bot) continue;
    result[member.id] = [...member.roles.cache.values()].filter(role => role.id !== guild.id && !role.managed).map(role => role.id).sort();
  }
  return result;
}

export async function takeSnapshot({ db, client, config, kind = "manual", actorId = null }) {
  const guild = client.guilds.cache.get(config.DISCORD_GUILD_ID) ?? await client.guilds.fetch(config.DISCORD_GUILD_ID);
  const members = await currentRoles(guild);
  const roleNames = Object.fromEntries([...guild.roles.cache.values()].filter(role => role.id !== guild.id).map(role => [role.id, role.name]));
  const snapshots = createRoleSnapshots(db);
  const id = snapshots.save({ guildId: guild.id, kind, actorId, members, roleNames });
  snapshots.prune(guild.id, config.ROLE_SNAPSHOT_KEEP ?? 14);
  if (kind !== "auto") audit(db, guild.id, actorId ?? client.user?.id ?? "system", "admin.roles_snapshot", id, { kind, entries: Object.keys(members).length });
  return { id, members: Object.keys(members).length };
}

/** Einmal pro Tag (Server-Zeitzone) automatisch sichern. */
export async function runDailySnapshot({ db, client, config, reference = new Date() }) {
  if (!config.DISCORD_GUILD_ID) return null;
  const day = localDay(reference, config.TIMEZONE);
  if (getSetting(db, config.DISCORD_GUILD_ID, LAST_DAY_KEY) === day) return null;
  setSetting(db, config.DISCORD_GUILD_ID, LAST_DAY_KEY, day);
  return takeSnapshot({ db, client, config, kind: "auto" });
}

/**
 * Was eine Wiederherstellung ändern würde. mode "add": nur fehlende Rollen zurückgeben (sicher).
 * mode "exact": zusätzlich Rollen entfernen, die es in der Sicherung nicht gab. Nur vergebbare Rollen zählen;
 * wer nicht mehr auf dem Server ist, wird übersprungen.
 */
export function planRestore({ snapshot, current, assignable, mode = "add", userId = null }) {
  const changes = [], missing = [];
  for (const [id, saved] of Object.entries(snapshot)) {
    if (userId && id !== userId) continue;
    const now = current[id];
    if (!now) { missing.push(id); continue; }
    const add = saved.filter(role => assignable.has(role) && !now.includes(role));
    const remove = mode === "exact" ? now.filter(role => assignable.has(role) && !saved.includes(role)) : [];
    if (add.length || remove.length) changes.push({ userId: id, add, remove });
  }
  return { changes, missing };
}

/** Vorschau oder Ausführung einer Wiederherstellung. Vor dem Ausführen wird der aktuelle Stand gesichert. */
export async function restoreSnapshot({ db, client, config, snapshotId, mode = "add", userId = null, actorId, dryRun = true }) {
  const guild = client.guilds.cache.get(config.DISCORD_GUILD_ID) ?? await client.guilds.fetch(config.DISCORD_GUILD_ID);
  const snapshot = createRoleSnapshots(db).get(guild.id, snapshotId);
  if (!snapshot) throw Object.assign(new Error("Sicherung nicht gefunden."), { status: 404 });
  const roles = await guild.roles.fetch();
  const highest = guild.members.me?.roles?.highest?.position ?? 0;
  const assignable = new Set([...roles.values()].filter(role => role.id !== guild.id && !role.managed && role.position < highest).map(role => role.id));
  const current = await currentRoles(guild);
  const plan = planRestore({ snapshot: snapshot.data.members, current, assignable, mode, userId });
  const skippedRoles = [...new Set(Object.values(snapshot.data.members).flat())].filter(id => !assignable.has(id)).map(id => roles.get(id)?.name ?? snapshot.data.roles[id] ?? id);
  const roleName = id => roles.get(id)?.name ?? snapshot.data.roles[id] ?? id;
  const described = plan.changes.map(c => ({ ...c, addNames: c.add.map(roleName), removeNames: c.remove.map(roleName) }));
  if (dryRun) return { changes: described, missing: plan.missing.length, skippedRoles, snapshot: { id: snapshot.id, created_at: snapshot.created_at } };
  const before = await takeSnapshot({ db, client, config, kind: "before_restore", actorId });
  let ok = 0, failed = 0;
  const reason = `Rollen-Wiederherstellung (Sicherung vom ${snapshot.created_at.slice(0, 10)})`;
  for (const change of plan.changes) {
    const member = await guild.members.fetch(change.userId).catch(() => null);
    if (!member) { failed++; continue; }
    try {
      if (change.add.length) await member.roles.add(change.add, reason);
      if (change.remove.length) await member.roles.remove(change.remove, reason);
      ok++;
    } catch { failed++; }
  }
  audit(db, guild.id, actorId, "admin.roles_restored", snapshot.id, { mode, value: userId ?? "alle", entries: ok, failed, backup: before.id.slice(0, 8) });
  return { ok, failed, missing: plan.missing.length, before: before.id };
}
