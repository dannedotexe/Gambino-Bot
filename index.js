import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { accessGroups, configWarnings, loadConfig } from "./src/config.js";
import { getSetting, openDatabase, setSetting } from "./src/database.js";
import { createFinance } from "./src/services/finance.js";
import { buildCommands, createHandler, handleComponent } from "./src/commands.js";
import { ensureLogbook } from "./src/logbooks.js";
import { startScheduler } from "./src/scheduler.js";
import { startModeration } from "./src/moderation.js";
import { createSettingsService } from "./src/services/settings.js";
import { createSeriesService } from "./src/services/event-series.js";
import { ensurePanels } from "./src/panels.js";
import { currentVersion } from "./src/version.js";
import { createDashboard } from "./src/dashboard.js";
import { createTicketService } from "./src/services/tickets.js";
import { createAccountClosureService } from "./src/services/account-closures.js";
import { createActivityService } from "./src/services/activity.js";
import { sendWelcome } from "./src/welcome.js";
import { trackRankChange } from "./src/rank-tracking.js";
import { migrateNicknameFormat } from "./src/nickname-migration.js";

let config;
try { config=loadConfig(); }
catch(error){ console.error(error.message); process.exit(1); }

for(const warning of configWarnings(config))console.warn(`Konfigurationshinweis: ${warning}`);

let db;
try { db=openDatabase(config.DATABASE_PATH); }
catch(error){ console.error(`Datenbank konnte nicht geöffnet werden (${config.DATABASE_PATH}):`,error.message); process.exit(1); }
// Über Website/Discord gespeicherte Einstellungen überschreiben die .env-Startwerte (nur mit DISCORD_GUILD_ID).
const settings=config.DISCORD_GUILD_ID?createSettingsService({db,config,env:{...process.env},guildId:config.DISCORD_GUILD_ID}):null;
if(settings){const {rejected}=settings.apply();for(const item of rejected)console.warn(`Gespeicherte Einstellung ignoriert (ungültig): ${item}`);}
const series=createSeriesService(db);
if(config.DISCORD_GUILD_ID){const seeded=series.seedDefaults(config.DISCORD_GUILD_ID);if(seeded)console.log(`${seeded} Standard-Aktivitäten angelegt (inaktiv). Aktivieren über Website oder /aktivitaeten.`);}
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],partials:[Partials.Channel]});
const finance=createFinance(db);
const handlers=createHandler({db,finance,config,client,settings,series});
const dashboard=createDashboard({db,client,config,settings,series});

client.once(Events.ClientReady,ready=>{
  console.log(`Gambino Bot bereit als ${ready.user.tag} (Version ${currentVersion()}).`);
  startScheduler({db,client,config,series});
  void adoptLeadershipDefaults();
  // Alle Mitglieder in den Cache laden, damit Rollenwechsel (z. B. neue Familienrolle) zuverlässig erkannt werden.
  if(config.DISCORD_GUILD_ID)void ready.guilds.fetch(config.DISCORD_GUILD_ID).then(g=>g.members.fetch()).catch(error=>console.warn("Mitglieder konnten nicht geladen werden:",error.message));
  void migrateNicknameFormat({db,client,config}).then(r=>{if(r)console.log(`Namensformat umgestellt: ${r.renamed} umbenannt, ${r.skipped} übersprungen, ${r.failed} fehlgeschlagen.`);}).catch(error=>console.warn("Namensformat konnte nicht umgestellt werden:",error.message));
});
// Von der Leitung genannte IDs einmalig übernehmen, falls noch nichts eingestellt ist. Gesetzt wird nur, was
// auf dem konfigurierten Server wirklich existiert und den richtigen Typ hat; jede Übernahme wird protokolliert.
const ADOPT_NAMES={CHANNEL_WELCOME:/^\W*willkommen$/i,CHANNEL_ABSENCES:/^\W*abmeldungen$/i};
const ADOPT_HINTS={CHANNEL_TICKET_CLOSED_CATEGORY:"1559680452980113479",ROLE_VERIFIED:"1559685681465397289",ROLE_MEMBERS:"1559954288652853248",CHANNEL_EVENT_CHECK:"1561413596150497300",CHANNEL_BOT_COMMANDS:"1561749617119461517",CHANNEL_TASK_FORUM:"1559991607791456398"};
async function adoptLeadershipDefaults(){
  if(!settings)return;
  const guild=await client.guilds.fetch(config.DISCORD_GUILD_ID).catch(()=>null);
  if(!guild)return;
  const adopt=(key,value,label)=>{try{settings.update({key,value,actorId:client.user.id,actorIsOwner:true});console.log(`${label} eingestellt.`);return true;}catch(error){console.warn(`${label} konnte nicht eingestellt werden:`,error.message);return false;}};
  if(!config.CHANNEL_TICKET_CLOSED_CATEGORY){const category=await guild.channels.fetch(ADOPT_HINTS.CHANNEL_TICKET_CLOSED_CATEGORY).catch(()=>null);if(category?.type===4)adopt("CHANNEL_TICKET_CLOSED_CATEGORY",category.id,`Kategorie für geschlossene Tickets (${category.name})`);}
  // Allgemeine Familienrolle (von der Leitung genannt): einmalig ergänzen, vorhandene Einträge bleiben erhalten.
  if(!getSetting(db,guild.id,"ADOPTED_ROLE_MEMBERS")&&!(config.ROLE_MEMBERS??[]).includes(ADOPT_HINTS.ROLE_MEMBERS)){const role=await guild.roles.fetch(ADOPT_HINTS.ROLE_MEMBERS).catch(()=>null);if(role&&adopt("ROLE_MEMBERS",[...(config.ROLE_MEMBERS??[]),role.id],`Familienmitglieder-Rolle (${role.name})`))setSetting(db,guild.id,"ADOPTED_ROLE_MEMBERS",new Date().toISOString());}
  if(!config.CHANNEL_BOT_COMMANDS&&!getSetting(db,guild.id,"ADOPTED_CHANNEL_BOT_COMMANDS")){const channel=await guild.channels.fetch(ADOPT_HINTS.CHANNEL_BOT_COMMANDS).catch(()=>null);if(channel?.isTextBased?.()&&adopt("CHANNEL_BOT_COMMANDS",channel.id,`Befehls-Channel (#${channel.name})`))setSetting(db,guild.id,"ADOPTED_CHANNEL_BOT_COMMANDS",new Date().toISOString());}
  if(!config.CHANNEL_EVENT_CHECK){const channel=await guild.channels.fetch(ADOPT_HINTS.CHANNEL_EVENT_CHECK).catch(()=>null);if(channel?.isTextBased?.())adopt("CHANNEL_EVENT_CHECK",channel.id,`Event-Check-Channel (#${channel.name})`);}
  // Logbücher-Forum („aufgaben-logs“) übernehmen, wenn es genau ein passendes Forum gibt.
  if(!config.CHANNEL_TASK_FORUM&&!getSetting(db,guild.id,"ADOPTED_CHANNEL_TASK_FORUM")){const hinted=await guild.channels.fetch(ADOPT_HINTS.CHANNEL_TASK_FORUM).catch(()=>null);if(hinted?.type===15&&adopt("CHANNEL_TASK_FORUM",hinted.id,`Logbücher-Forum (#${hinted.name})`))setSetting(db,guild.id,"ADOPTED_CHANNEL_TASK_FORUM",new Date().toISOString());}
  if(!config.CHANNEL_TASK_FORUM&&!getSetting(db,guild.id,"ADOPTED_CHANNEL_TASK_FORUM")){const forums=[...(await guild.channels.fetch().catch(()=>new Map())).values()].filter(ch=>ch?.type===15&&/aufgaben-?logs?/i.test(ch.name));if(forums.length===1&&adopt("CHANNEL_TASK_FORUM",forums[0].id,`Logbücher-Forum (#${forums[0].name})`))setSetting(db,guild.id,"ADOPTED_CHANNEL_TASK_FORUM",new Date().toISOString());}
  // Turf Leader dürfen Events (z. B. Staatliche Kontrolle) ankündigen: einmalig ins Event-Team übernehmen, bestehende Einträge bleiben.
  if(!getSetting(db,guild.id,"ADOPTED_TURF_LEADER_EVENTS")){const roles=[...(await guild.roles.fetch().catch(()=>new Map())).values()].filter(r=>/turf\s*leader/i.test(r.name)&&!r.managed);if(roles.length===1){const ids=[...new Set([...(config.ROLE_EVENT_TEAM??[]),roles[0].id])];if(ids.length===(config.ROLE_EVENT_TEAM??[]).length||adopt("ROLE_EVENT_TEAM",ids,`Event-Team ergänzt um ${roles[0].name}`))setSetting(db,guild.id,"ADOPTED_TURF_LEADER_EVENTS",new Date().toISOString());}}
  if(!config.ROLE_VERIFIED?.length){const role=await guild.roles.fetch(ADOPT_HINTS.ROLE_VERIFIED).catch(()=>null);if(role)adopt("ROLE_VERIFIED",[role.id],`Verifiziert-Rolle (${role.name})`);}
  // Willkommens- und Abmeldungs-Channel aus dem Gambinos-Layout übernehmen, wenn es genau einen passenden gibt.
  const allChannels=[...(await guild.channels.fetch().catch(()=>new Map())).values()].filter(ch=>ch?.isTextBased?.());
  for(const [key,pattern] of Object.entries(ADOPT_NAMES)){
    if(config[key])continue;
    const plain=ch=>String(ch.name).replace(/^[^a-z0-9äöüß]+/i,"");
    const matches=allChannels.filter(ch=>pattern.test(plain(ch)));
    if(matches.length===1&&adopt(key,matches[0].id,`${key==="CHANNEL_WELCOME"?"Willkommens":"Abmeldungs"}-Channel (#${matches[0].name})`)&&key==="CHANNEL_ABSENCES")await ensurePanels({db,client,config,series,only:["CHANNEL_ABSENCES"]}).catch(()=>{});
  }
  if(!config.CHANNEL_VERIFICATION_PANEL){
    const matches=[...(await guild.channels.fetch().catch(()=>new Map())).values()].filter(ch=>ch?.isTextBased?.()&&/neue-spieler/i.test(ch.name));
    if(matches.length===1&&adopt("CHANNEL_VERIFICATION_PANEL",matches[0].id,`Verifizierungs-Panel-Channel (#${matches[0].name})`))await ensurePanels({db,client,config,series,only:["CHANNEL_VERIFICATION_PANEL"]}).catch(()=>{});
  }
}
client.on(Events.InteractionCreate,async interaction=>{
  try {
    if(interaction.isAutocomplete()) await handlers.autocomplete(interaction);
    else if(interaction.isChatInputCommand()) await handlers.command(interaction);
    else await handleComponent(interaction,handlers);
  } catch(error){
    console.error("Interaction failed:",error);
    if(interaction.isRepliable()&&!interaction.replied&&!interaction.deferred)await interaction.reply({content:"Die Aktion ist fehlgeschlagen. Bitte versuche es später erneut.",flags:MessageFlags.Ephemeral}).catch(()=>{});
  }
});
// Neue Familienmitglieder (Mitglieder-Rolle erhalten) bekommen automatisch ein Familienkonto.
client.on(Events.GuildMemberUpdate,(oldMember,newMember)=>{void trackRankChange({db,config,oldMember,newMember}).catch(error=>console.warn("Rangänderung nicht protokolliert:",error.message));});
client.on(Events.GuildMemberUpdate,(_old,member)=>{
  try{
    if(!config.ACCOUNT_AUTO_OPEN_FOR_MEMBERS||member.user?.bot)return;
    if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
    if(!(config.ROLE_MEMBERS??[]).some(id=>member.roles.cache.has(id)))return;
    finance.openAccount({guildId:member.guild.id,userId:member.id,actorId:client.user?.id??"system",note:"Familienmitglieder-Rolle erhalten"});
  }catch(error){console.error("Familienkonto konnte nicht automatisch angelegt werden:",error.message);}
});
// Familienrolle neu erhalten: Logbuch im Forum anlegen (nur beim Wechsel von „ohne“ zu „mit“ Rolle).
client.on(Events.GuildMemberUpdate,(oldMember,member)=>{
  if(!config.LOGBOOK_AUTO_CREATE||!config.CHANNEL_TASK_FORUM||member.user?.bot)return;
  if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
  const had=oldMember?.partial?null:(config.ROLE_MEMBERS??[]).some(id=>oldMember.roles.cache.has(id));
  if(had!==false||!(config.ROLE_MEMBERS??[]).some(id=>member.roles.cache.has(id)))return;
  void ensureLogbook({db,client,config,member}).then(r=>{if(r.status==="created")console.log(`Logbuch angelegt: ${r.thread.name}`);}).catch(error=>console.warn("Logbuch konnte nicht angelegt werden:",error.message));
});
// Familienrolle verloren oder Server verlassen: Löschanfrage für das Familienkonto (Bestätigung über die Website).
const closures=createAccountClosureService(db,finance);
const hasFamilyRole=member=>(config.ROLE_MEMBERS??[]).some(id=>member?.roles?.cache?.has(id));
client.on(Events.GuildMemberUpdate,(oldMember,member)=>{
  try{
    if(member.user?.bot||!(config.ROLE_MEMBERS??[]).length)return;
    if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
    const before=oldMember?.partial?null:hasFamilyRole(oldMember),now=hasFamilyRole(member);
    if(now){if(before===false||before===null)closures.resolveRejoined({guildId:member.guild.id,userId:member.id,actorId:client.user?.id??"system"});return;}
    if(before===false)return;
    closures.request({guildId:member.guild.id,userId:member.id,reason:"role_removed",actorId:client.user?.id??"system",definite:before===true});
  }catch(error){console.error("Löschanfrage konnte nicht angelegt werden:",error.message);}
});
client.on(Events.GuildMemberRemove,member=>{
  try{
    if(member.user?.bot)return;
    if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
    closures.request({guildId:member.guild.id,userId:member.id,reason:"left",actorId:client.user?.id??"system"});
  }catch(error){console.error("Löschanfrage konnte nicht angelegt werden:",error.message);}
});
// Begrüßung neuer Spieler (Channel CHANNEL_WELCOME, optional DM). Texte über die Website änderbar.
client.on(Events.GuildMemberAdd,member=>{void sendWelcome({db,client,config,member}).catch(error=>console.warn("Begrüßung fehlgeschlagen:",error.message));});
// Aktivität: nur Zeitpunkt und Anzahl der Nachrichten, nie Inhalte (für Inaktivitäts-Check und Mitgliederprofil).
const activity=createActivityService(db);
client.on(Events.MessageCreate,message=>{
  try{
    if(!message.guildId||message.author?.bot||message.webhookId)return;
    if(config.DISCORD_GUILD_ID&&message.guildId!==config.DISCORD_GUILD_ID)return;
    activity.recordMessage(message.guildId,message.author.id,message.createdAt??new Date());
    // Befehls-Channel sauber halten: normale Nachrichten von Mitgliedern verschwinden (Staff darf schreiben).
    if(config.BOT_COMMANDS_CLEANUP&&config.CHANNEL_BOT_COMMANDS&&message.channelId===config.CHANNEL_BOT_COMMANDS){
      const staff=(config.BOT_OWNER_IDS??[]).includes(message.author.id)||accessGroups(config).anyStaff.some(id=>message.member?.roles?.cache?.has(id));
      if(!staff)void message.delete().then(()=>message.channel.send({content:`<@${message.author.id}> Hier bitte nur Bot-Befehle nutzen (z. B. \`/abwesend\`, \`/rangliste\`).`,allowedMentions:{users:[message.author.id]}})).then(hint=>setTimeout(()=>hint?.delete?.().catch(()=>{}),8000)).catch(()=>{});
    }
  }catch(error){console.warn("Aktivität konnte nicht gespeichert werden:",error.message);}
});
// Gelöschte Ticket-Channels: Ticket wird geschlossen und protokolliert, Daten und Transkript bleiben erhalten.
const ticketService=createTicketService(db);
client.on(Events.ChannelDelete,channel=>{
  try{
    const ticket=db.prepare("SELECT id FROM tickets WHERE channel_id=?").get(channel.id);
    if(ticket)ticketService.markChannelMissing({ticketId:ticket.id,actorId:client.user?.id??"system"});
  }catch(error){console.error("Ticket-Channel-Löschung konnte nicht verarbeitet werden:",error.message);}
});
client.on(Events.Error,error=>console.error("Discord client error:",error));
client.on(Events.ShardError,error=>console.error("Discord gateway shard error:",error));
client.on(Events.ShardDisconnect,(_event,id)=>console.warn(`Discord shard ${id} getrennt; Reconnect wird versucht.`));
startModeration({client,db,config});
process.on("unhandledRejection",error=>console.error("Unhandled rejection:",error));
process.on("uncaughtException",error=>{console.error("Uncaught exception:",error);process.exitCode=1;});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{console.log(`${signal}: sauberer Shutdown.`);client.destroy();void dashboard.close();db.close();process.exit(0);});
client.login(config.DISCORD_TOKEN).catch(error=>{console.error("Discord-Login fehlgeschlagen:",error.message);db.close();process.exit(1);});
