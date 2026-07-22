const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { listClients } = require('../services/unifiController');

// Read-only — no allowlist scoping needed (see unifi-block.js for why
// /unifi-block, the mutating counterpart, is also unscoped rather than
// allowlist-driven like /poe and /unifi-restart).
module.exports = {
  cooldown: 15,
  data: new SlashCommandBuilder()
    .setName('unifi-clients')
    .setDescription('List known WiFi/wired clients from the UniFi controller (most recently seen first)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const clients = await listClients();

      if (clients.length === 0) {
        return interaction.editReply('No clients found in the controller\'s client table.');
      }

      const ICON = { active: '🟢', blocked: '🚫' };
      const lines = clients.map(c =>
        `${ICON[c.status] || '⚪'} \`${c.mac}\` **${c.name}** — ${c.ip || 'no IP'} (${c.connType})`
      );

      const embed = new EmbedBuilder()
        .setColor(0x00cc66)
        .setTitle('UniFi clients')
        .setDescription(lines.join('\n').slice(0, 4000))
        .addFields({ name: 'Count', value: String(clients.length), inline: true })
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.username}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('unifi-clients error:', error.message);
      await interaction.editReply(`Failed to list clients: ${error.message}`);
    }
  }
};
