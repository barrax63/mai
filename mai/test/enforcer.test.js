/**
 * The enforcement tick's row loop: which rows it picks up, which it drops, and
 * what happens to one it cannot get through.
 *
 * Three properties that are invisible from a single row:
 *
 *   - the due query is oldest-first *and* capped, so any row that is kept but
 *     never resolved occupies the cap forever. A paused guild produces exactly
 *     that, which is why its rows are excluded from the query rather than
 *     skipped inside the loop.
 *   - an exemption covers the threads of the exempted channel, which is only
 *     knowable from the channel object, not from the row.
 *   - a row that throws has to count as a failed attempt, or it retries every
 *     tick forever without ever reaching the give-up threshold.
 */
import './setup-enforcer.js';
import { openTestDatabase, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueue, findRow, remove } from '../src/db/queue.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { clearOwnDeletions } from '../src/moderation/cleanup.js';
import { runTick } from '../src/moderation/enforcer.js';

await openTestDatabase();

const CHANNEL = '940000000000000001';
const PARENT = '940000000000000002';
const THREAD = '940000000000000003';

// Timeouts are not what these tests are about, and switching escalation off
// keeps the fake client down to the calls the row loop actually makes.
updateSettings(TEST_GUILD, { escalation: false });
updateSettings(OTHER_GUILD, { escalation: false });

/**
 * @param {{ parents?: Record<string, string>, onFetchMessage?: (id: string) => object }} [options]
 *   `parents` maps a channel id to its parent, which is how a thread is
 *   represented; `onFetchMessage` replaces the message object for one id.
 */
function fakeClient({ parents = {}, onFetchMessage } = {}) {
  const record = { deleted: [], dms: [] };

  const message = (channelId, messageId) => ({
    id: messageId,
    cleanContent: 'text',
    content: 'text',
    attachments: { size: 0 },
    createdAt: new Date(),
    delete: async () => record.deleted.push({ channelId, messageId }),
  });

  const client = {
    user: { id: '940000000000000009' },
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        parentId: parents[channelId] ?? null,
        isTextBased: () => true,
        send: async () => {},
        messages: {
          fetch: async (messageId) =>
            (onFetchMessage?.(messageId) ?? message(channelId, messageId)),
          delete: async (messageId) => record.deleted.push({ channelId, messageId }),
        },
      }),
    },
    users: {
      fetch: async (userId) => ({
        send: async (payload) => record.dms.push({ userId, ...payload }),
      }),
    },
  };

  return { client, record };
}

const seed = (messageId, { guildId = TEST_GUILD, channelId = CHANNEL, dueAt } = {}) =>
  enqueue({
    messageId,
    guildId,
    channelId,
    userId: TEST_USER,
    categories: ['harassment'],
    warnedAt: new Date(Date.now() - 900_000).toISOString(),
    dueAt: dueAt ?? new Date(Date.now() - 60_000).toISOString(),
    scoldMessageId: null,
  });

test('a paused guild does not occupy the tick cap and starve the others', async () => {
  clearOwnDeletions();
  // Older than the active guild's row, and more of them than the cap (2), so an
  // unfiltered oldest-first query would return nothing else.
  const pausedRows = ['950000000000000001', '950000000000000002', '950000000000000003'];
  const activeRow = '950000000000000004';

  updateSettings(OTHER_GUILD, { enabled: false });
  try {
    pausedRows.forEach((messageId, index) =>
      seed(messageId, {
        guildId: OTHER_GUILD,
        dueAt: new Date(Date.now() - 600_000 + index).toISOString(),
      }),
    );
    seed(activeRow, { dueAt: new Date(Date.now() - 60_000).toISOString() });

    const { client, record } = fakeClient();
    await runTick(client);

    assert.deepEqual(
      record.deleted,
      [{ channelId: CHANNEL, messageId: activeRow }],
      'the active guild is reached despite three older paused rows',
    );
    assert.equal(findRow(activeRow), null, 'and its row is resolved');
    for (const messageId of pausedRows) {
      assert.ok(findRow(messageId), `paused row ${messageId} is kept, not enforced`);
    }
  } finally {
    updateSettings(OTHER_GUILD, { enabled: true });
    // Otherwise the next tick in this file would enforce them.
    pausedRows.forEach(remove);
  }
});

test('a thread whose parent was exempted after the flag is dropped, not enforced', async () => {
  clearOwnDeletions();
  updateSettings(TEST_GUILD, { 'exempt-channels': PARENT });

  try {
    const messageId = '950000000000000005';
    seed(messageId, { channelId: THREAD });

    const { client, record } = fakeClient({ parents: { [THREAD]: PARENT } });
    await runTick(client);

    assert.equal(record.deleted.length, 0, 'nothing is deleted in an exempt scope');
    assert.equal(findRow(messageId), null, 'the row is dropped rather than kept pending');
  } finally {
    resetSettings(TEST_GUILD, 'exempt-channels');
  }
});

test('a directly exempted channel still drops its rows', async () => {
  clearOwnDeletions();
  updateSettings(TEST_GUILD, { 'exempt-channels': CHANNEL });

  try {
    const messageId = '950000000000000006';
    seed(messageId);

    const { client, record } = fakeClient();
    await runTick(client);

    assert.equal(record.deleted.length, 0);
    assert.equal(findRow(messageId), null);
  } finally {
    resetSettings(TEST_GUILD, 'exempt-channels');
  }
});

test('a row that throws counts as a failed attempt and is eventually given up on', async () => {
  clearOwnDeletions();
  const messageId = '950000000000000007';
  seed(messageId);

  // Something unexpected inside the row's own work, rather than a Discord
  // lookup failure (which reports itself). Reading the message throws.
  const { client, record } = fakeClient({
    onFetchMessage: (id) => ({
      id,
      cleanContent: 'text',
      get attachments() {
        throw new Error('boom');
      },
      delete: async () => {},
    }),
  });

  await runTick(client);
  assert.equal(findRow(messageId)?.attempts, 1, 'the throw was counted');

  // GIVE_UP_AFTER_ATTEMPTS is 60; the row must not retry past it forever.
  for (let tick = 0; tick < 60 && findRow(messageId); tick++) {
    await runTick(client);
  }

  assert.equal(findRow(messageId), null, 'Mai stops trying instead of looping forever');
  assert.equal(record.deleted.length, 0, 'and never deleted anything on the way');
});
