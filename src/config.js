import { z } from "zod";

const csv = (value) => value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
const idList = z.string().optional().transform(csv).pipe(z.array(z.string().regex(/^\d{17,20}$/)));
const snowflake = z.string().regex(/^\d{17,20}$/).optional().or(z.literal(""));

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
  DISCORD_GUILD_ID: snowflake,
  DATABASE_PATH: z.string().default("./data/gambino.sqlite"),
  TIMEZONE: z.string().default("Europe/Vienna"),
  CURRENCY_NAME: z.string().default("Gambinos-Familienguthaben"),
  PAYOUT_MINIMUM_CENTS: z.coerce.number().int().nonnegative().optional(),
  ROLE_LEADERS: idList.optional(), ROLE_STAFF: idList.optional(), ROLE_EVENT_TEAM: idList.optional(),
  ROLE_FINANCE: idList.optional(), ROLE_REVIEWERS: idList.optional(), ROLE_MEMBERS: idList.optional(),
  BOT_OWNER_IDS: idList.optional(),
  CHANNEL_TICKET_CATEGORY: snowflake, CHANNEL_TICKET_LOG: snowflake,
  CHANNEL_APPLICATION_REVIEW: snowflake, CHANNEL_RANK_REVIEW: snowflake, CHANNEL_EVENT_ANNOUNCEMENTS: snowflake,
  CHANNEL_AUDIT_LOG: snowflake, CHANNEL_STATS: snowflake, CHANNEL_AUTOMOD_LOG: snowflake,
  TICKET_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  TICKET_MAX_OPEN_PER_USER: z.coerce.number().int().positive().default(2),
  TICKET_CATEGORIES_JSON: z.string().default('[{"id":"support","label":"Support","roleIds":[]},{"id":"beschwerde","label":"Beschwerde","roleIds":[]},{"id":"leitung","label":"Leitung","roleIds":[]}]').transform((raw,ctx)=>{try{return JSON.parse(raw);}catch{ctx.addIssue({code:"custom",message:"Muss gültiges JSON sein"});return [];}}).pipe(z.array(z.object({id:z.string().regex(/^[a-z0-9_-]{1,25}$/),label:z.string().min(1).max(100),roleIds:z.array(z.string().regex(/^\d{17,20}$/)).default([])})).min(1).max(25)).transform(categories=>categories.filter(category=>category.id!=="bewerbung")),
  AUTOMOD_ENABLED: z.string().default("false").transform((v) => v.toLowerCase() === "true"),
  AUTOMOD_BLOCKED_TERMS: z.string().default("").transform(csv),
  AUTOMOD_ALLOWED_DOMAINS: z.string().default("discord.com,discord.gg").transform(csv),
  AUTOMOD_SPAM_COUNT: z.coerce.number().int().min(3).default(5),
  AUTOMOD_SPAM_WINDOW_SECONDS: z.coerce.number().int().positive().default(8),
  RAID_JOIN_COUNT: z.coerce.number().int().min(3).default(10),
  RAID_WINDOW_SECONDS: z.coerce.number().int().positive().default(20),
  DASHBOARD_ENABLED: z.string().default("false").transform(v=>v.toLowerCase()==="true"),
  DASHBOARD_BIND: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(3080),
  DASHBOARD_PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DASHBOARD_SESSION_SECRET: z.string().optional(),
}).superRefine((cfg, ctx) => {
  try { new Intl.DateTimeFormat("de-AT", { timeZone: cfg.TIMEZONE }); }
  catch { ctx.addIssue({ code: "custom", path: ["TIMEZONE"], message: "Unbekannte IANA-Zeitzone" }); }
  for (const [name, ids] of Object.entries({ leaders: cfg.ROLE_LEADERS, staff: cfg.ROLE_STAFF, events: cfg.ROLE_EVENT_TEAM, finance: cfg.ROLE_FINANCE, reviewers: cfg.ROLE_REVIEWERS })) {
    if (ids?.length && new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [`ROLE_${name.toUpperCase()}`], message: "Doppelte Rollen-ID" });
  }
  if(cfg.DASHBOARD_ENABLED){
    if(!cfg.DISCORD_GUILD_ID)ctx.addIssue({code:"custom",path:["DISCORD_GUILD_ID"],message:"Für das Dashboard erforderlich"});
    let dashboardUrl;
    try { dashboardUrl = new URL(cfg.DASHBOARD_PUBLIC_URL); } catch { dashboardUrl = null; }
    if(!dashboardUrl||dashboardUrl.protocol!=="https:"||dashboardUrl.pathname!=="/"||dashboardUrl.search||dashboardUrl.hash)ctx.addIssue({code:"custom",path:["DASHBOARD_PUBLIC_URL"],message:"Eine reine HTTPS-Domain ohne zusätzlichen Pfad ist erforderlich"});
    if(!["127.0.0.1","::1","localhost"].includes(cfg.DASHBOARD_BIND))ctx.addIssue({code:"custom",path:["DASHBOARD_BIND"],message:"Aus Sicherheitsgründen muss das Dashboard an localhost gebunden sein"});
    if(!cfg.DISCORD_CLIENT_SECRET)ctx.addIssue({code:"custom",path:["DISCORD_CLIENT_SECRET"],message:"Für Discord-OAuth erforderlich"});
    if(!cfg.DASHBOARD_SESSION_SECRET||cfg.DASHBOARD_SESSION_SECRET.length<32)ctx.addIssue({code:"custom",path:["DASHBOARD_SESSION_SECRET"],message:"Mindestens 32 Zeichen erforderlich"});
    const dashboardRoles=[...(cfg.ROLE_LEADERS??[]),...(cfg.ROLE_STAFF??[]),...(cfg.ROLE_FINANCE??[]),...(cfg.ROLE_EVENT_TEAM??[]),...(cfg.ROLE_REVIEWERS??[])];
    if(!dashboardRoles.length&&!cfg.BOT_OWNER_IDS?.length)ctx.addIssue({code:"custom",path:["ROLE_*"] ,message:"Mindestens eine Staff-Rolle oder BOT_OWNER_IDS muss für den Dashboard-Zugriff gesetzt sein"});
  }
});

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Konfiguration: ${details}`);
  }
  return parsed.data;
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
