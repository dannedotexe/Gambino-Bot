import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { configWarnings, loadConfig } from "./src/config.js";
import { openDatabase } from "./src/database.js";
import { createFinance } from "./src/services/finance.js";
import { buildCommands, createHandler, handleComponent } from "./src/commands.js";
import { startScheduler } from "./src/scheduler.js";
import { startModeration } from "./src/moderation.js";
import { createSettingsService } from "./src/services/settings.js";
import { createSeriesService } from "./src/services/event-series.js";
import { createDashboard } from "./src/dashboard.js";
import { createTicketService } from "./src/services/tickets.js";

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
  console.log(`Gambino Bot bereit als ${ready.user.tag}.`);
  startScheduler({db,client,config,series});
  void adoptClosedTicketCategory();
});
// Von der Leitung genannte Kategorie für geschlossene Tickets einmalig übernehmen, falls noch keine eingestellt ist.
// Wird nur gesetzt, wenn die Kategorie wirklich auf dem konfigurierten Server existiert.
const CLOSED_TICKETS_CATEGORY_HINT="1559680452980113479";
async function adoptClosedTicketCategory(){
  if(!settings||config.CHANNEL_TICKET_CLOSED_CATEGORY)return;
  const guild=await client.guilds.fetch(config.DISCORD_GUILD_ID).catch(()=>null);
  const category=guild?await guild.channels.fetch(CLOSED_TICKETS_CATEGORY_HINT).catch(()=>null):null;
  if(category?.type!==4)return;
  try{settings.update({key:"CHANNEL_TICKET_CLOSED_CATEGORY",value:category.id,actorId:client.user.id,actorIsOwner:true});console.log(`Kategorie für geschlossene Tickets eingestellt: ${category.name}`);}
  catch(error){console.warn("Kategorie für geschlossene Tickets konnte nicht eingestellt werden:",error.message);}
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
