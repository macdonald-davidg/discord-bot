const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'router',
  commandName: 'router',
  commandDescription: 'Run an allowlisted diagnostic or management command on the UDM SE gateway/router'
  // The router authenticates as root over a dedicated single-host key
  // (bot_router_ed25519, not the jarvis fleet key) — see config/allowlist.json's
  // "lan.router" entry. As of the wan-bounce/reboot additions this category is
  // no longer readOnly — those two checks are mutating: true, so they go
  // through the same Confirm/Cancel button gate in buildCategoryCommand as
  // every other mutating check (proxmox restarts, docker restarts, etc.).
});
