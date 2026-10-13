import { z } from "zod";

const csv = (value) => value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
const SNOWFLAKE = /^\d{17,20}$/;
const idList = z.string().optional().transform(csv).pipe(z.array(z.string().regex(SNOWFLAKE)));
const snowflake = z.string().regex(SNOWFLAKE).optional().or(z.literal(""));
const bool = (fallback) => z.string().default(fallback).transform((v) => v.trim().toLowerCase() === "true");
const actionList = (fallback) => z.string().default(fallback).transform(csv).pipe(z.array(z.enum(["warn", "delete", "timeout", "alert"])));
const jsonValue = (fallback) => z.string().default(fallback).transform((raw, ctx) => {
  try { return JSON.parse(raw); } catch { ctx.addIssue({ code: "custom", message: "Muss gültiges JSON sein" }); return z.NEVER; }
});

const questionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  // Discord begrenzt Modal-Feldbeschriftungen auf 45 Zeichen.
  label: z.string().min(1).max(45),
  style: z.enum(["short", "paragraph"]).default("short"),
  maxLength: z.number().int().min(1).max(4000).default(500),
  required: z.boolean().default(true),
  placeholder: z.string().max(100).optional(),
});
const applicationQuestionsSchema = z.object({
  bewerbung: z.array(questionSchema).min(1).max(5).optional(),
  rang: z.array(questionSchema).min(1).max(5).optional(),
}).strict();

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(SNOWFLAKE),
  DISCORD_GUILD_ID: snowflake,
  DATABASE_PATH: z.string().default("./data/gambino.sqlite"),
  TIMEZONE: z.string().default("Europe/Vienna"),
  CURRENCY_NAME: z.string().default("Gambinos-Familienguthaben"),
  PAYOUT_MINIMUM_CENTS: z.coerce.number().int().nonnegative().optional(),
  ROLE_LEADERS: idList.optional(), ROLE_STAFF: idList.optional(), ROLE_EVENT_TEAM: idList.optional(),
  ROLE_FINANCE: idList.optional(), ROLE_REVIEWERS: idList.optional(), ROLE_MEMBERS: idList.optional(),
  ROLE_FINANCE_VIEWERS: idList.optional(), ROLE_VERIFIED: idList.optional(), ROLE_MODERATORS: idList.optional(), EVENT_PING_ROLES: idList.optional(),
  BOT_OWNER_IDS: idList.optional(),
  CHANNEL_TICKET_CATEGORY: snowflake, CHANNEL_TICKET_LOG: snowflake,
  CHANNEL_APPLICATION_REVIEW: snowflake, CHANNEL_RANK_REVIEW: snowflake, CHANNEL_EVENT_ANNOUNCEMENTS: snowflake,
  CHANNEL_AUDIT_LOG: snowflake, CHANNEL_STATS: snowflake, CHANNEL_AUTOMOD_LOG: snowflake,
  CHANNEL_TICKET_PANEL: snowflake, CHANNEL_TICKET_CLOSED_CATEGORY: snowflake, CHANNEL_VERIFICATION_PANEL: snowflake, CHANNEL_APPLICATION_PANEL: snowflake, CHANNEL_STAFF_DASHBOARD: snowflake,
  CHANNEL_ACTIVITY_BOARD: snowflake, CHANNEL_EVENT_SIGNUP: snowflake, CHANNEL_ACCOUNT_PANEL: snowflake, CHANNEL_EVENT_RESULTS: snowflake, CHANNEL_EVENT_LOG: snowflake,
  CHANNEL_GIVEAWAYS: snowflake, CHANNEL_SANCTION_LOG: snowflake, CHANNEL_FINANCE_LOG: snowflake,
  AUDIT_CHANNEL_IGNORE_ACTIONS: z.string().default("event.participation,giveaway.entry").transform(csv),
  TICKET_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  TICKET_MAX_OPEN_PER_USER: z.coerce.number().int().positive().default(2),
  TICKET_TRANSCRIPT_LIMIT: z.coerce.number().int().min(100).max(1000).default(500),
  TICKET_CATEGORIES_JSON: z.string().default('[{"id":"support","label":"Support","roleIds":[]},{"id":"beschwerde","label":"Beschwerde","roleIds":[]},{"id":"leitung","label":"Leitung","roleIds":[]}]').transform((raw,ctx)=>{try{return JSON.parse(raw);}catch{ctx.addIssue({code:"custom",message:"Muss gültiges JSON sein"});return [];}}).pipe(z.array(z.object({id:z.string().regex(/^[a-z0-9_-]{1,25}$/),label:z.string().min(1).max(100),roleIds:z.array(z.string().regex(SNOWFLAKE)).default([]),description:z.string().max(100).optional(),emoji:z.string().max(20).optional()})).min(1).max(25)).transform(categories=>categories.filter(category=>category.id!=="bewerbung")),
  EVENT_REMINDER_MINUTES: z.string().default("60,15").transform(csv).pipe(z.array(z.coerce.number().int().min(1).max(10080)).max(5)).transform(list => [...new Set(list)].sort((a, b) => b - a)),
  EVENT_SERIES_DELETE_ENDED: bool("false"),
  ACCOUNT_AUTO_OPEN_FOR_MEMBERS: bool("true"),
  EVENT_SERIES_AUTO_END_MINUTES: z.coerce.number().int().min(15).max(1440).default(120),
  APPLICATION_QUESTIONS_JSON: jsonValue("{}").pipe(applicationQuestionsSchema),
  RANK_ROLE_ASSIGNMENT_ENABLED: bool("false"),
  RANK_ROLES_JSON: jsonValue("[]").pipe(z.array(z.object({ label: z.string().min(1).max(80), roleId: z.string().regex(SNOWFLAKE) })).max(25)),
  WARN_DM_ENABLED: bool("true"),
  WARN_EXPIRE_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  WARN_TIMEOUT_AT: z.coerce.number().int().min(0).max(50).default(0),
  WARN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(40320).default(60),
  WARN_ALERT_AT: z.coerce.number().int().min(0).max(50).default(0),
  AUTOMOD_ENABLED: bool("false"),
  AUTOMOD_BLOCKED_TERMS: z.string().default("").transform(csv),
  AUTOMOD_ALLOWED_DOMAINS: z.string().default("discord.com,discord.gg").transform(csv),
  AUTOMOD_SPAM_COUNT: z.coerce.number().int().min(3).default(5),
  AUTOMOD_SPAM_WINDOW_SECONDS: z.coerce.number().int().positive().default(8),
  AUTOMOD_DUPLICATE_COUNT: z.coerce.number().int().min(2).default(3),
  AUTOMOD_SPAM_ACTIONS: actionList("delete,alert"),
  AUTOMOD_DUPLICATE_ACTIONS: actionList("delete,alert"),
  AUTOMOD_LINK_ACTIONS: actionList("delete,warn,alert"),
  AUTOMOD_TERM_ACTIONS: actionList("delete,warn,alert"),
  AUTOMOD_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(40320).default(10),
  AUTOMOD_ESCALATION_COUNT: z.coerce.number().int().min(0).default(0),
  AUTOMOD_ESCALATION_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),
  AUTOMOD_EXEMPT_ROLES: idList.optional(),
  AUTOMOD_EXEMPT_CHANNELS: idList.optional(),
  RAID_JOIN_COUNT: z.coerce.number().int().min(3).default(10),
  RAID_WINDOW_SECONDS: z.coerce.number().int().positive().default(20),
  RAID_ACTIONS: z.string().default("alert").transform(csv).pipe(z.array(z.enum(["alert", "timeout"]))),
  RAID_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(40320).default(30),
  RAID_ALERT_COOLDOWN_SECONDS: z.coerce.number().int().min(30).default(300),
  FLOOD_MESSAGE_COUNT: z.coerce.number().int().min(0).default(60),
  FLOOD_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  STATS_CHANNEL_UPDATE_MINUTES: z.coerce.number().int().min(0).default(60),
  DASHBOARD_PANEL_REFRESH_MINUTES: z.coerce.number().int().min(0).default(5),
  DASHBOARD_ENABLED: bool("false"),
  DASHBOARD_BIND: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(3080),
  DASHBOARD_PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DASHBOARD_SESSION_SECRET: z.string().optional(),
}).superRefine((cfg, ctx) => {
  try { new Intl.DateTimeFormat("de-AT", { timeZone: cfg.TIMEZONE }); }
  catch { ctx.addIssue({ code: "custom", path: ["TIMEZONE"], message: "Unbekannte IANA-Zeitzone" }); }
  for (const [name, ids] of Object.entries({ leaders: cfg.ROLE_LEADERS, staff: cfg.ROLE_STAFF, moderators: cfg.ROLE_MODERATORS, event_team: cfg.ROLE_EVENT_TEAM, finance: cfg.ROLE_FINANCE, reviewers: cfg.ROLE_REVIEWERS })) {
    if (ids?.length && new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [`ROLE_${name.toUpperCase()}`], message: "Doppelte Rollen-ID" });
  }
  const categoryIds = cfg.TICKET_CATEGORIES_JSON.map(category => category.id);
  if (new Set(categoryIds).size !== categoryIds.length) ctx.addIssue({ code: "custom", path: ["TICKET_CATEGORIES_JSON"], message: "Kategorie-IDs müssen eindeutig sein" });
  for (const [kind, questions] of Object.entries(cfg.APPLICATION_QUESTIONS_JSON)) {
    const ids = questions.map(question => question.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["APPLICATION_QUESTIONS_JSON", kind], message: "Fragen-IDs müssen eindeutig sein" });
  }
  if (cfg.RANK_ROLE_ASSIGNMENT_ENABLED) {
    if (!cfg.RANK_ROLES_JSON.length) ctx.addIssue({ code: "custom", path: ["RANK_ROLES_JSON"], message: "Für die Rollenvergabe muss mindestens eine Rang-Rolle konfiguriert sein" });
    if (!cfg.ROLE_LEADERS?.length && !cfg.BOT_OWNER_IDS?.length) ctx.addIssue({ code: "custom", path: ["ROLE_LEADERS"], message: "Die Rollenvergabe ist nur mit konfigurierter Leitung erlaubt" });
  }
  if(cfg.DASHBOARD_ENABLED){
    if(!cfg.DISCORD_GUILD_ID)ctx.addIssue({code:"custom",path:["DISCORD_GUILD_ID"],message:"Für das Dashboard erforderlich"});
    let dashboardUrl;
    try { dashboardUrl = new URL(cfg.DASHBOARD_PUBLIC_URL); } catch { dashboardUrl = null; }
    if(!dashboardUrl||dashboardUrl.protocol!=="https:"||dashboardUrl.pathname!=="/"||dashboardUrl.search||dashboardUrl.hash)ctx.addIssue({code:"custom",path:["DASHBOARD_PUBLIC_URL"],message:"Eine reine HTTPS-Domain ohne zusätzlichen Pfad ist erforderlich"});
    if(!["127.0.0.1","::1","localhost"].includes(cfg.DASHBOARD_BIND))ctx.addIssue({code:"custom",path:["DASHBOARD_BIND"],message:"Aus Sicherheitsgründen muss das Dashboard an localhost gebunden sein"});
    if(!cfg.DISCORD_CLIENT_SECRET)ctx.addIssue({code:"custom",path:["DISCORD_CLIENT_SECRET"],message:"Für Discord-OAuth erforderlich"});
    if(!cfg.DASHBOARD_SESSION_SECRET||cfg.DASHBOARD_SESSION_SECRET.length<32)ctx.addIssue({code:"custom",path:["DASHBOARD_SESSION_SECRET"],message:"Mindestens 32 Zeichen erforderlich"});
    const dashboardRoles=[...(cfg.ROLE_LEADERS??[]),...(cfg.ROLE_STAFF??[]),...(cfg.ROLE_MODERATORS??[]),...(cfg.ROLE_FINANCE??[]),...(cfg.ROLE_EVENT_TEAM??[]),...(cfg.ROLE_REVIEWERS??[])];
    if(!dashboardRoles.length&&!cfg.BOT_OWNER_IDS?.length)ctx.addIssue({code:"custom",path:["ROLE_*"] ,message:"Mindestens eine Staff-Rolle oder BOT_OWNER_IDS muss für den Dashboard-Zugriff gesetzt sein"});
  }
});

export function loadConfig(env = process.env) {
  // Leere Werte aus .env-Dateien (`KEY=`) gelten als nicht gesetzt, damit Standardwerte greifen.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  for (const key of ["DISCORD_GUILD_ID", "DASHBOARD_PUBLIC_URL"]) if (env[key] === "") cleaned[key] = "";
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Konfiguration: ${details}`);
  }
  return parsed.data;
}

/** Rollenstufen. Leitung erbt alle Staff-Bereiche; leere Listen verweigern sicher. */
export function accessGroups(config) {
  const L = config.ROLE_LEADERS ?? [];
  const unique = (...lists) => [...new Set(lists.flat())];
  return {
    leaders: unique(L),
    staff: unique(L, config.ROLE_STAFF ?? []),
    finance: unique(L, config.ROLE_FINANCE ?? []),
    financeView: unique(L, config.ROLE_FINANCE ?? [], config.ROLE_FINANCE_VIEWERS ?? []),
    reviewers: unique(L, config.ROLE_REVIEWERS ?? []),
    events: unique(L, config.ROLE_EVENT_TEAM ?? []),
    moderation: unique(L, config.ROLE_STAFF ?? [], config.ROLE_MODERATORS ?? []),
    anyStaff: unique(L, config.ROLE_STAFF ?? [], config.ROLE_FINANCE ?? [], config.ROLE_REVIEWERS ?? [], config.ROLE_EVENT_TEAM ?? [], config.ROLE_MODERATORS ?? []),
    members: unique(config.ROLE_MEMBERS ?? []),
  };
}

/** Hinweise auf fehlende optionale Einstellungen. Notwendige Werte lösen bereits in loadConfig einen Fehler aus. */
export function configWarnings(config) {
  const warnings = [];
  if (!config.DISCORD_GUILD_ID) warnings.push("DISCORD_GUILD_ID fehlt: Commands werden global registriert und der Bot akzeptiert jeden Server.");
  const roles = { ROLE_LEADERS: "Leitungsaktionen (Sanktionsaufhebung, Korrekturen, Einstellungen)", ROLE_STAFF: "Tickets, Sanktionen, Giveaways", ROLE_FINANCE: "Gutschriften und Auszahlungen", ROLE_REVIEWERS: "Antragsprüfung", ROLE_EVENT_TEAM: "Eventverwaltung" };
  for (const [key, purpose] of Object.entries(roles)) if (!config[key]?.length) warnings.push(`${key} ist leer (betrifft: ${purpose}). Diese Aktionen können nur ${key === "ROLE_LEADERS" ? "Bot-Owner" : "Leitung und Bot-Owner"} ausführen.`);
  const channels = { CHANNEL_TICKET_CATEGORY: "Ticket-Channels entstehen ohne Kategorie", CHANNEL_TICKET_LOG: "keine Ticket-Kurzmeldungen und Transkript-Dateien", CHANNEL_APPLICATION_REVIEW: "Bewerbungen werden über den Channel-Namen gesucht", CHANNEL_RANK_REVIEW: "Rang-Anträge werden über den Channel-Namen gesucht", CHANNEL_EVENT_ANNOUNCEMENTS: "Events werden im Command-Channel angekündigt", CHANNEL_AUDIT_LOG: "Audit-Logs nur in der Datenbank", CHANNEL_AUTOMOD_LOG: "keine AutoMod-/Raid-Meldungen in Discord", CHANNEL_STATS: "kein automatischer Statistik-Channel" };
  for (const [key, effect] of Object.entries(channels)) if (!config[key]) warnings.push(`${key} ist leer: ${effect}.`);
  if (config.AUTOMOD_ENABLED && !config.CHANNEL_AUTOMOD_LOG) warnings.push("AutoMod ist aktiv, aber CHANNEL_AUTOMOD_LOG fehlt.");
  return warnings;
}

export function hasRole(member, allowed = []) {
  return allowed.length > 0 && member?.roles?.cache && allowed.some((id) => member.roles.cache.has(id));
}

export function requireRole(interaction, allowed, label = "autorisierte Staff-Rolle") {
  if (!interaction.inGuild()) return "Dieser Befehl funktioniert nur auf einem Server.";
  if (interaction.user?.id && interaction.client?.gambinoOwnerIds?.includes(interaction.user.id)) return null;
  if (!allowed?.length) return `Die Rollen für diese Aktion sind noch nicht konfiguriert. Bitte ROLE_* in der .env setzen.`;
  if (!hasRole(interaction.member, allowed)) return `Dafür brauchst du eine ${label}.`;
  return null;
}
