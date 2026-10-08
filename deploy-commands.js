import { REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID in your .env file.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check whether Gambino Bot is online"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show the available commands"),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(token);
const route = guildId
  ? Routes.applicationGuildCommands(clientId, guildId)
  : Routes.applicationCommands(clientId);

try {
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands ${guildId ? "for the test server" : "globally"}.`);
} catch (error) {
  console.error("Could not register slash commands:", error);
  process.exit(1);
}
