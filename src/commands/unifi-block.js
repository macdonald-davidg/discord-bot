const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { confirmMutatingAction } = require('../services/netcheckRunner');
const { setClientBlocked } = require('../services/unifiController');

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

// Deliberately not allowlist-scoped the way /poe and /unifi-restart's
// device dropdowns are — those cover a small, fixed set of infra devices
// picked ahead of time, but a block/unblock target is, by definition, often
// a client nobody added to any list in advance (that's the whole reason to
// block it). Authorization here is Discord's Administrator-only command
// permission plus the mandatory Confirm button, not a pre-approved list —
// see the comment on setClientBlocked() in services/unifiController.js.
module.exports = {
  cooldown: 15,
  data: new SlashCommandBuilder()
    .setName('unifi-block')
    .setDescription('Block or unblock a client on the UniFi network by MAC address')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option.setName('mac')
        .setDescription('Client MAC address, e.g. aa:bb:cc:dd:ee:ff (see /unifi-clients)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('action')
        .setDescription('Block or unblock')
        .setRequired(true)
        .addChoices(
          { name: 'block', value: 'block' },
          { name: 'unblock', value: 'unblock' }
        )),

  async execute(interaction) {
    const mac = interaction.options.getString('mac').trim().toLowerCase();
    const action = interaction.options.getString('action');

    if (!MAC_RE.test(mac)) {
      return interaction.reply({
        content: `"${mac}" doesn't look like a MAC address (expected aa:bb:cc:dd:ee:ff format).`,
        ephemeral: true
      });
    }

    const blocked = action === 'block';

    const confirmed = await confirmMutatingAction(interaction, {
      idPrefix: 'unifi-block',
      title: `${blocked ? 'Block' : 'Unblock'} ${mac}`,
      description:
        `This will **${blocked ? 'block' : 'unblock'}** client \`${mac}\` on the UniFi network` +
        (blocked ? ' — it will immediately lose network access.' : ' — it will regain network access.') +
        ' Confirm within 15 seconds.'
    });
    if (!confirmed) return;

    try {
      await setClientBlocked(mac, blocked);
      const embed = new EmbedBuilder()
        .setColor(0x00cc66)
        .setTitle(`${blocked ? 'Blocked' : 'Unblocked'}: ${mac}`)
        .setDescription(`Client \`${mac}\` has been ${blocked ? 'blocked' : 'unblocked'}.`)
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.username}` });
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('unifi-block error:', error.message);
      await interaction.editReply(`Failed to ${blocked ? 'block' : 'unblock'} ${mac}: ${error.message}`);
    }
  }
};
