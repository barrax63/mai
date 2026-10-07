/**
 * Mai asleep.
 *
 * The whole file runs inside a nap window (see setup-naps.js). What it pins
 * down is the one property a nap must not have, first: **moderation keeps
 * running**. A window every night in which the rules do not apply would be a
 * different and much worse feature, and the only thing standing between the two
 * is that nobody added the check to the moderation path.
 *
 * Then the three things a nap does change: she reacts instead of replying, she
 * refuses `/mai ask` in one line, and the presence says so, because a bot that
 * goes quiet with no visible reason reads as broken rather than asleep.
 */
import './setup-naps.js';
import { openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityType } from 'discord.js';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { mai as maiCommand } from '../src/commands/mai.js';
import { depth, findRow } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';
import { startPresenceRotation } from '../src/gateway/presence.js';
import { napping } from '../src/naps.js';
import { inZoomies, rollZoomies } from '../src/zoomies.js';

await openTestDatabase();

const BOT = '880000000000000000';
const CHANNEL = '810000000000000020';

const wipe = () => {
  getDb().prepare('DELETE FROM moderation_queue').run();
};

function fakeMessage({ id = '885000000000000001', text = 'hallo', mentionsBot = false } = {}) {
  const record = { reacted: [], replies: [], typing: 0 };

  const message = {
    id,
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    system: false,
    content: text,
    author: { id: TEST_USER, bot: false, username: 'tester' },
    attachments: { size: 0, map: () => [], values: () => [].values() },
    mentions: { users: new Map(mentionsBot ? [[BOT, { id: BOT }]] : []) },
    reference: null,
    channel: {
      isThread: () => false,
      sendTyping: async () => {
        record.typing += 1;
      },
    },
    client: { user: { id: BOT }, guilds: { cache: new Map() }, channels: { fetch: async () => null } },
    react: async (emoji) => record.reacted.push(emoji),
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'reply-message' };
    },
  };

  return { message, record };
}

/** `/moderations` with the given verdict, `/chat/completions` with a reply. */
function stubApi({ flagged = false, categories = [] } = {}) {
  const calls = { moderation: 0, chat: 0 };
  const restore = stubFetch((url) => {
    const body = url.endsWith('/moderations')
      ? (calls.moderation += 1,
        {
          results: [
            { flagged, categories: Object.fromEntries(categories.map((name) => [name, true])) },
          ],
        })
      : (calls.chat += 1, { choices: [{ message: { role: 'assistant', content: 'miau' } }] });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, restore };
}

test('the test file is actually running inside a nap', () => {
  assert.notEqual(config.naps.startHour, null);
  assert.equal(napping(), true);
});

test('a sleeping cat still moderates, which is the point of the whole design', async () => {
  wipe();
  const { message } = fakeMessage({ id: '885000000000000002', text: 'du wicht' });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 1, 'the message was classified');
  assert.equal(depth(), 1, 'and queued for enforcement');
  assert.ok(findRow('885000000000000002'));
});

test('a mention gets a look instead of an answer, and costs no tokens', async () => {
  wipe();
  const { message, record } = fakeMessage({
    id: '885000000000000003',
    text: 'Mai, bist du wach?',
    mentionsBot: true,
  });
  const { calls, restore } = stubApi({ flagged: false });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.chat, 0, 'she is asleep, not thinking about it');
  assert.deepEqual(record.replies, []);
  assert.equal(record.typing, 0);
  assert.deepEqual(record.reacted, [content.chat.sleepingEmoji], 'silence alone reads as broken');
  // Still classified: addressed to Mai or not makes no difference to that.
  assert.equal(calls.moderation, 1);
});

test('/mai ask is answered in one line, not with a model call', async () => {
  const asking = {
    id: 'interaction-nap',
    application_id: 'app-1',
    token: 'interaction-token',
    guild_id: TEST_GUILD,
    member: { user: { id: TEST_USER, username: 'tester' }, permissions: '0' },
    data: {
      name: 'mai',
      options: [{ name: 'ask', type: 1, options: [{ name: 'frage', value: 'wach?' }] }],
    },
  };
  const { calls, restore } = stubApi();

  let response;
  try {
    response = await maiCommand.execute(asking);
  } finally {
    restore();
  }

  assert.equal(response.data.content, content.commands.ask.sleeping);
  assert.equal(calls.chat, 0);
  // Refused before the screen, too: a question nobody answers costs nothing.
  assert.equal(calls.moderation, 0);
});

test('the presence says she is asleep, which is the only tell there is', () => {
  const presences = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() { return this; } });

  try {
    startPresenceRotation({ user: { setPresence: (payload) => presences.push(payload) } });
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  const [activity] = presences[0].activities;
  assert.equal(activity.type, ActivityType.Custom);
  assert.ok(content.presence.naps.includes(activity.state), activity.state);
  assert.equal(content.presence.statuses.includes(activity.state), false, 'not an awake one');
});

test('no zoomies while she is asleep: the status cannot claim both', () => {
  const realRandom = Math.random;
  Math.random = () => 0;

  try {
    // A roll that would always win while she is awake.
    assert.ok(config.zoomies.chance > 0, 'the chance is not switched off here');
    assert.equal(rollZoomies(), false);
    assert.equal(inZoomies(), false);
  } finally {
    Math.random = realRandom;
  }
});

test('a nap is hours of the clock, so it ends without anybody ending it', () => {
  const { startHour } = config.naps;
  const outside = (startHour + 3) % 24;

  assert.equal(napping(new Date(2026, 0, 15, startHour, 0, 0)), true);
  assert.equal(napping(new Date(2026, 0, 15, outside, 0, 0)), false, `awake at ${outside}`);
});
