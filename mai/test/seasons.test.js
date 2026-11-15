/**
 * Seasons: the days of the year Mai is a different cat on.
 *
 * The file runs inside a season that covers today (see setup-seasons.js), which
 * is what lets the prompt and the presence be shown to change without a clock
 * seam in either. First the property a season must not have: moderation does
 * not know what time of year it is. Then the two things it does change, and
 * finally the calendar arithmetic, against lists handed in rather than the
 * shipped one, so that rewriting the YAML cannot quietly change what the tests
 * prove.
 */
import './setup-gateway.js';
import { TODAY_SEASON } from './setup-seasons.js';
import { openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ActivityType } from 'discord.js';
import { parse } from 'yaml';
import { buildMessages } from '../src/ai/chat.js';
import { compileSeasons, content } from '../src/content.js';
import { depth, findRow } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';
import { startPresenceRotation } from '../src/gateway/presence.js';
import { onSeasonChange, season, startSeasons } from '../src/seasons.js';
import { rollZoomies } from '../src/zoomies.js';

await openTestDatabase();

const BOT = '890000000000000000';
const CHANNEL = '890000000000000020';
const NO_VIOLATIONS = { count: 0, categories: [] };

const wipe = () => {
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM chat_history');
};

function fakeMessage({ id, text, mentionsBot = false }) {
  const record = { reacted: [], replies: [] };

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

/** `/moderations` with the given verdict, `/chat/completions` with a reply, prompts kept. */
function stubApi({ flagged = false, categories = [] } = {}) {
  const calls = { moderation: 0, chat: 0, prompts: [] };
  const restore = stubFetch((url, options) => {
    let body;
    if (url.endsWith('/moderations')) {
      calls.moderation += 1;
      body = {
        results: [{ flagged, categories: Object.fromEntries(categories.map((name) => [name, true])) }],
      };
    } else {
      calls.chat += 1;
      calls.prompts.push(JSON.parse(options.body).messages);
      body = { choices: [{ message: { role: 'assistant', content: 'miau' } }] };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, restore };
}

/**
 * Starts the rotation with its interval disarmed, in a process that has been up
 * an hour (one started a moment ago is back from the vet, which outranks a
 * season and is presence.test.js's business), and returns what it set.
 */
function startCapturedPresence() {
  const presences = [];
  const realSetInterval = globalThis.setInterval;
  const realUptime = process.uptime;
  globalThis.setInterval = () => ({ unref() { return this; } });
  process.uptime = () => 3600;
  try {
    startPresenceRotation({ user: { setPresence: (payload) => presences.push(payload) } });
  } finally {
    globalThis.setInterval = realSetInterval;
    process.uptime = realUptime;
  }
  return presences;
}

const states = (presences) => presences.map((presence) => presence.activities[0].state);

/** One season, compiled the way the shipped file is. */
const only = (from, to) => compileSeasons([{ name: 'probe', from, to, directive: 'probe' }]);

test('the test file is actually running inside a season', () => {
  assert.equal(season()?.name, TODAY_SEASON.name);
});

test('a violation during a season is still classified and queued, which is the point', async () => {
  wipe();
  const { message } = fakeMessage({ id: '891000000000000001', text: 'du wicht' });
  const { calls, restore } = stubApi({ flagged: true, categories: ['harassment'] });

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.moderation, 1, 'the message was classified');
  assert.equal(depth(), 1, 'and queued for enforcement');
  assert.ok(findRow('891000000000000001'));
});

test('a mention is answered with the season in the prompt', async () => {
  wipe();
  const { message, record } = fakeMessage({
    id: '891000000000000002',
    text: 'Mai, was machst du so?',
    mentionsBot: true,
  });
  const { calls, restore } = stubApi();

  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }

  assert.equal(calls.chat, 1);
  assert.ok(calls.prompts[0][0].content.includes(TODAY_SEASON.directive), 'the season reached the model');
  assert.equal(record.replies.length, 1, 'and she answered as usual');
});

test('the season is added to the tone in force, never in place of it', () => {
  const calm = buildMessages({ history: [], username: 'noah', content: 'hi', violations: NO_VIOLATIONS })[0]
    .content;
  assert.ok(calm.includes(content.chat.friendlyDirective));
  assert.ok(calm.includes(TODAY_SEASON.directive));

  const hissing = buildMessages({
    history: [],
    username: 'noah',
    content: 'hi',
    violations: { count: 3, categories: ['harassment'] },
  })[0].content;

  assert.ok(hissing.includes(TODAY_SEASON.directive), 'the season is in there');
  assert.ok(hissing.includes(content.chat.flagged.tones.at(-1)), 'and so is the tone');
  assert.equal(hissing.includes(content.chat.friendlyDirective), false);
  // The notice stays last: everything after it is the conversation.
  assert.ok(hissing.endsWith(content.chat.prompt.untrustedNotice));
});

test('the presence rotates through the season statuses', () => {
  const [activity] = startCapturedPresence()[0].activities;

  assert.equal(activity.type, ActivityType.Custom);
  assert.ok(TODAY_SEASON.statuses.includes(activity.state), activity.state);
});

test('a burst beats the season in the status, and the season comes back after it', () => {
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  let end = null;
  globalThis.setTimeout = (callback) => {
    end = callback;
    return { unref() { return this; } };
  };

  let presences;
  try {
    presences = startCapturedPresence();
    Math.random = () => 0;
    assert.equal(rollZoomies(), true, 'the roll started a burst');
    Math.random = realRandom;
    end();
  } finally {
    Math.random = realRandom;
    globalThis.setTimeout = realSetTimeout;
  }

  const [before, during, after] = states(presences);
  assert.ok(TODAY_SEASON.statuses.includes(before), before);
  assert.ok(content.presence.zoomies.includes(during), during);
  assert.ok(TODAY_SEASON.statuses.includes(after), after);
});

test('the shipped calendar compiles', () => {
  const shipped = parse(readFileSync(new URL('../config/mai.yaml', import.meta.url), 'utf8'));
  const seasons = compileSeasons(shipped.seasons);

  assert.ok(seasons.length > 0, 'the image ships with some');
  // A season lasts days or weeks, and a directive that does not say so would
  // put the Christmas tree into every single reply for three weeks.
  for (const entry of seasons) {
    assert.ok(entry.directive.includes('nicht in jeder Antwort'), entry.name);
  }
});

test('both ends of a season are days in it', () => {
  const advent = only('12-01', '12-24');

  assert.equal(season(new Date(2026, 10, 30, 23, 59), advent), null);
  assert.equal(season(new Date(2026, 11, 1, 0, 0), advent)?.name, 'probe');
  assert.equal(season(new Date(2026, 11, 24, 23, 59), advent)?.name, 'probe');
  assert.equal(season(new Date(2026, 11, 25, 0, 0), advent), null);
});

test('a season can run over new year', () => {
  const fireworks = only('12-31', '01-01');

  assert.equal(season(new Date(2026, 11, 30), fireworks), null);
  assert.equal(season(new Date(2026, 11, 31), fireworks)?.name, 'probe');
  assert.equal(season(new Date(2027, 0, 1), fireworks)?.name, 'probe');
  assert.equal(season(new Date(2027, 0, 2), fireworks), null);
  // Not "between 12-31 and 01-01", which is no day at all.
  assert.equal(season(new Date(2027, 5, 15), fireworks), null);
});

test('a one-day season is a real season, and 29 February is a day like any other', () => {
  assert.equal(season(new Date(2026, 9, 31), only('10-31', '10-31'))?.name, 'probe');
  assert.equal(season(new Date(2026, 10, 1), only('10-31', '10-31')), null);

  const leap = only('02-29', '02-29');
  assert.equal(season(new Date(2028, 1, 29), leap)?.name, 'probe');
  assert.equal(season(new Date(2027, 1, 28), leap), null);
  assert.equal(season(new Date(2027, 2, 1), leap), null);
});

test('two seasons on the same day are refused, not resolved by their order', () => {
  const entry = (name, from, to) => ({ name, from, to, directive: name });

  assert.throws(
    () => compileSeasons([entry('advent', '12-01', '12-26'), entry('feiertage', '12-24', '12-31')]),
    /"advent" and "feiertage" overlap on 12-24/,
  );
  // Across new year, which is where an off-by-one would hide.
  assert.throws(
    () => compileSeasons([entry('silvester', '12-31', '01-01'), entry('neujahr', '01-01', '01-06')]),
    /overlap on 01-01/,
  );
  // Touching is not overlapping.
  assert.equal(
    compileSeasons([entry('advent', '12-01', '12-26'), entry('zwischen', '12-27', '12-30')]).length,
    2,
  );
});

test('a day that is not on the calendar is refused', () => {
  for (const raw of ['13-01', '00-10', '12-00', '02-30', '04-31', '1-5', '12/24', '2026-12-24', ' ', 1224]) {
    assert.throws(
      () => compileSeasons([{ name: 'probe', from: raw, to: '12-31', directive: 'probe' }]),
      /seasons\.0\.from/,
      String(raw),
    );
  }
});

test('a name is a short slug, and each one is used once', () => {
  assert.throws(
    () => compileSeasons([{ name: 'Weihnachten!', from: '12-01', to: '12-02', directive: 'x' }]),
    /slug/,
  );
  assert.throws(
    () =>
      compileSeasons([
        { name: 'advent', from: '12-01', to: '12-02', directive: 'x' },
        { name: 'advent', from: '12-05', to: '12-06', directive: 'x' },
      ]),
    /defined twice/,
  );
});

test('no seasons at all is a valid year; a malformed list is a typo', () => {
  assert.deepEqual(compileSeasons(undefined), []);
  assert.equal(season(new Date(2026, 11, 24), compileSeasons(undefined)), null);

  assert.throws(() => compileSeasons('weihnachten'), /must be an array/);
  // A season with nothing to say, or an empty status list, is a mistake rather
  // than a choice: leaving `statuses` out is how a season keeps the usual ones.
  assert.throws(() => compileSeasons([{ name: 'leer', from: '01-01', to: '01-02' }]), /directive/);
  assert.throws(
    () => compileSeasons([{ name: 'leer', from: '01-01', to: '01-02', directive: 'x', statuses: [] }]),
    /statuses/,
  );
  assert.equal(only('01-01', '01-02')[0].statuses, null);
});

test('the edge timer flips at midnight, re-arms itself and keeps nobody alive', () => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const later = new Date(noon);
  later.setDate(later.getDate() + 5);

  let now = noon;
  const timers = [];
  const changes = [];
  onSeasonChange(() => changes.push(season(now)?.name ?? null));

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms) => {
    const timer = { callback, ms, unrefs: 0, unref() { this.unrefs += 1; return this; } };
    timers.push(timer);
    return timer;
  };

  try {
    startSeasons(() => now);

    assert.equal(timers.length, 1);
    // Twelve hours to midnight, give or take a daylight-saving hour.
    assert.ok(timers[0].ms > 10 * 3_600_000 && timers[0].ms <= 13 * 3_600_000, String(timers[0].ms));
    assert.equal(timers[0].unrefs, 1);

    // Still the same season: nothing to announce, but the watch goes on.
    timers[0].callback();
    assert.deepEqual(changes, []);
    assert.equal(timers.length, 2);

    // Five days on, the season is over and the presence is told once.
    now = later;
    timers[1].callback();
    assert.deepEqual(changes, [null]);
    assert.equal(timers.length, 3);
    assert.equal(timers[2].unrefs, 1);

    timers[2].callback();
    assert.deepEqual(changes, [null], 'an ordinary day after an ordinary day is not news');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
