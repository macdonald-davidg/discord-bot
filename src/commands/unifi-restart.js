const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { confirmMutatingAction, allowlist } = require('../services/netcheckRunner');
const { restartDevice } = require('../services/unifiController');

// config/allowlist.json's unifi_devices is the allowlist for this command —
// only devices listed there can be selected (Discord enforces choices
// server-side), same authorization model as every other allowlisted command.
// Unlike /poe, restart targets the device itself over the controller's
// management channel rather than a switch/gateway port, so it doesn't
// require a wired PoE uplink — a mesh-uplinked AP with no PoE port to cycle
// can still be listed here.
const unifiDevices = allowlist.unifi_devices || {};
const deviceChoices = Object.entries(unifiDevices)
  .slice(0, 25)
  .map(([key, d]) => ({ name: `${key} — ${d.description || d.ip}`.slice(0, 100), value: key }));

module.exports = {
  cooldown: 30,
  data: new SlashCommandBuilder()
    .setName('unifi-restart')
    .setDescription('Restart a UniFi switch or access point (device-level, not a PoE port bounce)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option.setName('device')
        .setDescription('Switch or AP to restart')
        .setRequired(true)
        .addChoices(...deviceChoices)),

  async execute(interaction) {
    const deviceKey = interaction.options.getString('device');
    const device = unifiDevices[deviceKey];

    if (!device) {
      return interaction.reply({ content: 'Invalid device selection.', ephemeral: true });
    }

    // Data-driven rather than matching a specific device key by name, so this
    // stays correct regardless of what a switch happens to be called in your
    // allowlist — set "type": "switch" on the entry in config/allowlist.json.
    const blastRadius = device.type === 'switch'
      ? ' This will drop every wired downstream device simultaneously for the duration of the reboot.'
      : '';

    const confirmed = await confirmMutatingAction(interaction, {
      idPrefix: 'unifi-restart',
      title: `Restart ${deviceKey}`,
      description:
        `This will restart **${deviceKey}** (${device.ip}) itself — a full device reboot, not a port-level ` +
        `PoE bounce.${blastRadius} Confirm within 15 seconds.`
    });
    if (!confirmed) return;

    try {
      const { mac, name } = await restartDevice(device.ip);
      const embed = new EmbedBuilder()
        .setColor(0x00cc66)
        .setTitle(`Restart issued: ${deviceKey}`)
        .setDescription(`Sent restart to **${name}** (\`${mac}\`).`)
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.username}` });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('unifi-restart error:', error.message);
      await interaction.editReply(`Restart failed for ${deviceKey}: ${error.message}`);
    }
  }
};
