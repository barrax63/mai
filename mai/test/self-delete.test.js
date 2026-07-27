/**
 * Reacting to a deletion instead of waiting for the deadline.
 *
 * The enforcer already handled "the author removed it", but only when the
 * grace period expired, so someone who fixed their mistake in ten seconds still
 * saw a scold reply under a message that no longer existed, and nothing in the
 * log, for up to the whole grace period.
 *
 * The hard part is that `messageDelete` does not say who did it: Mai's own
 * enforcement fires the same event, and must not be recorded as the author
 * having fixed it.
 */
import './setup-moderation.js';
import { openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { enqueue, findRow } from '../src/db/queue.js';
import { historyFor, strikeCount } from '../src/db/violations.js';
import { updateSettings } from '../src/db/settings.js';
import { onMessageDelete } from '../src/gateway/events/message-delete.js';
import { clearOwnDeletions, markOwnDeletion } from '../src/moderation/cleanup.js';

await openTestDatabase();

const CHANNEL = '910000000000000001';
const LOG_CHANNEL = '910000000000000002';
const SCOLD = '910000000000000003';

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

function fakeClient() {
  const record = { posted: [], deleted: [] };
  const client = {
    user: { id: '920000000000000001' },
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => record.posted.push({ channelId: id, ...payload }),
        messages: {
          delete: async (messageId) => record.deleted.push({ channelId: id, messageId }),
        },
      }),
    },
  };
  return { client, record };
}

const deletedMessage = (id, client) => ({ id, client });

function seed(messageId, { guildId = TEST_GUILD } = {}) {
  enqueue({
    messageId,
    guildId,
    channelId: CHANNEL,
    userId: TEST_USER,
    categories: ['harassment'],
    warnedAt: new Date().toISOString(),
    // Deliberately far in the future: the whole point is not waiting for it.
    dueAt: new Date(Date.now() + 600_000).toISOString(),
    scoldMessageId: SCOLD,
  });
}

test('deleting a flagged message resolves it at once', async () => {
  const messageId = '930000000000000001';
  seed(messageId);
  clearOwnDeletions();

  const { client, record } = fakeClient();
  await onMessageDelete(deletedMessage(messageId, client));

  assert.equal(findRow(messageId), null, 'the queue row is gone immediately');
  assert.deepEqual(
    record.deleted,
    [{ channelId: CHANNEL, messageId: SCOLD }],
    'the orphaned scold reply goes with it',
  );

  const entry = record.posted.at(-1);
  assert.equal(entry.channelId, LOG_CHANNEL);
  assert.equal(entry.embeds[0].title, content.moderation.log.titles.selfDeleted);

  const recorded = historyFor(TEST_GUILD, TEST_USER, 20).filter((row) => row.messageId === messageId);
  assert.equal(recorded[0].action, 'self_deleted');
});

test('a self-deletion during the grace period is still not a strike', async () => {
  const messageId = '930000000000000002';
  seed(messageId);
  clearOwnDeletions();

  const before = strikeCount(TEST_GUILD, TEST_USER, '1970-01-01T00:00:00.000Z');
  const { client } = fakeClient();
  await onMessageDelete(deletedMessage(messageId, client));

  assert.equal(strikeCount(TEST_GUILD, TEST_USER, '1970-01-01T00:00:00.000Z'), before);
});

test("Mai's own enforcement is never recorded as the author fixing it", async () => {
  const messageId = '930000000000000003';
  seed(messageId);
  clearOwnDeletions();

  // What the enforcer does just before calling message.delete().
  markOwnDeletion(messageId);

  const { client, record } = fakeClient();
  await onMessageDelete(deletedMessage(messageId, client));

  assert.ok(findRow(messageId), 'the row stays for the enforcer to finish with');
  assert.equal(record.posted.length, 0, 'no self-deleted entry');
  assert.equal(record.deleted.length, 0);
});

test('a deletion of something Mai never flagged is ignored', async () => {
  clearOwnDeletions();
  const { client, record } = fakeClient();

  await onMessageDelete(deletedMessage('930000000000000009', client));
  await onMessageDelete({ client });

  assert.equal(record.posted.length, 0);
});

test('a paused guild keeps its rows: pausing is not an amnesty', async () => {
  const messageId = '930000000000000004';
  seed(messageId);
  clearOwnDeletions();
  updateSettings(TEST_GUILD, { enabled: false });

  const { client, record } = fakeClient();
  try {
    await onMessageDelete(deletedMessage(messageId, client));
    assert.ok(findRow(messageId), 'the row waits for Mai to be switched back on');
    assert.equal(record.posted.length, 0);
  } finally {
    updateSettings(TEST_GUILD, { enabled: true });
  }
});
