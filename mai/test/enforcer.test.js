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
import { bumpAttempts, enqueue, findRow, remove } from '../src/db/queue.js';
import { content } from '../src/content.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { historyFor } from '../src/db/violations.js';
import { explainError } from '../src/errors.js';
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
    // Distinguishable, so a DM quoting the wrong guild's messages is visible.
    cleanContent: `text of ${messageId}`,
    content: `text of ${messageId}`,
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

test('re-flagging a message does not forget how often it has already failed', () => {
  const messageId = '950000000000000020';

  // Cleaned up even when an assertion throws: the row is seeded overdue, and
  // the per-tick cap here is 2, so one left behind would be enforced by the
  // next test's runTick and fail it for reasons of its own.
  try {
    seed(messageId);
    bumpAttempts(messageId);
    bumpAttempts(messageId);
    assert.equal(findRow(messageId).attempts, 2);

    // Re-classification of the same message upserts the row. INSERT OR REPLACE
    // is a delete plus an insert, which silently reset this counter, so a
    // permanently stuck row could never reach the give-up threshold.
    seed(messageId, { channelId: '940000000000000200' });

    const row = findRow(messageId);
    assert.equal(row.attempts, 2, 'the attempt count survives');
    assert.equal(row.channelId, '940000000000000200', 'while the rest of the row is updated');
  } finally {
    remove(messageId);
  }
});

test('a member enforced in two guilds gets one DM per guild, not one merged one', async () => {
  clearOwnDeletions();
  const here = '950000000000000010';
  const there = '950000000000000011';

  // Both guilds can receive appeals, so each DM carries its own appeal button.
  updateSettings(TEST_GUILD, { 'log-channel': '940000000000000100' });
  updateSettings(OTHER_GUILD, { 'log-channel': '940000000000000101' });

  try {
    seed(here, { guildId: TEST_GUILD });
    seed(there, { guildId: OTHER_GUILD });

    const { client, record } = fakeClient();
    await runTick(client);

    assert.equal(record.deleted.length, 2, 'both messages enforced');
    assert.equal(record.dms.length, 2, 'one warning per guild');

    const forHere = record.dms.find((dm) => dm.content.includes(here));
    const forThere = record.dms.find((dm) => dm.content.includes(there));
    assert.ok(forHere && forThere, 'each guild is warned about its own message');

    // The decisive part: neither DM may quote the other guild's message.
    assert.equal(forHere.content.includes(there), false);
    assert.equal(forThere.content.includes(here), false);

    // And each appeal button names its own guild, so granting it overturns the
    // strikes of that incident rather than the other guild's.
    const appealId = (dm) => dm.components?.[0]?.components?.[0]?.custom_id ?? '';
    assert.ok(appealId(forHere).startsWith(`appeal:${TEST_GUILD}:`), appealId(forHere));
    assert.ok(appealId(forThere).startsWith(`appeal:${OTHER_GUILD}:`), appealId(forThere));
  } finally {
    resetSettings(TEST_GUILD, 'log-channel');
    resetSettings(OTHER_GUILD, 'log-channel');
  }
});

test('a paused guild that also left the allowlist still has its rows dropped', async () => {
  clearOwnDeletions();
  const messageId = '950000000000000030';

  // Both at once. The allowlist check runs before the pause check, so these
  // rows must still reach processRow: excluding every paused guild from the
  // due query would strand them in the database for good.
  const stranger = '333333333333333333';
  updateSettings(stranger, { enabled: false });

  try {
    seed(messageId, { guildId: stranger });

    const { client, record } = fakeClient();
    await runTick(client);

    assert.equal(findRow(messageId), null, 'dropped, because the guild is no longer allowlisted');
    assert.equal(record.deleted.length, 0, 'and nothing was enforced in it on the way out');
  } finally {
    remove(messageId);
  }
});

test('a channel that holds no messages is a failure, not a self-deletion', async () => {
  clearOwnDeletions();
  const messageId = '950000000000000031';

  try {
    seed(messageId);

    // Resolves, but is a category or a voice channel: no `messages` on it.
    const { client, record } = fakeClient();
    client.channels.fetch = async (channelId) => ({ id: channelId, parentId: null });

    await runTick(client);

    const row = findRow(messageId);
    assert.ok(row, 'the row is kept for the next tick');
    assert.equal(row.attempts, 1, 'counted as an attempt, so it can give up eventually');
    assert.equal(record.deleted.length, 0);

    // The decisive part: recording this as the author having deleted their own
    // message would quietly downgrade a strike.
    const recorded = historyFor(TEST_GUILD, TEST_USER, 50)
      .filter((entry) => entry.messageId === messageId);
    assert.deepEqual(recorded, [], 'nothing goes on the record');

    // This code is one Mai mints herself rather than one Discord sent, so the
    // log-channel map has to know it. Unmapped, staff would read
    // "Error code=not_text_channel", which is the unreadable output the map
    // exists to prevent: any new internal code needs a line in the YAML.
    const explained = explainError(Object.assign(new Error('x'), { code: 'not_text_channel' }));
    assert.ok(
      explained.includes(content.moderation.errors.not_text_channel),
      `internal error code is not explained in the content config: ${explained}`,
    );
  } finally {
    remove(messageId);
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
