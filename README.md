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

The Gambino repository is checked out at `/home/ubuntu/Gambino-Bot`. The VM has Node.js 20 and PM2 installed. For first setup, add `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` to `/home/ubuntu/Gambino-Bot/.env` on the VM, then run:

```sh
cd /home/ubuntu/Gambino-Bot
npm install
npm run deploy-commands
pm2 start npm --name gambino-bot -- start
pm2 save
```

After first setup, code changes requested in ChatGPT are committed to GitHub and deployed to the VM by pulling the new commit, installing any updated packages, and restarting `gambino-bot` with PM2. You do not need to run those deployment commands yourself.

The Discord token stays only in the VM's `.env` file. Never commit it or send it in chat. If a token is exposed, reset it in the Developer Portal.
