const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'docker',
  commandName: 'docker',
  commandDescription: 'Run an allowlisted read-only Docker inspection command on a host'
});
