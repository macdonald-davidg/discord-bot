# Open WebUI Discord Bot

A Discord bot that interacts with a self-hosted Open WebUI instance, allowing you to access your AI models directly from Discord.

## Features

- `/ping` - Check bot latency and status
- `/status` - Get the status of your Open WebUI instance
- `/models` - List all available models in your Open WebUI instance
- `/ask` - Ask a question to your AI models through Open WebUI
- `/linux`, `/docker`, `/pihole`, `/proxmox`, `/proxmox-backup`, `/windows`, `/fileserver`, `/router` - Run allowlisted diagnostic checks on your hosts via open-terminal (configured in `config/allowlist.json`; mutating checks require an in-Discord confirmation). `/router` includes two mutating checks (`wan-bounce`, `reboot`) — see "SSH key architecture" below for its dedicated non-fleet key. `/windows` includes `reboot`/`shutdown`. `/proxmox-backup` is split out from `/proxmox` rather than folded into it — see "Backups" below for why.
- `/jarvis-audit` - Sweep every jarvis-managed POSIX host (excludes the router and Windows hosts — see "SSH key architecture" below) and report whether passwordless SSH + passwordless sudo is actually working on each one (no host/check picker — fixed `sudo -n true` probe, read-only, runs in parallel)
- `/poe` - Power-cycle a camera or access point's PoE switch port, picked from `config/allowlist.json`'s `poe_devices` list (mutating, requires confirmation). The lookup goes over SSH like everything else, but the actual power-cycle call goes straight to the UniFi Network controller's own REST API. See "PoE bounce and device restart" below before using it.
- `/unifi-restart` - Restart a UniFi switch or AP as a whole device (soft reboot over the controller's management channel, not a port bounce — works even without a wired PoE uplink), picked from `config/allowlist.json`'s `unifi_devices` list (mutating, requires confirmation). Same REST API mechanism as `/poe`. See "PoE bounce and device restart" below.
- `/unifi-clients` - List known WiFi/wired clients from the controller's client table (read-only, no allowlist picker — see "UniFi client actions" below).
- `/unifi-block` - Block or unblock a client by MAC address (mutating, requires confirmation). Deliberately not allowlist-scoped like `/poe`/`/unifi-restart` — see "UniFi client actions" below for why.
- `/camera-status` - Check a camera's UniFi Protect connection + recording status, picked from the same `poe_devices` list `/poe` uses (read-only). See "Camera recording status" below — this one hasn't been live-verified yet.

## Prerequisites

- Node.js 22+ (matches the Docker image; only needed if running without Docker)
- Discord Bot Token (from [Discord Developer Portal](https://discord.com/developers/applications))
- Self-hosted Open WebUI instance
- Open WebUI API key (generated from Settings > Account in Open WebUI)
- **open-terminal**, reachable and holding the per-host SSH keys described in
  "SSH key architecture" below — required by every netcheck command
  (`/linux`, `/docker`, `/pihole`, `/proxmox*`, `/windows`, `/fileserver`,
  `/router`, `/jarvis-audit`)
- A **UniFi Network/Protect controller** with a dedicated local admin account
  for the bot — required by `/poe`, `/unifi-restart`, `/unifi-clients`,
  `/unifi-block`, and `/camera-status` (see `UNIFI_CONTROLLER_*` below)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/macdonald-davidg/discord-bot.git
cd discord-bot
```

In this deployment the repo is instead a git submodule cloned into
`llm-stack/discord-bot/` — see the "Using Docker Compose" step below.

### 2. Configure environment variables

Create a `.env` file in the project root with the following variables:

```
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_discord_server_id

# Open WebUI Configuration
# Only needs to be reachable on the same Docker network as the bot — in this
# deployment that's the internal llm_network bridge (open-webui:8080), not a
# public URL. Use a public/Authentik-fronted URL only if the bot itself runs
# somewhere that can't reach Open WebUI over a private network.
OPEN_WEBUI_URL=http://open-webui:8080

# API Authentication
# Get your API key from Settings > Account in Open WebUI
OPEN_WEBUI_API_KEY=your_open_webui_api_key

# Default model to use for /ask when no model is specified
OPEN_WEBUI_DEFAULT_MODEL=your_default_model_id

# open-terminal (required by the netcheck commands)
OPEN_TERMINAL_URL=http://your-open-terminal-host:8100
OPEN_TERMINAL_API_KEY=your_open_terminal_api_key

# UniFi controller (required by /poe, /unifi-restart, /unifi-clients,
# /unifi-block, /camera-status) — use a dedicated local admin account
# created in the Network app UI, not your primary admin login, and use the
# controller's IP rather than a hostname (see "SSH key architecture" /
# "PoE bounce and device restart" below for why a CNAME hostname breaks this
# image's DNS resolution)
UNIFI_CONTROLLER_URL=https://192.168.x.x
UNIFI_CONTROLLER_USERNAME=your_dedicated_bot_account
UNIFI_CONTROLLER_PASSWORD=your_password
UNIFI_CONTROLLER_SITE=default

# Rate Limiting (requests per minute)
RATE_LIMIT=10

# Optional: Port for status web server
PORT=3001
```

See `.env.example` for the authoritative, fully-commented list.

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
| `lan.gfh` | nas.example.local | `/home/user/.ssh/bot_gfh_ed25519` |
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

## UniFi client actions

`/unifi-clients` and `/unifi-block` extend the same UniFi controller
integration `/poe` and `/unifi-restart` use (`src/services/unifiController.js`)
from infra devices (switches/APs) down to individual clients.

**`/unifi-clients` (read-only)** reads the controller's `db.user` collection
over the same SSH+mongo path `findUplinkPort`/`findDeviceMac` already use
(see "PoE bounce and device restart" above for why the lookup goes over SSH
rather than the REST API — same reasoning applies here: the API's field
names were never verified live against this controller, but the Mongo
schema was). Sorted most-recently-seen first, capped at 60 rows since this
feeds one Discord embed rather than a paged UI.

**`/unifi-block` (mutating)** takes a free-text MAC address rather than a
dropdown, which is a deliberate break from `/poe`/`/unifi-restart`'s
allowlist-driven device pickers: those cover a small, fixed set of infra
devices decided ahead of time, but the entire point of a block command is
being able to act on a client nobody pre-approved — an unrecognized MAC
spotted in `/unifi-clients` output, say. The authorization boundary here is
Discord's Administrator-only command permission plus the mandatory Confirm
button, not a `config/allowlist.json` entry. Calls the controller's
`cmd/stamgr` endpoint (`block-sta`/`unblock-sta`) — same REST mechanism as
`/poe`'s `cmd/devmgr` calls, different command namespace since this targets
a client, not an infra device.

**NOT YET LIVE-TESTED**, same caveat as `/poe`/`/unifi-restart` when they
were first added — the read side (`db.user` schema) hasn't been verified
against this controller's actual data the way `db.device`/`port_table` were
for the PoE/restart work. Verify a `/unifi-clients` listing looks sane
before trusting `/unifi-block` against a real MAC.

## Camera recording status

`/camera-status` reads a camera's connection + recording state from the
**UniFi Protect** app rather than the Network app `/poe`/`/unifi-restart`
use — a separate app on the same UniFi OS console, proxied at
`/proxy/protect/api` instead of `/proxy/network/api`, but authenticated with
the exact same OS-level `login()` session (`getCameraRecordingStatus()` in
`unifiController.js`), since a UniFi OS login grants access to every local
app on the console, not just the one you logged in through. Matches a
camera by IP against Protect's `host` field, reusing the same `poe_devices`
entries `/poe` already draws its camera list from — no second device list
to maintain.

**NOT YET LIVE-TESTED.** Unlike the Network app's Mongo schema (verified
live while building `/poe`), Protect's `/proxy/protect/api/cameras` response
shape — field names, exact recording-mode values — was never confirmed
against this controller. If this throws or returns something that doesn't
look right on first real use, capture the raw response and adjust the field
names in `getCameraRecordingStatus()` before trusting it further. Only
recording *status* is exposed right now (connection state, recording mode,
last-motion timestamp) — no snapshot/live-view/motion-alert-configuration
abilities, which would be a separate, larger addition.

## Backups

`/proxmox-backup` adds on-demand `vzdump` backups and backup visibility
(`backup-list`: recent local dump files; `backup-jobs`: configured scheduled
jobs) for the guests that already have restart/stop checks under `/proxmox`
(431, 530, 421, 422, 521, 522, 524 — see `config/allowlist.json`).

**Split into its own category/command rather than added to `/proxmox`**
because `/proxmox` was already at 22 checks and Discord caps a slash
command's choices at 25 per option — adding 9 backup-related checks there
would have pushed it to 31, silently truncating the last 6 out of the
dropdown with no error (`buildCategoryCommand()` used to `.slice(0, 25)`
with no warning; it now throws at startup instead if any category ever
grows past the limit — see the guard in `src/services/netcheckRunner.js`).

**Known blocker, not yet resolved: the configured backup storage doesn't
currently have enough free space to actually run a backup.** The
`<vmid>-backup` checks are wired up and will show in the `/proxmox-backup`
dropdown, but firing one for real is expected to fail on disk space until
that's addressed — check `pvesm status` (`/proxmox`'s `proxmox-storage`
check) and `backup-list`/`backup-jobs` first to see current headroom before
trying an on-demand backup. The commands intentionally don't specify
`--storage` explicitly (`vzdump <vmid> --mode snapshot --compress zstd`),
relying on whatever backup-content-flagged storage is already configured as
default — confirm that's still the intended target once storage capacity is
sorted out, rather than assuming.

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to the "Bot" tab and create a bot (no Privileged Gateway Intents needed
   — this bot is slash-command-only and requests only the default `Guilds`
   and `GuildMessages` intents, no `MESSAGE CONTENT INTENT`)
4. Copy the token and add it to your `.env` file
5. Go to OAuth2 > URL Generator
6. Select the following scopes: `bot`, `applications.commands`
7. Bot Permissions: `Send Messages`, `Embed Links`, `Read Message History`
8. Copy the generated URL and open it in your browser to add the bot to your server

## Docker Deployment

This bot is designed to be run in a Docker container, but is not deployed
standalone — see "Using Docker Compose" under Setup above. In this
deployment it's always built as the `discord-bot` service in the
**llm-stack** repo's `docker-compose.yml`:

```bash
docker compose --project-directory ~/compose/llm-stack up -d --build discord-bot
```

That service:

- Publishes **no host port** — it only joins the internal `llm_network`
  bridge; the Dockerfile's `HEALTHCHECK` hits `http://localhost:$PORT/health`
  from inside the container, which needs no published port.
- Bind-mounts only `./discord-bot/config:/app/config:ro` (the allowlist, so
  it can be edited without a rebuild — restart to apply). There is no logs
  volume; nothing is written to `logs/` beyond the container's own lifetime.
- Uses `restart: unless-stopped`, with `env_file: ./discord-bot/.env` for
  configuration.

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

