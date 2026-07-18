const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'windows',
  commandName: 'windows',
  commandDescription: 'Run an allowlisted PowerShell diagnostic check on a Windows host'
});
