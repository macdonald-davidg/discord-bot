const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'router',
  commandName: 'router',
  commandDescription: 'Run an allowlisted read-only diagnostic check on the UDM SE gateway/router',
  // The router authenticates as root over a dedicated single-host key
  // (bot_router_ed25519, not the jarvis fleet key) — see config/allowlist.json's
  // "lan.router" entry. readOnly is a hard safety net, not just a convention:
  // buildCategoryCommand throws at startup if this category ever gets a
  // mutating: true check, so a future allowlist edit can't silently grant
  // Discord-triggered state changes on the household's sole gateway/firewall.
  readOnly: true
});
