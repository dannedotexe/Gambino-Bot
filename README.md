# Gambino Bot

A starter Discord bot built with Node.js and [discord.js](https://discord.js.org/). It currently provides the slash commands `/ping` and `/help`.

## Requirements

- Node.js 20.6 or newer
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

## Run continuously on an Oracle Cloud VM

The repository includes a systemd service template at `deploy/gambino-bot.service`. These steps assume an Oracle Linux VM with the default `opc` user and Node.js installed system-wide at `/usr/bin/node`. For an Ubuntu VM, replace `opc` with `ubuntu` in the commands and service file.

1. Connect to the VM over SSH. Make sure it has Node.js 20.6 or newer and Git installed.
2. Clone the repository into `/opt/gambino-bot` and set ownership to the VM user:

   ```sh
   sudo mkdir -p /opt/gambino-bot
   sudo chown opc:opc /opt/gambino-bot
   git clone https://github.com/dannedotexe/Gambino-Bot.git /opt/gambino-bot
   cd /opt/gambino-bot
   ```

3. Create the environment file, enter the token and application ID, then install dependencies and register commands:

   ```sh
   cp .env.example .env
   nano .env
   npm install
   npm run deploy-commands
   ```

4. Install and start the systemd service:

   ```sh
   sudo cp deploy/gambino-bot.service /etc/systemd/system/gambino-bot.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now gambino-bot
   ```

## Automatic deployments from ChatGPT changes

The workflow at `.github/workflows/deploy-oracle.yml` deploys every push to `main` and restarts the bot. Once this one-time setup is complete, changes pushed to GitHub from ChatGPT deploy automatically.

1. Create a dedicated SSH key pair for deployments. Add its **public key** to the VM user's `~/.ssh/authorized_keys`; keep the **private key** for the GitHub secret. Do not reuse your personal SSH key.
2. Allow that VM user to restart only this service without an interactive password. Open a sudoers file with `sudo visudo -f /etc/sudoers.d/gambino-bot` and add this line (replace `opc` with `ubuntu` on Ubuntu):

   ```text
   opc ALL=(root) NOPASSWD: /usr/bin/systemctl restart gambino-bot, /usr/bin/systemctl is-active gambino-bot
   ```

3. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add these repository secrets:
   - `ORACLE_HOST`: the VM's public IP address
   - `ORACLE_USER`: `opc` or `ubuntu`
   - `ORACLE_SSH_KEY`: the deployment private key
   - `ORACLE_KNOWN_HOSTS`: the verified SSH host-key line for the VM
4. Push a change to `main`. Check the **Actions** tab for the deployment result.

The deployment key gives access to the VM account and permission to restart only the Gambino Bot service. Do not put the Discord token or SSH private key in the repository or in chat.

Check the service with `sudo systemctl status gambino-bot` and view logs with `sudo journalctl -u gambino-bot -f`. If automatic deployment is not configured yet, manual updates are `git pull`, `npm install`, and `sudo systemctl restart gambino-bot`.

Never commit your real `.env` file or share your bot token. If a token is exposed, reset it in the Developer Portal.
