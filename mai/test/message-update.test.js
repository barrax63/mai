/**
 * Moderation of edited messages: the hole the edit button used to be.
 *
 * Covers both directions — a harmless message edited into a violation, and a
 * flagged message edited back into something harmless — plus the update events
 * that are not edits at all and must never reach the classifier.
 */
import './setup-moderation.js';
import { openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { depth, enqueue, findRow } from '../src/db/queue.js';
import { updateSettings } from '../src/db/settings.js';
import { historyFor, strikeCount } from '../src/db/violations.js';
import { onMessageUpdate } from '../src/gateway/events/message-update.js';
import { recheckMessage } from '../src/moderation/check.js';

await openTestDatabase();

const CHANNEL = '820000000000000001';
const LOG_CHANNEL = '820000000000000002';
const BOT = '830000000000000001';

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

/** Minimal stand-in for the discord.js Collection of attachments. */
const attachments = (items = []) => ({
  size: items.length,
  map: (fn) => items.map(fn),
});

/**
 * A fake gateway client that records everything Mai does through Discord.
 */
function fakeClient() {
  const record = { posted: [], deleted: [], reactionRoutes: [] };

  const client = {
    user: { id: BOT },
    rest: {
      delete: async (route) => {
        record.reactionRoutes.push(route);
      },
    },
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => {
          record.posted.push(payload);
          return { id: 'log-message' };
        },
        messages: {
          delete: async (messageId) => {
            record.deleted.push({ channelId: id, messageId });
          },
        },
      }),
    },
  };

  return { client, record };
}

/**
 * @param {object} options
 */
function fakeMessage({
  id = '810000000000000001',
  text = 'harmlos',
  files = [],
  editedTimestamp = 1_700_000_000_000,
  partial = false,
  bot = false,
  guildId = TEST_GUILD,
  cachedReaction = false,
} = {}) {
  const { client, record } = fakeClient();
  record.reacted = [];
  record.replies = [];
  record.reactionsRemoved = [];

  const message = {
    id,
    guildId,
    channelId: CHANNEL,
    client,
    partial,
    system: false,
    editedTimestamp,
    author: { id: TEST_USER, bot },
    content: text,
    attachments: attachments(files),
    reactions: {
      cache: {
        get: (emoji) =>
          cachedReaction && emoji === content.moderation.warningEmoji
            ? { users: { remove: async (userId) => record.reactionsRemoved.push(userId) } }
            : undefined,
      },
    },
    react: async (emoji) => record.reacted.push(emoji),
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'scold-message' };
    },
    fetch: async () => message,
  };

  return { message, record };
}

/** Stubs the moderation endpoint with a fixed verdict. */
function stubVerdict({ flagged, categories = [] }) {
  const calls = [];
  const restore = stubFetch((url, options) => {
    calls.push({ url, body: JSON.parse(options.body ?? '{}') });
    return new Response(
      JSON.stringify({
        results: [
          {
            flagged,
            categories: Object.fromEntries(categories.map((name) => [name, true])),
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { calls, restore };
}

/**
 * Seeds a pending queue row, as if the message had been flagged on creation.
 */
function seedFlagged(messageId, { categories = ['harassment'], dueAt } = {}) {
  const due = dueAt ?? new Date(Date.now() + 600_000).toISOString();
  enqueue({
    messageId,
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    userId: TEST_USER,
    categories,
    warnedAt: new Date(Date.now() - 60_000).toISOString(),
    dueAt: due,
    scoldMessageId: 'scold-message',
  });
  return due;
}

test('a harmless message edited into a violation is flagged like a new one', async () => {
  const { message, record } = fakeMessage({ id: '810000000000000010', text: 'du wicht' });
  const { calls, restore } = stubVerdict({ flagged: true, categories: ['harassment'] });

  let verdict;
  try {
    verdict = await recheckMessage(message);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1, 'the edit was classified');
  assert.equal(verdict.action, 'flagged');

  const row = findRow('810000000000000010');
  assert.ok(row, 'the edit is queued for enforcement');
  assert.deepEqual(row.categories, ['harassment']);
  assert.deepEqual(record.reacted, [content.moderation.warningEmoji]);
  assert.equal(record.replies.length, 1, 'the author is scolded');
  assert.deepEqual(record.replies[0].allowedMentions, { parse: [], repliedUser: true });
});

test('a flagged message edited clean loses reaction, scold reply and queue row', async () => {
  const messageId = '810000000000000011';
  seedFlagged(messageId);

  const { message, record } = fakeMessage({ id: messageId, text: 'sorry, das war doof' });
  const { restore } = stubVerdict({ flagged: false });

  let verdict;
  try {
    verdict = await recheckMessage(message);
  } finally {
    restore();
  }

  assert.equal(verdict.action, 'cleared');
  assert.equal(findRow(messageId), null, 'the queue row is gone');

  // No cached reaction on this message, so the removal takes the REST route —
  // and it targets Mai's own reaction only.
  assert.equal(record.reactionRoutes.length, 1);
  assert.match(record.reactionRoutes[0], /\/@me$/);
  assert.match(
    record.reactionRoutes[0],
    new RegExp(`/messages/${messageId}/reactions/${encodeURIComponent(content.moderation.warningEmoji)}/`),
  );

  assert.deepEqual(record.deleted, [{ channelId: CHANNEL, messageId: 'scold-message' }]);

  const entries = historyFor(TEST_GUILD, TEST_USER, 10).filter(
    (entry) => entry.messageId === messageId,
  );
  assert.equal(entries.length, 1, 'the correction is on the record');
  assert.equal(entries[0].action, 'edited');
  assert.equal(
    strikeCount(TEST_GUILD, TEST_USER, '1970-01-01T00:00:00.000Z'),
    0,
    'a correction during the grace period is deliberately not a strike',
  );

  const embed = record.posted.at(-1)?.embeds?.[0];
  assert.equal(embed?.title, content.moderation.log.titles.cleared);
});

test('a cached warning reaction is removed through discord.js, not the REST fallback', async () => {
  const messageId = '810000000000000012';
  seedFlagged(messageId);

  const { message, record } = fakeMessage({
    id: messageId,
    text: 'alles gut jetzt',
    cachedReaction: true,
  });
  const { restore } = stubVerdict({ flagged: false });

  try {
    await recheckMessage(message);
  } finally {
    restore();
  }

  assert.deepEqual(record.reactionsRemoved, [BOT]);
  assert.equal(record.reactionRoutes.length, 0);
});

test('editing one violation into another keeps the original deadline', async () => {
  const messageId = '810000000000000013';
  const dueAt = seedFlagged(messageId, { categories: ['harassment'] });

  const { message, record } = fakeMessage({ id: messageId, text: 'anderer mist' });
  const { restore } = stubVerdict({ flagged: true, categories: ['hate'] });

  let verdict;
  try {
    verdict = await recheckMessage(message);
  } finally {
    restore();
  }

  const row = findRow(messageId);
  assert.equal(verdict.action, 'flagged');
  assert.equal(row.dueAt, dueAt, 'editing does not buy a fresh grace period');
  assert.deepEqual(row.categories, ['hate'], 'the categories are refreshed');
  assert.equal(record.replies.length, 0, 'an already-scolded message is not scolded twice');
  assert.equal(record.reacted.length, 0);
});

test('an edit stripped down to nothing clears a pending flag', async () => {
  const messageId = '810000000000000014';
  seedFlagged(messageId);

  const { message } = fakeMessage({ id: messageId, text: '   ' });
  const { calls, restore } = stubVerdict({ flagged: false });

  let verdict;
  try {
    verdict = await recheckMessage(message);
  } finally {
    restore();
  }

  assert.equal(calls.length, 0, 'there is nothing left to classify');
  assert.equal(verdict.action, 'cleared');
  assert.equal(findRow(messageId), null);
});

test('a failed classification keeps a queued row instead of forgiving it', async () => {
  const messageId = '810000000000000015';
  seedFlagged(messageId);

  const restore = stubFetch(() => new Response('boom', { status: 500 }));
  let verdict;
  try {
    verdict = await recheckMessage({ ...fakeMessage({ id: messageId, text: 'wer weiß' }).message });
  } finally {
    restore();
  }

  assert.equal(verdict.action, 'flagged', 'no verdict is not the same as innocent');
  assert.ok(findRow(messageId), 'the row survives an unreachable classifier');
});

test('an update that is not a content edit never reaches the classifier', async () => {
  const before = depth();
  const { message } = fakeMessage({ id: '810000000000000016', editedTimestamp: null });
  const { calls, restore } = stubVerdict({ flagged: true, categories: ['harassment'] });

  try {
    // A link preview resolving looks exactly like this.
    await onMessageUpdate({ partial: true }, message);
  } finally {
    restore();
  }

  assert.equal(calls.length, 0);
  assert.equal(depth(), before);
});

test('an edit whose content did not change is skipped', async () => {
  const { message } = fakeMessage({ id: '810000000000000017', text: 'gleich' });
  const { calls, restore } = stubVerdict({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageUpdate({ partial: false, content: 'gleich' }, message);
  } finally {
    restore();
  }

  assert.equal(calls.length, 0);
});

test('edits from bots, from DMs and from foreign guilds are ignored', async () => {
  const { calls, restore } = stubVerdict({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageUpdate(null, fakeMessage({ id: '810000000000000018', bot: true }).message);
    await onMessageUpdate(null, fakeMessage({ id: '810000000000000019', guildId: null }).message);
    await onMessageUpdate(
      null,
      fakeMessage({ id: '810000000000000020', guildId: '999999999999999999' }).message,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 0);
});

test('a real edit routed through the gateway handler is classified', async () => {
  const messageId = '810000000000000021';
  const { message } = fakeMessage({ id: messageId, text: 'jetzt aber' });
  const { calls, restore } = stubVerdict({ flagged: true, categories: ['violence'] });

  try {
    await onMessageUpdate({ partial: false, content: 'vorher harmlos' }, message);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(findRow(messageId)?.categories, ['violence']);
});
