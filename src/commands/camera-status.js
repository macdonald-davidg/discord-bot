const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { allowlist } = require('../services/netcheckRunner');
const { getCameraRecordingStatus } = require('../services/unifiController');

// Reuses config/allowlist.json's poe_devices list, filtered to type "camera"
// — same allowlist /poe already draws its device choices from, so adding a
// camera here doesn't require touching two separate lists.
const cameras = Object.entries(allowlist.poe_devices || {})
  .filter(([, d]) => d.type === 'camera');
const deviceChoices = cameras
  .slice(0, 25)
  .map(([key, d]) => ({ name: `${key} — ${d.description || d.ip}`.slice(0, 100), value: key }));

module.exports = {
  cooldown: 15,
  data: new SlashCommandBuilder()
    .setName('camera-status')
    .setDescription("Check a camera's UniFi Protect connection + recording status")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option.setName('device')
        .setDescription('Camera to check')
        .setRequired(true)
        .addChoices(...deviceChoices)),

  async execute(interaction) {
    await interaction.deferReply();

    const deviceKey = interaction.options.getString('device');
    const device = (allowlist.poe_devices || {})[deviceKey];

    if (!device || device.type !== 'camera') {
      return interaction.editReply('Invalid camera selection.');
    }

    try {
      const status = await getCameraRecordingStatus(device.ip);
      const embed = new EmbedBuilder()
        .setColor(status.isConnected ? 0x00cc66 : 0xff3333)
        .setTitle(`Camera status: ${deviceKey}`)
        .addFields(
          { name: 'Protect name', value: status.name, inline: true },
          { name: 'Connected', value: status.isConnected ? 'Yes' : 'No', inline: true },
          { name: 'Recording mode', value: status.recordingMode, inline: true },
          { name: 'Last motion', value: status.lastMotion || 'None recorded', inline: true }
        )
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.username}` });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('camera-status error:', error.message);
      await interaction.editReply(`Failed to get camera status for ${deviceKey}: ${error.message}`);
    }
  }
};
