const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { confirmMutatingAction } = require('../src/services/netcheckRunner');

// confirmMutatingAction is the single gate every mutating check (fleet
// restarts, router reboot, UniFi block) goes through. Two properties
// matter most: a click from someone other than the requester must never
// count, and confirm/cancel/timeout must each resolve correctly. Uses a
// minimal fake interaction rather than a real discord.js client.
//
// confirmMutatingAction awaits interaction.reply(...) before it ever calls
// awaitMessageComponent, so helpers below wait on `ready` (resolved the
// instant awaitMessageComponent is actually invoked) before simulating a
// click/timeout — otherwise resolveAwait/rejectAwait wouldn't exist yet.

function makeFakeInteraction({ requesterId = 'requester-1', interactionId = 'interaction-1' } = {}) {
  const editReplyCalls = [];
  let capturedAwaitOptions = null;
  let resolveAwait, rejectAwait, readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  const promptMessage = {
    awaitMessageComponent: (opts) => {
      capturedAwaitOptions = opts;
      readyResolve();
      return new Promise((resolve, reject) => {
        resolveAwait = resolve;
        rejectAwait = reject;
      });
    }
  };

  const interaction = {
    id: interactionId,
    user: { id: requesterId, username: 'requester' },
    reply: async () => promptMessage,
    editReply: async (payload) => { editReplyCalls.push(payload); }
  };

  function makeButtonInteraction(customId, clickerId) {
    const buttonInteraction = {
      customId,
      user: { id: clickerId },
      update: async (payload) => { buttonInteraction.updatePayload = payload; }
    };
    return buttonInteraction;
  }

  return {
    interaction, editReplyCalls,
    getFilter: async () => { await ready; return capturedAwaitOptions.filter; },
    clickAs: async (customId, clickerId) => { await ready; resolveAwait(makeButtonInteraction(customId, clickerId)); },
    timeOut: async () => { await ready; rejectAwait(new Error('time')); }
  };
}

describe('confirmMutatingAction', () => {
  test('confirm click by the requester resolves true', async () => {
    const h = makeFakeInteraction();
    const promise = confirmMutatingAction(h.interaction, { idPrefix: 'netcheck', title: 't', description: 'd' });
    const confirmId = `netcheck-confirm-${h.interaction.id}`;
    await h.clickAs(confirmId, h.interaction.user.id);
    const result = await promise;
    assert.equal(result, true);
  });

  test('cancel click resolves false', async () => {
    const h = makeFakeInteraction();
    const promise = confirmMutatingAction(h.interaction, { idPrefix: 'netcheck', title: 't', description: 'd' });
    const cancelId = `netcheck-cancel-${h.interaction.id}`;
    await h.clickAs(cancelId, h.interaction.user.id);
    const result = await promise;
    assert.equal(result, false);
  });

  test('timeout with no click resolves false and edits the original reply', async () => {
    const h = makeFakeInteraction();
    const promise = confirmMutatingAction(h.interaction, { idPrefix: 'netcheck', title: 't', description: 'd' });
    await h.timeOut();
    const result = await promise;
    assert.equal(result, false);
    assert.equal(h.editReplyCalls.length, 1);
  });

  test('the awaitMessageComponent filter rejects a click from a different user, even with the right customId', async () => {
    const h = makeFakeInteraction({ requesterId: 'requester-1' });
    const promise = confirmMutatingAction(h.interaction, { idPrefix: 'netcheck', title: 't', description: 'd' });
    const filter = await h.getFilter();
    const confirmId = `netcheck-confirm-${h.interaction.id}`;

    assert.equal(filter({ user: { id: 'someone-else' }, customId: confirmId }), false);
    assert.equal(filter({ user: { id: 'requester-1' }, customId: confirmId }), true);
    assert.equal(filter({ user: { id: 'requester-1' }, customId: 'unrelated-button-id' }), false);

    await h.timeOut();
    await promise;
  });

  test('confirm/cancel ids are scoped to this interaction, not reused across a different one', async () => {
    const h1 = makeFakeInteraction({ interactionId: 'interaction-A' });
    const p1 = confirmMutatingAction(h1.interaction, { idPrefix: 'netcheck', title: 't', description: 'd' });
    const filter1 = await h1.getFilter();

    // a confirm button id minted for a DIFFERENT interaction must not pass this one's filter
    assert.equal(filter1({ user: { id: h1.interaction.user.id }, customId: 'netcheck-confirm-interaction-B' }), false);

    await h1.timeOut();
    await p1;
  });
});
