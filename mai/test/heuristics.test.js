/**
 * The rules Mai applies without asking a classifier.
 *
 * Three properties are the substance here, and none of them are visible from
 * the rule functions alone:
 *
 *   - a message a local rule trips on is never sent to the provider: these
 *     rules exist partly because they are free, and partly because they have to
 *     keep working while it is down.
 *   - a flood is one incident, not one per message: the guard would otherwise
 *     answer a burst with a scold reply per message, out-spamming the spammer.
 *   - an edit goes through the content rules but not the rate rule: editing a
 *     message is not sending one.
 */
import './setup-moderation.js';
import { openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueue, findRow } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { checkMessage, recheckMessage } from '../src/moderation/check.js';
import {
  contentViolations,
  floodViolation,
  resetFloodWindows,
} from '../src/moderation/heuristics.js';

await openTestDatabase();

const CHANNEL = '960000000000000001';

/** Only the fields the rules read, so a test says what it depends on. */
const rules = (overrides = {}) => ({
  inviteFilter: false,
  linkPolicy: 'off',
  linkDomains: [],
  mentionCap: 0,
  floodRule: null,
  ...overrides,
});

let nextId = 0;
const messageId = () => `961000000000000${(nextId += 1).toString().padStart(3, '0')}`;

/**
 * A message plus a record of what Mai did to it.
 *
 * @param {{ text?: string, id?: string }} [options]
 */
function fakeMessage({ text = 'ein ganz normaler satz', id = messageId() } = {}) {
  const record = { reacted: [], replies: [] };

  const message = {
    id,
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    content: text,
    author: { id: TEST_USER, bot: false, username: 'tester' },
    attachments: { size: 0, map: () => [] },
    channel: { parentId: null },
    client: {},
    react: async (emoji) => record.reacted.push(emoji),
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: `${id}-scold` };
    },
  };

  return { message, record };
}

/** Nothing in this file may reach the network: a call here is the failure. */
const forbidFetch = () =>
  stubFetch(() => {
    throw new Error('the classifier must not be reached for a local rule');
  });

const wipe = () => {
  getDb().exec('DELETE FROM moderation_queue');
  resetSettings(TEST_GUILD);
  resetFloodWindows();
};

test('every local rule is off until a guild turns it on', () => {
  const loud = '@everyone @everyone <@1> <@2> <@3> https://example.com discord.gg/abcdef';
  assert.deepEqual(contentViolations(loud, rules()), []);
});

test('the invite filter catches an invite with or without a scheme', () => {
  const on = rules({ inviteFilter: true });

  for (const text of [
    'komm rüber: discord.gg/abcdef',
    'https://discord.com/invite/abcdef',
    'http://discordapp.com/invite/xY-9',
    'schau mal DISCORD.GG/AbCdEf',
  ]) {
    assert.deepEqual(contentViolations(text, on), ['invite'], `missed: ${text}`);
  }

  for (const text of ['ich mag discord', 'discord.gg ohne code', 'https://example.com/discord.gg']) {
    assert.deepEqual(contentViolations(text, on), [], `false positive: ${text}`);
  }
});

test('the link allowlist covers subdomains but nothing else', () => {
  const on = rules({ linkPolicy: 'allowlist', linkDomains: ['example.com', 'github.io'] });

  assert.deepEqual(contentViolations('https://example.com/a', on), []);
  assert.deepEqual(contentViolations('https://www.example.com/a', on), []);
  assert.deepEqual(contentViolations('https://cdn.example.com/a', on), []);
  assert.deepEqual(contentViolations('siehe https://example.com.evil.tld/a', on), ['link']);
  assert.deepEqual(contentViolations('siehe https://elsewhere.tld', on), ['link']);
  // Trailing punctuation belongs to the sentence, not to the host.
  assert.deepEqual(contentViolations('guck: https://example.com/a.', on), []);
  // A masked link hides the URL from a reader, not from the rule.
  assert.deepEqual(contentViolations('[harmlos](https://elsewhere.tld/x)', on), ['link']);
});

test('an invite is one thing the member did, so it gets one slug', () => {
  // Both rules match the same link; two categories on one message would read as
  // two separate offences in the log and in the warning DM.
  const both = rules({ inviteFilter: true, linkPolicy: 'allowlist', linkDomains: [] });
  assert.deepEqual(contentViolations('https://discord.gg/abcdef', both), ['invite']);
});

test('the mention cap counts users, roles and mass pings, but not channels', () => {
  const on = rules({ mentionCap: 3 });

  assert.deepEqual(contentViolations('<@1> <@!2> <@&3>', on), [], 'exactly at the cap');
  assert.deepEqual(contentViolations('<@1> <@!2> <@&3> <@4>', on), ['mentions']);
  assert.deepEqual(contentViolations('@everyone @here <@1> <@2>', on), ['mentions']);
  assert.deepEqual(contentViolations('<#1> <#2> <#3> <#4> <#5>', on), [], 'channel links ping nobody');
});

test('a flood trips once per burst, not once per message', () => {
  resetFloodWindows();
  const on = rules({ floodRule: { messages: 3, seconds: 10 } });
  const at = (second) => 1_000_000 + second * 1000;

  // Three in the window are fine; the fourth is the flood.
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(0)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(1)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(2)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(3)), true);

  // Everything else in the same burst is counted but answered for already.
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(4)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(5)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(6)), false);

  // A second burst after the cooldown is a second incident.
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(14)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(15)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(16)), false);
  assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, at(17)), true);
});

test('flood windows are swept, but never one still serving a cooldown', () => {
  resetFloodWindows();
  const on = rules({ floodRule: { messages: 3, seconds: 10 } });
  const start = 3_000_000;

  // One member who actually tripped the rule, so their entry is in cooldown.
  for (const offset of [0, 1, 2, 3]) floodViolation(TEST_GUILD, 'tripper', on, start + offset);

  // Enough idle members to push the map past the sweep threshold.
  for (let index = 0; index <= 1000; index++) {
    floodViolation(TEST_GUILD, `quiet-${index}`, on, start + 4);
  }

  // Well past the window, but still inside the tripper's cooldown (one window
  // from the trip). The sweep runs and has to leave that one alone: dropping it
  // would end the cooldown early, and the next message in the same burst would
  // trip the rule a second time, which is the whole thing "once per burst"
  // exists to prevent.
  floodViolation(TEST_GUILD, 'someone-new', on, start + 11_000);
  assert.equal(floodViolation(TEST_GUILD, 'tripper', on, start + 11_100), false, 'still cooling down');

  // Once the cooldown has passed too, the entry is reclaimable like any other.
  floodViolation(TEST_GUILD, 'someone-else', on, start + 60_000);
  assert.equal(
    floodViolation(TEST_GUILD, 'tripper', on, start + 60_001),
    false,
    'and a returning member starts from an empty window rather than mid-burst',
  );
});

test('the flood window is per member and per guild', () => {
  resetFloodWindows();
  const on = rules({ floodRule: { messages: 2, seconds: 10 } });
  const now = 2_000_000;

  for (const guild of ['1', '2']) {
    for (const user of ['a', 'b']) {
      assert.equal(floodViolation(guild, user, on, now), false);
      assert.equal(floodViolation(guild, user, on, now + 1), false);
    }
  }

  // Only the member who actually sent a third message trips.
  assert.equal(floodViolation('1', 'a', on, now + 2), true);
  assert.equal(floodViolation('1', 'b', on, now + 2), true);
  assert.equal(floodViolation('2', 'a', on, now + 2), true);
});

test('messages spread out over time never trip the rule', () => {
  resetFloodWindows();
  const on = rules({ floodRule: { messages: 3, seconds: 10 } });

  for (let index = 0; index < 20; index += 1) {
    assert.equal(floodViolation(TEST_GUILD, TEST_USER, on, 3_000_000 + index * 9000), false);
  }
});

test('a local rule flags the message without ever calling the provider', async () => {
  wipe();
  updateSettings(TEST_GUILD, { 'invite-filter': true });
  const restore = forbidFetch();

  try {
    const { message, record } = fakeMessage({ text: 'komm zu discord.gg/abcdef' });
    const verdict = await checkMessage(message);

    assert.equal(verdict.action, 'flagged');
    assert.deepEqual(verdict.categories, ['invite']);
    // The same treatment a classified violation gets: reaction, scold, queue row.
    assert.equal(record.reacted.length, 1);
    assert.equal(record.replies.length, 1);
    assert.equal(findRow(message.id)?.categories.join(), 'invite');
  } finally {
    restore();
    wipe();
  }
});

test('a message no local rule objects to still goes to the provider', async () => {
  wipe();
  updateSettings(TEST_GUILD, { 'invite-filter': true });
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return new Response(
      JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  try {
    const { message } = fakeMessage({ text: 'ein ganz normaler satz' });
    assert.equal((await checkMessage(message)).action, 'ok');
    assert.equal(calls, 1, 'the local rules are a layer in front, not a replacement');
  } finally {
    restore();
    wipe();
  }
});

test('an edit that adds an invite is caught, and the deadline stays put', async () => {
  wipe();
  updateSettings(TEST_GUILD, { 'invite-filter': true });
  const restore = forbidFetch();

  try {
    // Posting clean and editing afterwards would otherwise walk past every
    // local rule, the same hole `recheckMessage` exists to close.
    const { message } = fakeMessage({ text: 'jetzt doch: discord.gg/abcdef' });
    const dueAt = new Date(Date.now() + 600_000).toISOString();
    enqueue({
      messageId: message.id,
      guildId: TEST_GUILD,
      channelId: CHANNEL,
      userId: TEST_USER,
      categories: ['harassment'],
      warnedAt: new Date().toISOString(),
      dueAt,
      scoldMessageId: null,
    });

    const verdict = await recheckMessage(message);

    assert.deepEqual(verdict.categories, ['invite']);
    assert.equal(verdict.dueAt, dueAt, 'editing one violation into another buys no new grace');
    assert.equal(findRow(message.id).categories.join(), 'invite');
  } finally {
    restore();
    wipe();
  }
});

test('an edit is not a new message, so it cannot trip the flood rule', async () => {
  wipe();
  updateSettings(TEST_GUILD, { flood: '2/10' });
  const restore = stubFetch(() =>
    new Response(
      JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

  try {
    const { message } = fakeMessage({ text: 'harmlos' });
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await recheckMessage(message)).action, 'ok', `edit ${index} tripped the rule`);
    }
  } finally {
    restore();
    wipe();
  }
});
