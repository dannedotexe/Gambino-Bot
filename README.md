# Gambino Bot

A starter Discord bot built with Node.js and [discord.js](https://discord.js.org/). It currently provides the slash commands `/ping` and `/help`.

## Requirements

- Node.js 20.6 or newer
- PM2 (used to keep the bot running on the Oracle VM)
- A Discord application and bot token from the [Discord Developer Portal](https://discord.com/developers/applications)

## Discord setup

1. Create a Discord application in the Developer Portal, add a bot user, and copy its token.
2. In **OAuth2 → General**, copy the Application ID.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes. It only needs the **Use Application Commands** permission for the included commands.

## Run locally

1. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`.
2. Install dependencies and register the slash commands:

   ```sh
   npm install
   npm run deploy-commands
   ```

3. Start the bot:

   ```sh
   npm start
   ```

For quick command updates while developing, set `DISCORD_GUILD_ID` in `.env` to your test server's ID. Leave it blank to register commands globally.

## Oracle VM and ChatGPT workflow

The Oracle VM already runs the HugoSMP bot with PM2 under the `ubuntu` account. Gambino uses the same VM and PM2 pattern. There is no separate GitHub Actions or systemd deployment setup.

After the one-time bot setup below, a requested change can be handled in ChatGPT: update and commit the code to GitHub, then pull the commit onto the VM and restart `gambino-bot` with PM2.

1. The repository checkout on the VM is `/home/ubuntu/Gambino-Bot`. Install dependencies there with `npm install`.
2. Create `/home/ubuntu/Gambino-Bot/.env` from `.env.example`; fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` directly on the VM. Do not add the real `.env` file to GitHub.
3. Register commands and start the bot:

   ```sh
   cd /home/ubuntu/Gambino-Bot
   npm run deploy-commands
   pm2 start npm --name gambino-bot -- start
   pm2 save
   ```

The VM already has Node.js 20 and PM2. PM2 keeps the process running and can restore saved processes when its startup service is enabled.

For later code changes, the deployment steps are:

```sh
cd /home/ubuntu/Gambino-Bot
git pull --ff-only origin main
npm install
pm2 restart gambino-bot
pm2 save
```

The Discord token stays only in the VM's `.env` file. Never commit it or send it in chat. If a token is exposed, reset it in the Developer Portal.
