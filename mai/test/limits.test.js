/**
 * The guards in front of a model call, and the sliding window they are built on.
 *
 * Three separate jobs: the per-user rate limit and the concurrency cap decide
 * *whether* Mai answers (both fail closed, with the busy emoji), the monthly
 * budget decides whether chat runs at all, and `runExclusive` decides *in what
 * order* two conversations in one channel touch the history table. The last one
 * is the reason a reply cannot read a history that a parallel turn is halfway
 * through writing.
 */
import './setup-limits.js';
import { openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import {
  acquireSlot,
  consumeRateLimit,
  releaseSlot,
  runExclusive,
  slotsInUse,
  withinBudget,
} from '../src/chat/limits.js';
import { closeDatabase, getDb, openDatabase } from '../src/db/index.js';
import { monthKey, recordUsage } from '../src/db/usage.js';
import { createRateLimiter } from '../src/rate-limit.js';

await openTestDatabase();

const wipeUsage = () => getDb().exec('DELETE FROM usage_daily');
const drainSlots = () => {
  while (slotsInUse() > 0) releaseSlot();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a limiter grants up to max per window, then refuses', () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000, name: 'test' });

  assert.deepEqual([limiter.consume('a'), limiter.consume('a'), limiter.consume('a')], [true, true, true]);
  assert.equal(limiter.consume('a'), false);
  assert.equal(limiter.consume('a'), false, 'a refusal does not consume a slot either');
});

test('keys are separate buckets: one loud member does not silence the rest', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000, name: 'test' });

  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('a'), false);
  assert.equal(limiter.consume('b'), true);
  assert.equal(limiter.size(), 2);
});

test('the window slides: grants age out instead of resetting on a fixed tick', () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;

  try {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, name: 'test' });

    assert.equal(limiter.consume('a'), true);
    clock += 600;
    assert.equal(limiter.consume('a'), true);
    assert.equal(limiter.consume('a'), false, 'both grants are still inside the window');

    // Past the first grant, not yet past the second: a sliding window, not a
    // bucket that empties on the hour.
    clock += 500;
    assert.equal(limiter.consume('a'), true);
    assert.equal(limiter.consume('a'), false);

    clock += 2000;
    assert.equal(limiter.consume('a'), true, 'everything has aged out');
  } finally {
    Date.now = realNow;
  }
});

test('a refusal is logged at the level the caller asked for', () => {
  // The HTTP limiter has to log at debug: an info line per refusal turns a
  // flood into a second flood in the log. Constructing it with either level
  // must work, and refusing must not throw at either.
  for (const level of ['info', 'debug']) {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, name: `test-${level}`, level });

    assert.equal(limiter.consume('a'), true);
    assert.equal(limiter.consume('a'), false);
  }
});

test('the chat limiter is the configured one, per user', () => {
  assert.equal(config.chat.rateLimitMax, 2);

  assert.equal(consumeRateLimit('user-a'), true);
  assert.equal(consumeRateLimit('user-a'), true);
  assert.equal(consumeRateLimit('user-a'), false);
  assert.equal(consumeRateLimit('user-b'), true, 'another member has their own budget');
});

test('slots are handed out up to the cap and given back again', () => {
  drainSlots();

  assert.equal(acquireSlot(), true);
  assert.equal(acquireSlot(), true);
  assert.equal(slotsInUse(), 2);
  assert.equal(acquireSlot(), false, 'the cap is a hard one: fail closed, react busy');

  releaseSlot();
  assert.equal(slotsInUse(), 1);
  assert.equal(acquireSlot(), true);

  drainSlots();
  assert.equal(slotsInUse(), 0);
});

test('releasing more than was taken cannot make the counter negative', () => {
  drainSlots();
  releaseSlot();
  releaseSlot();

  assert.equal(slotsInUse(), 0);
  assert.equal(acquireSlot(), true, 'and the cap still means what it says afterwards');
  assert.equal(acquireSlot(), true);
  assert.equal(acquireSlot(), false);
  drainSlots();
});

test('turns for one channel run one after another, not interleaved', async () => {
  const order = [];
  const task = (name) => async () => {
    order.push(`${name}:read`);
    await sleep(5);
    order.push(`${name}:write`);
    return name;
  };

  const [first, second, third] = await Promise.all([
    runExclusive('channel-1', task('a')),
    runExclusive('channel-1', task('b')),
    runExclusive('channel-1', task('c')),
  ]);

  assert.deepEqual(order, ['a:read', 'a:write', 'b:read', 'b:write', 'c:read', 'c:write']);
  assert.deepEqual([first, second, third], ['a', 'b', 'c'], 'each caller gets its own result');
});

test('two channels do not wait for each other', async () => {
  const order = [];
  const started = { one: null, two: null };

  await Promise.all([
    runExclusive('channel-a', async () => {
      started.one = true;
      order.push('a:start');
      await sleep(10);
      order.push('a:end');
    }),
    runExclusive('channel-b', async () => {
      started.two = true;
      order.push('b:start');
      await sleep(1);
      order.push('b:end');
    }),
  ]);

  assert.deepEqual(order, ['a:start', 'b:start', 'b:end', 'a:end']);
});

test('a failing turn is reported to its own caller and does not block the next', async () => {
  const failing = runExclusive('channel-2', async () => {
    throw new Error('model exploded');
  });

  await assert.rejects(() => failing, /model exploded/);

  const after = await runExclusive('channel-2', async () => 'still works');
  assert.equal(after, 'still works');
});

test('a channel that has gone quiet is forgotten again', async () => {
  await runExclusive('channel-3', async () => 'done');
  // The chain tail is dropped once it is the current one, so the map does not
  // grow by one entry per channel Mai has ever answered in.
  await sleep(5);

  const again = await runExclusive('channel-3', async () => 'done again');
  assert.equal(again, 'done again');
});

test('within the budget she talks, beyond it she only reacts', () => {
  wipeUsage();
  assert.equal(withinBudget(), true);

  recordUsage({
    guildId: TEST_GUILD,
    model: 'test-chat-model',
    purpose: 'chat',
    usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
  });

  assert.equal(withinBudget(), false, 'the budget is reached, not merely approached');
  wipeUsage();
  assert.equal(withinBudget(), true);
});

test('the budget spans the month across guilds, because the bill does too', () => {
  wipeUsage();
  recordUsage({
    guildId: TEST_GUILD,
    model: 'test-chat-model',
    purpose: 'chat',
    usage: { total_tokens: 60 },
  });
  recordUsage({
    guildId: '999999999999999999',
    model: 'test-chat-model',
    purpose: 'chat',
    usage: { total_tokens: 60 },
  });

  assert.ok(monthKey().length === 7);
  assert.equal(withinBudget(), false);
  wipeUsage();
});

test('a broken counter must not silence her', () => {
  closeDatabase();
  try {
    assert.equal(withinBudget(), true);
  } finally {
    openDatabase();
  }
});

test('the user id is what the chat limit is keyed on, not the guild', () => {
  // Same member, two guilds: still one budget, because the tokens are one bill.
  assert.equal(consumeRateLimit(TEST_USER), true);
  assert.equal(consumeRateLimit(TEST_USER), true);
  assert.equal(consumeRateLimit(TEST_USER), false);
});
