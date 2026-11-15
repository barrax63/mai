/**
 * Letting a grudge go: once somebody's last strike has aged out of the strike
 * window, the next time they talk to her in that server she says, once, that
 * she is over it.
 *
 * The feature is acceptable because of its limits, so most of this file is
 * about them: only what counts as a strike, only in the server it happened in,
 * only recently, only once, never while she is hissing at them about something
 * open, and never in words that say what it was. And the rule every persona
 * feature keeps: moderation is exactly as it was.
 */
import './setup-gateway.js';
import { openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { resetGrudges, takeGrudgeRelease } from '../src/chat/grudges.js';
import { depth } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { effectiveSettings } from '../src/db/settings.js';
import {
  ACTION_DELETED,
  ACTION_EDITED,
  ACTION_OVERTURNED,
  ACTION_SELF_DELETED,
  ACTION_WARNED,
  recordViolation,
} from '../src/db/violations.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';

await openTestDatabase();

const BOT = '895000000000000000';
const CHANNEL = '895000000000000020';
const DAY = 86_400_000;
const WINDOW_DAYS = effectiveSettings(TEST_GUILD).strikeWindowDays;
const MEMORY_DAYS = config.grudges.memoryMs / DAY;

let nextId = 0;
const nextMessageId = () => {
  nextId += 1;
  return `896${String(nextId).padStart(15, '0')}`;
};

const wipe = () => {
  getDb().exec('DELETE FROM violations');
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM chat_history');
  resetGrudges();
};

/** One entry on the record, `daysAgo` before `now`. */
const strike = ({ daysAgo, guildId = TEST_GUILD, action = ACTION_DELETED, now = Date.now() }) =>
  recordViolation({
    guildId,
    userId: TEST_USER,
    messageId: nextMessageId(),
    categories: ['harassment'],
    action,
    createdAt: new Date(now - daysAgo * DAY).toISOString(),
  });

/** Aged out of the window, and recently: the case the line is for. */
const AGED_OUT = WINDOW_DAYS + 2;

function fakeMessage(text = 'Mai, na?') {
  const record = { reacted: [], replies: [] };

  const message = {
    id: nextMessageId(),
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    system: false,
    content: text,
    author: { id: TEST_USER, bot: false, username: 'tester' },
    attachments: { size: 0, map: () => [], values: () => [].values() },
    mentions: { users: new Map([[BOT, { id: BOT }]]) },
    reference: null,
    channel: { isThread: () => false, sendTyping: async () => {} },
    client: { user: { id: BOT }, guilds: { cache: new Map() }, channels: { fetch: async () => null } },
    react: async (emoji) => record.reacted.push(emoji),
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'reply-message' };
    },
  };

  return { message, record };
}

/** `/moderations` with the given verdict, `/chat/completions` answering "miau". */
function stubApi({ flagged = false } = {}) {
  const calls = { moderation: 0, chat: 0, prompts: [] };
  const restore = stubFetch((url, options) => {
    if (url.endsWith('/moderations')) {
      calls.moderation += 1;
      return Response.json({
        results: [{ flagged, categories: flagged ? { harassment: true } : {} }],
      });
    }
    calls.chat += 1;
    calls.prompts.push(JSON.parse(options.body).messages);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });
  return { calls, restore };
}

/** Sends a mention through the whole handler and returns what she posted. */
async function talk({ flagged = false, text } = {}) {
  const { message, record } = fakeMessage(text);
  const { calls, restore } = stubApi({ flagged });
  // A roll she never walks across the keyboard on, so the reply asserted on is
  // exactly the one she gave (keyboard.test.js is about the other rolls).
  const realRandom = Math.random;
  Math.random = () => 0.999;
  try {
    await onMessageCreate(message);
  } finally {
    Math.random = realRandom;
    restore();
  }
  return { record, calls };
}

const startsWithALetGoLine = (text) => content.chat.letGo.some((line) => text.startsWith(`${line}\n`));

test('a strike that recently left the window earns the line, exactly once', () => {
  wipe();
  strike({ daysAgo: AGED_OUT });

  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), true);
  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), false, 'she said it, she is done');
});

test('a strike still inside the window: not over it yet', () => {
  wipe();
  strike({ daysAgo: AGED_OUT });
  strike({ daysAgo: 1 });

  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), false);
});

test('a strike that left the window long ago is not brought up at all', () => {
  wipe();
  strike({ daysAgo: WINDOW_DAYS + MEMORY_DAYS + 1 });

  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), false);
});

test('no record, no grudge', () => {
  wipe();

  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), false);
});

test('only an enforced deletion is a grudge: a fix in time, a warning or an overturned strike is not', () => {
  for (const action of [ACTION_SELF_DELETED, ACTION_EDITED, ACTION_WARNED, ACTION_OVERTURNED]) {
    wipe();
    strike({ daysAgo: AGED_OUT, action });

    assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), false, action);
  }
});

test('another server’s record stays in that server', () => {
  wipe();
  strike({ daysAgo: AGED_OUT, guildId: OTHER_GUILD });

  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER), false, 'not a word about it here');
  assert.equal(takeGrudgeRelease(OTHER_GUILD, TEST_USER), true, 'where it happened, yes');
});

test('a DM is never where she says it', () => {
  wipe();
  strike({ daysAgo: AGED_OUT });

  assert.equal(takeGrudgeRelease(null, TEST_USER), false);
});

test('a new strike that ages out in turn earns a new line', () => {
  wipe();
  const now = Date.now();
  strike({ daysAgo: AGED_OUT, now });
  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER, now), true);

  // A day later it happens again, and that one leaves the window as well.
  strike({ daysAgo: -1, now });
  const later = now + (1 + AGED_OUT) * DAY;
  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER, later), true);
  assert.equal(takeGrudgeRelease(TEST_GUILD, TEST_USER, later + 1), false);
});

test('a mention gets the line ahead of her answer, and the next one does not', async () => {
  wipe();
  strike({ daysAgo: AGED_OUT });

  const first = await talk();
  assert.equal(first.record.replies.length, 1);
  const text = first.record.replies[0].content;
  assert.ok(startsWithALetGoLine(text), text);
  assert.ok(text.endsWith('\nmiau'), 'and then her ordinary answer');
  // The model was never told: what it was about is not in the prompt.
  assert.equal(JSON.stringify(first.calls.prompts[0]).includes('harassment'), false);

  const second = await talk();
  assert.equal(second.record.replies[0].content, 'miau');
});

test('not while she is hissing at them: an open violation keeps the line for later', async () => {
  wipe();
  strike({ daysAgo: AGED_OUT });

  // A new violation, flagged and queued: scolded, not answered, and nothing
  // about being over it, which would be the wrong note entirely.
  const scolded = await talk({ flagged: true, text: 'Mai, du wicht' });
  assert.equal(scolded.calls.moderation, 1, 'moderation is exactly as it was');
  assert.equal(depth(), 1);
  assert.equal(startsWithALetGoLine(scolded.record.replies[0].content), false);

  const hissing = await talk();
  assert.equal(hissing.record.replies[0].content, 'miau', 'open violation: no line');

  // Once the queue is clear again she is free to be over the old one.
  getDb().exec('DELETE FROM moderation_queue');
  const after = await talk();
  assert.ok(startsWithALetGoLine(after.record.replies[0].content), after.record.replies[0].content);
});

test('the lines never say what it was, because they are said in front of everybody', () => {
  // Not a style check: the feature is acceptable *because* the line is
  // content-free. A rewrite that names the rule, the number or the date
  // publishes a member's record in their server's channel.
  const forbidden = ['regel', 'strike', 'verwarn', 'verstoß', 'gelösch', 'lösch', 'moderat', 'timeout', 'gesperrt'];
  for (const line of content.chat.letGo) {
    assert.equal(/\d/.test(line), false, `no numbers: ${line}`);
    for (const word of forbidden) {
      assert.equal(line.toLowerCase().includes(word), false, `"${word}" in: ${line}`);
    }
  }
});
