# Open WebUI Discord Bot

A Discord bot that interacts with a self-hosted Open WebUI instance, allowing you to access your AI models directly from Discord.

## Features

- `/ping` - Check bot latency and status
- `/status` - Get the status of your Open WebUI instance
- `/models` - List all available models in your Open WebUI instance
- `/ask` - Ask a question to your AI models through Open WebUI
- `/linux`, `/docker`, `/pihole`, `/proxmox`, `/windows`, `/fileserver`, `/router` - Run allowlisted diagnostic checks on your hosts via open-terminal (configured in `config/allowlist.json`; mutating checks require an in-Discord confirmation). `/router` is read-only by design — see "SSH key architecture" below.
- `/jarvis-audit` - Sweep every jarvis-managed POSIX host (excludes the router and Windows hosts — see "SSH key architecture" below) and report whether passwordless SSH + passwordless sudo is actually working on each one (no host/check picker — fixed `sudo -n true` probe, read-only, runs in parallel)

## Prerequisites

- Node.js 16+ (if running without Docker)
- Discord Bot Token (from [Discord Developer Portal](https://discord.com/developers/applications))
- Self-hosted Open WebUI instance
- Open WebUI API key (generated from Settings > Account in Open WebUI)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/open-webui-discord-bot.git
cd open-webui-discord-bot
```

### 2. Configure environment variables

Create a `.env` file in the project root with the following variables:

```
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_discord_server_id

# Open WebUI Configuration
# Make sure this URL is publicly accessible from where the bot is hosted
OPEN_WEBUI_URL=https://your-openwebui-domain.com

# API Authentication
# Get your API key from Settings > Account in Open WebUI
OPEN_WEBUI_API_KEY=your_open_webui_api_key

# open-terminal (required by the netcheck commands)
OPEN_TERMINAL_URL=http://your-open-terminal-host:8100
OPEN_TERMINAL_API_KEY=your_open_terminal_api_key

# Rate Limiting (requests per minute)
RATE_LIMIT=10

# Optional: Port for status web server
PORT=3001
```

### 3. Configure the command allowlist

The netcheck commands (`/linux`, `/docker`, etc.) refuse to start without an
allowlist describing which hosts can be reached and which checks may run on
them:

```bash
cp config/allowlist.example.json config/allowlist.json
# then edit config/allowlist.json for your hosts and checks
```

### 4. Install dependencies (if not using Docker)

```bash
npm install
```

### 5. Run the bot

#### Using Node.js directly

```bash
npm start
```

#### Using Docker Compose

This repo intentionally has no compose file of its own. The bot is deployed
as the `discord-bot` service in the **llm-stack** repo's
`docker-compose.yml`, which builds this repo's Dockerfile from a clone at
`llm-stack/discord-bot/`:

```bash
cd ../llm-stack
docker compose up -d --build discord-bot
```

## Adding new checks or commands

**Adding a check to an existing category** (e.g. another `/proxmox` check): add
an entry under the relevant category in `config/allowlist.json` — no code
change needed. Restart the `discord-bot` container to pick it up; commands
re-register with Discord automatically on startup (`src/index.js` calls
`registerCommands()` every boot, so there's no separate manual deploy step).

**Adding a new category** (a whole new host/check-picker slash command like
`/linux` or `/proxmox`): add a `categories.<name>` block to
`config/allowlist.json`, then create `src/commands/<name>.js` as a thin
wrapper around `buildCategoryCommand()` — see `src/commands/linux.js` for the
minimal 7-line pattern every category command follows. Any `.js` file dropped
into `src/commands/` is auto-loaded (`src/index.js`), so nothing else needs
wiring up.

**Adding a command that isn't a single host/check picker** (e.g.
`/jarvis-audit`, which sweeps every allowlisted host with one fixed command
rather than letting the user choose): don't use `buildCategoryCommand`. Import
`executeRemoteCommand` and `allowlist` directly from
`src/services/netcheckRunner.js` — `executeRemoteCommand({ sshUser, hostname,
remoteCommand, maxWaitMs })` is the shared open-terminal SSH-and-poll
primitive underneath every check, decoupled from Discord embeds so it can be
reused for custom command shapes. See `src/commands/jarvis-audit.js`.

## SSH key architecture

Every netcheck command SSHes out through `open-terminal`, which holds its own
keys in its persistent volume (`/srv/docker/open-terminal/home/.ssh/` on the
host, `/home/user/.ssh/` inside the container). **Every host in
`config/allowlist.json` has its own dedicated `identity_file`** — there is no
shared/fleet-wide key in `open-terminal` at all (there was, historically; see
"History" below). A leak of any one key exposes exactly one host, not the
rest of the fleet.

| Host key (example) | Example hostname | Key file (container path) |
|---|---|---|
| `dmz.dns1` | dns1.example.dmz | `/home/user/.ssh/bot_dmzdns1_ed25519` |
| `dmz.dns2` | dns2.example.dmz | `/home/user/.ssh/bot_dmzdns2_ed25519` |
| `lan.dns1` | dns1.example.local | `/home/user/.ssh/bot_landns1_ed25519` |
| `lan.dns2` | dns2.example.local | `/home/user/.ssh/bot_landns2_ed25519` |
| `lan.server` | hypervisor.example.local | `/home/user/.ssh/bot_server_ed25519` |
| `lan.jarvis` | (the host this bot runs on) | `/home/user/.ssh/bot_llmgpu_ed25519` |
| `dmz.docker` | docker.example.dmz | `/home/user/.ssh/bot_dmzdocker_ed25519` |
| `lan.cifs` | fileserver.example.local | `/home/user/.ssh/bot_cifs_ed25519` |
| `lan.itunes` | media-vm.example.local (Windows) | `/home/user/.ssh/bot_itunes_ed25519` |
| `lan.router` | router.example.local | `/home/user/.ssh/bot_router_ed25519` |

(Host keys and file-naming pattern shown above match this deployment's real
`config/allowlist.json`, which is gitignored and never leaves this machine —
the example hostnames in the table are placeholders, not this network's
actual DNS names.)

**This is a separate credential tier from the interactive `jarvis` identity.**
A single passwordless-sudo automation account (deployed the same way across
every fleet host — its own key, `NOPASSWD: ALL` sudo) is what's used for
direct/scripted admin sessions, stays intentionally broad, and is **still
present** in every host's `authorized_keys` alongside its dedicated `bot_*`
key — splitting the interactive identity per-host was explicitly out of
scope for this migration, since it would mean juggling multiple keys for
ordinary ad hoc admin work. `open-terminal` never holds a copy of the
interactive key, only its own per-host `bot_*` keys.

**Naming convention:** `<actor>_<scope>_<algo>`
- `actor` — `jarvis` (the interactive identity above) or `bot`
  (open-terminal/discord-bot's own execution identity — always a **separate
  keypair** from `jarvis`, even on hosts where both log in as the same
  remote `jarvis` account).
- `scope` — a specific host key (`router`, `cifs`, `dmzdns1`, ...). Every
  current key is single-host-scoped; a `fleet`-scoped `bot_*` key would mean
  one key trusted by multiple hosts, which nothing currently uses.
- `algo` — `ed25519`, kept explicit in case a future key ever needs a
  different algorithm.

**Adding a new host:** generate `bot_<newscope>_ed25519` into
`open-terminal`'s `.ssh/` volume, append its `.pub` to that host's
`authorized_keys` (or, for a Windows host, `C:\ProgramData\ssh\administrators_authorized_keys`
if the account is a local Administrator — see the itunes-vm gotcha below),
verify with `BatchMode=yes` before relying on it, then set `identity_file` in
`config/allowlist.json`.

**Windows hosts — `Add-Content` gotcha:** if the target file doesn't already
end in a newline, `Add-Content`/`>>` appends the new key onto the *same line*
as the last one instead of starting a new line — the file looks fine at a
glance but the appended key silently doesn't parse (sshd reads the first
key's type+blob as valid, swallows everything after into the trailing
comment field). Hit this live on the `lan.itunes` host in this deployment.
Use `Set-Content`
with an explicit array of lines (or verify with `Get-Content $file |
ForEach-Object { ... }` line-by-line) instead of trusting a raw `Get-Content
-Raw` dump not to hide a missing line break. Also re-assert ACLs after any
edit to `administrators_authorized_keys` (`icacls.exe $file /inheritance:r`
then `/grant:r "SYSTEM:(F)"` and `"BUILTIN\Administrators:(F)"`) — sshd
enforces strict permissions on that specific file and silently stops
honoring it if they drift.

**History:** until 2026-07-20, every fleet host except the router trusted one
shared key (`open-terminal`'s `id_ed25519`, identical to the interactive
`jarvis_fleet_ed25519`) — a compromise of `open-terminal` would have meant
access to the whole fleet. Migrated to the per-host scheme above; the old
key file was deleted from `open-terminal`'s volume and its
`~/.ssh/config` no longer sets a default `IdentityFile` (each check passes
`-i <identity_file> -o IdentitiesOnly=yes` explicitly instead). The shared
key itself was **not** revoked from any fleet host's `authorized_keys` — it's
still what the interactive `jarvis` identity uses.

**Why `/router` is read-only:** many consumer/prosumer router/gateway
appliances have no non-root SSH account, so `lan.router` necessarily
authenticates as `root` — there's no unprivileged account to fall back to
the way `jarvis` is unprivileged-until-`sudo` on every other host.
`buildCategoryCommand()` takes a `readOnly: true` option (see
`src/commands/router.js`) that throws at startup if the category ever picks
up a `mutating: true` check, so a future allowlist edit can't silently turn
a read-only category into one that can change state on the network's
gateway/firewall from Discord.

**Persisting a key on a UniFi Dream Machine-family router across reboots and
firmware updates:** newer UniFi OS builds (`uos` CLI, no `unifi-os shell`
binary at all) don't use the classic `/mnt/data/on_boot.d/` + `udm-boot`
mechanism most guides describe — that assumes a nested container
architecture this firmware generation doesn't have. Use
[`unifi-on-boot`](https://github.com/unredacted/unifi-on-boot) instead: it
operates directly on the host filesystem, installs proper systemd units, and
integrates with the OS's own `ubnt-dpkg-cache` package-persistence mechanism.
Scripts go in `/data/on_boot.d/` (not `/mnt/data/`). Confirmed working
against a `uos 5.1.4` device in this deployment; check `uos --version` (vs.
whether `unifi-os` exists at all) on any other UniFi OS console before
assuming either mechanism applies.

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to the "Bot" tab and create a bot
4. Enable the "MESSAGE CONTENT INTENT" under Privileged Gateway Intents
5. Copy the token and add it to your `.env` file
6. Go to OAuth2 > URL Generator
7. Select the following scopes: `bot`, `applications.commands`
8. Bot Permissions: `Send Messages`, `Embed Links`, `Read Message History`
9. Copy the generated URL and open it in your browser to add the bot to your server

## Docker Deployment

This bot is designed to be easily deployed in a Docker container. The provided Docker configuration includes:

- Health checks to ensure the bot is running
- Volume mapping for logs
- Environment variable configuration through `.env` file
- Automatic restart on failure

To build and run with Docker:

```bash
# Build the image
docker build -t open-webui-discord-bot .

# Run the container
docker run -d --name open-webui-discord-bot --env-file .env -p 3001:3001 open-webui-discord-bot
```

## Troubleshooting

### Connection Issues with Open WebUI

If you're experiencing connection issues with your Open WebUI instance, try these solutions:

1. **API Key Authentication**:
   - Make sure you've generated an API key in Open WebUI (Settings > Account)
   - Use this API key in your `.env` file as `OPEN_WEBUI_API_KEY`
   - The bot uses standard OpenAI-compatible API endpoints as documented in the official Open WebUI documentation

2. **Authentik SSO Configuration**:
   - If using Authentik, make sure to whitelist these paths:
   ```
   /api/models
   /api/chat/completions
   ```

3. **Check API Response Format**:
   - If you're getting HTML responses, check if your API endpoints are properly configured
   - Ensure your API key has the correct permissions

4. **OpenAI-Compatible API Format**:
   - This bot uses the OpenAI-compatible API format as documented
   - Messages are sent in the format:
   ```json
   {
     "model": "your_model_id",
     "messages": [
       { "role": "user", "content": "Your question here" }
     ]
   }
   ```

## Rate Limiting

The bot includes built-in rate limiting to prevent overloading your Open WebUI instance. By default, it's set to 10 requests per minute, but you can adjust this in the `.env` file.

