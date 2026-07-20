const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { executeRemoteCommand, allowlist } = require('../services/netcheckRunner');

// Fixed, read-only probe — this command has no host/check picker, it sweeps
// every allowlisted host with the same check, so there's nothing to inject
// via user input the way the category commands guard against.
const AUDIT_COMMAND = 'sudo -n true && echo JARVIS_SUDO_OK || echo JARVIS_SUDO_FAIL';

// Per-host wait budget. This is a trivial command (`sudo -n true`) with no
// legitimate reason to take more than a couple seconds on a live host — a
// short cap here means one down/unreachable host doesn't stall the sweep,
// which otherwise runs in parallel across all hosts.
const PER_HOST_TIMEOUT_MS = 10000;

module.exports = {
  cooldown: 30,
  data: new SlashCommandBuilder()
    .setName('jarvis-audit')
    .setDescription('Test passwordless jarvis SSH + sudo across jarvis POSIX hosts (excludes router, Windows)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply();

    // In scope: hosts that log in as the "jarvis" account on a POSIX box
    // with real sudo. Every fleet host now has its own dedicated
    // identity_file (see config/allowlist.json's "SSH key architecture"
    // note in README.md), so identity_file alone no longer distinguishes
    // anything — the real filters are: the router logs in as root (no sudo
    // concept to test), and itunes-vm is Windows (no sudo at all; jarvis's
    // equivalent there is Administrators-group membership, a different
    // check entirely).
    const hosts = Object.entries(allowlist.hosts)
      .filter(([, host]) => host.ssh_user === 'jarvis' && host.platform !== 'windows');

    const results = await Promise.all(hosts.map(async ([hostKey, host]) => {
      try {
        const { status, exitCode, outputText } = await executeRemoteCommand({
          sshUser: host.ssh_user,
          hostname: host.hostname,
          remoteCommand: AUDIT_COMMAND,
          maxWaitMs: PER_HOST_TIMEOUT_MS,
          identityFile: host.identity_file
        });

        // ssh itself failed/timed out (auth, DNS, network) before our
        // command's own echo ever ran — exit code won't be 0 in that case
        // since AUDIT_COMMAND's `... || echo ...` only covers sudo failing,
        // not ssh failing to connect at all.
        if (status !== 'completed' || exitCode !== 0) {
          return { hostKey, host, verdict: 'unreachable', detail: firstLine(outputText) || status };
        }
        if (outputText.includes('JARVIS_SUDO_OK')) {
          return { hostKey, host, verdict: 'ok', detail: null };
        }
        return { hostKey, host, verdict: 'no-sudo', detail: firstLine(outputText) };
      } catch (error) {
        return { hostKey, host, verdict: 'error', detail: error.message };
      }
    }));

    const ICON = { ok: '✅', 'no-sudo': '⚠️', unreachable: '❌', error: '❌' };
    const LABEL = {
      ok: 'OK',
      'no-sudo': 'SSH OK, sudo NOT passwordless',
      unreachable: 'SSH unreachable/failed',
      error: 'Error'
    };

    const lines = results.map(r =>
      `${ICON[r.verdict]} \`${r.hostKey}\` (${r.host.description || r.host.hostname}) — ${LABEL[r.verdict]}${r.detail ? `: ${r.detail}` : ''}`
    );

    const okCount = results.filter(r => r.verdict === 'ok').length;

    const embed = new EmbedBuilder()
      .setColor(okCount === results.length ? 0x00cc66 : 0xff3333)
      .setTitle('jarvis SSH + sudo audit')
      .setDescription(lines.join('\n').slice(0, 4000))
      .addFields({ name: 'Summary', value: `${okCount}/${results.length} hosts OK` })
      .setTimestamp()
      .setFooter({ text: `Requested by ${interaction.user.username}` });

    await interaction.editReply({ embeds: [embed] });
  }
};

function firstLine(text) {
  return (text || '').split('\n')[0].trim();
}
