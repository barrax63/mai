/**
 * Hissing at other bots: the one thing Mai does with a message another bot
 * wrote.
 *
 * Mostly a test of what it is not. A bot is never moderated and never answered
 * (two bots answering each other is a loop), so a hiss is a reaction and
 * nothing else. It never lands on herself, never on a webhook (proxy bots post
 * people's messages through one), never where she is paused or not allowed,
 * and at most once an hour per bot per server, because a bot posting a line per
 * song would otherwise be hissed at all evening.
 */
import './setup-gateway.js';
import { openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { depth } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { updateSettings } from '../src/db/settings.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';
import { maybeHissAtBot, resetBotHisses } from '../src/gateway/events/reactions.js';

await openTestDatabase();

const MAI = '893000000000000001';
const MUSIC_BOT = '893000000000000002';
const LEVEL_BOT = '893000000000000003';
const CHANNEL = '893000000000000010';

let nextId = 0;

/** A message another bot wrote, plus a record of what Mai did to it. */
function botMessage({ authorId = MUSIC_BOT, guildId = TEST_GUILD, webhookId = null } = {}) {
  const record = { reacted: [], replies: [] };
  nextId += 1;

  const message = {
    id: `894${String(nextId).padStart(15, '0')}`,
    guildId,
    channelId: CHANNEL,
    system: false,
    webhookId,
    content: 'Now playing: Never Gonna Give You Up <@893000000000000001>',
    author: { id: authorId, bot: true, username: 'musicbot' },
    attachments: { size: 0, map: () => [], values: () => [].values() },
    mentions: { users: new Map([[MAI, { id: MAI }]]) },
    reference: null,
    channel: { isThread: () => false, sendTyping: async () => {} },
    client: { user: { id: MAI }, guilds: { cache: new Map() }, channels: { fetch: async () => null } },
    react: async (emoji) => record.reacted.push(emoji),
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'reply-message' };
    },
  };

  return { message, record };
}

/** Both endpoints, counted: nothing here may reach either of them. */
function stubApi() {
  const calls = { moderation: 0, chat: 0 };
  const restore = stubFetch((url) => {
    if (url.endsWith('/moderations')) {
      calls.moderation += 1;
      return Response.json({ results: [{ flagged: true, categories: { harassment: true } }] });
    }
    calls.chat += 1;
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });
  return { calls, restore };
}

/** Runs `fn` with every roll landing on `roll`. */
async function rolling(roll, fn) {
  const realRandom = Math.random;
  Math.random = () => roll;
  try {
    return await fn();
  } finally {
    Math.random = realRandom;
  }
}

test('now and then she hisses at another bot, and that is all she does', async () => {
  resetBotHisses();
  getDb().exec('DELETE FROM moderation_queue');
  const { message, record } = botMessage();
  const { calls, restore } = stubApi();

  try {
    await rolling(0, () => onMessageCreate(message));
  } finally {
    restore();
  }

  assert.equal(record.reacted.length, 1);
  assert.ok(content.bots.hisses.includes(record.reacted[0]), record.reacted[0]);
  // Mentioned, and "flagged" if anybody asked: nobody asks.
  assert.equal(calls.moderation, 0, 'a bot is not moderated');
  assert.equal(calls.chat, 0, 'and not answered');
  assert.deepEqual(record.replies, []);
  assert.equal(depth(), 0);
});

test('an aloof roll is no hiss', async () => {
  resetBotHisses();
  const { message, record } = botMessage();
  assert.ok(content.bots.chance < 0.99, 'the shipped chance is well under this');

  await rolling(0.99, () => onMessageCreate(message));

  assert.deepEqual(record.reacted, []);
});

test('she never hisses at herself', async () => {
  resetBotHisses();
  const { message, record } = botMessage({ authorId: MAI });

  await rolling(0, () => onMessageCreate(message));

  assert.deepEqual(record.reacted, []);
});

test('never at a webhook, which may be a person speaking through a proxy', async () => {
  resetBotHisses();
  const { message, record } = botMessage({ webhookId: '893000000000000099' });

  await rolling(0, () => onMessageCreate(message));

  assert.deepEqual(record.reacted, []);
});

test('a paused server and one outside the allowlist get no hiss either', async () => {
  resetBotHisses();

  const outside = botMessage({ guildId: OTHER_GUILD });
  await rolling(0, () => onMessageCreate(outside.message));
  assert.deepEqual(outside.record.reacted, [], 'not allowlisted: no behaviour at all');

  updateSettings(TEST_GUILD, { enabled: 'false' });
  const paused = botMessage();
  try {
    await rolling(0, () => onMessageCreate(paused.message));
  } finally {
    updateSettings(TEST_GUILD, { enabled: 'true' });
  }
  assert.deepEqual(paused.record.reacted, [], 'paused: the same');
});

test('a bot in her DMs gets nothing', async () => {
  resetBotHisses();
  const { message, record } = botMessage({ guildId: null });

  await rolling(0, () => onMessageCreate(message));

  assert.deepEqual(record.reacted, []);
});

test('once an hour per bot per server, so it stays a feud rather than a reflex', async () => {
  resetBotHisses();
  const now = Date.now();
  const hiss = async (options, at) => {
    const { message, record } = botMessage(options);
    await rolling(0, () => maybeHissAtBot(message, at));
    return record.reacted.length;
  };

  assert.equal(await hiss({}, now), 1);
  assert.equal(await hiss({}, now + 1_000), 0, 'the same bot, a second later');
  assert.equal(await hiss({}, now + config.bots.hissCooldownMs - 1), 0, 'still within the hour');
  // Somebody else entirely, or the same bot somewhere else, is a fresh grudge.
  assert.equal(await hiss({ authorId: LEVEL_BOT }, now + 1_000), 1);
  assert.equal(await hiss({ guildId: OTHER_GUILD }, now + 1_000), 1);
  assert.equal(await hiss({}, now + config.bots.hissCooldownMs), 1, 'and an hour later, again');
});

test('a lost roll does not use up the hour', async () => {
  resetBotHisses();
  const now = Date.now();

  const first = botMessage();
  await rolling(0.99, () => maybeHissAtBot(first.message, now));
  const second = botMessage();
  await rolling(0, () => maybeHissAtBot(second.message, now + 1_000));

  assert.deepEqual(first.record.reacted, []);
  assert.equal(second.record.reacted.length, 1);
});

test('a refused reaction is not worth an exception', async () => {
  resetBotHisses();
  const { message } = botMessage();
  message.react = async () => {
    throw new Error('Missing Permissions');
  };

  await rolling(0, () => onMessageCreate(message));
});
