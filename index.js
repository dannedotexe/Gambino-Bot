import { Client, Events, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply(`Pong! ${client.ws.ping} ms`);
    return;
  }

  if (interaction.commandName === "help") {
    await interaction.reply({
      content: "**Gambino Bot**\n\n`/ping` — check whether the bot is online\n`/help` — show this help message",
      ephemeral: true,
    });
  }
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

client.login(token);
