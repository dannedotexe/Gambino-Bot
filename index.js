import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { loadConfig } from "./src/config.js";
import { openDatabase } from "./src/database.js";
import { createFinance } from "./src/services/finance.js";
import { buildCommands, createHandler, handleComponent } from "./src/commands.js";
import { startScheduler } from "./src/scheduler.js";
import { startModeration } from "./src/moderation.js";

let config;
try { config=loadConfig(); }
catch(error){ console.error(error.message); process.exit(1); }

const db=openDatabase(config.DATABASE_PATH);
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],partials:[Partials.Channel]});
const finance=createFinance(db);
const handlers=createHandler({db,finance,config,client});

client.once(Events.ClientReady,ready=>{
  console.log(`Gambino Bot bereit als ${ready.user.tag}.`);
  startScheduler({db,client,config});
});
client.on(Events.InteractionCreate,async interaction=>{
  try {
    if(interaction.isChatInputCommand()) await handlers.command(interaction);
    else await handleComponent(interaction,handlers);
  } catch(error){
    console.error("Interaction failed:",error);
    if(interaction.isRepliable()&&!interaction.replied&&!interaction.deferred)await interaction.reply({content:"Die Aktion ist fehlgeschlagen. Bitte versuche es später erneut.",ephemeral:true}).catch(()=>{});
  }
});
client.on(Events.Error,error=>console.error("Discord client error:",error));
client.on(Events.ShardError,error=>console.error("Discord gateway shard error:",error));
client.on(Events.ShardDisconnect,(_event,id)=>console.warn(`Discord shard ${id} getrennt; Reconnect wird versucht.`));
startModeration({client,db,config});
process.on("unhandledRejection",error=>console.error("Unhandled rejection:",error));
process.on("uncaughtException",error=>{console.error("Uncaught exception:",error);process.exitCode=1;});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{console.log(`${signal}: sauberer Shutdown.`);client.destroy();db.close();process.exit(0);});
client.login(config.DISCORD_TOKEN).catch(error=>{console.error("Discord-Login fehlgeschlagen:",error.message);db.close();process.exit(1);});
