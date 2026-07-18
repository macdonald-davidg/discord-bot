const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const allowlistPath = path.join(__dirname, '..', '..', 'config', 'allowlist.json');
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

const OPEN_TERMINAL_URL = process.env.OPEN_TERMINAL_URL;
const OPEN_TERMINAL_API_KEY = process.env.OPEN_TERMINAL_API_KEY;

// Discord caps slash command choices at 25 per option.
const hostChoices = Object.entries(allowlist.hosts)
  .slice(0, 25)
  .map(([key, h]) => ({ name: `${key} — ${h.description}`.slice(0, 100), value: key }));

/**
 * Builds a full Discord slash command (data + execute) scoped to one
 * allowlist category (e.g. "linux", "pihole", "proxmox", "docker").
 * All four category commands share this exact execution path — only the
 * category key, command name, and description differ between them.
 */
function buildCategoryCommand({ categoryKey, commandName, commandDescription }) {
  const checks = allowlist.categories[categoryKey];
  if (!checks) {
    throw new Error(`Unknown allowlist category: ${categoryKey}`);
  }

  const checkChoices = Object.entries(checks)
    .slice(0, 25)
    .map(([key, c]) => ({ name: `${key} — ${c.description}`.slice(0, 100), value: key }));

  return {
    cooldown: 10,
    data: new SlashCommandBuilder()
      .setName(commandName)
      .setDescription(commandDescription)
      // Locks to Administrator by default. Fine-tune actual access via
      // Server Settings > Integrations > this bot > <command name>.
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(option =>
        option.setName('host')
          .setDescription('Target host')
          .setRequired(true)
          .addChoices(...hostChoices))
      .addStringOption(option =>
        option.setName('check')
          .setDescription('Allowed check/command to run')
          .setRequired(true)
          .addChoices(...checkChoices)),

    async execute(interaction) {
      const hostKey = interaction.options.getString('host');
      const checkKey = interaction.options.getString('check');

      const host = allowlist.hosts[hostKey];
      const check = checks[checkKey];

      if (!host || !check) {
        return interaction.reply({ content: 'Invalid host or check selection.', ephemeral: true });
      }

      if (!OPEN_TERMINAL_URL || !OPEN_TERMINAL_API_KEY) {
        return interaction.reply({
          content: 'open-terminal is not configured (missing OPEN_TERMINAL_URL or OPEN_TERMINAL_API_KEY).',
          ephemeral: true
        });
      }

      if (!check.mutating) {
        // Read-only check — run immediately, same as before.
        await interaction.deferReply();
        return runCheck({ interaction, commandName, hostKey, checkKey, host, check });
      }

      // Mutating check — require explicit confirmation before touching anything.
      const confirmId = `netcheck-confirm-${interaction.id}`;
      const cancelId = `netcheck-cancel-${interaction.id}`;

      const warnEmbed = new EmbedBuilder()
        .setColor(0xff3333)
        .setTitle(`⚠️ Confirm: ${checkKey} on ${hostKey}`)
        .setDescription(
          `This will run:\n\`\`\`${check.sudo ? 'sudo ' : ''}${check.command}\`\`\`\non **${host.hostname}**.\n\nThis action changes state on that host. Confirm within 15 seconds.`
        )
        .setFooter({ text: `Requested by ${interaction.user.username}` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      const promptMessage = await interaction.reply({ embeds: [warnEmbed], components: [row], fetchReply: true });

      let buttonInteraction;
      try {
        buttonInteraction = await promptMessage.awaitMessageComponent({
          filter: i => i.user.id === interaction.user.id && (i.customId === confirmId || i.customId === cancelId),
          time: 15000
        });
      } catch {
        // Timed out with no click.
        return interaction.editReply({
          embeds: [warnEmbed.setColor(0x888888).setTitle(`Timed out: ${checkKey} on ${hostKey}`)],
          components: []
        });
      }

      if (buttonInteraction.customId === cancelId) {
        return buttonInteraction.update({
          embeds: [warnEmbed.setColor(0x888888).setTitle(`Cancelled: ${checkKey} on ${hostKey}`)],
          components: []
        });
      }

      await buttonInteraction.update({
        embeds: [warnEmbed.setColor(0xffaa00).setTitle(`Running: ${checkKey} on ${hostKey}`)],
        components: []
      });

      return runCheck({ interaction, commandName, hostKey, checkKey, host, check });
    }
  };
}

async function runCheck({ interaction, commandName, hostKey, checkKey, host, check }) {
      const remoteCommand = check.sudo ? `sudo ${check.command}` : check.command;
      // Properly escape any single quotes within remoteCommand using the
      // standard POSIX technique ('->'\'') before wrapping in outer single
      // quotes. Without this, a literal single quote inside remoteCommand
      // (extremely common in PowerShell string literals, e.g. 'Running')
      // would prematurely close our quoting and get silently stripped
      // rather than erroring loudly — exactly the bug this fixes.
      const escapedRemoteCommand = remoteCommand.replace(/'/g, `'\\''`);
      const sshCommand = `ssh -T -o BatchMode=yes -l ${host.ssh_user} ${host.hostname} '${escapedRemoteCommand}'`;

      const headers = {
        Authorization: `Bearer ${OPEN_TERMINAL_API_KEY}`,
        'Content-Type': 'application/json'
      };

      try {
        const startRes = await axios.post(
          `${OPEN_TERMINAL_URL}/execute`,
          { command: sshCommand },
          { headers, timeout: 10000 }
        );

        const processId = startRes.data.id;
        let status = startRes.data.status;
        let exitCode = startRes.data.exit_code;
        let output = Array.isArray(startRes.data.output)
          ? startRes.data.output.map(o => (typeof o === 'string' ? o : o.data ?? JSON.stringify(o)))
          : [];
        let offset = startRes.data.next_offset || 0;

        const maxWaitMs = 25000; // stay under Discord's interaction edit window
        const pollIntervalMs = 1000;
        const startTime = Date.now();

        while (status === 'running' && Date.now() - startTime < maxWaitMs) {
          await new Promise(r => setTimeout(r, pollIntervalMs));

          const statusRes = await axios.get(
            `${OPEN_TERMINAL_URL}/execute/${processId}/status`,
            { headers, params: { offset }, timeout: 10000 }
          );

          status = statusRes.data.status;
          exitCode = statusRes.data.exit_code;
          if (Array.isArray(statusRes.data.output)) {
            output = output.concat(
              statusRes.data.output.map(o => (typeof o === 'string' ? o : o.data ?? JSON.stringify(o)))
            );
          }
          offset = statusRes.data.next_offset ?? offset;
        }

        // If it's still running after our patience window, kill it rather
        // than leave an orphaned sudo-capable SSH session dangling remotely.
        if (status === 'running') {
          try {
            await axios.delete(`${OPEN_TERMINAL_URL}/execute/${processId}`, { headers, timeout: 5000 });
          } catch (killErr) {
            console.error('Failed to clean up timed-out process:', killErr.message);
          }
        }

        const outputText = output.join('\n').trim().slice(0, 3800) || '(no output captured)';

        const embed = new EmbedBuilder()
          .setColor(status === 'completed' && exitCode === 0 ? 0x00cc66 : 0xff9900)
          .setTitle(`${commandName}: ${checkKey} on ${hostKey}`)
          .setDescription(`\`\`\`\n${outputText}\n\`\`\``)
          .addFields(
            { name: 'Host', value: host.hostname, inline: true },
            { name: 'Status', value: status, inline: true },
            { name: 'Exit Code', value: String(exitCode ?? 'n/a'), inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Requested by ${interaction.user.username}` });

        if (status === 'running') {
          embed.addFields({
            name: 'Note',
            value: 'Command exceeded the wait window and was terminated. Check open-terminal directly if it needed more time.'
          });
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error(`${commandName} error:`, error.message);
        await interaction.editReply(`Error running ${commandName}: ${error.message}`);
      }
}

module.exports = { buildCategoryCommand };
