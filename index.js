import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { accessGroups, configWarnings, loadConfig } from "./src/config.js";
import { audit, getSetting, openDatabase, setSetting } from "./src/database.js";
import { createFinance } from "./src/services/finance.js";
import { buildCommands, createHandler, handleComponent } from "./src/commands.js";
import { LOGBOOK_FORUMS, activeLogbookKinds, archiveLogbook, createMissingLogbooks, ensureLogbook, logbookStatus, resetLogbookForum, syncLogbookTemplates, applyLogbookTemplate, templateKindOf, familyOf, fixLogbookMentions, reopenLogbook, renameLogbook, guardLogbookName, logbookTitle } from "./src/logbooks.js";
import { handleLogbookMessage } from "./src/task-logs.js";
import { refreshProofPrompt } from "./src/event-proofs.js";
import { refreshEventPosts } from "./src/event-posts.js";
import { giveawayResultPayload, giveawayWinnerPayload } from "./src/giveaway-cards.js";
import { startScheduler } from "./src/scheduler.js";
import { ensureFamilyRole, syncFamilyRoles } from "./src/family-role.js";
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
// Auf Wunsch der Leitung (21.10.2026): „Der Kampf um die Werft“ alle 3 Std. um xx:10 (ab 01:10), direkt aktiv.
if(config.DISCORD_GUILD_ID&&series.addDefaultOnce(config.DISCORD_GUILD_ID,"Der Kampf um die Werft",{active:true,key:"SERIES_WERFT_ADDED"}))console.log("Aktivität „Der Kampf um die Werft“ angelegt (aktiv).");
// Auf Wunsch der Leitung (21.10.2026): Hafen/Werft nur noch abends + 01:10 – nur wenn die Zeiten noch unverändert alle 3 Std. sind.
if(config.DISCORD_GUILD_ID&&!getSetting(db,config.DISCORD_GUILD_ID,"SERIES_WERFT_EVENING")){
  setSetting(db,config.DISCORD_GUILD_ID,"SERIES_WERFT_EVENING",new Date().toISOString());
  const changed=db.prepare("UPDATE event_series SET times='01:10,19:10,22:10',updated_at=? WHERE guild_id=? AND times='01:10,04:10,07:10,10:10,13:10,16:10,19:10,22:10'").run(new Date().toISOString(),config.DISCORD_GUILD_ID).changes;
  if(changed){audit(db,config.DISCORD_GUILD_ID,"system","event.series_updated",null,{name:"Hafen/Werft",schedule:"täglich 01:10, 19:10, 22:10",reason:"nur abends + 01:10"});console.log("Hafen/Werft: Zeiten auf 01:10, 19:10, 22:10 umgestellt.");}
}
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],partials:[Partials.Channel,Partials.Message]});
const finance=createFinance(db);
const handlers=createHandler({db,finance,config,client,settings,series});
const dashboard=createDashboard({db,client,config,settings,series});

client.once(Events.ClientReady,ready=>{
  console.log(`Gambino Bot bereit als ${ready.user.tag} (Version ${currentVersion()}).`);
  startScheduler({db,client,config,series});
  void adoptLeadershipDefaults();
  if(config.DISCORD_GUILD_ID&&!getSetting(db,config.DISCORD_GUILD_ID,"LOGBOOK_MENTION_FIXED"))void fixLogbookMentions({db,client:ready,guildId:config.DISCORD_GUILD_ID}).then(n=>{setSetting(db,config.DISCORD_GUILD_ID,"LOGBOOK_MENTION_FIXED",new Date().toISOString());if(n)console.log(`Logbücher: Markierung in ${n} Posts nach unten verschoben.`);}).catch(error=>console.warn("Logbuch-Markierung nicht korrigiert:",error.message));
  // Alle Mitglieder in den Cache laden, damit Rollenwechsel (z. B. neue Familienrolle) zuverlässig erkannt werden.
  if(config.DISCORD_GUILD_ID)void ready.guilds.fetch(config.DISCORD_GUILD_ID).then(g=>g.members.fetch().then(()=>syncFamilyRoles({config,guild:g})).then(r=>{if(r?.added||r?.failed)console.log(`Familienrolle nachgezogen: ${r.added} vergeben, ${r.failed} fehlgeschlagen.`);})).catch(error=>console.warn("Mitglieder konnten nicht geladen werden:",error.message));
  void migrateNicknameFormat({db,client,config}).then(r=>{if(r)console.log(`Namensformat umgestellt: ${r.renamed} umbenannt, ${r.skipped} übersprungen, ${r.failed} fehlgeschlagen.`);}).catch(error=>console.warn("Namensformat konnte nicht umgestellt werden:",error.message));
});
// Von der Leitung genannte IDs einmalig übernehmen, falls noch nichts eingestellt ist. Gesetzt wird nur, was
// auf dem konfigurierten Server wirklich existiert und den richtigen Typ hat; jede Übernahme wird protokolliert.
const ADOPT_NAMES={CHANNEL_WELCOME:/^\W*willkommen$/i,CHANNEL_ABSENCES:/^\W*abmeldungen$/i};
const ADOPT_HINTS={ROLE_PRIO_QUEUE:"1562836910127452260",CHANNEL_TICKET_CLOSED_CATEGORY:"1559680452980113479",ROLE_VERIFIED:"1559685681465397289",ROLE_MEMBERS:"1559954288652853248",CHANNEL_EVENT_CHECK:"1561413596150497300",CHANNEL_BOT_COMMANDS:"1561749617119461517",CHANNEL_TASK_FORUM:"1559991607791456398"};
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
  if(!config.CHANNEL_EVENT_FORUM&&!getSetting(db,guild.id,"ADOPTED_CHANNEL_EVENT_FORUM")){const forums=[...(await guild.channels.fetch().catch(()=>new Map())).values()].filter(ch=>ch?.type===15&&/event-?logs?/i.test(ch.name));if(forums.length===1&&adopt("CHANNEL_EVENT_FORUM",forums[0].id,`Event-Logbücher-Forum (#${forums[0].name})`))setSetting(db,guild.id,"ADOPTED_CHANNEL_EVENT_FORUM",new Date().toISOString());}
  // Turf Leader dürfen Events (z. B. Staatliche Kontrolle) ankündigen: einmalig ins Event-Team übernehmen, bestehende Einträge bleiben.
  if(!getSetting(db,guild.id,"ADOPTED_TURF_LEADER_EVENTS")){const roles=[...(await guild.roles.fetch().catch(()=>new Map())).values()].filter(r=>/turf\s*leader/i.test(r.name)&&!r.managed);if(roles.length===1){const ids=[...new Set([...(config.ROLE_EVENT_TEAM??[]),roles[0].id])];if(ids.length===(config.ROLE_EVENT_TEAM??[]).length||adopt("ROLE_EVENT_TEAM",ids,`Event-Team ergänzt um ${roles[0].name}`))setSetting(db,guild.id,"ADOPTED_TURF_LEADER_EVENTS",new Date().toISOString());}}
  if(!config.ROLE_PRIO_QUEUE?.length&&!getSetting(db,guild.id,"ADOPTED_ROLE_PRIO_QUEUE")){const role=await guild.roles.fetch(ADOPT_HINTS.ROLE_PRIO_QUEUE).catch(()=>null);if(role&&adopt("ROLE_PRIO_QUEUE",[role.id],`Prio-Queue-Rolle (${role.name})`))setSetting(db,guild.id,"ADOPTED_ROLE_PRIO_QUEUE",new Date().toISOString());}
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
  // Einmalig: Antworten unter Event-Log-Bildern der letzten 36 Std. neu aufbauen (jetzt immer mit Auswahl aller Events des Tages).
  if(!getSetting(db,guild.id,"EVENT_PROOF_PROMPTS_V2")){
    setSetting(db,guild.id,"EVENT_PROOF_PROMPTS_V2",new Date().toISOString());
    for(const proof of db.prepare("SELECT * FROM event_proofs WHERE guild_id=? AND created_at>=? AND prompt_message_id IS NOT NULL").all(guild.id,new Date(Date.now()-36*3_600_000).toISOString())){
      if(await refreshProofPrompt({db,client,config,proof}).catch(()=>false))await new Promise(r=>setTimeout(r,800));
    }
  }
  // Einmalig: Ergebnis-Karten der Giveaways der letzten 7 Tage im neuen Aussehen.
  // V3: auch die alte Glückwunsch-Zeile darunter durch die neue Karte ersetzen (Bearbeiten pingt nicht erneut).
  if(!getSetting(db,guild.id,"GIVEAWAY_CARDS_V3")){
    setSetting(db,guild.id,"GIVEAWAY_CARDS_V3",new Date().toISOString());
    for(const row of db.prepare("SELECT * FROM giveaways WHERE guild_id=? AND status='ended' AND message_id IS NOT NULL AND ended_at>=?").all(guild.id,new Date(Date.now()-7*86_400_000).toISOString())){
      const channel=await client.channels.fetch(row.channel_id).catch(()=>null),message=await channel?.messages?.fetch(row.message_id).catch(()=>null);
      if(message)await message.edit(giveawayResultPayload(row,{entries:db.prepare("SELECT COUNT(*) n FROM giveaway_entries WHERE giveaway_id=?").get(row.id).n})).catch(error=>console.warn("Giveaway-Karte nicht aktualisiert:",error.message));
      const later=await channel?.messages?.fetch({after:row.message_id,limit:50}).catch(()=>null);
      for(const old of later?.values?.()??[])if(old.author?.id===client.user?.id&&/^Glückwunsch /.test(old.content??"")&&!old.embeds?.length)await old.edit({...giveawayWinnerPayload(row),allowedMentions:{parse:[]}}).catch(error=>console.warn("Giveaway-Glückwunsch nicht aktualisiert:",error.message));
    }
  }
  // Einmalig: bereits verschickte Logbuch-Pings auf „ein Bild während dem Event“ umschreiben (Bearbeiten pingt nicht erneut).
  if(!getSetting(db,guild.id,"SIGNUP_PING_TEXT_V2")){
    setSetting(db,guild.id,"SIGNUP_PING_TEXT_V2",new Date().toISOString());
    let fixed=0;
    for(const row of db.prepare("SELECT channel_id,message_id FROM event_signup_pings").all()){
      const channel=await client.channels.fetch(row.channel_id).catch(()=>null),message=await channel?.messages?.fetch(row.message_id).catch(()=>null);
      if(!message?.content)continue;
      const content=message.content.replace("**vor und nach dem Event ein Bild**","**während dem Event ein Bild**").replace(" – und nach dem Event noch eins.",".");
      if(content!==message.content&&await message.edit({content,allowedMentions:{parse:[]}}).then(()=>true).catch(()=>false))fixed++;
    }
    if(fixed)console.log(`Logbuch-Pings: ${fixed} Nachrichten auf den neuen Text umgestellt.`);
  }
  // Offene Event-Karten bei jedem Start neu aufbauen, damit neue Knöpfe/Texte (z. B. „👥 Verwalten“) auch an älteren Karten erscheinen.
  for(const row of db.prepare("SELECT * FROM events WHERE guild_id=? AND status='scheduled' AND message_id IS NOT NULL AND starts_at>=? ORDER BY starts_at LIMIT 30").all(guild.id,new Date(Date.now()-12*3_600_000).toISOString())){
    await refreshEventPosts({db,client,config,event:row,cardOnly:true}).catch(()=>{});
    await new Promise(r=>setTimeout(r,500));
  }
  // Geänderte Vorlage (Standardtext oder „Vorlage …“-Post) in die bestehenden Bot-Posts übernehmen.
  // Einmalig nach dem Update (archivierte Posts konnten vorher nicht bearbeitet werden): Vorlage erzwungen übernehmen.
  const forceTemplates=!getSetting(db,guild.id,"LOGBOOK_TEMPLATE_FORCE_V2");
  if(forceTemplates)setSetting(db,guild.id,"LOGBOOK_TEMPLATE_FORCE_V2",new Date().toISOString());
  for(const kind of activeLogbookKinds(config)){const r=await applyLogbookTemplate({db,client,config,guildId:guild.id,kind,force:forceTemplates}).catch(()=>({updated:0}));if(r.updated||r.failed)console.log(`${LOGBOOK_FORUMS[kind].label}: Text in ${r.updated} Posts aktualisiert${r.failed?`, ${r.failed} fehlgeschlagen`:""} (Quelle: ${r.source}).`);}
  // Auf Wunsch der Leitung (20.10.2026) einmalig: Forum event-logs leeren und alle Event-Logbücher mit dem neuen Text frisch anlegen.
  // Nur wenn Forum und Bot-Rechte (inkl. „Threads verwalten“ zum Löschen) passen – sonst beim nächsten Start erneut.
  if(config.CHANNEL_EVENT_FORUM&&!getSetting(db,guild.id,"EVENT_LOGBOOKS_RESET_V1")){
    const status=await logbookStatus({db,client,config,guild,kind:"events"}).catch(()=>null);
    if(status?.forum&&!status.problems.length){
      setSetting(db,guild.id,"EVENT_LOGBOOKS_RESET_V1",new Date().toISOString());
      setSetting(db,guild.id,"EVENT_LOGBOOKS_BACKFILLED",new Date().toISOString());
      const r=await resetLogbookForum({db,client,config,guild,actorId:client.user.id,kind:"events"}).catch(error=>({error:error.message}));
      console.log(r.error?`Event-Logbücher neu aufsetzen fehlgeschlagen: ${r.error}`:`Event-Logbücher neu aufgesetzt: ${r.deleted} gelöscht, ${r.created} neu angelegt, ${r.failed} fehlgeschlagen.`);
    }else if(status)console.warn("Event-Logbücher werden noch nicht neu aufgesetzt:",status.problems.join(" "));
  }
  // Event-Logbücher einmalig für alle bestehenden Familienmitglieder anlegen (Neue bekommen ihres automatisch).
  // Erst wenn Forum und Bot-Rechte passen – sonst beim nächsten Start erneut versuchen.
  if(config.CHANNEL_EVENT_FORUM&&config.LOGBOOK_AUTO_CREATE&&!getSetting(db,guild.id,"EVENT_LOGBOOKS_BACKFILLED")){
    const status=await logbookStatus({db,client,config,guild,kind:"events"}).catch(()=>null);
    if(status?.forum&&!status.problems.length){
      setSetting(db,guild.id,"EVENT_LOGBOOKS_BACKFILLED",new Date().toISOString());
      const r=await createMissingLogbooks({db,client,config,guild,actorId:client.user.id,kind:"events"}).catch(error=>({created:0,linked:0,failed:1,errors:[error.message]}));
      console.log(`Event-Logbücher: ${r.created} angelegt, ${r.linked} verknüpft, ${r.failed} fehlgeschlagen.`);
      audit(db,guild.id,client.user.id,"logbook.bulk",null,{kind:"events",created:r.created,linked:r.linked,failed:r.failed,errors:r.errors.slice(0,5)});
    }else if(status)console.warn("Event-Logbücher noch nicht angelegt:",status.problems.join(" "));
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
// Rang-Rolle erhalten → Familienrolle dazu (danach greifen Logbücher, Konto usw. über das normale Rollen-Event).
client.on(Events.GuildMemberUpdate,(_old,member)=>{
  if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
  void ensureFamilyRole({config,member}).then(added=>{if(added)console.log(`Familienrolle vergeben: ${member.displayName??member.id} (Rang-Rolle)`);}).catch(error=>console.warn("Familienrolle konnte nicht vergeben werden:",error.message));
});
client.on(Events.GuildMemberUpdate,(oldMember,newMember)=>{void trackRankChange({db,config,oldMember,newMember}).catch(error=>console.warn("Rangänderung nicht protokolliert:",error.message));});
client.on(Events.GuildMemberUpdate,(_old,member)=>{
  try{
    if(!config.ACCOUNT_AUTO_OPEN_FOR_MEMBERS||member.user?.bot)return;
    if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
    if(!(config.ROLE_MEMBERS??[]).some(id=>member.roles.cache.has(id)))return;
    finance.openAccount({guildId:member.guild.id,userId:member.id,actorId:client.user?.id??"system",note:"Familienmitglieder-Rolle erhalten"});
  }catch(error){console.error("Familienkonto konnte nicht automatisch angelegt werden:",error.message);}
});
// Familienrolle neu erhalten: Logbücher (Aufgaben, Events) anlegen – nur beim Wechsel von „ohne“ zu „mit“ Familie.
const logbookError=(guildId,message)=>setSetting(db,guildId,"LOGBOOK_LAST_ERROR",JSON.stringify({at:new Date().toISOString(),message}));
client.on(Events.GuildMemberUpdate,(oldMember,member)=>{
  if(!config.LOGBOOK_AUTO_CREATE||member.user?.bot||!activeLogbookKinds(config).length)return;
  if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
  // Unbekannter Vorher-Zustand zählt als „neu“; doppelte Posts verhindert ensureLogbook.
  const had=oldMember?.partial||!oldMember?.roles?.cache?null:familyOf(config,oldMember.roles.cache);
  if(had===true||!familyOf(config,member.roles.cache))return;
  void (async()=>{
    for(const kind of activeLogbookKinds(config)){
      if(config.LOGBOOK_ARCHIVE)await reopenLogbook({db,client,guildId:member.guild.id,userId:member.id,kind}).catch(()=>{});
      if(had===null&&db.prepare(`SELECT 1 FROM ${LOGBOOK_FORUMS[kind].table} WHERE guild_id=? AND user_id=?`).get(member.guild.id,member.id))continue;
      const r=await ensureLogbook({db,client,config,member,kind}).catch(error=>({status:"error",reason:error.message}));
      if(r.status==="created")console.log(`${LOGBOOK_FORUMS[kind].label} angelegt: ${r.thread.name}`);
      else if(r.status==="skipped"||r.status==="error"){console.warn(`${LOGBOOK_FORUMS[kind].label} nicht angelegt:`,r.reason);logbookError(member.guild.id,`${LOGBOOK_FORUMS[kind].label}: ${r.reason}`);}
    }
  })();
});
// Logbuch-Titel verwaltet nur der Bot: fremde Umbenennungen zurücksetzen.
client.on(Events.ThreadUpdate,(oldThread,thread)=>{void guardLogbookName({db,oldThread,thread}).then(reset=>{if(reset)console.log(`Logbuch-Titel zurückgesetzt: ${thread.id}`);}).catch(()=>{});});
// Server-Name geändert (z. B. „Vorname Nachname | ID“): Logbücher automatisch mit umbenennen.
client.on(Events.GuildMemberUpdate,(oldMember,member)=>{
  if(member.user?.bot||oldMember?.partial||!oldMember?.displayName||oldMember.displayName===member.displayName)return;
  if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
  const title=/\|\s*\d+\s*$/.test(member.displayName)?member.displayName:logbookTitle(db,member.guild.id,member);
  for(const kind of activeLogbookKinds(config))void renameLogbook({db,client,guildId:member.guild.id,userId:member.id,title,kind}).catch(()=>{});
});
// Familie verlassen: Logbücher archivieren und sperren (Rolle weg oder Server verlassen).
const archiveAll=(member,reason)=>{for(const kind of activeLogbookKinds(config))void archiveLogbook({db,client,guildId:member.guild.id,userId:member.id,reason,kind}).catch(()=>{});};
client.on(Events.GuildMemberUpdate,(oldMember,member)=>{
  if(!config.LOGBOOK_ARCHIVE||member.user?.bot||oldMember?.partial||!oldMember?.roles?.cache)return;
  if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
  if(familyOf(config,oldMember.roles.cache)&&!familyOf(config,member.roles.cache))archiveAll(member,"Familienrolle entfernt");
});
client.on(Events.GuildMemberRemove,member=>{
  if(!config.LOGBOOK_ARCHIVE||member.user?.bot)return;
  if(config.DISCORD_GUILD_ID&&member.guild.id!==config.DISCORD_GUILD_ID)return;
  archiveAll(member,"Server verlassen");
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
// Screenshot im eigenen Logbuch: Bot fragt per Auswahlmenü, welche Aufgabe es ist (kein /log nötig).
// „Vorlage …“-Post bearbeitet: Text gleich in alle Logbücher übernehmen (kurz warten, falls mehrfach hintereinander bearbeitet).
const templateTimers=new Map();
client.on(Events.MessageUpdate,async(_,message)=>{
  if(!message.guildId||(config.DISCORD_GUILD_ID&&message.guildId!==config.DISCORD_GUILD_ID))return;
  // Nur Startnachrichten (ID = Thread-ID); Thread ggf. nachladen, weil archivierte Posts nicht im Speicher sind.
  if(message.id!==message.channelId)return;
  const channel=message.channel??await client.channels.fetch(message.channelId).catch(()=>null);
  const kind=templateKindOf(config,{id:message.id,channel});if(!kind)return;
  clearTimeout(templateTimers.get(kind));
  templateTimers.set(kind,setTimeout(()=>{templateTimers.delete(kind);void syncLogbookTemplates({db,client,config,guildId:message.guildId,kind}).then(n=>{if(n)console.log(`${LOGBOOK_FORUMS[kind].label}: Vorlage geändert – Text in ${n} Posts aktualisiert.`);}).catch(error=>console.warn("Vorlage konnte nicht übernommen werden:",error.message));},5000));
});
client.on(Events.MessageCreate,message=>{
  if(!message.guildId||message.author?.bot||message.webhookId)return;
  if(config.DISCORD_GUILD_ID&&message.guildId!==config.DISCORD_GUILD_ID)return;
  void handleLogbookMessage({db,config,message}).catch(error=>console.warn("Logbuch-Screenshot nicht verarbeitet:",error.message));
});
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
