/**
 * Strike history and the escalation ladder.
 */
import { interaction, openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import {
  ACTION_DELETED,
  ACTION_SELF_DELETED,
  clearForUser,
  historyFor,
  pruneOlderThan,
  recordViolation,
  strikeCount,
  totalsFor,
} from '../src/db/violations.js';
import { routeInteraction } from '../src/interactions/router.js';
import { applyTimeout, decideEscalation, ladderFor } from '../src/moderation/escalation.js';

await openTestDatabase();

const GUILD = '710000000000000001';
const OTHER_GUILD = '710000000000000002';
const MEMBER = '720000000000000001';

const strike = (overrides = {}) =>
  recordViolation({
    guildId: GUILD,
    userId: MEMBER,
    messageId: `m-${Math.random()}`,
    categories: ['harassment'],
    action: ACTION_DELETED,
    ...overrides,
  });

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

test('the default ladder lets a first offence pass, then escalates', () => {
  assert.deepEqual(config.moderation.timeoutLadder, [0, 10, 60, 1440]);
  assert.deepEqual(ladderFor(GUILD), [0, 10, 60, 1440]);

  strike();
  assert.deepEqual(decideEscalation(GUILD, MEMBER), { strikes: 1, minutes: 0 });

  strike();
  assert.deepEqual(decideEscalation(GUILD, MEMBER), { strikes: 2, minutes: 10 });

  strike();
  assert.deepEqual(decideEscalation(GUILD, MEMBER), { strikes: 3, minutes: 60 });
});

test('the last ladder step repeats for everything above it', () => {
  strike();
  strike();
  strike();
  const { strikes, minutes } = decideEscalation(GUILD, MEMBER);

  assert.equal(strikes, 6);
  assert.equal(minutes, 1440, 'stays at the ceiling instead of running off the end');
});

test('a member with no record gets no timeout', () => {
  assert.deepEqual(decideEscalation(GUILD, 'someone-else'), { strikes: 0, minutes: 0 });
});

test('self-deleted messages are on the record but do not escalate', () => {
  const guild = '710000000000000003';
  recordViolation({
    guildId: guild,
    userId: MEMBER,
    messageId: 'm-self',
    categories: ['spam'],
    action: ACTION_SELF_DELETED,
  });

  assert.equal(decideEscalation(guild, MEMBER).strikes, 0, 'the grace period did its job');
  assert.equal(totalsFor(guild, MEMBER).total, 1, 'still recorded');
  assert.equal(totalsFor(guild, MEMBER).selfDeleted, 1);
});

test('strikes are counted per guild', () => {
  recordViolation({
    guildId: OTHER_GUILD,
    userId: MEMBER,
    messageId: 'm-other',
    categories: [],
    action: ACTION_DELETED,
  });

  assert.equal(decideEscalation(OTHER_GUILD, MEMBER).strikes, 1);
  assert.ok(decideEscalation(GUILD, MEMBER).strikes > 1, 'the other guild is unaffected');
});

test('strikes age out of the window', () => {
  const guild = '710000000000000004';
  strike({ guildId: guild, createdAt: daysAgo(40) });
  strike({ guildId: guild, createdAt: daysAgo(2) });

  // MODERATION_STRIKE_WINDOW_DAYS defaults to 30.
  assert.equal(decideEscalation(guild, MEMBER).strikes, 1, 'only the recent one counts');
  assert.equal(totalsFor(guild, MEMBER).total, 2, 'both stay in the record');

  updateSettings(guild, { 'strike-window': 60 });
  assert.equal(decideEscalation(guild, MEMBER).strikes, 2, 'a wider window counts both');
  resetSettings(guild);
});

test('a guild can define its own ladder', () => {
  const guild = '710000000000000005';
  updateSettings(guild, { 'timeout-ladder': '5,5,5' });
  strike({ guildId: guild });

  assert.deepEqual(decideEscalation(guild, MEMBER), { strikes: 1, minutes: 5 });
  resetSettings(guild);
});

test('history is newest first and keeps its categories', () => {
  const guild = '710000000000000006';
  strike({ guildId: guild, categories: ['hate'], createdAt: daysAgo(3) });
  strike({ guildId: guild, categories: ['spam'], createdAt: daysAgo(1) });

  const entries = historyFor(guild, MEMBER, 10);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].categories, ['spam'], 'newest first');
  assert.equal(entries[0].action, ACTION_DELETED);
});

test('retention drops old rows entirely', () => {
  const guild = '710000000000000007';
  strike({ guildId: guild, createdAt: daysAgo(200) });
  strike({ guildId: guild, createdAt: daysAgo(1) });

  const removed = pruneOlderThan(daysAgo(90));
  assert.ok(removed >= 1);
  assert.equal(totalsFor(guild, MEMBER).total, 1);
});

test('clearing a record only touches that member in that guild', () => {
  const guild = '710000000000000008';
  strike({ guildId: guild });
  strike({ guildId: guild, userId: 'other-member' });

  assert.equal(clearForUser(guild, MEMBER), 1);
  assert.equal(totalsFor(guild, MEMBER).total, 0);
  assert.equal(totalsFor(guild, 'other-member').total, 1);
});

test('applying a timeout asks Discord for exactly the ladder duration', async () => {
  const calls = [];
  const client = {
    guilds: {
      fetch: async () => ({
        members: {
          fetch: async () => ({
            timeout: async (ms, reason) => calls.push({ ms, reason }),
          }),
        },
      }),
    },
  };

  const result = await applyTimeout(client, {
    guildId: GUILD,
    userId: MEMBER,
    minutes: 10,
    reason: 'Mai: 2. Verstoß',
  });

  assert.equal(result.applied, true);
  assert.deepEqual(calls, [{ ms: 600_000, reason: 'Mai: 2. Verstoß' }]);
  assert.ok(result.until instanceof Date);
});

test('zero minutes never calls Discord', async () => {
  let called = false;
  const client = { guilds: { fetch: async () => { called = true; return {}; } } };

  const result = await applyTimeout(client, { guildId: GUILD, userId: MEMBER, minutes: 0 });
  assert.equal(result.applied, false);
  assert.equal(called, false);
});

test('a refused timeout is reported, not thrown, and without the raw message', async () => {
  const failure = Object.assign(new Error('Missing Permissions in #geheim-intern'), {
    name: 'DiscordAPIError',
    code: 50013,
  });

  const client = {
    guilds: {
      fetch: async () => ({
        members: {
          fetch: async () => ({
            timeout: async () => {
              throw failure;
            },
          }),
        },
      }),
    },
  };

  const result = await applyTimeout(client, { guildId: GUILD, userId: MEMBER, minutes: 10 });
  assert.equal(result.applied, false, 'refused rather than thrown');

  // `error` is shown in the guild's log channel, which is permanent Discord
  // storage. Staff get the code translated into something they can act on; the
  // raw message is free text that can quote anything the failing call touched.
  assert.ok(result.error.includes(content.moderation.errors['50013']), result.error);
  assert.ok(result.error.includes('50013'), 'the code stays, to hand to the operator');
  assert.equal(
    result.error.includes('geheim-intern'),
    false,
    'the raw message must never reach the log channel',
  );
});

test('an unmapped error code degrades to the name and the code, never the message', async () => {
  const client = {
    guilds: {
      fetch: async () => ({
        members: {
          fetch: async () => ({
            timeout: async () => {
              throw Object.assign(new Error('quota for guild #intern exceeded'), {
                name: 'DiscordAPIError',
                code: 30046,
              });
            },
          }),
        },
      }),
    },
  };

  const result = await applyTimeout(client, { guildId: GUILD, userId: MEMBER, minutes: 10 });

  assert.equal(result.error, 'DiscordAPIError code=30046');
  assert.equal(result.error.includes('#intern'), false, 'still no free text');
});

test('/mod history shows the record and the next consequence', async () => {
  const guild = TEST_GUILD;
  strike({ guildId: guild, categories: ['harassment'] });

  let body;
  await routeInteraction(
    interaction({
      type: 2,
      member: { user: { id: TEST_USER, username: 'staff' }, permissions: String(1n << 13n) },
      data: {
        name: 'mod',
        options: [
          { name: 'history', type: 1, options: [{ name: 'user', value: MEMBER }] },
        ],
      },
    }),
    (sent) => {
      body = sent;
    },
  );

  const text = body.data.content;
  assert.match(text, new RegExp(`<@${MEMBER}>`));
  assert.match(text, /Verstöße im Fenster:\*\* 1/);
  // One strike so far, so the *next* one lands on the second ladder step.
  assert.ok(text.includes('10 Minuten Timeout'), text);
  assert.equal(/\{[a-z]/i.test(text), false, `unsubstituted placeholder: ${text}`);
});

test('/mod forgive can wipe the strike record too', async () => {
  const guild = TEST_GUILD;
  assert.ok(totalsFor(guild, MEMBER).total > 0);

  let body;
  await routeInteraction(
    interaction({
      type: 2,
      member: { user: { id: TEST_USER, username: 'staff' }, permissions: String(1n << 13n) },
      data: {
        name: 'mod',
        options: [
          {
            name: 'forgive',
            type: 1,
            options: [
              { name: 'user', value: MEMBER },
              { name: 'strikes', value: true },
            ],
          },
        ],
      },
    }),
    (sent) => {
      body = sent;
    },
  );

  assert.match(body.data.content, /aus der Akte gelöscht/);
  assert.equal(totalsFor(guild, MEMBER).total, 0);
});

test('the warning DM names the timeout when there was one', async () => {
  const { buildWarning, groupByMember } = await import('../src/moderation/warning.js');
  const [group] = groupByMember([
    {
      userId: MEMBER,
      guildId: GUILD,
      content: 'boese nachricht',
      timestamp: new Date(),
      categories: ['harassment'],
    },
  ]);

  const until = new Date(Date.now() + 600_000);
  const dm = buildWarning(group, { applied: true, until, strikes: 2, minutes: 10 });
  assert.match(dm, /Verstoß Nummer 2/);
  assert.match(dm, /<t:\d+:f>/, 'Discord renders the deadline in the reader\'s timezone');

  const without = buildWarning(group, undefined);
  assert.equal(without.includes('Verstoß Nummer'), false);
  assert.ok(without.endsWith(content.moderation.warningDm.footer));
});
