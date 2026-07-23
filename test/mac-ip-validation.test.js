const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// unifiController requires UNIFI_CONTROLLER_URL/USERNAME/PASSWORD to be read
// at require-time into module-level consts, but none of that is exercised
// by ensureIp/ensureMac themselves, so no env setup is needed here.
const { ensureIp, ensureMac } = require('../src/services/unifiController');
const { MAC_RE } = require('../src/commands/unifi-block');

describe('ensureIp', () => {
  test('accepts a well-formed IPv4 address', () => {
    assert.doesNotThrow(() => ensureIp('203.0.113.5'));
  });

  test('rejects a hostname', () => {
    assert.throws(() => ensureIp('some-host.example.test'), /Refusing to look up non-IP value/);
  });

  test('rejects a value with a trailing mongo-injection attempt', () => {
    assert.throws(() => ensureIp('192.168.1.1"; db.dropDatabase(); //'), /Refusing to look up non-IP value/);
  });

  test('rejects an empty string', () => {
    assert.throws(() => ensureIp(''), /Refusing to look up non-IP value/);
  });
});

describe('ensureMac', () => {
  test('accepts a well-formed MAC address, case-insensitively', () => {
    assert.doesNotThrow(() => ensureMac('aa:bb:cc:dd:ee:ff'));
    assert.doesNotThrow(() => ensureMac('AA:BB:CC:DD:EE:FF'));
  });

  test('rejects a MAC-shaped string with an injection payload appended', () => {
    assert.throws(() => ensureMac("aa:bb:cc:dd:ee:ff' ; db.dropDatabase(); '"), /Refusing to act on non-MAC value/);
  });

  test('rejects the wrong number of octets', () => {
    assert.throws(() => ensureMac('aa:bb:cc:dd:ee'), /Refusing to act on non-MAC value/);
  });
});

// The /unifi-block command layer re-validates with its own regex before
// ever reaching ensureMac — the audit's "double-validated, non-injectable"
// finding rests on both layers actually agreeing, so pin that down too.
describe('unifi-block command-layer MAC_RE matches the service-layer ensureMac', () => {
  const cases = ['aa:bb:cc:dd:ee:ff', 'AA:BB:CC:DD:EE:FF', 'not-a-mac', 'aa:bb:cc:dd:ee', ''];

  for (const value of cases) {
    test(`agrees on: ${JSON.stringify(value)}`, () => {
      const commandLayerAccepts = MAC_RE.test(value);
      let serviceLayerAccepts = true;
      try { ensureMac(value); } catch { serviceLayerAccepts = false; }
      assert.equal(commandLayerAccepts, serviceLayerAccepts);
    });
  }
});
