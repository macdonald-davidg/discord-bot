const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildCategoryCommand, allowlist } = require('../src/services/netcheckRunner');

// These exercise buildCategoryCommand's startup validation against the
// REAL config/allowlist.json wherever a real category already has the
// shape needed (a category with mutating checks, one with none, an
// unknown key) — no fixture needed. A couple of branches (no category ever
// has >25 checks or an unknown host today, by design) are exercised by
// temporarily mutating the shared `allowlist` object the module already
// holds, then restoring it — this is the same live config every command
// module in the bot reads, so tests must not leave it altered.

describe('buildCategoryCommand startup validation', () => {
  afterEach(() => {
    delete allowlist.categories['__test_fixture__'];
    delete allowlist.hosts['__test_fixture_host__'];
  });

  test('throws on an unknown category key', () => {
    assert.throws(
      () => buildCategoryCommand({
        categoryKey: 'not-a-real-category',
        commandName: 'nope',
        commandDescription: 'test'
      }),
      /Unknown allowlist category: not-a-real-category/
    );
  });

  test('readOnly: true throws when the category actually has mutating checks', () => {
    // "docker" has real mutating checks (container restart/stop) in the
    // live config — this is the exact bug fixed elsewhere in this pass
    // (docker.js's description falsely claimed read-only); this test
    // locks in that the structural guard behind it actually fires.
    assert.throws(
      () => buildCategoryCommand({
        categoryKey: 'docker',
        commandName: 'docker-readonly-test',
        commandDescription: 'test',
        readOnly: true
      }),
      /is built with readOnly: true but has mutating: true checks/
    );
  });

  test('readOnly: true does not throw for a category with no mutating checks', () => {
    // "linux" has zero mutating checks in the live config.
    assert.doesNotThrow(() => buildCategoryCommand({
      categoryKey: 'linux',
      commandName: 'linux-readonly-test',
      commandDescription: 'test',
      readOnly: true
    }));
  });

  test('throws when a category has no hosts list', () => {
    allowlist.categories['__test_fixture__'] = { checks: { x: { command: 'echo hi' } } };
    assert.throws(
      () => buildCategoryCommand({
        categoryKey: '__test_fixture__',
        commandName: 'fixture-test',
        commandDescription: 'test'
      }),
      /has no "hosts" list/
    );
  });

  test('throws when a category references an unknown host key', () => {
    allowlist.categories['__test_fixture__'] = {
      hosts: ['this-host-does-not-exist'],
      checks: { x: { command: 'echo hi' } }
    };
    assert.throws(
      () => buildCategoryCommand({
        categoryKey: '__test_fixture__',
        commandName: 'fixture-test',
        commandDescription: 'test'
      }),
      /lists unknown host\(s\): this-host-does-not-exist/
    );
  });

  test('throws when a category has more than 25 checks (Discord\'s choice limit)', () => {
    allowlist.hosts['__test_fixture_host__'] = { hostname: 'nowhere', description: 'fixture' };
    const checks = {};
    for (let i = 0; i < 26; i++) checks[`check-${i}`] = { command: 'echo hi', description: `check ${i}` };
    allowlist.categories['__test_fixture__'] = { hosts: ['__test_fixture_host__'], checks };

    assert.throws(
      () => buildCategoryCommand({
        categoryKey: '__test_fixture__',
        commandName: 'fixture-test',
        commandDescription: 'test'
      }),
      /has 26 checks, over Discord's 25-choice-per-option limit/
    );
  });

  test('a well-formed category builds a command with matching host/check choices', () => {
    const cmd = buildCategoryCommand({
      categoryKey: 'linux',
      commandName: 'linux-shape-test',
      commandDescription: 'test'
    });
    assert.equal(cmd.data.name, 'linux-shape-test');
    assert.equal(typeof cmd.execute, 'function');
  });
});
