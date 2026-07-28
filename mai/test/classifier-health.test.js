/**
 * What a guild is told when classification stops working.
 *
 * Moderation fails open on purpose: a dead provider must not take the rest of
 * Mai down with it. The cost is that an outage looks exactly like a quiet
 * afternoon from inside Discord, so it is turned into two log entries, one when
 * it starts and one when it ends, and nothing in between: an entry per failed
 * message would be a second flood on top of the first.
 */
import './setup-health.js';
import { openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { updateSettings } from '../src/db/settings.js';
import { checkMessage } from '../src/moderation/check.js';
import {
  degradedGuildIds,
  recordClassifierFailure,
  recordClassifierSuccess,
  resetClassifierHealth,
} from '../src/moderation/health.js';

await openTestDatabase();

const CHANNEL = '970000000000000001';
const LOG_CHANNEL = '970000000000000002';

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

let nextId = 0;
const messageId = () => `971000000000000${(nextId += 1).toString().padStart(3, '0')}`;

/** Captures what Mai posts into the guild's log channel. */
function fakeClient() {
  const posts = [];

  return {
    posts,
    client: {
      channels: {
        fetch: async (channelId) => ({
          id: channelId,
          guildId: TEST_GUILD,
          isTextBased: () => true,
          send: async (payload) => posts.push(payload),
        }),
      },
    },
  };
}

const fakeMessage = (client) => ({
  id: messageId(),
  guildId: TEST_GUILD,
  channelId: CHANNEL,
  content: 'ein ganz normaler satz',
  author: { id: TEST_USER, bot: false, username: 'tester' },
  attachments: { size: 0, map: () => [] },
  channel: { parentId: null },
  client,
  react: async () => {},
  reply: async () => ({ id: 'scold' }),
});

/** Log entries are posted detached, so let the microtasks drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const titles = content.moderation.log.titles;
const titlesOf = (posts) => posts.map((post) => post.embeds[0].title);

test('one failure is not an outage, the threshold is', () => {
  resetClassifierHealth();
  assert.equal(config.moderation.degradedAfter, 2);

  assert.deepEqual(recordClassifierFailure('g'), { announce: false, failures: 1 });
  assert.deepEqual(recordClassifierFailure('g'), { announce: true, failures: 2 });
  // Announced once: an hour-long outage is still one event.
  assert.deepEqual(recordClassifierFailure('g'), { announce: false, failures: 3 });
});

test('recovery is reported only if the outage was', () => {
  resetClassifierHealth();

  recordClassifierFailure('g');
  assert.equal(recordClassifierSuccess('g'), false, 'a single failure told nobody anything');

  recordClassifierFailure('g');
  recordClassifierFailure('g');
  assert.equal(recordClassifierSuccess('g'), true);
  assert.equal(recordClassifierSuccess('g'), false, 'and only once');
});

test('the streak is per guild', () => {
  resetClassifierHealth();

  recordClassifierFailure('a');
  recordClassifierFailure('b');
  assert.deepEqual(degradedGuildIds(), [], 'neither has reached the threshold');

  assert.equal(recordClassifierFailure('a').announce, true);
  assert.deepEqual(degradedGuildIds(), ['a'], 'b is still fine');
});

test('a guild is told once when moderation starts failing open', async () => {
  resetClassifierHealth();
  const { client, posts } = fakeClient();
  const restore = stubFetch(() => {
    throw new Error('provider is down');
  });

  try {
    for (let index = 0; index < 4; index += 1) {
      // The message passes: failing open is the deliberate behaviour, and the
      // point of the entry is that it stops being invisible.
      assert.equal((await checkMessage(fakeMessage(client))).action, 'ok');
      await settle();
    }

    assert.deepEqual(titlesOf(posts), [titles.degraded], 'one entry, not one per message');
    assert.deepEqual(degradedGuildIds(), [TEST_GUILD]);
  } finally {
    restore();
  }
});

test('the entry names the failure without quoting it', async () => {
  resetClassifierHealth();
  const { client, posts } = fakeClient();
  const restore = stubFetch(() => {
    throw new Error('sk-secret-key rejected by https://internal.example/v1');
  });

  try {
    for (let index = 0; index < 2; index += 1) {
      await checkMessage(fakeMessage(client));
      await settle();
    }

    const embed = posts.at(-1).embeds[0];
    assert.equal(embed.title, titles.degraded);
    // An exception message is free text that can quote a key, a URL or a
    // request body, and a log channel is permanent storage.
    assert.equal(JSON.stringify(embed).includes('sk-secret-key'), false);
    assert.equal(JSON.stringify(embed).includes('internal.example'), false);
    assert.ok(
      JSON.stringify(embed).includes(content.moderation.log.fields.attempts),
      'but the streak is there, so staff can tell a blip from an outage',
    );
  } finally {
    restore();
  }
});

test('and once more when it works again', async () => {
  resetClassifierHealth();
  const { client, posts } = fakeClient();

  let down = true;
  const restore = stubFetch(() => {
    if (down) throw new Error('provider is down');
    return new Response(
      JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  try {
    for (let index = 0; index < 2; index += 1) {
      await checkMessage(fakeMessage(client));
      await settle();
    }

    down = false;
    for (let index = 0; index < 3; index += 1) {
      await checkMessage(fakeMessage(client));
      await settle();
    }

    assert.deepEqual(titlesOf(posts), [titles.degraded, titles.recovered]);
    assert.deepEqual(degradedGuildIds(), []);
  } finally {
    restore();
  }
});
