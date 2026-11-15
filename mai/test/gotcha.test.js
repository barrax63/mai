/**
 * Gotcha day: the anniversary of the day Mai moved into a server.
 *
 * First the rule every persona feature keeps: moderation does not know what
 * day it is. Then the calendar, against dates handed in rather than today's,
 * so the arithmetic is proven on the days that are easy to get wrong (the day
 * itself, the 29th of February, the edges of the local day). Then where it
 * shows: her tone in that server and nowhere else, `/mai ask` like chat, and
 * one line in `/mai mood`.
 *
 * The integration tests set the move-in date to today's date some years ago,
 * at noon, and they use four years so that a run on 29 February still lands on
 * a 29 February.
 */
import './setup-gateway.js';
import { interaction, openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessages } from '../src/ai/chat.js';
import { gotchaDay, gotchaYears } from '../src/chat/gotcha.js';
import { describeMood } from '../src/chat/mood.js';
import { mai as maiCommand } from '../src/commands/mai.js';
import { content, fill } from '../src/content.js';
import { getDb } from '../src/db/index.js';
import { depth } from '../src/db/queue.js';
import { markOnboarded, onboardedAt } from '../src/db/settings.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';

await openTestDatabase();

const YEARS = 4;
const BOT = '897500000000000000';
const CHANNEL = '897500000000000020';
const NO_VIOLATIONS = { count: 0, categories: [] };
const directive = (years) => fill(content.chat.gotchaDay, { years });

/** She moved into `guildId` on today's date, `years` years ago, at noon. */
function movedInYearsAgo(guildId, years = YEARS) {
  const today = new Date();
  markOnboarded(guildId, new Date(today.getFullYear() - years, today.getMonth(), today.getDate(), 12));
}

const wipe = () => {
  getDb().exec('DELETE FROM guild_settings');
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM chat_history');
};

let nextId = 0;
async function mention({ flagged = false, text = 'Mai, na?' } = {}) {
  nextId += 1;
  const record = { replies: [] };
  const message = {
    id: `8976${String(nextId).padStart(14, '0')}`,
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

  const calls = { moderation: 0, prompts: [] };
  const restore = stubFetch((url, options) => {
    if (url.endsWith('/moderations')) {
      calls.moderation += 1;
      return Response.json({ results: [{ flagged, categories: flagged ? { harassment: true } : {} }] });
    }
    calls.prompts.push(JSON.parse(options.body).messages);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });
  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }
  return { record, calls };
}

test('a violation on her gotcha day is classified and queued like on any other day', async () => {
  wipe();
  movedInYearsAgo(TEST_GUILD);
  assert.equal(gotchaDay(TEST_GUILD), YEARS, 'it is the day');

  const { calls } = await mention({ flagged: true, text: 'Mai, du wicht' });

  assert.equal(calls.moderation, 1);
  assert.equal(depth(), 1);
  assert.equal(calls.prompts.length, 0, 'scolded, not answered, as on any other day');
});

test('the anniversary is the same day in a later year, and only that day', () => {
  const joined = new Date(2025, 7, 2, 12).toISOString();

  assert.equal(gotchaYears(joined, new Date(2025, 7, 2, 18)), 0, 'the day she moved in is a move');
  assert.equal(gotchaYears(joined, new Date(2026, 7, 2, 0, 0)), 1);
  assert.equal(gotchaYears(joined, new Date(2026, 7, 2, 23, 59)), 1);
  assert.equal(gotchaYears(joined, new Date(2026, 7, 1, 23, 59)), 0);
  assert.equal(gotchaYears(joined, new Date(2026, 7, 3, 0, 0)), 0);
  assert.equal(gotchaYears(joined, new Date(2029, 7, 2, 9)), 4);
  // A date before she moved in is not an anniversary of anything.
  assert.equal(gotchaYears(joined, new Date(2024, 7, 2, 9)), 0);
});

test('it is the day on her own calendar, the one the move was written down on', () => {
  // Late in the evening, local time: in UTC this may already be the next day,
  // and the anniversary still has to be the local date.
  const joined = new Date(2025, 2, 10, 23, 45).toISOString();

  assert.equal(gotchaYears(joined, new Date(2026, 2, 10, 8)), 1);
  assert.equal(gotchaYears(joined, new Date(2026, 2, 11, 8)), 0);
});

test('moving in on 29 February is celebrated on the 28th in the years without one', () => {
  const joined = new Date(2024, 1, 29, 12).toISOString();

  assert.equal(gotchaYears(joined, new Date(2025, 1, 28, 12)), 1);
  assert.equal(gotchaYears(joined, new Date(2025, 2, 1, 12)), 0);
  assert.equal(gotchaYears(joined, new Date(2028, 1, 29, 12)), 4, 'on the day itself when there is one');
  assert.equal(gotchaYears(joined, new Date(2028, 1, 28, 12)), 0, 'and not the day before it');
});

test('no date is no gotcha day: a server from before introductions, a DM, a bad value', () => {
  wipe();
  assert.equal(onboardedAt(TEST_GUILD), null);
  assert.equal(gotchaDay(TEST_GUILD), 0);
  assert.equal(gotchaDay(null), 0);
  assert.equal(gotchaYears(null), 0);
  assert.equal(gotchaYears('not a date'), 0);
});

test('on the day she is extra smug in that server, and in that server only', () => {
  wipe();
  movedInYearsAgo(TEST_GUILD);
  // The other server's day is tomorrow's date, so it is not today.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  markOnboarded(OTHER_GUILD, new Date(tomorrow.getFullYear() - 2, tomorrow.getMonth(), tomorrow.getDate(), 12));

  assert.equal(gotchaDay(TEST_GUILD), YEARS);
  assert.equal(gotchaDay(OTHER_GUILD), 0);
});

test('the directive is added to the tone in force, never in place of it', () => {
  const system = (violations, gotchaYearsValue) =>
    buildMessages({
      history: [],
      username: 'noah',
      content: 'hi',
      violations,
      gotchaYears: gotchaYearsValue,
    })[0].content;

  assert.equal(system(NO_VIOLATIONS, 0).includes(directive(0)), false);
  assert.equal(system(NO_VIOLATIONS, 0).includes('Einzugstag'), false, 'nothing on an ordinary day');

  const calm = system(NO_VIOLATIONS, 2);
  assert.ok(calm.includes(directive(2)));
  assert.ok(calm.includes(content.chat.friendlyDirective));

  const hissing = system({ count: 3, categories: ['harassment'] }, 2);
  assert.ok(hissing.includes(directive(2)));
  assert.ok(hissing.includes(content.chat.flagged.tones.at(-1)), 'the tone is still in force');
  assert.ok(hissing.endsWith(content.chat.prompt.untrustedNotice));
});

test('a mention on the day reaches the model with it, and is answered as usual', async () => {
  wipe();
  movedInYearsAgo(TEST_GUILD);

  const { record, calls } = await mention();

  assert.ok(calls.prompts[0][0].content.includes(directive(YEARS)));
  assert.equal(record.replies.length, 1);
});

test('/mai ask knows the day too', async () => {
  wipe();
  movedInYearsAgo(TEST_GUILD);
  const prompts = [];
  const restore = stubFetch((url, options) => {
    if (url.endsWith('/moderations')) return Response.json({ results: [{ flagged: false, categories: {} }] });
    prompts.push(JSON.parse(options.body).messages);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });

  try {
    await maiCommand.execute(
      interaction({
        member: { user: { id: '897600000000000001', username: 'asker' }, permissions: '0' },
        data: {
          name: 'mai',
          options: [{ name: 'ask', type: 1, options: [{ name: 'frage', value: 'na?' }] }],
        },
      }),
    );
  } finally {
    restore();
  }

  assert.ok(prompts[0][0].content.includes(directive(YEARS)));
});

test('/mai mood says so on the day, in that server', () => {
  wipe();
  movedInYearsAgo(TEST_GUILD);
  const realUptime = process.uptime;
  process.uptime = () => 3600;

  try {
    const here = describeMood({ userId: TEST_USER, guildId: TEST_GUILD }).split('\n');
    assert.equal(here.length, 2);
    assert.equal(here[1], fill(content.commands.mood.gotchaDay, { years: YEARS }));

    const elsewhere = describeMood({ userId: TEST_USER, guildId: OTHER_GUILD });
    assert.equal(elsewhere.includes('\n'), false, 'one line in a server where it is not the day');
  } finally {
    process.uptime = realUptime;
  }
});

test('the shipped lines say how many years, and the directive keeps it to now and then', () => {
  assert.ok(content.chat.gotchaDay.includes('{years}'));
  assert.ok(content.commands.mood.gotchaDay.includes('{years}'));
  assert.ok(content.chat.gotchaDay.includes('nicht in jeder Antwort'));
});
