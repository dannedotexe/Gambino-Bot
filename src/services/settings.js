import { audit } from "../database.js";
import { loadConfig } from "../config.js";

/**
 * Über Website/Discord bearbeitbare Einstellungen. Werte werden im .env-Format in guild_settings gespeichert,
 * mit derselben Validierung wie beim Start geprüft und sofort auf die laufende Konfiguration angewendet.
 * Bewusst NICHT bearbeitbar: Token, Client-ID/Secret, Guild-ID, Bot-Owner, Datenbankpfad und Webdashboard-Zugang.
 */
const ACTIONS = [["warn", "Hinweis"], ["delete", "Löschen"], ["timeout", "Timeout"], ["alert", "Staff-Meldung"]];
export const SETTINGS = [
  { key: "ROLE_LEADERS", group: "Rollen", label: "Leitung", type: "roles", help: "Vollzugriff inkl. Einstellungen, Korrekturen und Aufhebungen." },
  { key: "ROLE_STAFF", group: "Rollen", label: "Staff", type: "roles", help: "Tickets, Sanktionen, Giveaways." },
  { key: "ROLE_FINANCE", group: "Rollen", label: "Finanzen", type: "roles", help: "Gutschriften und Auszahlungen buchen." },
  { key: "ROLE_FINANCE_VIEWERS", group: "Rollen", label: "Finanz-Einsicht", type: "roles", help: "Kontostände nur ansehen." },
  { key: "ROLE_REVIEWERS", group: "Rollen", label: "Reviewer", type: "roles", help: "Bewerbungen und Rang-Anträge prüfen." },
  { key: "ROLE_EVENT_TEAM", group: "Rollen", label: "Event-Team", type: "roles", help: "Events und Aktivitäten verwalten." },
  { key: "ROLE_MEMBERS", group: "Rollen", label: "Familienmitglieder", type: "roles", help: "Wenn gesetzt: nur diese (und Staff) dürfen sich für Events anmelden und Rang-Anträge stellen." },
  { key: "CHANNEL_TICKET_CATEGORY", group: "Channels", label: "Ticket-Kategorie", type: "category", help: "Unter dieser Kategorie entstehen Ticket-Channels." },
  { key: "CHANNEL_TICKET_LOG", group: "Channels", label: "Ticket-Log", type: "channel" },
  { key: "CHANNEL_APPLICATION_REVIEW", group: "Channels", label: "Bewerbungen (Staff)", type: "channel" },
  { key: "CHANNEL_RANK_REVIEW", group: "Channels", label: "Rang-Anträge (Staff)", type: "channel" },
  { key: "CHANNEL_EVENT_ANNOUNCEMENTS", group: "Channels", label: "Event-Ankündigungen", type: "channel", help: "Auch automatische Aktivitäten werden hier gepostet." },
  { key: "CHANNEL_AUDIT_LOG", group: "Channels", label: "Audit-Log", type: "channel" },
  { key: "CHANNEL_AUTOMOD_LOG", group: "Channels", label: "AutoMod-/Raid-Log", type: "channel" },
  { key: "CHANNEL_STATS", group: "Channels", label: "Statistik", type: "channel", help: "Öffentliche Statistik ohne Finanzdaten." },
  { key: "TICKET_CATEGORIES_JSON", group: "Tickets", label: "Ticket-Kategorien", type: "ticketCategories" },
  { key: "TICKET_MAX_OPEN_PER_USER", group: "Tickets", label: "Max. offene Tickets pro Person", type: "number", min: 1, max: 20 },
  { key: "TICKET_COOLDOWN_SECONDS", group: "Tickets", label: "Wartezeit zwischen Tickets (Sekunden)", type: "number", min: 1, max: 86400 },
  { key: "TICKET_TRANSCRIPT_LIMIT", group: "Tickets", label: "Nachrichten im Transkript", type: "number", min: 100, max: 1000 },
  { key: "PAYOUT_MINIMUM_CENTS", group: "Familienkonto", label: "Auszahlungs-Mindestbetrag ($)", type: "money", help: "Leer = kein Mindestbetrag, alle Kontostände werden angezeigt." },
  { key: "TIMEZONE", group: "Events", label: "Zeitzone", type: "text", help: "IANA-Name, z. B. Europe/Vienna." },
  { key: "EVENT_REMINDER_MINUTES", group: "Events", label: "Erinnerungen (Minuten vorher)", type: "numberList", help: "Kommagetrennt, z. B. 60, 15. Leer = Standard." },
  { key: "EVENT_SERIES_AUTO_END_MINUTES", group: "Events", label: "Aktivitäten automatisch beenden nach (Minuten)", type: "number", min: 15, max: 1440, help: "Automatisch erstellte Termine werden so lange nach Start geschlossen." },
  { key: "RANK_ROLE_ASSIGNMENT_ENABLED", group: "Anträge", label: "Rang-Rollen nach Annahme vergeben", type: "bool", help: "Nur Leitung, nur nach Bestätigung, mit Hierarchieprüfung." },
  { key: "RANK_ROLES_JSON", group: "Anträge", label: "Freigegebene Rang-Rollen", type: "rankRoles" },
  { key: "APPLICATION_QUESTIONS_JSON", group: "Anträge", label: "Eigene Antragsfragen (JSON, optional)", type: "json", help: '{"rang":[{"id":"name","label":"Ingame-Name","style":"short"}]} – max. 5 Fragen, Beschriftung max. 45 Zeichen. {} = Standardfragen.' },
  { key: "AUTOMOD_ENABLED", group: "AutoMod", label: "AutoMod aktiv", type: "bool" },
  { key: "AUTOMOD_BLOCKED_TERMS", group: "AutoMod", label: "Gesperrte Begriffe", type: "list" },
  { key: "AUTOMOD_ALLOWED_DOMAINS", group: "AutoMod", label: "Erlaubte Link-Domains", type: "list" },
  { key: "AUTOMOD_SPAM_COUNT", group: "AutoMod", label: "Spam: Nachrichten", type: "number", min: 3, max: 50 },
  { key: "AUTOMOD_SPAM_WINDOW_SECONDS", group: "AutoMod", label: "Spam: Zeitfenster (Sekunden)", type: "number", min: 1, max: 600 },
  { key: "AUTOMOD_DUPLICATE_COUNT", group: "AutoMod", label: "Gleiche Nachricht: Anzahl", type: "number", min: 2, max: 50 },
  { key: "AUTOMOD_SPAM_ACTIONS", group: "AutoMod", label: "Aktionen bei Spam", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_DUPLICATE_ACTIONS", group: "AutoMod", label: "Aktionen bei Wiederholung", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_LINK_ACTIONS", group: "AutoMod", label: "Aktionen bei fremden Links", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_TERM_ACTIONS", group: "AutoMod", label: "Aktionen bei gesperrten Begriffen", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_TIMEOUT_MINUTES", group: "AutoMod", label: "Timeout-Dauer (Minuten)", type: "number", min: 1, max: 40320 },
  { key: "AUTOMOD_ESCALATION_COUNT", group: "AutoMod", label: "Eskalation nach Verstößen (0 = aus)", type: "number", min: 0, max: 50 },
  { key: "AUTOMOD_ESCALATION_WINDOW_MINUTES", group: "AutoMod", label: "Eskalations-Zeitfenster (Minuten)", type: "number", min: 1, max: 1440 },
  { key: "AUTOMOD_EXEMPT_ROLES", group: "AutoMod", label: "Ausgenommene Rollen", type: "roles" },
  { key: "AUTOMOD_EXEMPT_CHANNELS", group: "AutoMod", label: "Ausgenommene Channels", type: "channels" },
  { key: "RAID_JOIN_COUNT", group: "Raid-Schutz", label: "Beitritte bis Raid-Alarm", type: "number", min: 3, max: 500 },
  { key: "RAID_WINDOW_SECONDS", group: "Raid-Schutz", label: "Zeitfenster (Sekunden)", type: "number", min: 1, max: 3600 },
  { key: "RAID_ACTIONS", group: "Raid-Schutz", label: "Aktionen bei Raid", type: "actions", options: [["alert", "Staff-Meldung"], ["timeout", "Neue Mitglieder stummschalten"]] },
  { key: "RAID_TIMEOUT_MINUTES", group: "Raid-Schutz", label: "Raid-Timeout (Minuten)", type: "number", min: 1, max: 40320 },
  { key: "FLOOD_MESSAGE_COUNT", group: "Raid-Schutz", label: "Nachrichtenflut ab (0 = aus)", type: "number", min: 0, max: 10000 },
  { key: "FLOOD_WINDOW_SECONDS", group: "Raid-Schutz", label: "Flut-Zeitfenster (Sekunden)", type: "number", min: 1, max: 600 },
  { key: "AUDIT_CHANNEL_IGNORE_ACTIONS", group: "Logs & Panels", label: "Nicht in den Audit-Channel senden", type: "list" },
  { key: "STATS_CHANNEL_UPDATE_MINUTES", group: "Logs & Panels", label: "Statistik-Channel aktualisieren (Minuten, 0 = aus)", type: "number", min: 0, max: 10080 },
  { key: "DASHBOARD_PANEL_REFRESH_MINUTES", group: "Logs & Panels", label: "Discord-Panels aktualisieren (Minuten, 0 = aus)", type: "number", min: 0, max: 1440 },
];
export const SETTING_KEYS = new Set(SETTINGS.map(setting => setting.key));
const SNOWFLAKE = /^\d{17,20}$/;

/** Wandelt einen Wert aus der Website (typisiert) in das gespeicherte .env-Format um. */
export function toRaw(definition, value) {
  const list = v => (Array.isArray(v) ? v : String(v ?? "").split(",")).map(x => String(x).trim()).filter(Boolean);
  switch (definition.type) {
    case "roles": case "channels": {
      const ids = [...new Set(list(value))];
      if (!ids.every(id => SNOWFLAKE.test(id))) throw new Error(`${definition.label}: ungültige ID.`);
      return ids.join(",");
    }
    case "channel": case "category": { const id = String(value ?? "").trim(); if (id && !SNOWFLAKE.test(id)) throw new Error(`${definition.label}: ungültige ID.`); return id; }
    case "number": { const n = Number(value); if (!Number.isInteger(n) || n < definition.min || n > definition.max) throw new Error(`${definition.label}: ganze Zahl von ${definition.min} bis ${definition.max}.`); return String(n); }
    case "money": {
      const text = String(value ?? "").trim().replace(/^\$/, "");
      if (!text) return "";
      const match = /^(\d{1,12})(?:[,.](\d{1,2}))?$/.exec(text);
      if (!match) throw new Error(`${definition.label}: Betrag wie 2500000 oder 12,50 angeben.`);
      return String(Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")));
    }
    case "bool": return value === true || value === "true" ? "true" : "false";
    case "list": case "actions": case "numberList": return list(value).join(",");
    case "text": return String(value ?? "").trim();
    case "json": case "ticketCategories": case "rankRoles": {
      if (typeof value === "string") { try { JSON.parse(value || (definition.type === "json" ? "{}" : "[]")); } catch { throw new Error(`${definition.label}: ungültiges JSON.`); } return value.trim() || (definition.type === "json" ? "{}" : "[]"); }
      return JSON.stringify(value ?? (definition.type === "json" ? {} : []));
    }
    default: throw new Error("Unbekannter Einstellungstyp.");
  }
}

export function createSettingsService({ db, config, env, guildId }) {
  const stored = () => Object.fromEntries(db.prepare("SELECT key,value FROM guild_settings WHERE guild_id=?").all(guildId).filter(row => SETTING_KEYS.has(row.key)).map(row => [row.key, row.value]));
  let effectiveEnv = { ...env };

  /** Übernimmt gespeicherte Werte in die laufende Konfiguration; ungültige Werte werden übersprungen und gemeldet. */
  function apply() {
    const candidate = { ...env }, rejected = [];
    for (const [key, value] of Object.entries(stored())) {
      try { loadConfig({ ...candidate, [key]: value }); candidate[key] = value; }
      catch (error) { rejected.push(`${key}: ${error.message.replace(/^Ungültige Konfiguration: /, "")}`); }
    }
    const parsed = loadConfig(candidate);
    for (const key of SETTING_KEYS) config[key] = parsed[key];
    effectiveEnv = candidate;
    return { rejected };
  }

  function describe() {
    const overrides = stored();
    return SETTINGS.map(definition => ({
      ...definition, value: config[definition.key] ?? null,
      source: Object.hasOwn(overrides, definition.key) ? "website" : env[definition.key] != null && env[definition.key] !== "" ? "env" : "standard",
    }));
  }

  /** Speichert eine Einstellung nach vollständiger Validierung. actorRoleIds schützt vor Selbstaussperrung der Leitung. */
  function update({ key, value, actorId, actorRoleIds = [], actorIsOwner = false }) {
    const definition = SETTINGS.find(item => item.key === key);
    if (!definition) throw new Error("Diese Einstellung kann nicht über die Oberfläche geändert werden.");
    const raw = toRaw(definition, value);
    let parsed;
    try { parsed = loadConfig({ ...effectiveEnv, [key]: raw }); }
    catch (error) { throw new Error(error.message.replace(/^Ungültige Konfiguration: /, "Ungültiger Wert – ")); }
    if (key === "ROLE_LEADERS" && !actorIsOwner && !parsed.ROLE_LEADERS.some(id => actorRoleIds.includes(id))) throw new Error("Du würdest dich selbst aus der Leitung aussperren. Behalte mindestens eine deiner Rollen in der Liste.");
    const previous = effectiveEnv[key] ?? "";
    db.transaction(() => {
      db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(guildId, key, raw, new Date().toISOString());
      audit(db, guildId, actorId, "config.changed", key, { setting: key, previous: String(previous).slice(0, 300), value: raw.slice(0, 300) });
    })();
    effectiveEnv = { ...effectiveEnv, [key]: raw };
    config[key] = parsed[key];
    return config[key];
  }

  /** Entfernt den Website-Wert; danach gilt wieder der Wert aus der .env bzw. der Standard. */
  function reset({ key, actorId, actorRoleIds = [], actorIsOwner = false }) {
    if (!SETTING_KEYS.has(key)) throw new Error("Unbekannte Einstellung.");
    const candidate = { ...effectiveEnv }; delete candidate[key];
    if (env[key] != null) candidate[key] = env[key];
    const parsed = loadConfig(candidate);
    if (key === "ROLE_LEADERS" && !actorIsOwner && !parsed.ROLE_LEADERS.some(id => actorRoleIds.includes(id))) throw new Error("Nach dem Zurücksetzen hättest du keine Leitungsrolle mehr.");
    db.transaction(() => {
      db.prepare("DELETE FROM guild_settings WHERE guild_id=? AND key=?").run(guildId, key);
      audit(db, guildId, actorId, "config.changed", key, { setting: key, previous: String(effectiveEnv[key] ?? "").slice(0, 300), value: "(.env/Standard)" });
    })();
    effectiveEnv = candidate;
    config[key] = parsed[key];
    return config[key];
  }

  return { apply, describe, update, reset };
}
