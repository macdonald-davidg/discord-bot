const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'docker',
  commandName: 'docker',
  commandDescription: 'Run an allowlisted Docker command on a host (inspection, or container restart/stop)'
});
