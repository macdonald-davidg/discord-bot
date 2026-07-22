# Open WebUI Discord Bot

A Discord bot that interacts with a self-hosted Open WebUI instance, allowing you to access your AI models directly from Discord.

## Features

- `/ping` - Check bot latency and status
- `/status` - Get the status of your Open WebUI instance
- `/models` - List all available models in your Open WebUI instance
- `/ask` - Ask a question to your AI models through Open WebUI
- `/linux`, `/docker`, `/pihole`, `/proxmox`, `/windows`, `/fileserver`, `/router` - Run allowlisted diagnostic checks on your hosts via open-terminal (configured in `config/allowlist.json`; mutating checks require an in-Discord confirmation). `/router` includes two mutating checks (`wan-bounce`, `reboot`) — see "SSH key architecture" below for its dedicated non-fleet key.
- `/jarvis-audit` - Sweep every jarvis-managed POSIX host (excludes the router and Windows hosts — see "SSH key architecture" below) and report whether passwordless SSH + passwordless sudo is actually working on each one (no host/check picker — fixed `sudo -n true` probe, read-only, runs in parallel)
- `/poe` - Power-cycle a camera or access point's PoE switch port, picked from `config/allowlist.json`'s `poe_devices` list (mutating, requires confirmation). The lookup goes over SSH like everything else, but the actual power-cycle call goes straight to the UniFi Network controller's own REST API. See "PoE bounce and device restart" below before using it.
- `/unifi-restart` - Restart a UniFi switch or AP as a whole device (soft reboot over the controller's management channel, not a port bounce — works even without a wired PoE uplink), picked from `config/allowlist.json`'s `unifi_devices` list (mutating, requires confirmation). Same REST API mechanism as `/poe`. See "PoE bounce and device restart" below.

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
an entry under `categories.<name>.checks` in `config/allowlist.json` — no code
change needed. Restart the `discord-bot` container to pick it up; commands
re-register with Discord automatically on startup (`src/index.js` calls
`registerCommands()` every boot, so there's no separate manual deploy step).

**Adding a new category** (a whole new host/check-picker slash command like
`/linux` or `/proxmox`): add a `categories.<name>` block to
`config/allowlist.json` with two keys — `hosts` (the array of host keys this
command's dropdown should offer) and `checks` (the commands it may run) — then
create `src/commands/<name>.js` as a thin wrapper around
`buildCategoryCommand()` — see `src/commands/linux.js` for the minimal 7-line
pattern every category command follows. Any `.js` file dropped into
`src/commands/` is auto-loaded (`src/index.js`), so nothing else needs wiring
up.

**Scoping a category to specific hosts:** each category's `hosts` array is
the actual Discord dropdown for that command — a host key not listed there
can't be selected, and `buildCategoryCommand()` throws at startup if a
category has no `hosts` list or lists an unknown host key. Keep this list
matched to reality: `/windows` should only ever list actual Windows hosts
(currently just `lan.itunes`), `/fileserver` only the boxes that run
Samba/NFS (`lan.gfh`, `lan.cifs`), `/proxmox` only the hypervisor itself
(`lan.server`), and so on — see `config/allowlist.json` for the full mapping.
`/linux`'s generic checks (uptime/disk/memory/etc.) are the exception and
stay broad across every non-Windows, non-router host, since those checks are
meaningful almost anywhere.

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

**`/router` and root access:** many consumer/prosumer router/gateway
appliances have no non-root SSH account, so `lan.router` necessarily
authenticates as `root` — there's no unprivileged account to fall back to
the way `jarvis` is unprivileged-until-`sudo` on every other host.
`buildCategoryCommand()` takes a `readOnly: true` option that throws at
startup if the category ever picks up a `mutating: true` check — this
category originally used it as a hard safety net. It was deliberately
dropped when `wan-bounce` and `reboot` were added as intentional mutating
checks; both still go through the standard Confirm/Cancel button gate before
running (see `buildCategoryCommand()` in `src/services/netcheckRunner.js`),
same as any other mutating check in the allowlist. If `/router` should ever
go back to read-only-only, re-add `readOnly: true` in
`src/commands/router.js` and remove those two checks first (the option
throws at startup otherwise).

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

## PoE bounce and device restart

`/poe` power-cycles the PoE port a camera or access point is plugged into.
`/unifi-restart` restarts a switch or AP as a whole device (a soft reboot
over the controller's management channel, not a port-level power toggle —
works even for a device with no PoE uplink at all, e.g. one on a wireless
mesh backhaul). Both are hybrids: the read-only lookup step goes over SSH
through open-terminal, same as everything else — but the actual mutating
action goes through the UniFi Network controller's own REST API
(`src/services/unifiController.js`), because neither PoE port control nor a
device restart is a plain shell command; both are things the controller
itself has to tell the device over its own management protocol.

**Why the lookup is SSH+mongo, not the REST API too:** the API's exact JSON
field names were never verified live — only the router's local MongoDB
schema was (read-only, over SSH). Rather than guess at the API's shape, the
lookup reads the DB directly (known-correct) and only the mutating call uses
the REST API, which has a simple, well-documented, stable signature.

**The port lookup was rebuilt to use each switch/gateway's own `port_table`,
not the target device's self-reported uplink field.** The original version
trusted a device's own `last_uplink.type`, which can go stale — one AP's own
record still said `"wireless"` even though the switch's `port_table`
(LLDP-confirmed, `poe_good: true`) showed it live-connected on a real port.
The self-reported field simply hadn't been refreshed. `findUplinkPort()` now
searches every adopted switch/gateway (`type: {$in: ["usw","udm"]}`) for a
`port_table` entry whose `last_connection.ip` matches — a single, more
authoritative mechanism that covers wired clients regardless of which
upstream device (switch vs. gateway) they're actually plugged into. This
also reliably distinguishes a genuinely wireless-meshed device (no entry in
any port_table — nothing to cycle) from one that's actually wired but
under-reporting its own state.

Some devices may be powered by a standalone wall-outlet PoE injector rather
than a managed switch/gateway port — for those, `findUplinkPort()` correctly
finds no port_table match (there's no managed port to control at all, so
`/poe` can't do anything for them regardless of implementation), but
`/unifi-restart` still works since it goes over the device's management
channel rather than a physical port.

**Login/CSRF confirmed working**, via a dedicated local admin account
created in the Network app UI specifically for the bot (not the primary
admin login — see `.env.example`'s comment on why). `login()`'s cookie +
CSRF handling and a `GET`/`PUT` round-trip against `rest/user/<id>` were
both exercised for real (used to fix a client-naming issue — see below) and
worked exactly as documented: `POST /api/auth/login` → `TOKEN` cookie +
`X-Csrf-Token` header, `GET`/`PUT /proxy/network/api/s/<site>/rest/user/<id>`
returns/accepts `{meta:{rc}, data:[{...}]}`.

**`UNIFI_CONTROLLER_URL` must be an IP, not a hostname that's a CNAME.**
Confirmed live: if your controller's hostname is a CNAME to its "real" name
(common on UniFi OS consoles — the friendly hostname is often a CNAME
record), the bot's `node:22-alpine` base image's musl libc `getaddrinfo()` —
what `dns.lookup`/`axios`/`https` use by default — doesn't chase that CNAME
and fails with `ENOTFOUND`, even though `dig`/`nslookup` resolve it fine
(different resolution path) and Node's own JS resolver (`dns.resolve4`) also
works fine. This isn't a test-script-only issue — the deployed bot uses the
same Alpine image, so it hits the same failure. Use the controller's IP
directly; `rejectUnauthorized: false` already means the self-signed cert's
hostname isn't validated anyway, so there's no downside to using the IP.

**`cmd/devmgr restart` confirmed working** against a mesh-uplinked AP (no
wired PoE port at all) — live-fired for real, command accepted, device
power-cycled and re-adopted successfully. This also incidentally confirmed
the whole SSH+mongo lookup → controller-login → `cmd/devmgr` chain works
end-to-end for a device with no port_table entry anywhere, exactly the case
`/poe` can't handle but `/unifi-restart` can.

**Still not verified:** `power-cycle` (no mutating PoE-bounce has been
live-fired yet); `restart` against a switch or a wired-not-mesh AP (only the
mesh case has been tested); and whether `power-cycle` accepts a gateway's
own MAC as the target the same way it does a switch's (a device wired
directly into the gateway rather than a switch is a `udm`-type target, not
`usw`). Recommended next test: `/unifi-restart` on a wired AP before the
switch (drops every wired downstream device simultaneously for the reboot),
then `/poe` on a low-consequence device before a camera (recording gap).

**Fixed: two more bugs found via live testing, not just design review.**
(1) open-terminal's actual terminal-success status is `"done"`, not
`"completed"` — every place checking for the literal string `"completed"`
was silently wrong; see `src/services/unifiController.js`,
`src/commands/jarvis-audit.js`, and `src/services/netcheckRunner.js` for the
fix and what each one actually broke (one purely cosmetic, one functional
and pre-existing). (2) if your UniFi controller password contains a literal
`$`, escape it as `$$` in `.env` — Docker Compose's own variable
interpolation applies to `env_file:`-sourced values in the version deployed
here, and a bare `$word` gets silently treated as an undefined variable
reference and dropped, truncating the password before the container ever
sees it. This produced a real `HTTP 403` login failure that looked like a
wrong password, not a parsing bug — worth checking first if login fails
despite a manually-verified-correct password.

**Fixed:** one camera's UniFi *name* field didn't match its DNS
hostname/`poe_devices` key (a leftover naming inconsistency from however it
was originally set up). Renamed via a one-off script using the same
`login()`/`rest/user` mechanism `/poe` relies on, fetching the full record,
changing only `name`, `PUT`-ing it back, and reading it back fresh
afterward to confirm the change actually stuck (it did) — a useful pattern
for any other one-off client-record fix via this same controller API.

List bounceable devices under `poe_devices` and restartable devices under
`unifi_devices` in `config/allowlist.json` — key is the Discord dropdown
value, `ip` is the device's stable LAN IP (used to resolve its current
port/MAC live on every run), `description` is cosmetic. No port number or
MAC is ever stored — that's what makes this survive a device moving to a
different physical port, or hardware being swapped, later.

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

