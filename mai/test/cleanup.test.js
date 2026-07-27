/**
 * Taking Mai's own marks back off a message.
 *
 * Two properties carry real weight here. Every deletion Mai performs is
 * registered first, because `messageDelete` never says who deleted a message and
 * an unregistered one would be recorded as the author having fixed it: a strike
 * silently downgraded. And the warning reaction is removed through `/@me` only,
 * never `removeAll()`, which would drop every other member's reactions too.
 */
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Routes } from 'discord.js';
import { content } from '../src/content.js';
import {
  clearOwnDeletions,
  deleteMessageById,
  isOwnDeletion,
  markOwnDeletion,
  removeWarningReaction,
} from '../src/moderation/cleanup.js';

const CHANNEL = '840000000000000001';
const MESSAGE = '840000000000000002';
const BOT = '840000000000000003';

/**
 * @param {{ fetchFails?: boolean, channel?: object | null }} options
 */
function fakeClient({ fetchFails = false, channel } = {}) {
  const record = { deleted: [], fetched: [], restDeleted: [] };

  const client = {
    user: { id: BOT },
    rest: {
      delete: async (route) => {
        record.restDeleted.push(route);
      },
    },
    channels: {
      fetch: async (id) => {
        record.fetched.push(id);
        if (fetchFails) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        if (channel !== undefined) return channel;
        return {
          id,
          messages: {
            delete: async (messageId) => {
              record.deleted.push({ channelId: id, messageId });
            },
          },
        };
      },
    },
  };

  return { client, record };
}

test('an id is registered as Mai\'s own deletion and can be recognised again', () => {
  clearOwnDeletions();

  assert.ok(!isOwnDeletion(MESSAGE));
  markOwnDeletion(MESSAGE);
  assert.ok(isOwnDeletion(MESSAGE));

  clearOwnDeletions();
  assert.ok(!isOwnDeletion(MESSAGE), 'the test seam really clears the registry');
});

test('marking nothing marks nothing', () => {
  clearOwnDeletions();

  markOwnDeletion(null);
  markOwnDeletion(undefined);
  markOwnDeletion('');

  assert.ok(!isOwnDeletion(''));
  assert.ok(!isOwnDeletion(undefined));
});

test('an entry expires on its own, so a failed delete cannot leak one forever', async () => {
  clearOwnDeletions();
  const realSetTimeout = globalThis.setTimeout;
  /** @type {number[]} */
  const delays = [];

  // The TTL is a minute; run the timer immediately instead of waiting it out.
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return realSetTimeout(fn, 0);
  };
  try {
    markOwnDeletion(MESSAGE);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.deepEqual(delays, [60_000], 'expiry is a minute after the mark');
  assert.ok(!isOwnDeletion(MESSAGE), 'the entry expired');
});

test('re-marking the same id restarts its expiry instead of stacking timers', () => {
  clearOwnDeletions();
  const realClearTimeout = globalThis.clearTimeout;
  const cleared = [];

  globalThis.clearTimeout = (timer) => {
    if (timer !== undefined) cleared.push(timer);
    return realClearTimeout(timer);
  };
  try {
    markOwnDeletion(MESSAGE);
    markOwnDeletion(MESSAGE);
    markOwnDeletion(MESSAGE);
  } finally {
    globalThis.clearTimeout = realClearTimeout;
  }

  assert.ok(isOwnDeletion(MESSAGE));
  // The two earlier timers are cleared, or the first expiry would drop an id
  // that was just re-marked and Mai's own delete would look like the author's.
  assert.equal(cleared.length, 2);
  clearOwnDeletions();
});

test('a message Mai deletes is registered before the delete, not after', async () => {
  clearOwnDeletions();
  const order = [];
  const { client } = fakeClient();
  client.channels.fetch = async (id) => {
    order.push(`marked:${isOwnDeletion(MESSAGE)}`);
    return {
      id,
      messages: {
        delete: async () => {
          order.push('deleted');
        },
      },
    };
  };

  await deleteMessageById(client, CHANNEL, MESSAGE);

  assert.deepEqual(order, ['marked:true', 'deleted']);
  clearOwnDeletions();
});

test('deleting nothing costs no Discord call', async () => {
  const { client, record } = fakeClient();

  await deleteMessageById(client, CHANNEL, null);

  assert.deepEqual(record.fetched, []);
});

test('a failing delete is swallowed: the queue has to move on', async () => {
  clearOwnDeletions();
  const { client } = fakeClient({ fetchFails: true });

  await assert.doesNotReject(() => deleteMessageById(client, CHANNEL, MESSAGE));

  // Still registered: the delete may yet have landed, and recording the author
  // as having fixed it is the worse of the two mistakes.
  assert.ok(isOwnDeletion(MESSAGE));
  clearOwnDeletions();
});

test('a channel that resolves to nothing is survivable too', async () => {
  const { client } = fakeClient({ channel: null });

  await assert.doesNotReject(() => deleteMessageById(client, CHANNEL, MESSAGE));
  clearOwnDeletions();
});

test('the cached reaction is used when the payload carries one', async () => {
  const removed = [];
  const { client, record } = fakeClient();
  const message = {
    id: MESSAGE,
    channelId: CHANNEL,
    client,
    reactions: {
      cache: {
        get: (emoji) =>
          emoji === content.moderation.warningEmoji
            ? { users: { remove: async (userId) => removed.push(userId) } }
            : undefined,
      },
    },
  };

  await removeWarningReaction(message);

  assert.deepEqual(removed, [BOT], 'hers only');
  assert.deepEqual(record.restDeleted, [], 'no REST call when the cache had it');
});

test('without a cached reaction the /@me route is used, never removeAll', async () => {
  const { client, record } = fakeClient();
  const message = {
    id: MESSAGE,
    channelId: CHANNEL,
    client,
    // A MESSAGE_UPDATE payload does not reliably carry `reactions` at all.
    reactions: undefined,
    removeAll: async () => assert.fail('removeAll drops other members reactions'),
  };

  await removeWarningReaction(message);

  assert.deepEqual(record.restDeleted, [
    Routes.channelMessageOwnReaction(
      CHANNEL,
      MESSAGE,
      encodeURIComponent(content.moderation.warningEmoji),
    ),
  ]);
  assert.match(record.restDeleted[0], /@me$/);
});

test('the emoji is encoded for the route, not pasted into it raw', async () => {
  const { client, record } = fakeClient();

  await removeWarningReaction({ id: MESSAGE, channelId: CHANNEL, client, reactions: undefined });

  assert.ok(
    !record.restDeleted[0].includes(content.moderation.warningEmoji),
    'a raw emoji in a URL path is not a valid route',
  );
});

test('without a client user there is nobody to remove a reaction for', async () => {
  const { record } = fakeClient();
  const message = {
    id: MESSAGE,
    channelId: CHANNEL,
    client: { user: null, rest: { delete: async (route) => record.restDeleted.push(route) } },
    reactions: undefined,
  };

  await removeWarningReaction(message);

  assert.deepEqual(record.restDeleted, []);
});

test('a failing reaction removal is best effort, like the delete', async () => {
  const message = {
    id: MESSAGE,
    channelId: CHANNEL,
    client: {
      user: { id: BOT },
      rest: {
        delete: async () => {
          throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        },
      },
    },
    reactions: undefined,
  };

  await assert.doesNotReject(() => removeWarningReaction(message));
});
