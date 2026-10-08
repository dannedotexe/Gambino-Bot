# Gambino Bot

A starter Discord bot built with Node.js and [discord.js](https://discord.js.org/). It currently provides the slash commands `/ping` and `/help`.

## Requirements

- Node.js 20.6 or newer
- A Discord application and bot token from the [Discord Developer Portal](https://discord.com/developers/applications)

## Setup

1. Create a Discord application in the Developer Portal, add a bot user, and copy its token.
2. In **OAuth2 → General**, copy the Application ID.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`.
4. Invite the bot to your server with the `bot` and `applications.commands` scopes. It only needs the **Use Application Commands** permission for the included commands.
5. Install dependencies and register the slash commands:

   ```sh
   npm install
   npm run deploy-commands
   ```

6. Start the bot:

   ```sh
   npm start
   ```

For quick command updates while developing, set `DISCORD_GUILD_ID` in `.env` to your test server's ID. Leave it blank to register commands globally.

Never commit your real `.env` file or share your bot token. If a token is exposed, reset it in the Developer Portal.
