import { randomUUID } from "node:crypto";
import { audit, getSetting, setSetting } from "../database.js";
import { localDay } from "./absences.js";

/**
 * Aufgaben-Logs: Mitglieder reichen erledigte Familienaufgaben (Invite, Plantage, Solar …) mit Screenshot ein,
 * das Team bestätigt oder lehnt ab. Bestätigte Logs werden einmalig (Idempotenz-Schlüssel) aufs Familienkonto gebucht.
 * task_types: Aufgaben-Arten mit Belohnung (fest oder pro Stück) und optionalem Tageslimit.
 * task_logs: jede Einreichung; status pending → approved | rejected. reward_cents = gebuchter bzw. erwarteter Betrag.
 */
export class TaskError extends Error {
  constructor(message, code = "TASK_ERROR") { super(message); this.code = code; }
}

const DAY = 86_400_000;
const now = () => new Date().toISOString();
// Startwerte aus der bisherigen Forum-Vorlage; Beträge für Plantage/Solar legt das Team auf der Website fest.
const DEFAULT_TYPES = [
  { name: "Invite – gute Leute", emoji: "🤝", reward: 5_000_000, perUnit: false, unit: "Invite", minDays: 2, minEvents: 4 },
  { name: "Plantage", emoji: "🌿", reward: 0, perUnit: true, unit: "Ernte" },
  { name: "Solar Panele", emoji: "☀️", reward: 0, perUnit: true, unit: "Panel" },
];

/** Stufen nach Anzahl bestätigter Logs (gesamt). */
export const LEVELS = [
  { min: 0, name: "Neuling", emoji: "🌱" },
  { min: 5, name: "Amateur", emoji: "🔧" },
  { min: 15, name: "Fortgeschrittener", emoji: "🥉" },
  { min: 30, name: "Profi", emoji: "🥈" },
  { min: 60, name: "Elite", emoji: "🥇" },
  { min: 100, name: "Legende", emoji: "💎" },
  { min: 200, name: "Gambino", emoji: "👑" },
];
export function levelFor(count) {
  const index = LEVELS.findLastIndex(level => count >= level.min);
  const current = LEVELS[index], next = LEVELS[index + 1] ?? null;
  return { ...current, rank: index + 1, of: LEVELS.length, count, next: next ? { ...next, missing: next.min - count } : null, progress: next ? (count - current.min) / (next.min - current.min) : 1 };
}

/** Montag (lokal) der Woche eines Tages, als YYYY-MM-DD. */
export function weekStart(day) {
  const date = new Date(`${day}T12:00:00Z`), weekday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - weekday * DAY).toISOString().slice(0, 10);
}

/** Aufeinanderfolgende Tage mit bestätigtem Log, endend heute oder gestern. */
export function streakOf(days, today) {
  const set = new Set(days);
  let cursor = set.has(today) ? today : new Date(Date.parse(`${today}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
  let streak = 0;
  while (set.has(cursor)) { streak++; cursor = new Date(Date.parse(`${cursor}T12:00:00Z`) - DAY).toISOString().slice(0, 10); }
  return streak;
}

export function createTaskService(db, { timezone = () => "Europe/Vienna" } = {}) {
  const tz = () => (typeof timezone === "function" ? timezone() : timezone) || "Europe/Vienna";
  const day = iso => localDay(new Date(iso), tz());
  const typeById = (guildId, id) => db.prepare("SELECT * FROM task_types WHERE guild_id=? AND id=?").get(guildId, id);
  const logById = (guildId, id) => db.prepare("SELECT l.*,t.name AS type_name,t.emoji AS type_emoji,t.unit AS type_unit,t.per_unit AS type_per_unit,t.invite_min_days,t.invite_min_events FROM task_logs l JOIN task_types t ON t.id=l.type_id WHERE l.guild_id=? AND l.id=?").get(guildId, id);
  const needsInvitee = type => type?.invite_min_days != null || type?.invite_min_events != null;
  const rewardFor = (type, quantity) => (type.per_unit ? type.reward_cents * quantity : type.reward_cents);

  /** Legt beim ersten Aufruf die Standard-Aufgaben an – nie wieder, auch wenn das Team später alle löscht. */
  function ensureDefaults(guildId) {
    if (!guildId || getSetting(db, guildId, "TASK_TYPES_SEEDED")) return;
    db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM task_types WHERE guild_id=?").get(guildId)) {
        DEFAULT_TYPES.forEach((t, index) => db.prepare("INSERT INTO task_types(id,guild_id,name,emoji,reward_cents,per_unit,unit,daily_limit,active,sort,invite_min_days,invite_min_events,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,1,?,?,?,?,?)")
          .run(randomUUID(), guildId, t.name, t.emoji, t.reward, t.perUnit ? 1 : 0, t.unit, index, t.minDays ?? null, t.minEvents ?? null, now(), now()));
      }
      setSetting(db, guildId, "TASK_TYPES_SEEDED", now());
    })();
  }

  /**
   * Einmalig (Leitung, 20.10.2026): Bei Invites gibt es nur noch „gute Leute“ (50k). Die alte 25k-Stufe wird
   * deaktiviert, „guter Gambo“ umbenannt – nur wenn die Namen noch dem alten Standard entsprechen.
   */
  function migrateInviteTiers(guildId) {
    if (!guildId || getSetting(db, guildId, "TASK_INVITE_GOOD_ONLY")) return;
    db.transaction(() => {
      db.prepare("UPDATE task_types SET active=0,updated_at=? WHERE guild_id=? AND name='Invite – normales Mitglied' AND active=1").run(now(), guildId);
      if (!db.prepare("SELECT 1 FROM task_types WHERE guild_id=? AND name='Invite – gute Leute'").get(guildId))
        db.prepare("UPDATE task_types SET name='Invite – gute Leute',emoji='🤝',updated_at=? WHERE guild_id=? AND name='Invite – guter Gambo'").run(now(), guildId);
      setSetting(db, guildId, "TASK_INVITE_GOOD_ONLY", now());
    })();
  }
  /** Einmalig: „gute Leute“ = mind. 2 Tage auf dem Server und bei 4 Events dabei (prüft der Bot selbst). */
  function migrateInviteConditions(guildId) {
    if (!guildId || getSetting(db, guildId, "TASK_INVITE_CONDITIONS")) return;
    db.transaction(() => {
      db.prepare("UPDATE task_types SET invite_min_days=2,invite_min_events=4,updated_at=? WHERE guild_id=? AND name='Invite – gute Leute' AND invite_min_days IS NULL AND invite_min_events IS NULL").run(now(), guildId);
      setSetting(db, guildId, "TASK_INVITE_CONDITIONS", now());
    })();
  }

  function listTypes(guildId, { all = false } = {}) {
    migrateInviteTiers(guildId);
    migrateInviteConditions(guildId);
    ensureDefaults(guildId);
    return db.prepare(`SELECT * FROM task_types WHERE guild_id=? ${all ? "" : "AND active=1"} ORDER BY sort,name`).all(guildId);
  }

  function saveType(guildId, actorId, input) {
    const name = String(input.name ?? "").trim(), emoji = String(input.emoji ?? "").trim().slice(0, 8) || "📋", unit = String(input.unit ?? "").trim().slice(0, 30) || "Stück";
    if (name.length < 2 || name.length > 60) throw new TaskError("Name: 2 bis 60 Zeichen.", "INVALID_INPUT");
    const reward = Number(input.rewardCents ?? 0);
    if (!Number.isSafeInteger(reward) || reward < 0 || reward > 100_000_000_00) throw new TaskError("Ungültige Belohnung.", "INVALID_INPUT");
    const limit = input.dailyLimit === "" || input.dailyLimit == null ? null : Number(input.dailyLimit);
    if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new TaskError("Tageslimit: 1 bis 100 oder leer.", "INVALID_INPUT");
    const perUnit = input.perUnit === true || input.perUnit === "true" || input.perUnit === "1" ? 1 : 0;
    // Einladungs-Bedingungen: leer = keine eingeladene Person nötig.
    const cond = (value, max, label) => { if (value === "" || value == null) return null; const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > max) throw new TaskError(`${label}: 0 bis ${max} oder leer.`, "INVALID_INPUT"); return n; };
    const minDays = cond(input.inviteMinDays, 60, "Mindest-Tage"), minEvents = cond(input.inviteMinEvents, 50, "Mindest-Events");
    const active = input.active === false || input.active === "false" || input.active === "0" ? 0 : 1;
    return db.transaction(() => {
      const duplicate = db.prepare("SELECT id FROM task_types WHERE guild_id=? AND lower(name)=lower(?) AND id<>?").get(guildId, name, input.id ?? "");
      if (duplicate) throw new TaskError("Eine Aufgabe mit diesem Namen gibt es schon.", "CONFLICT");
      if (input.id) {
        const before = typeById(guildId, input.id);
        if (!before) throw new TaskError("Aufgabe nicht gefunden.", "NOT_FOUND");
        db.prepare("UPDATE task_types SET name=?,emoji=?,reward_cents=?,per_unit=?,unit=?,daily_limit=?,active=?,invite_min_days=?,invite_min_events=?,updated_at=? WHERE id=?").run(name, emoji, reward, perUnit, unit, limit, active, minDays, minEvents, now(), input.id);
        audit(db, guildId, actorId, "task.type_updated", input.id, { name, reward, perUnit: Boolean(perUnit), dailyLimit: limit, active: Boolean(active), previousReward: before.reward_cents });
        return typeById(guildId, input.id);
      }
      const id = randomUUID(), sort = db.prepare("SELECT COALESCE(MAX(sort),-1)+1 n FROM task_types WHERE guild_id=?").get(guildId).n;
      db.prepare("INSERT INTO task_types(id,guild_id,name,emoji,reward_cents,per_unit,unit,daily_limit,active,sort,invite_min_days,invite_min_events,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, guildId, name, emoji, reward, perUnit, unit, limit, active, sort, minDays, minEvents, now(), now());
      audit(db, guildId, actorId, "task.type_created", id, { name, reward, perUnit: Boolean(perUnit), dailyLimit: limit });
      return typeById(guildId, id);
    })();
  }

  /**
   * Neue Einreichung. proofKey (Bildmaße + Dateigröße) erkennt denselben Screenshot erneut – er wird nicht blockiert,
   * aber für das Team markiert.
   */
  function submit({ guildId, userId, typeId, quantity = 1, note = "", proofKey = null, inviteeId = null, reference = new Date() }) {
    const type = typeById(guildId, typeId);
    if (!type || !type.active) throw new TaskError("Diese Aufgabe gibt es nicht (mehr). Bitte aus der Liste wählen.", "NOT_FOUND");
    if (needsInvitee(type)) {
      if (!inviteeId) throw new TaskError("Bitte angeben, wen du eingeladen hast.", "INVITEE");
      if (inviteeId === userId) throw new TaskError("Dich selbst kannst du nicht einladen. 😉", "INVITEE");
      const taken = db.prepare("SELECT user_id FROM task_logs WHERE guild_id=? AND invitee_id=? AND status<>'rejected' LIMIT 1").get(guildId, inviteeId);
      if (taken) throw new TaskError(taken.user_id === userId ? "Für diese Person hast du schon einen Invite eingereicht." : "Für diese Person hat schon jemand anderes einen Invite eingereicht.", "INVITEE");
    }
    const qty = type.per_unit ? Number(quantity) : 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new TaskError("Menge: ganze Zahl von 1 bis 999.", "INVALID_INPUT");
    const text = String(note ?? "").trim().slice(0, 300);
    return db.transaction(() => {
      const today = localDay(reference, tz());
      if (type.daily_limit) {
        const recent = db.prepare("SELECT created_at FROM task_logs WHERE guild_id=? AND user_id=? AND type_id=? AND status IN ('pending','approved') AND created_at>=?").all(guildId, userId, typeId, new Date(reference.getTime() - 2 * DAY).toISOString());
        if (recent.filter(r => day(r.created_at) === today).length >= type.daily_limit) throw new TaskError(`Tageslimit erreicht: ${type.name} geht höchstens ${type.daily_limit}× pro Tag.`, "LIMIT");
      }
      const duplicate = proofKey ? db.prepare("SELECT id,user_id,created_at FROM task_logs WHERE guild_id=? AND proof_key=? AND status<>'rejected' AND created_at>=? ORDER BY created_at LIMIT 1").get(guildId, proofKey, new Date(reference.getTime() - 14 * DAY).toISOString()) : null;
      const id = randomUUID(), ts = reference.toISOString();
      db.prepare("INSERT INTO task_logs(id,guild_id,user_id,type_id,quantity,reward_cents,note,proof_key,duplicate_of,status,invitee_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)")
        .run(id, guildId, userId, typeId, qty, rewardFor(type, qty), text, proofKey, duplicate?.id ?? null, needsInvitee(type) ? inviteeId : null, ts, ts);
      audit(db, guildId, userId, "task.submitted", id, { type: type.name, quantity: qty, reward: rewardFor(type, qty), duplicateOf: duplicate?.id ?? null });
      return { ...logById(guildId, id), duplicate };
    })();
  }

  function attachMessage(id, { channelId, messageId, proofUrl }) {
    db.prepare("UPDATE task_logs SET channel_id=?,message_id=?,proof_url=COALESCE(?,proof_url) WHERE id=?").run(channelId, messageId, proofUrl ?? null, id);
  }
  const setProofUrl = (id, url) => db.prepare("UPDATE task_logs SET proof_url=? WHERE id=?").run(url, id);

  /** Bestätigen (optional mit korrigierter Menge) und Belohnung in derselben Transaktion buchen. */
  /**
   * Bestätigen. Hat die Aufgabe Einladungs-Bedingungen und sind sie noch nicht erfüllt (conditionsMet=false), wird nur
   * vorgemerkt („bestätigt, wartet“) – die Belohnung bucht später releaseHeld, sobald die Bedingungen erfüllt sind.
   */
  function approve({ guildId, id, actorId, finance, quantity = null, allowSelf = false, conditionsMet = true }) {
    return db.transaction(() => {
      const log = logById(guildId, id);
      if (!log) throw new TaskError("Log nicht gefunden.", "NOT_FOUND");
      if (log.status !== "pending") throw new TaskError(log.status === "approved" ? "Dieses Log wurde bereits bestätigt." : "Dieses Log wurde bereits abgelehnt.", "CONFLICT");
      if (log.user_id === actorId && !allowSelf) throw new TaskError("Eigene Logs muss jemand anderes bestätigen.", "SELF");
      const type = typeById(guildId, log.type_id);
      if (needsInvitee(type) && !conditionsMet) {
        if (log.preapproved_at) throw new TaskError("Dieses Log ist schon bestätigt und wartet auf die Bedingungen.", "CONFLICT");
        db.prepare("UPDATE task_logs SET preapproved_by=?,preapproved_at=?,updated_at=? WHERE id=? AND status='pending'").run(actorId, now(), now(), id);
        audit(db, guildId, actorId, "task.preapproved", id, { userId: log.user_id, inviteeId: log.invitee_id, type: type.name });
        return { ...logById(guildId, id), held: true };
      }
      const qty = quantity == null ? log.quantity : Number(quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new TaskError("Menge: ganze Zahl von 1 bis 999.", "INVALID_INPUT");
      const reward = rewardFor(type, type.per_unit ? qty : 1);
      let transactionId = null;
      if (reward > 0) {
        const tx = finance.credit({ guildId, userId: log.user_id, actorId, cents: reward, key: `task-log:${id}`, reason: `Aufgabe: ${type.emoji} ${type.name}${type.per_unit ? ` ×${qty} ${type.unit}` : ""}` });
        transactionId = tx.id;
      }
      db.prepare("UPDATE task_logs SET status='approved',quantity=?,reward_cents=?,reviewer_id=?,reviewed_at=?,transaction_id=?,updated_at=? WHERE id=? AND status='pending'").run(type.per_unit ? qty : 1, reward, actorId, now(), transactionId, now(), id);
      audit(db, guildId, actorId, "task.approved", id, { userId: log.user_id, type: type.name, quantity: qty, reward, corrected: quantity != null && qty !== log.quantity });
      return logById(guildId, id);
    })();
  }

  function reject({ guildId, id, actorId, reason, allowSelf = false }) {
    const text = String(reason ?? "").trim();
    if (text.length < 3) throw new TaskError("Bitte einen Grund angeben (mindestens 3 Zeichen).", "INVALID_INPUT");
    return db.transaction(() => {
      const log = logById(guildId, id);
      if (!log) throw new TaskError("Log nicht gefunden.", "NOT_FOUND");
      if (log.status !== "pending") throw new TaskError("Dieses Log wurde bereits entschieden.", "CONFLICT");
      if (log.user_id === actorId && !allowSelf) throw new TaskError("Eigene Logs muss jemand anderes prüfen.", "SELF");
      db.prepare("UPDATE task_logs SET status='rejected',reviewer_id=?,reviewed_at=?,reject_reason=?,updated_at=? WHERE id=? AND status='pending'").run(actorId, now(), text.slice(0, 300), now(), id);
      audit(db, guildId, actorId, "task.rejected", id, { userId: log.user_id, type: log.type_name, reason: text.slice(0, 300) });
      return logById(guildId, id);
    })();
  }

  /** Eigene Einreichung zurückziehen, solange sie offen ist. */
  function withdraw({ guildId, id, userId }) {
    return db.transaction(() => {
      const log = logById(guildId, id);
      if (!log || log.user_id !== userId) throw new TaskError("Log nicht gefunden.", "NOT_FOUND");
      if (log.status !== "pending") throw new TaskError("Nur offene Logs können zurückgezogen werden.", "CONFLICT");
      db.prepare("UPDATE task_logs SET status='rejected',reviewer_id=?,reviewed_at=?,reject_reason=?,updated_at=? WHERE id=?").run(userId, now(), "Selbst zurückgezogen", now(), id);
      audit(db, guildId, userId, "task.withdrawn", id, { type: log.type_name });
      return logById(guildId, id);
    })();
  }

  /** Bestätigte, aber noch auf Bedingungen wartende Logs. */
  const held = guildId => db.prepare("SELECT l.*,t.name AS type_name,t.emoji AS type_emoji,t.unit AS type_unit,t.per_unit AS type_per_unit,t.invite_min_days,t.invite_min_events FROM task_logs l JOIN task_types t ON t.id=l.type_id WHERE l.guild_id=? AND l.status='pending' AND l.preapproved_at IS NOT NULL ORDER BY l.preapproved_at").all(guildId);
  /** Fortschritt einer Einladung: Tage seit Beitritt und anwesende Events seitdem. */
  function inviteProgress(log, type, { joinedAt = null, reference = new Date() } = {}) {
    const days = joinedAt ? Math.floor((reference - new Date(joinedAt)) / DAY) : 0;
    const since = joinedAt ? new Date(joinedAt).toISOString() : log.created_at;
    const events = log.invitee_id ? db.prepare("SELECT COUNT(*) n FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.user_id=? AND p.status='present' AND e.starts_at>=?").get(log.guild_id, log.invitee_id, since).n : 0;
    const needDays = type.invite_min_days ?? 0, needEvents = type.invite_min_events ?? 0;
    return { days, events, needDays, needEvents, inGuild: Boolean(joinedAt), met: Boolean(joinedAt) && days >= needDays && events >= needEvents };
  }
  const setProgress = (id, text) => db.prepare("UPDATE task_logs SET progress=? WHERE id=?").run(text, id);

  const list = (guildId, { status = null, userId = null, limit = 100 } = {}) =>
    db.prepare(`SELECT l.*,t.name AS type_name,t.emoji AS type_emoji,t.unit AS type_unit,t.per_unit AS type_per_unit,t.invite_min_days,t.invite_min_events FROM task_logs l JOIN task_types t ON t.id=l.type_id WHERE l.guild_id=? ${status ? "AND l.status=?" : ""} ${userId ? "AND l.user_id=?" : ""} ORDER BY ${status === "pending" ? "l.created_at" : "l.created_at DESC"} LIMIT ?`)
      .all(...[guildId, status, userId].filter(Boolean), Math.min(500, limit));

  /** Bestenliste ab einem lokalen Tag (inklusive): Logs, Stück und verdientes Geld. */
  function leaderboard(guildId, { since = null, limit = 10 } = {}) {
    const rows = db.prepare("SELECT user_id,quantity,reward_cents,created_at FROM task_logs WHERE guild_id=? AND status='approved' AND created_at>=?").all(guildId, since ? new Date(Date.parse(`${since}T00:00:00Z`) - DAY).toISOString() : "0");
    const map = new Map();
    for (const r of rows) {
      if (since && day(r.created_at) < since) continue;
      const entry = map.get(r.user_id) ?? { userId: r.user_id, logs: 0, units: 0, earned: 0 };
      entry.logs++; entry.units += r.quantity; entry.earned += r.reward_cents;
      map.set(r.user_id, entry);
    }
    return [...map.values()].sort((a, b) => b.logs - a.logs || b.earned - a.earned).slice(0, limit);
  }

  /** Persönliche Bilanz: Stufe, Serie, Woche, gesamt, Platz in der Wochen-Bestenliste. */
  function profile(guildId, userId, reference = new Date()) {
    const rows = db.prepare("SELECT status,quantity,reward_cents,created_at,preapproved_at FROM task_logs WHERE guild_id=? AND user_id=?").all(guildId, userId);
    const approved = rows.filter(r => r.status === "approved"), today = localDay(reference, tz()), week = weekStart(today);
    const weekRows = approved.filter(r => day(r.created_at) >= week);
    const board = leaderboard(guildId, { since: week, limit: 1000 });
    const place = board.findIndex(r => r.userId === userId);
    return {
      level: levelFor(approved.length),
      streak: streakOf(approved.map(r => day(r.created_at)), today),
      total: { logs: approved.length, earned: approved.reduce((s, r) => s + r.reward_cents, 0) },
      week: { logs: weekRows.length, earned: weekRows.reduce((s, r) => s + r.reward_cents, 0), place: place >= 0 ? place + 1 : null, of: board.length },
      pending: rows.filter(r => r.status === "pending" && !r.preapproved_at).length,
      held: rows.filter(r => r.status === "pending" && r.preapproved_at).length,
    };
  }

  function summary(guildId, reference = new Date()) {
    const week = weekStart(localDay(reference, tz()));
    const rows = db.prepare("SELECT status,reward_cents,created_at,reviewed_at,preapproved_at FROM task_logs WHERE guild_id=? AND (status='pending' OR created_at>=?)").all(guildId, new Date(Date.parse(`${week}T00:00:00Z`) - DAY).toISOString());
    const thisWeek = rows.filter(r => r.status === "approved" && day(r.created_at) >= week);
    return { pending: rows.filter(r => r.status === "pending" && !r.preapproved_at).length, held: rows.filter(r => r.status === "pending" && r.preapproved_at).length, weekApproved: thisWeek.length, weekPaid: thisWeek.reduce((s, r) => s + r.reward_cents, 0), weekStart: week };
  }

  return { held, inviteProgress, setProgress, needsInvitee, ensureDefaults, listTypes, saveType, typeById, submit, attachMessage, setProofUrl, approve, reject, withdraw, get: logById, list, leaderboard, profile, summary };
}
