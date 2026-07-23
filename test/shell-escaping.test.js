const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { executeRemoteCommand } = require('../src/services/netcheckRunner');

// executeRemoteCommand builds a real `ssh ... '<command>'` string and hands
// it to open-terminal over HTTP. A single unescaped quote in remoteCommand
// would prematurely close that quoting; this is the one place free-form
// text (a check's own command string, sometimes containing PowerShell
// literals) flows into a shell invocation, so it's worth pinning down
// exactly what gets sent — without making a real network call.

describe('executeRemoteCommand shell quoting', () => {
  let capturedCommand;
  let originalPost;

  beforeEach(() => {
    capturedCommand = null;
    originalPost = axios.post;
    axios.post = async (url, body) => {
      capturedCommand = body.command;
      return { data: { id: 'test-id', status: 'done', exit_code: 0, output: [], next_offset: 0 } };
    };
  });

  afterEach(() => {
    axios.post = originalPost;
  });

  async function captureFor(remoteCommand) {
    await executeRemoteCommand({
      sshUser: 'testuser',
      hostname: 'example-host.test',
      remoteCommand
    });
    return capturedCommand;
  }

  test('a command with no quotes passes through unescaped inside the outer quotes', async () => {
    const cmd = await captureFor('systemctl status nginx');
    assert.equal(cmd, "ssh -T -o BatchMode=yes -o ConnectTimeout=8 -l testuser example-host.test 'systemctl status nginx'");
  });

  test('a single embedded quote is escaped with the close-escape-reopen sequence', async () => {
    const cmd = await captureFor("echo 'Running'");
    // The literal quote inside remoteCommand must become '\'' — closing the
    // outer quote, an escaped literal quote, then reopening — never a bare
    // quote that would terminate the outer quoting early.
    assert.equal(cmd, `ssh -T -o BatchMode=yes -o ConnectTimeout=8 -l testuser example-host.test 'echo '\\''Running'\\'''`);
  });

  test('multiple embedded quotes are each escaped independently', async () => {
    const cmd = await captureFor("echo 'a' 'b'");
    const occurrences = (cmd.match(/'\\''/g) || []).length;
    assert.equal(occurrences, 4, `expected 4 escaped-quote sequences, got: ${cmd}`);
  });

  test('an identity file adds -i and -o IdentitiesOnly=yes ahead of the user/host', async () => {
    capturedCommand = null;
    await executeRemoteCommand({
      sshUser: 'testuser',
      hostname: 'example-host.test',
      remoteCommand: 'echo hi',
      identityFile: '/home/testuser/.ssh/fixture_ed25519'
    });
    assert.equal(
      capturedCommand,
      "ssh -T -o BatchMode=yes -o ConnectTimeout=8 -i /home/testuser/.ssh/fixture_ed25519 -o IdentitiesOnly=yes -l testuser example-host.test 'echo hi'"
    );
  });

  test('resolves with the mocked status/exitCode/output on a normal completion', async () => {
    axios.post = async () => ({
      data: { id: 'x', status: 'done', exit_code: 0, output: ['line one', 'line two'], next_offset: 2 }
    });
    const result = await executeRemoteCommand({
      sshUser: 'testuser',
      hostname: 'example-host.test',
      remoteCommand: 'echo hi'
    });
    assert.equal(result.status, 'done');
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputText, 'line one\nline two');
  });
});
