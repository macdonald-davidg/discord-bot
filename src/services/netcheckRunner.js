const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const allowlistPath = path.join(__dirname, '..', '..', 'config', 'allowlist.json');

// The allowlist is required for every netcheck command to even be defined,
// so a missing/broken file is fatal — but fail with an error that says
// exactly what's wrong and how to fix it, instead of a bare ENOENT stack
// trace from deep inside a require() chain.
let allowlist;
try {
  allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    throw new Error(
      `Missing allowlist config: ${allowlistPath}\n` +
      'Copy config/allowlist.example.json to config/allowlist.json and edit it for your hosts and checks.'
    );
  }
  throw new Error(`Failed to parse ${allowlistPath}: ${err.message}`);
}

const OPEN_TERMINAL_URL = process.env.OPEN_TERMINAL_URL;
const OPEN_TERMINAL_API_KEY = process.env.OPEN_TERMINAL_API_KEY;

// Discord caps slash command choices at 25 per option.
function buildHostChoices(hostKeys) {
  return hostKeys
    .slice(0, 25)
    .map(key => ({ name: `${key} — ${allowlist.hosts[key].description}`.slice(0, 100), value: key }));
}

/**
 * Builds a full Discord slash command (data + execute) scoped to one
 * allowlist category (e.g. "linux", "pihole", "proxmox", "docker").
 * All four category commands share this exact execution path — only the
 * category key, command name, and description differ between them.
 */
function buildCategoryCommand({ categoryKey, commandName, commandDescription, readOnly = false }) {
  const category = allowlist.categories[categoryKey];
  if (!category) {
    throw new Error(`Unknown allowlist category: ${categoryKey}`);
  }

  const { hosts: allowedHostKeys, checks } = category;
  if (!Array.isArray(allowedHostKeys) || allowedHostKeys.length === 0) {
    throw new Error(
      `Category "${categoryKey}" has no "hosts" list in config/allowlist.json — ` +
      'every category must scope itself to the hosts it actually applies to.'
    );
  }
  const unknownHostKeys = allowedHostKeys.filter(key => !allowlist.hosts[key]);
  if (unknownHostKeys.length > 0) {
    throw new Error(`Category "${categoryKey}" lists unknown host(s): ${unknownHostKeys.join(', ')}`);
  }

  const hostChoices = buildHostChoices(allowedHostKeys);

  // Safety net for any category built with readOnly: true. Fails loudly at
  // startup rather than letting a future allowlist edit silently add a
  // mutating command to a category that was reviewed and approved
  // specifically because it couldn't change state. No category currently
  // opts into readOnly — router lost that status once wan-bounce/reboot
  // were added as mutating checks (see src/commands/router.js) — but
  // linux and fileserver have zero mutating checks today and could.
  if (readOnly) {
    const mutatingKeys = Object.entries(checks).filter(([, c]) => c.mutating).map(([k]) => k);
    if (mutatingKeys.length > 0) {
      throw new Error(
        `Category "${categoryKey}" is built with readOnly: true but has mutating: true checks: ${mutatingKeys.join(', ')}. ` +
        'Either remove mutating from those checks or drop readOnly from the command definition.'
      );
    }
  }

  // Discord caps a string option at 25 choices total. Fail loudly at
  // startup rather than silently slicing off the tail of the check list —
  // confirmed 2026-07-22 this isn't hypothetical: "proxmox" briefly hit 31
  // checks while adding on-demand backup support, which would have made
  // the last 6 checks permanently unreachable via the dropdown with no
  // error anywhere. Split into "proxmox" + "proxmox-backup" instead; this
  // guard exists so the next category that grows past 25 breaks the build,
  // not a Discord dropdown silently missing entries.
  const checkKeys = Object.keys(checks);
  if (checkKeys.length > 25) {
    throw new Error(
      `Category "${categoryKey}" has ${checkKeys.length} checks, over Discord's 25-choice-per-option limit. ` +
      'Split it into multiple categories/commands (see proxmox vs proxmox-backup for the pattern) instead of ' +
      'letting choices silently truncate.'
    );
  }

  const checkChoices = checkKeys
    .map(key => ({ name: `${key} — ${checks[key].description}`.slice(0, 100), value: key }));

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

      if (!host || !check || !allowedHostKeys.includes(hostKey)) {
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
      const confirmed = await confirmMutatingAction(interaction, {
        idPrefix: 'netcheck',
        title: `${checkKey} on ${hostKey}`,
        description: `This will run:\n\`\`\`${check.sudo ? 'sudo ' : ''}${check.command}\`\`\`\non **${host.hostname}**.\n\nThis action changes state on that host. Confirm within 15 seconds.`
      });
      if (!confirmed) return;

      return runCheck({ interaction, commandName, hostKey, checkKey, host, check });
    }
  };
}

/**
 * Shared Confirm/Cancel button gate for any mutating action, regardless of
 * whether it runs over SSH (buildCategoryCommand's mutating checks) or some
 * other transport (e.g. /poe's UniFi controller API calls). Replies to the
 * interaction itself with the warning embed/buttons; on confirm, edits that
 * same reply to "Running" and returns true so the caller can do the actual
 * work and finish with its own interaction.editReply. On cancel/timeout, it
 * finishes the interaction itself and returns false — the caller does nothing
 * further.
 */
async function confirmMutatingAction(interaction, { idPrefix, title, description }) {
  const confirmId = `${idPrefix}-confirm-${interaction.id}`;
  const cancelId = `${idPrefix}-cancel-${interaction.id}`;

  const warnEmbed = new EmbedBuilder()
    .setColor(0xff3333)
    .setTitle(`⚠️ Confirm: ${title}`)
    .setDescription(description)
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
    await interaction.editReply({
      embeds: [warnEmbed.setColor(0x888888).setTitle(`Timed out: ${title}`)],
      components: []
    });
    return false;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({
      embeds: [warnEmbed.setColor(0x888888).setTitle(`Cancelled: ${title}`)],
      components: []
    });
    return false;
  }

  await buttonInteraction.update({
    embeds: [warnEmbed.setColor(0xffaa00).setTitle(`Running: ${title}`)],
    components: []
  });
  return true;
}

/**
 * Runs a single command on a remote host via open-terminal (SSH under the
 * hood) and polls until completion or timeout. This is the shared execution
 * primitive behind both the per-check category commands (buildCategoryCommand
 * below) and any command that needs to SSH out without the host/check
 * allowlist dropdown flow, e.g. /jarvis-audit, which sweeps every host with
 * a fixed command rather than letting the user pick one check.
 *
 * Returns { status, exitCode, outputText } rather than touching Discord at
 * all, so callers control their own embeds/formatting.
 */
async function executeRemoteCommand({ sshUser, hostname, remoteCommand, maxWaitMs = 25000, identityFile }) {
  // Properly escape any single quotes within remoteCommand using the
  // standard POSIX technique ('->'\'') before wrapping in outer single
  // quotes. Without this, a literal single quote inside remoteCommand
  // (extremely common in PowerShell string literals, e.g. 'Running')
  // would prematurely close our quoting and get silently stripped
  // rather than erroring loudly — exactly the bug this fixes.
  const escapedRemoteCommand = remoteCommand.replace(/'/g, `'\\''`);
  // ConnectTimeout keeps a down/unreachable host from hanging the caller for
  // the platform's default TCP timeout — matters most for /jarvis-audit,
  // which sweeps hosts that may not all be up.
  //
  // Every host in config/allowlist.json sets identity_file to its own
  // dedicated, single-host-scoped key (see README.md's "SSH key
  // architecture") — open-terminal holds no shared/fleet-wide key at all,
  // so a leak of one host's key doesn't expose any other host.
  // IdentitiesOnly=yes stops ssh from also trying any other identity it
  // might otherwise pick up from its own ~/.ssh/config, keeping auth
  // deterministic. identityFile is technically optional in this function's
  // signature (falls back to ssh's own default identity resolution when
  // omitted) in case a host is ever added without one.
  const identityOpts = identityFile ? `-i ${identityFile} -o IdentitiesOnly=yes ` : '';
  const sshCommand = `ssh -T -o BatchMode=yes -o ConnectTimeout=8 ${identityOpts}-l ${sshUser} ${hostname} '${escapedRemoteCommand}'`;

  const headers = {
    Authorization: `Bearer ${OPEN_TERMINAL_API_KEY}`,
    'Content-Type': 'application/json'
  };

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

  return { status, exitCode, outputText };
}

async function runCheck({ interaction, commandName, hostKey, checkKey, host, check }) {
      const remoteCommand = check.sudo ? `sudo ${check.command}` : check.command;

      try {
        const { status, exitCode, outputText } = await executeRemoteCommand({
          sshUser: host.ssh_user,
          hostname: host.hostname,
          remoteCommand,
          identityFile: host.identity_file
        });

        const embed = new EmbedBuilder()
          // open-terminal's actual terminal-success status is "done", not
          // "completed" — confirmed 2026-07-22 against real API responses.
          // Every check run through this path before that fix rendered its
          // embed orange (warning) even on full success; this was purely
          // cosmetic (the output itself was always displayed correctly).
          .setColor(status === 'done' && exitCode === 0 ? 0x00cc66 : 0xff9900)
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

module.exports = { buildCategoryCommand, executeRemoteCommand, confirmMutatingAction, allowlist };
