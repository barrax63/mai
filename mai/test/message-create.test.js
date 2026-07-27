/**
 * The gateway entry point every message goes through, and the ambient reaction
 * that hangs off it.
 *
 * The order of the gates is the substance here. An un-allowlisted guild and a
 * paused one get *no* behaviour at all, not "no moderation but still chat". A
 * message addressed to Mai waits for the moderation verdict before she answers,
 * so a flagged message is scolded instead of replied to and never reaches the
 * chat history. A direct message skips moderation entirely, because a bot cannot
 * delete a DM, and is gated on shared membership instead.
 */
import './setup-gateway.js';
import { openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { depth, findRow } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { updateSettings } from '../src/db/settings.js';
import { clearDmGateCache } from '../src/gateway/events/mai-chat.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';
import { maybeReactAsCat } from '../src/gateway/events/reactions.js';

await openTestDatabase();

const CHANNEL = '880000000000000001';
const BOT = '880000000000000002';
const STRANGER = '880000000000000003';

const wipe = () => {
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM chat_history');
};

const attachments = (items = []) => ({ size: items.length, map: (fn) => items.map(fn), values: () => items.values() });

/**
 * A message plus a record of everything Mai did to it.
 *
 * @param {object} options
 */
function fakeMessage({
  id = '881000000000000001',
  text = 'ein ganz normaler satz',
  guildId = TEST_GUILD,
  authorId = TEST_USER,
  bot = false,
  system = false,
  mentionsBot = false,
  memberOfAllowedGuild = true,
} = {}) {
  const record = { reacted: [], replies: [], typing: 0 };

  const guilds = new Map();
  if (memberOfAllowedGuild) {
    guilds.set(TEST_GUILD, { id: TEST_GUILD, members: { fetch: async () => ({ id: authorId }) } });
  }

  const message = {
    id,
    guildId,
    channelId: CHANNEL,
    system,
    content: text,
    author: { id: authorId, bot, username: 'tester' },
    attachments: attachments(),
    mentions: { users: new Map(mentionsBot ? [[BOT, { id: BOT }]] : []) },
    reference: null,
    channel: {
      isThread: () => false,
      sendTyping: async () => {
        record.typing += 1;
      },
    },
    client: {
      user: { id: BOT },
      guilds: { cache: guilds },
      channels: { fetch: async () => null },
      rest: { delete: async () => {} },
    },
    react: async (emoji) => {
      record.reacted.push(emoji);
    },
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'reply-message' };
    },
  };

  return { message, record };
}

/**
 * Answers both endpoints: `/moderations` with the given verdict, and
 * `/chat/completions` with a fixed reply.
 */
function stubApi({ flagged = false, categories = [], reply = 'miau' } = {}) {
  const calls = { moderation: 0, chat: 0 };
  const restore = stubFetch((url) => {
    if (url.endsWith('/moderations')) {
      calls.moderation += 1;
      return new Response(
        JSON.stringify({
          results: [{ flagged, categories: Object.fromEntries(categories.map((name) => [name, true])) }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    calls.chat += 1;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, restore };
}

test('a message from a bot is ignored entirely', async () => {
  wipe();
  const { message, record } = fakeMessage({ bot: true, text: 'du wicht' });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 0);
  assert.deepEqual(record.reacted, []);
  assert.equal(depth(), 0);
});

test('a system message is ignored too', async () => {
  wipe();
  const { message } = fakeMessage({ system: true });
  const { calls, restore } = stubApi();

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 0);
});

test('a guild outside the allowlist gets no behaviour: not moderation, not chat', async () => {
  wipe();
  const { message, record } = fakeMessage({ guildId: OTHER_GUILD, text: 'du wicht', mentionsBot: true });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 0);
  assert.equal(calls.chat, 0);
  assert.deepEqual(record.replies, []);
});

test('a paused guild is just as quiet, and it is the server own decision', async () => {
  wipe();
  updateSettings(TEST_GUILD, { enabled: 'false' });
  const { message, record } = fakeMessage({ text: 'du wicht', mentionsBot: true });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
    updateSettings(TEST_GUILD, { enabled: 'true' });
  }

  assert.equal(calls.moderation, 0);
  assert.equal(calls.chat, 0);
  assert.deepEqual(record.replies, []);
});

test('an ordinary message is classified and passes', async () => {
  wipe();
  const { message, record } = fakeMessage({ id: '881000000000000010' });
  const { calls, restore } = stubApi({ flagged: false });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 1);
  assert.equal(calls.chat, 0, 'nobody addressed her');
  assert.equal(depth(), 0);
  assert.deepEqual(record.replies, []);
});

test('a violation is flagged, scolded and queued', async () => {
  wipe();
  const { message, record } = fakeMessage({ id: '881000000000000011', text: 'du wicht' });
  const { restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  const row = findRow('881000000000000011');
  assert.ok(row, 'queued for the grace period');
  assert.deepEqual(row.categories, ['harassment']);
  assert.equal(row.scoldMessageId, 'reply-message');
  assert.ok(record.reacted.includes(content.moderation.warningEmoji));
  assert.equal(record.replies.length, 1);
  assert.ok(record.replies[0].content.startsWith(content.moderation.scoldPrefix));
  assert.deepEqual(record.replies[0].allowedMentions, { parse: [], repliedUser: true });
});

test('a message addressed to Mai gets an answer, after the verdict', async () => {
  wipe();
  const { message, record } = fakeMessage({ id: '881000000000000012', text: `<@${BOT}> hallo`, mentionsBot: true });
  const { calls, restore } = stubApi({ flagged: false, reply: 'miau, was?' });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 1, 'chat does not skip moderation');
  assert.equal(calls.chat, 1);
  assert.equal(record.replies.at(-1).content, 'miau, was?');
  assert.deepEqual(record.replies.at(-1).allowedMentions, { parse: [], repliedUser: true });
  assert.ok(record.typing > 0);
});

test('a flagged message addressed to Mai is scolded instead of answered', async () => {
  wipe();
  const { message, record } = fakeMessage({
    id: '881000000000000013',
    text: `<@${BOT}> du wicht`,
    mentionsBot: true,
  });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.chat, 0, 'no model call, so no answer to a message she is deleting');
  assert.ok(findRow('881000000000000013'));
  assert.equal(record.replies.length, 1);
  assert.ok(record.replies[0].content.startsWith(content.moderation.scoldPrefix));
  // The chat pipeline never saw it, so her memory did not either.
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM chat_history').get().n, 0);
});

test('a direct message skips moderation: a bot cannot delete one', async () => {
  wipe();
  clearDmGateCache();
  const { message, record } = fakeMessage({ id: '881000000000000014', guildId: null, text: 'du wicht' });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'], reply: 'was willst du?' });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 0);
  assert.equal(calls.chat, 1, 'a DM is always addressed to her');
  assert.equal(record.replies.at(-1).content, 'was willst du?');
  assert.equal(depth(), 0);
});

test('a DM from someone who shares no allowlisted guild is dropped', async () => {
  wipe();
  clearDmGateCache();
  const { message, record } = fakeMessage({
    id: '881000000000000015',
    guildId: null,
    authorId: STRANGER,
    memberOfAllowedGuild: false,
  });
  const { calls, restore } = stubApi();

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.chat, 0);
  assert.deepEqual(record.replies, []);
  clearDmGateCache();
});

test('a failing chat reply does not take the handler down with it', async () => {
  wipe();
  const { message, record } = fakeMessage({ id: '881000000000000016', text: `<@${BOT}> hallo`, mentionsBot: true });
  const restore = stubFetch((url) => {
    if (url.endsWith('/moderations')) {
      return new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 500 });
  });

  try {
    await assert.doesNotReject(() => onMessageCreate(message));
  } finally {
    restore();
  }

  assert.deepEqual(record.replies, [], 'no reply rather than a broken one');
});

test('an unreachable classifier lets the message through: moderation fails open', async () => {
  wipe();
  const { message, record } = fakeMessage({ id: '881000000000000017', text: 'du wicht' });
  const restore = stubFetch(() => {
    throw new TypeError('fetch failed');
  });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(depth(), 0);
  assert.deepEqual(record.replies, []);
  assert.deepEqual(record.reacted, []);
});

test('a trigger word earns a reaction, and only one', async () => {
  const { message, record } = fakeMessage({ text: 'ich hätte gern fisch, gute katze' });
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    await maybeReactAsCat(message);
  } finally {
    Math.random = realRandom;
  }

  assert.equal(record.reacted.length, 1);
  // First match in the configured order wins, there is no fallthrough.
  const first = content.reactions.find((trigger) => trigger.pattern.test(message.content));
  assert.equal(record.reacted[0], first.emoji);
});

test('an aloof cat stays aloof instead of falling through to a weaker trigger', async () => {
  // 'katze' matches a 0.2-chance trigger; a roll above it means no reaction at
  // all, not a search for something else to react to.
  const { message, record } = fakeMessage({ text: 'schau mal, eine katze' });
  const realRandom = Math.random;
  Math.random = () => 0.99;

  try {
    await maybeReactAsCat(message);
  } finally {
    Math.random = realRandom;
  }

  assert.deepEqual(record.reacted, []);
});

test('a message with nothing to match gets no reaction', async () => {
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    for (const text of ['', 'völlig unauffälliger text']) {
      const { message, record } = fakeMessage({ text });
      await maybeReactAsCat(message);
      assert.deepEqual(record.reacted, [], text);
    }
  } finally {
    Math.random = realRandom;
  }
});

test('a refused reaction is not worth an exception', async () => {
  const { message } = fakeMessage({ text: 'fisch!' });
  message.react = async () => {
    throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
  };
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    await assert.doesNotReject(() => maybeReactAsCat(message));
  } finally {
    Math.random = realRandom;
  }
});

test('the same message matches the same trigger every time', async () => {
  // The `g` and `y` flags are stripped when the patterns are compiled: either
  // one would walk lastIndex and make a reaction fire every other time.
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    for (let round = 0; round < 4; round++) {
      const { message, record } = fakeMessage({ text: 'fisch!' });
      await maybeReactAsCat(message);
      assert.equal(record.reacted.length, 1, `round ${round}`);
    }
  } finally {
    Math.random = realRandom;
  }
});

test('a plain message may still get an ambient reaction while being moderated', async () => {
  wipe();
  const { message, record } = fakeMessage({ id: '881000000000000018', text: 'fisch!' });
  const { calls, restore } = stubApi({ flagged: false });
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    await onMessageCreate(message);
  } finally {
    Math.random = realRandom;
    restore();
  }

  assert.equal(calls.moderation, 1);
  assert.equal(record.reacted.length, 1, 'the two run side by side, they are independent');
});
