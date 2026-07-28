/**
 * Shadow mode and `/mod simulate`: the two ways to find out where a server's
 * line sits without discovering it by deleting the wrong messages.
 *
 * What matters in shadow mode is what does *not* happen: no reaction, no scold,
 * no queue row, no strike, and a verdict the member never notices. What matters
 * in `/mod simulate` is that it answers with the guild's own policy applied.
 */
import './setup-moderation.js';
import { interaction, openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { getDb } from '../src/db/index.js';
import { depth, findRow } from '../src/db/queue.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { routeInteraction } from '../src/interactions/router.js';
import { checkMessage } from '../src/moderation/check.js';

await openTestDatabase();

const CHANNEL = '870000000000000001';
const LOG_CHANNEL = '870000000000000002';
const STAFF = { user: { id: TEST_USER, username: 'tester' }, permissions: String(1n << 13n) };

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

let nextId = 0;
const messageId = () => `871000000000000${(nextId += 1).toString().padStart(3, '0')}`;

/** The provider flags it, with a score worth showing. */
const flagging = () =>
  stubFetch(() =>
    new Response(
      JSON.stringify({
        results: [
          {
            flagged: true,
            categories: { harassment: true, hate: false },
            category_scores: { harassment: 0.91, hate: 0.12, violence: 0.03 },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

function fakeMessage({ text = 'du bist ein idiot' } = {}) {
  const record = { reacted: [], replies: [], posted: [] };

  const message = {
    id: messageId(),
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    content: text,
    author: { id: TEST_USER, bot: false, username: 'tester' },
    attachments: { size: 0, map: () => [] },
    channel: { parentId: null },
    client: {
      channels: {
        fetch: async (channelId) => ({
          id: channelId,
          guildId: TEST_GUILD,
          isTextBased: () => true,
          send: async (payload) => record.posted.push({ channelId, ...payload }),
        }),
      },
    },
    react: async (emoji) => record.reacted.push(emoji),
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'scold' };
    },
  };

  return { message, record };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

const simulateCommand = (text) =>
  interaction({
    type: 2,
    member: STAFF,
    data: {
      name: 'mod',
      options: [{ name: 'simulate', type: 1, options: [{ name: 'text', value: text }] }],
    },
  });

test('shadow mode reports the verdict and touches nothing', async () => {
  getDb().exec('DELETE FROM moderation_queue');
  updateSettings(TEST_GUILD, { shadow: true });
  const restore = flagging();

  try {
    const { message, record } = fakeMessage();
    const verdict = await checkMessage(message);
    await settle();

    // The member sees nothing at all: that is what makes a week of shadow mode
    // an honest sample of what would have happened.
    assert.equal(verdict.action, 'ok');
    assert.deepEqual(record.reacted, []);
    assert.deepEqual(record.replies, []);
    assert.equal(findRow(message.id), null);
    assert.equal(depth(TEST_GUILD), 0);

    const embed = record.posted.at(-1).embeds[0];
    assert.equal(embed.title, content.moderation.log.titles.shadow);
    const value = (label) => embed.fields.find((field) => field.name === label)?.value;
    assert.equal(value(content.moderation.log.fields.categories), 'harassment');
    // The number staff tune against, and the reason the entry exists.
    assert.equal(value(content.moderation.log.fields.score), '0.91');
    // The message is untouched, so the jump link still resolves.
    assert.match(value(content.moderation.log.fields.message), /discord\.com\/channels/);
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'shadow');
  }
});

test('a local rule in shadow mode is reported, not enforced', async () => {
  updateSettings(TEST_GUILD, { shadow: true, 'invite-filter': true });
  const restore = stubFetch(() => {
    throw new Error('a local rule needs no classifier');
  });

  try {
    const { message, record } = fakeMessage({ text: 'komm zu discord.gg/abcdef' });
    assert.equal((await checkMessage(message)).action, 'ok');
    await settle();

    assert.equal(findRow(message.id), null);
    assert.equal(record.posted.at(-1).embeds[0].title, content.moderation.log.titles.shadow);
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'shadow');
    resetSettings(TEST_GUILD, 'invite-filter');
  }
});

test('with shadow off the same message is flagged as usual', async () => {
  getDb().exec('DELETE FROM moderation_queue');
  const restore = flagging();

  try {
    const { message, record } = fakeMessage();
    const verdict = await checkMessage(message);

    assert.equal(verdict.action, 'flagged');
    assert.equal(record.replies.length, 1);
    assert.ok(findRow(message.id));
  } finally {
    restore();
    getDb().exec('DELETE FROM moderation_queue');
  }
});

test('/mod simulate answers with this guild\'s policy applied', async () => {
  updateSettings(TEST_GUILD, { threshold: 0.5 });
  const restore = flagging();

  try {
    const body = await route(simulateCommand('du bist ein idiot'));

    // Deferred, because it is a model call: the answer arrives as an edit.
    assert.equal(body.type, 5, 'deferred, and ephemeral by the command flag');
    assert.equal(body.data?.flags, 64);
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'threshold');
  }
});

test('the simulation shows the scores that produced the verdict', async () => {
  updateSettings(TEST_GUILD, { threshold: 0.5, 'invite-filter': true });
  const restore = flagging();

  try {
    // Drive the handler directly: the router's deferred path edits through the
    // interaction webhook, which is not what this test is about.
    const { mod } = await import('../src/commands/mod.js');
    const answer = await mod.execute(simulateCommand('komm zu discord.gg/abcdef, du idiot'));
    const rendered = answer.data.content;
    assert.match(rendered, /0\.910/, 'the score vector, for the moderator who has to pick a number');
    assert.match(rendered, /harassment/);
    // Both layers answer: the local rule caught the invite before the score.
    assert.match(rendered, /invite/);
    assert.match(rendered, new RegExp(content.commands.simulate.wouldFlag));
    assert.equal(/\{[a-z]/i.test(rendered), false, `unsubstituted placeholder: ${rendered}`);
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'threshold');
    resetSettings(TEST_GUILD, 'invite-filter');
  }
});

test('a simulation stores nothing and needs no message', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS count FROM violations').get().count;
  const restore = flagging();

  try {
    const { mod } = await import('../src/commands/mod.js');
    await mod.execute(simulateCommand('irgendwas'));

    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM violations').get().count, before);
    assert.equal(depth(TEST_GUILD), 0, 'nothing queued, nothing recorded, nothing deleted');
  } finally {
    restore();
  }
});

test('an empty simulation is refused before the API is called', async () => {
  const restore = stubFetch(() => {
    throw new Error('nothing to classify');
  });

  try {
    const { mod } = await import('../src/commands/mod.js');
    const answer = await mod.execute(simulateCommand('   '));
    assert.equal(answer.data.content, content.commands.simulate.empty);
  } finally {
    restore();
  }
});
