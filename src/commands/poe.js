const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { confirmMutatingAction, allowlist } = require('../services/netcheckRunner');
const { poeBounce } = require('../services/unifiController');

// config/allowlist.json's poe_devices is the allowlist for this command —
// only devices listed there can be selected (Discord enforces choices
// server-side), same authorization model as every other allowlisted command.
// Port numbers are deliberately NOT stored here — unifiController resolves
// the current switch/port live from the device's IP on every run.
const poeDevices = allowlist.poe_devices || {};
const deviceChoices = Object.entries(poeDevices)
  .slice(0, 25)
  .map(([key, d]) => ({ name: `${key} — ${d.description || d.ip}`.slice(0, 100), value: key }));

module.exports = {
  cooldown: 30,
  data: new SlashCommandBuilder()
    .setName('poe')
    .setDescription("Power-cycle a camera or access point's PoE switch port")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option.setName('device')
        .setDescription('Camera or AP to bounce')
        .setRequired(true)
        .addChoices(...deviceChoices)),

  async execute(interaction) {
    const deviceKey = interaction.options.getString('device');
    const device = poeDevices[deviceKey];

    if (!device) {
      return interaction.reply({ content: 'Invalid device selection.', ephemeral: true });
    }

    const confirmed = await confirmMutatingAction(interaction, {
      idPrefix: 'poe',
      title: `PoE bounce ${deviceKey}`,
      description:
        `This will power-cycle the switch port for **${deviceKey}** (${device.ip}), resolved live from the ` +
        'UniFi controller. The device will briefly go offline (camera recording gap / AP Wi-Fi drop for ' +
        'connected clients). Confirm within 15 seconds.'
    });
    if (!confirmed) return;

    try {
      const { switchMac, portIdx, deviceName } = await poeBounce(device.ip);
      const embed = new EmbedBuilder()
        .setColor(0x00cc66)
        .setTitle(`PoE bounce complete: ${deviceKey}`)
        .setDescription(`Power-cycled **${deviceName}** on switch \`${switchMac}\`, port ${portIdx}.`)
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.username}` });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('poe error:', error.message);
      await interaction.editReply(`PoE bounce failed for ${deviceKey}: ${error.message}`);
    }
  }
};
