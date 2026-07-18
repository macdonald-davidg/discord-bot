const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'proxmox',
  commandName: 'proxmox',
  commandDescription: 'Run an allowlisted Proxmox management/stats command on a host'
});
