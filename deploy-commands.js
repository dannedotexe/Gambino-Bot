import { REST, Routes } from "discord.js";
import { loadConfig } from "./src/config.js";
import { buildCommands } from "./src/commands.js";

let config;
try { config=loadConfig(); } catch(error){ console.error(error.message);process.exit(1); }
const rest=new REST({version:"10"}).setToken(config.DISCORD_TOKEN);
const route=config.DISCORD_GUILD_ID?Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID,config.DISCORD_GUILD_ID):Routes.applicationCommands(config.DISCORD_CLIENT_ID);
try { await rest.put(route,{body:buildCommands()});console.log(`Slash-Commands für ${config.DISCORD_GUILD_ID?"den konfigurierten Server":"alle Server"} registriert.`); }
catch(error){console.error("Slash-Commands konnten nicht registriert werden:",error.message);process.exit(1);}
