const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'linux',
  commandName: 'linux',
  commandDescription: 'Run an allowlisted general Linux diagnostic check on a host'
});
