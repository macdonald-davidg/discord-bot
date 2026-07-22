const axios = require('axios');
const https = require('https');
const { executeRemoteCommand, allowlist } = require('./netcheckRunner');

const CONTROLLER_URL = process.env.UNIFI_CONTROLLER_URL;
const USERNAME = process.env.UNIFI_CONTROLLER_USERNAME;
const PASSWORD = process.env.UNIFI_CONTROLLER_PASSWORD;
const SITE = process.env.UNIFI_CONTROLLER_SITE || 'default';

// This is the router's own self-hosted controller on the LAN, not a public
// endpoint, and UniFi OS consoles use a self-signed cert by default — so we
// trust it explicitly rather than needing a real CA-issued cert.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Logs in against the UniFi OS console (not the classic standalone-controller
 * /api/login — UDM/UDM-Pro/UDM-SE proxy the Network app behind /proxy/network
 * and authenticate at the OS layer instead) and returns the session cookie +
 * CSRF token needed for subsequent requests. Re-authenticates on every call
 * rather than caching a session — this command runs rarely (manual Discord
 * trigger), so the extra login round-trip is cheap and avoids having to
 * detect/handle session expiry. Confirmed working live (used to fix a
 * client's mismatched display name via GET/PUT rest/user/<id>).
 */
async function login() {
  const res = await axios.post(
    `${CONTROLLER_URL}/api/auth/login`,
    { username: USERNAME, password: PASSWORD },
    { httpsAgent, timeout: 10000, validateStatus: () => true }
  );
  if (res.status !== 200) {
    throw new Error(`UniFi controller login failed: HTTP ${res.status}`);
  }

  const setCookie = res.headers['set-cookie'] || [];
  const tokenCookie = setCookie.find(c => c.startsWith('TOKEN='));
  if (!tokenCookie) {
    throw new Error('UniFi controller login succeeded but returned no TOKEN cookie.');
  }
  const cookie = tokenCookie.split(';')[0];

  // Some UniFi OS versions return the CSRF token as a response header;
  // others only embed it as a claim in the TOKEN JWT itself. Try the header
  // first, fall back to decoding the JWT payload.
  let csrfToken = res.headers['x-csrf-token'];
  if (!csrfToken) {
    const jwt = cookie.split('=')[1];
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    csrfToken = payload.csrfToken;
  }
  if (!csrfToken) {
    throw new Error('UniFi controller login succeeded but no CSRF token could be found (header or JWT claim).');
  }

  return { cookie, csrfToken };
}

/**
 * Runs a mongo --eval on the router over SSH (same open-terminal path and
 * dedicated router key every other check uses) and parses a
 * RESULT_START/...key=value.../RESULT_END block out of the output.
 * SSH output preserves the remote shell's CRLF line endings, not plain \n
 * — confirmed live 2026-07-22. Tolerate \r?\n on the delimiter and trim()
 * each field line (trim() strips \r along with other whitespace) so field
 * values don't end up with a trailing carriage return baked in.
 */
async function queryRouterMongoRaw(mongoEval) {
  const router = allowlist.hosts['lan.router'];
  if (!router) {
    throw new Error('config/allowlist.json has no "lan.router" host entry.');
  }

  const { status, exitCode, outputText } = await executeRemoteCommand({
    sshUser: router.ssh_user,
    hostname: router.hostname,
    remoteCommand: `mongo --port 27117 ace --quiet --eval '${mongoEval}'`,
    identityFile: router.identity_file
  });

  // open-terminal's actual terminal-success status string is "done", not
  // "completed" — confirmed against every raw API response captured while
  // building this (2026-07-22). Every prior verification in this session
  // used raw curl and only checked exit_code, never status, which is why
  // this mismatch went unnoticed until it broke a real Discord command.
  if (status !== 'done' || exitCode !== 0) {
    throw new Error(`Router query failed (status=${status}, exit=${exitCode}): ${outputText}`);
  }

  const match = outputText.match(/RESULT_START\r?\n([\s\S]*?)RESULT_END/);
  if (!match) {
    throw new Error(`Unexpected output from router query: ${outputText}`);
  }
  return match[1];
}

/**
 * Same as queryRouterMongoRaw, but for eval scripts that print a single
 * flat key=value block (most lookups here — one device, a handful of
 * fields). Row-oriented queries like listClients() parse the raw block
 * themselves instead, since key=value doesn't fit a variable-length list.
 */
async function queryRouterMongo(mongoEval) {
  const raw = await queryRouterMongoRaw(mongoEval);
  const fields = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return fields;
}

function ensureIp(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`Refusing to look up non-IP value: ${ip}`);
  }
}

function ensureMac(mac) {
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) {
    throw new Error(`Refusing to act on non-MAC value: ${mac}`);
  }
}

function requireControllerConfig() {
  if (!CONTROLLER_URL || !USERNAME || !PASSWORD) {
    throw new Error(
      'UniFi controller is not configured (missing UNIFI_CONTROLLER_URL/USERNAME/PASSWORD in .env).'
    );
  }
}

/**
 * Finds the switch/gateway MAC + port index a device (by its known LAN IP)
 * is currently plugged into, by searching the port_table of every adopted
 * switch/gateway (type usw/udm) for a port whose last_connection.ip matches.
 *
 * This replaces an earlier version that trusted each device's own
 * self-reported last_uplink field — confirmed live that field can go stale
 * (an AP reported last_uplink.type "wireless" even though the switch's own
 * port_table showed it live-connected on a real port, LLDP-confirmed,
 * poe_good:true). The upstream device's port_table is the more authoritative
 * source: it's what's actually driving PoE delivery.
 * Deliberately not cached/hardcoded — a device can move ports over time, and
 * resolving this live means config/allowlist.json only needs each device's
 * stable IP, never a port number.
 */
async function findUplinkPort(ip) {
  ensureIp(ip);

  const mongoEval = [
    `var ip = "${ip}";`,
    'var mac = null, port = null, sourceDevice = null;',
    'db.device.find({type: {$in: ["usw", "udm"]}}, {port_table: 1, mac: 1, name: 1}).forEach(function(dev) {',
    '  if (mac !== null) return;',
    '  (dev.port_table || []).forEach(function(p) {',
    '    if (mac !== null) return;',
    '    if (p.last_connection && p.last_connection.ip === ip) {',
    '      mac = dev.mac; port = p.port_idx; sourceDevice = dev.name;',
    '    }',
    '  });',
    '});',
    'print("RESULT_START");',
    'print("mac=" + (mac || ""));',
    'print("port=" + (port !== null ? port : ""));',
    'print("sourceDevice=" + (sourceDevice || ""));',
    'print("RESULT_END");'
  ].join(' ');

  const fields = await queryRouterMongo(mongoEval);

  if (!fields.mac || fields.port === '') {
    throw new Error(
      `${ip} isn't currently connected on any known managed port (switch or gateway) — ` +
      'it may be offline, wirelessly meshed, or powered by something outside UniFi\'s control ' +
      '(e.g. a standalone wall-outlet PoE injector), none of which this can power-cycle.'
    );
  }

  return { switchMac: fields.mac, portIdx: parseInt(fields.port, 10), deviceName: fields.sourceDevice };
}

/**
 * Finds a device's own MAC (for a device-level restart, which targets the
 * device itself, not an upstream port) by its known LAN IP.
 */
async function findDeviceMac(ip) {
  ensureIp(ip);

  const mongoEval = [
    `var ip = "${ip}";`,
    'var d = db.device.findOne({ip: ip}, {mac: 1, name: 1, type: 1});',
    'print("RESULT_START");',
    'print("mac=" + (d ? d.mac : ""));',
    'print("name=" + (d ? d.name : ""));',
    'print("type=" + (d ? d.type : ""));',
    'print("RESULT_END");'
  ].join(' ');

  const fields = await queryRouterMongo(mongoEval);

  if (!fields.mac) {
    throw new Error(`${ip} isn't an adopted network device (no matching entry in the controller's device list).`);
  }

  return { mac: fields.mac, name: fields.name || ip, type: fields.type };
}

async function sendDevmgrCmd(session, body) {
  const res = await axios.post(
    `${CONTROLLER_URL}/proxy/network/api/s/${SITE}/cmd/devmgr`,
    body,
    {
      httpsAgent,
      timeout: 10000,
      headers: { Cookie: session.cookie, 'X-Csrf-Token': session.csrfToken },
      validateStatus: () => true
    }
  );
  if (res.status !== 200 || res.data?.meta?.rc !== 'ok') {
    throw new Error(`devmgr "${body.cmd}" failed: HTTP ${res.status} ${JSON.stringify(res.data?.meta || res.data)}`);
  }
}

/**
 * Full PoE-bounce flow for one device, identified by its LAN IP: resolve
 * which switch/gateway port it's currently on (via SSH+mongo, see
 * findUplinkPort), then log in to the controller and issue the power-cycle
 * over its REST API — the same call the "Power Cycle Port" button in the
 * Network app UI makes. NOT YET LIVE-TESTED (mutating — deliberately not
 * fired this session; only the read-side lookups and the login+rename flow
 * have been exercised for real).
 */
async function poeBounce(ip) {
  requireControllerConfig();
  const { switchMac, portIdx, deviceName } = await findUplinkPort(ip);
  const session = await login();
  await sendDevmgrCmd(session, { cmd: 'power-cycle', mac: switchMac, port_idx: portIdx });
  return { switchMac, portIdx, deviceName };
}

/**
 * Restarts an adopted network device itself (switch or AP) via the
 * controller's management channel — unlike poeBounce, this doesn't require
 * a wired PoE port, since it's a soft command sent over the same channel the
 * device uses to check in with the controller (works over a wireless mesh
 * uplink too, in principle). NOT YET LIVE-TESTED — same caveat as poeBounce.
 */
async function restartDevice(ip) {
  requireControllerConfig();
  const { mac, name } = await findDeviceMac(ip);
  const session = await login();
  await sendDevmgrCmd(session, { cmd: 'restart', mac });
  return { mac, name };
}

/**
 * Lists known WiFi/wired clients from the router's own client table
 * (db.user — distinct from db.device, which is infra: switches/APs/gateway).
 * Same SSH+mongo lookup pattern as findUplinkPort/findDeviceMac, for the
 * same reason noted in README's "PoE bounce and device restart" section:
 * the API's exact JSON field names were never verified live against this
 * controller, but the Mongo schema was. Sorted by last_seen descending and
 * capped at 60 rows — this feeds a single Discord embed (4096-char
 * description limit), not a paged UI, so an unbounded client table would
 * just get truncated anyway.
 *
 * Row-oriented, not a flat key=value block like the single-device lookups
 * above, so this parses queryRouterMongoRaw's output itself: one client per
 * line, fields pipe-separated (hostnames/names can't contain a MongoDB
 * document boundary but could in principle contain "=", which is why this
 * doesn't reuse queryRouterMongo's key=value parsing).
 */
async function listClients() {
  const mongoEval = [
    'var rows = [];',
    'db.user.find({}, {mac:1, name:1, hostname:1, ip:1, is_wired:1, blocked:1, last_seen:1}).sort({last_seen:-1}).limit(60).forEach(function(u) {',
    '  rows.push([u.mac || "", u.name || u.hostname || "(unnamed)", u.ip || "", u.is_wired ? "wired" : "wifi", u.blocked ? "blocked" : "active", u.last_seen || ""].join("|"));',
    '});',
    'print("RESULT_START");',
    'print(rows.join("\\n"));',
    'print("RESULT_END");'
  ].join(' ');

  const raw = await queryRouterMongoRaw(mongoEval);
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [mac, name, ip, connType, status, lastSeen] = line.split('|');
      return { mac, name, ip, connType, status, lastSeen: lastSeen ? Number(lastSeen) : null };
    });
}

/**
 * Blocks or unblocks a client by MAC via the controller's stamgr command —
 * the same call the "Block"/"Unblock" button in the client's detail panel
 * makes. Unlike /poe and /unifi-restart, this isn't scoped to a fixed
 * allowlist of pre-approved device keys: the whole point is being able to
 * act on a client that wasn't anticipated ahead of time (an unrecognized or
 * misbehaving device someone spots in /unifi-clients output). The
 * authorization boundary here is Discord's Administrator-only command
 * permission plus the mandatory confirm button, not an allowlist entry —
 * see commands/unifi-block.js. NOT YET LIVE-TESTED — same caveat as
 * poeBounce/restartDevice.
 */
async function setClientBlocked(mac, blocked) {
  requireControllerConfig();
  ensureMac(mac);
  const session = await login();
  const res = await axios.post(
    `${CONTROLLER_URL}/proxy/network/api/s/${SITE}/cmd/stamgr`,
    { cmd: blocked ? 'block-sta' : 'unblock-sta', mac },
    {
      httpsAgent,
      timeout: 10000,
      headers: { Cookie: session.cookie, 'X-Csrf-Token': session.csrfToken },
      validateStatus: () => true
    }
  );
  if (res.status !== 200 || res.data?.meta?.rc !== 'ok') {
    throw new Error(`stamgr "${blocked ? 'block-sta' : 'unblock-sta'}" failed: HTTP ${res.status} ${JSON.stringify(res.data?.meta || res.data)}`);
  }
  return { mac };
}

/**
 * Reads a camera's recording status from the UniFi Protect app, which is a
 * separate app from Network under the same UniFi OS console — proxied at
 * /proxy/protect/api rather than /proxy/network/api, but authenticated with
 * the exact same OS-level login()/session, since UniFi OS grants one login
 * access to every local app on the console. Matches on the camera's `host`
 * field, which Protect populates with the camera's LAN IP — the same IP
 * already stored per-device in config/allowlist.json's poe_devices, so no
 * new identifier needs to be tracked.
 *
 * NOT YET LIVE-TESTED — the Protect API's exact response shape (camera
 * list field names, recording-mode values) was never verified live against
 * this controller the way the Network app's Mongo schema was for
 * findUplinkPort/findDeviceMac; see README's PoE section for why that
 * verification mattered there. If this throws or returns unexpected data
 * on first real use, capture the raw `/proxy/protect/api/cameras` response
 * and adjust the field names below before trusting this further.
 */
async function getCameraRecordingStatus(ip) {
  requireControllerConfig();
  ensureIp(ip);
  const session = await login();
  const res = await axios.get(
    `${CONTROLLER_URL}/proxy/protect/api/cameras`,
    {
      httpsAgent,
      timeout: 10000,
      headers: { Cookie: session.cookie, 'X-Csrf-Token': session.csrfToken },
      validateStatus: () => true
    }
  );
  if (res.status !== 200) {
    throw new Error(`UniFi Protect camera list failed: HTTP ${res.status}`);
  }
  const cameras = Array.isArray(res.data) ? res.data : (res.data?.cameras || []);
  const cam = cameras.find(c => c.host === ip || c.connectionHost === ip);
  if (!cam) {
    throw new Error(
      `${ip} wasn't found in UniFi Protect's camera list. It may not be adopted into Protect specifically ` +
      '(the Network app device record /poe and /unifi-restart use is separate from Protect adoption).'
    );
  }

  return {
    name: cam.name || ip,
    isConnected: cam.state ? cam.state === 'CONNECTED' : Boolean(cam.isConnected),
    recordingMode: cam.recordingSettings?.mode ?? 'unknown',
    lastMotion: cam.lastMotion ? new Date(cam.lastMotion).toISOString() : null
  };
}

module.exports = { poeBounce, restartDevice, listClients, setClientBlocked, getCameraRecordingStatus };
