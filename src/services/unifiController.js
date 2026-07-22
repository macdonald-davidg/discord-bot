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
async function queryRouterMongo(mongoEval) {
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

  if (status !== 'completed' || exitCode !== 0) {
    throw new Error(`Router query failed (status=${status}, exit=${exitCode}): ${outputText}`);
  }

  const match = outputText.match(/RESULT_START\r?\n([\s\S]*?)RESULT_END/);
  if (!match) {
    throw new Error(`Unexpected output from router query: ${outputText}`);
  }
  const fields = {};
  for (const rawLine of match[1].split('\n')) {
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
  if (!CONTROLLER_URL || !USERNAME || !PASSWORD) {
    throw new Error(
      'UniFi controller is not configured (missing UNIFI_CONTROLLER_URL/USERNAME/PASSWORD in .env).'
    );
  }
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
  if (!CONTROLLER_URL || !USERNAME || !PASSWORD) {
    throw new Error(
      'UniFi controller is not configured (missing UNIFI_CONTROLLER_URL/USERNAME/PASSWORD in .env).'
    );
  }
  const { mac, name } = await findDeviceMac(ip);
  const session = await login();
  await sendDevmgrCmd(session, { cmd: 'restart', mac });
  return { mac, name };
}

module.exports = { poeBounce, restartDevice };
