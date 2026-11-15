/**
 * Walking across the keyboard: now and then a line of key smash in front of a
 * chat reply she was going to give anyway.
 *
 * What makes it a joke rather than a bug is where it stops, so that is most of
 * this file: never instead of the reply, never in her memory (or the model
 * would learn to write it), never on top of the let-go line, never in a scold
 * and never in `/mai ask`. And the rule every persona feature keeps:
 * moderation is exactly as it was.
 */
import './setup-gateway.js';
import { interaction, openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetGrudges } from '../src/chat/grudges.js';
import { walkAcrossTheKeyboard } from '../src/chat/reply.js';
import { mai as maiCommand } from '../src/commands/mai.js';
import { content, fill } from '../src/content.js';
import { recentTurns } from '../src/db/history.js';
import { getDb } from '../src/db/index.js';
import { depth } from '../src/db/queue.js';
import { effectiveSettings } from '../src/db/settings.js';
import { ACTION_DELETED, recordViolation } from '../src/db/violations.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';

await openTestDatabase();

const { chance, smashes } = content.chat.keyboard;
const BOT = '899000000000000000';
const CHANNEL = '899000000000000020';
const DAY = 86_400_000;

let nextId = 0;
const nextMessageId = () => {
  nextId += 1;
  return `899${String(nextId).padStart(15, '0')}`;
};

const wipe = () => {
  getDb().exec('DELETE FROM violations');
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM chat_history');
  resetGrudges();
};

/** A mention of Mai through the whole handler, with every roll landing on `roll`. */
async function mention({ roll, flagged = false, text = 'Mai, na?' }) {
  const record = { replies: [] };
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
    react: async () => {},
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'reply-message' };
    },
  };

  const restore = stubFetch((url) => {
    if (url.endsWith('/moderations')) {
      return Response.json({ results: [{ flagged, categories: flagged ? { harassment: true } : {} }] });
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });
  const realRandom = Math.random;
  Math.random = () => roll;
  try {
    await onMessageCreate(message);
  } finally {
    Math.random = realRandom;
    restore();
  }
  return record.replies.map((reply) => reply.content);
}

const mentionsASmash = (text) => smashes.some((smash) => text.includes(smash));

test('a roll under the chance puts a line of key smash in front of her answer', async () => {
  wipe();

  assert.deepEqual(await mention({ roll: 0 }), [`${smashes[0]}\nmiau`]);
});

test('a roll over it is her answer exactly as she gave it', async () => {
  wipe();

  assert.deepEqual(await mention({ roll: chance }), ['miau']);
});

test('her memory keeps the answer without the smash, or the model would learn to write one', async () => {
  wipe();
  await mention({ roll: 0 });

  const said = recentTurns(CHANNEL, 10)
    .filter((turn) => turn.role === 'assistant')
    .map((turn) => turn.content);
  assert.deepEqual(said, ['miau']);
});

test('never instead of the reply: a GIF sent without words stays a GIF', () => {
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const gifOnly = { text: '', gifUrl: 'https://media.giphy.com/media/x/giphy.gif' };
    assert.equal(walkAcrossTheKeyboard({ messageId: 'm', guildId: TEST_GUILD }, gifOnly), gifOnly);
  } finally {
    Math.random = realRandom;
  }
});

test('never on top of the line about letting a grudge go', async () => {
  wipe();
  const windowDays = effectiveSettings(TEST_GUILD).strikeWindowDays;
  recordViolation({
    guildId: TEST_GUILD,
    userId: TEST_USER,
    messageId: nextMessageId(),
    categories: ['harassment'],
    action: ACTION_DELETED,
    createdAt: new Date(Date.now() - (windowDays + 2) * DAY).toISOString(),
  });

  const [posted] = await mention({ roll: 0 });

  assert.equal(posted, `${content.chat.letGo[0]}\nmiau`);
  assert.equal(mentionsASmash(posted), false);
});

test('a flagged message is scolded, not smashed, and queued exactly as before', async () => {
  wipe();

  const [scold] = await mention({ roll: 0, flagged: true, text: 'Mai, du wicht' });

  assert.ok(scold.startsWith(content.moderation.scoldPrefix), scold);
  assert.equal(mentionsASmash(scold), false);
  assert.equal(depth(), 1, 'still queued for enforcement');
});

test('/mai ask never walks across the keyboard: one question, one answer', async () => {
  wipe();
  const restore = stubFetch((url) => {
    if (url.endsWith('/moderations')) return Response.json({ results: [{ flagged: false, categories: {} }] });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });
  const realRandom = Math.random;
  const realUptime = process.uptime;
  Math.random = () => 0;
  process.uptime = () => 3600;

  let response;
  try {
    response = await maiCommand.execute(
      interaction({
        member: { user: { id: '899100000000000001', username: 'asker' }, permissions: '0' },
        data: {
          name: 'mai',
          options: [{ name: 'ask', type: 1, options: [{ name: 'frage', value: 'na?' }] }],
        },
      }),
    );
  } finally {
    Math.random = realRandom;
    process.uptime = realUptime;
    restore();
  }

  assert.equal(response.data.content, fill(content.commands.ask.answer, { question: 'na?', reply: 'miau' }));
});

test('the shipped smashes are rare, plain keys, and fit in front of any reply', () => {
  assert.ok(chance > 0 && chance <= 0.05, `rare: ${chance}`);
  for (const smash of smashes) {
    assert.ok(smash.length <= 190, smash);
    assert.equal(/[*_~|`>#@<\\\r\n]/.test(smash), false, smash);
  }
});
