const { buildCategoryCommand } = require('../services/netcheckRunner');

// Split out from /proxmox rather than added to it — config/allowlist.json's
// "proxmox" category was already at 22 checks, and Discord caps a slash
// command's string-option choices at 25 total. Adding backup-list/
// backup-jobs plus a per-guest -backup check for all 7 backed-up guests
// would have pushed it to 31, silently truncating the last 6 checks out of
// the dropdown (buildCategoryCommand slices choices to 25 with no warning).
// See netcheckRunner.js's startup guard, added at the same time, which now
// throws instead of truncating if any category ever grows past the limit
// again.
module.exports = buildCategoryCommand({
  categoryKey: 'proxmox-backup',
  commandName: 'proxmox-backup',
  commandDescription: 'List/trigger vzdump backups on the Proxmox hypervisor'
});
