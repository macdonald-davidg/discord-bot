const { buildCategoryCommand } = require('../services/netcheckRunner');

module.exports = buildCategoryCommand({
  categoryKey: 'fileserver',
  commandName: 'fileserver',
  commandDescription: 'Run an allowlisted NFS/CIFS/Samba diagnostic check on a host'
});
