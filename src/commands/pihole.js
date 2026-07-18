const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'pihole',
  commandName: 'pihole',
  commandDescription: 'Run an allowlisted Pi-hole status/management command on a host'
});
