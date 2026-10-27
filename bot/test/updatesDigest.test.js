import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextSlot, startUpdatesDigest } from '../src/updatesDigest.js';

const H = 3600_000;

test('digest slots are Tashkent hours, not server UTC hours', () => {
  // 02:30 UTC = 07:30 Tashkent -> next slot 08:00 Tashkent = 03:00 UTC
  assert.equal(msUntilNextSlot(new Date('2026-10-27T02:30:00Z')), 0.5 * H);
  // 15:00 UTC = 20:00 Tashkent exactly -> that slot is now, next is 08:00 Tashkent = 03:00 UTC tomorrow
  assert.equal(msUntilNextSlot(new Date('2026-10-27T15:00:00Z')), 12 * H);
  // 20:00 UTC = 01:00 Tashkent: no overnight slot, next is 03:00 UTC
  assert.equal(msUntilNextSlot(new Date('2026-10-27T20:00:00Z')), 7 * H);
});

function harness(stats) {
  const sent = [];
  const digest = startUpdatesDigest({
    bot: { telegram: { sendMessage: async (id, text) => { sent.push({ id, text }); } } },
    apiClient: { getStats: async () => stats },
    tokens: { getIdToken: async () => 'tok' },
    store: { listAllTelegramUserIds: async () => [1, 2], getLanguage: async () => 'en' },
    config: { broadcastLang: 'en', broadcastSpacingMs: 0 },
    log: { warn() {} },
  });
  return { digest, sent };
}

test('digest is not sent while the board is empty', async () => {
  const { digest, sent } = harness({ loads: 0, trucks: 0 });
  await digest._sendOnce();
  assert.equal(sent.length, 0);
});

test('digest goes to everyone when there is something on the board', async () => {
  const { digest, sent } = harness({ loads: 3, trucks: 0 });
  await digest._sendOnce();
  assert.deepEqual(sent.map((m) => m.id), [1, 2]);
});
