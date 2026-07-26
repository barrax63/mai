/**
 * Ops: token accounting with its budget cap, and the enforcement retry counter.
 */
import { interaction, openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { bumpAttempts, dueRows, enqueue, remove } from '../src/db/queue.js';
import {
  breakdownFor,
  budgetState,
  dayKey,
  monthKey,
  recordUsage,
  totalsFor,
} from '../src/db/usage.js';
import { routeInteraction } from '../src/interactions/router.js';

await openTestDatabase();

const STAFF = { user: { id: TEST_USER, username: 'tester' }, permissions: String(1n << 13n) };

const spend = (member = STAFF) =>
  interaction({
    type: 2,
    member,
    data: { name: 'mod', options: [{ name: 'spend', type: 1 }] },
  });

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

test('day and month keys are UTC, so a restart cannot double-count', () => {
  const date = new Date('2026-07-26T23:30:00.000Z');
  assert.equal(dayKey(date), '2026-07-26');
  assert.equal(monthKey(date), '2026-07');
});

test('usage accumulates per day, guild, model and purpose', () => {
  recordUsage({
    guildId: TEST_GUILD,
    model: 'gpt-test',
    purpose: 'chat',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
  recordUsage({
    guildId: TEST_GUILD,
    model: 'gpt-test',
    purpose: 'chat',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  const totals = totalsFor(dayKey());
  assert.equal(totals.calls, 2, 'two calls collapsed into one row');
  assert.equal(totals.promptTokens, 110);
  assert.equal(totals.completionTokens, 55);
  assert.equal(totals.totalTokens, 165);
});

test('a call without usage still counts as a call', () => {
  const before = totalsFor(dayKey());
  recordUsage({ guildId: null, model: 'omni-moderation-latest', purpose: 'moderation' });
  const after = totalsFor(dayKey());

  assert.equal(after.calls, before.calls + 1);
  assert.equal(after.totalTokens, before.totalTokens, 'moderation reports no tokens');
});

test('the breakdown separates purposes and models', () => {
  const rows = breakdownFor(monthKey());
  const purposes = rows.map((row) => row.purpose);

  assert.ok(purposes.includes('chat'));
  assert.ok(purposes.includes('moderation'));
  assert.equal(rows.find((row) => row.purpose === 'chat').totalTokens, 165);
});

test('no budget configured means never exceeded', () => {
  const state = budgetState();
  assert.equal(state.budget, 0, 'OPENAI_MONTHLY_TOKEN_BUDGET defaults to 0 in tests');
  assert.equal(state.exceeded, false);
  assert.ok(state.used >= 165);
});

test('/mod spend reports today, the month and the breakdown', async () => {
  const body = await route(spend());
  const text = body.data.content;

  assert.match(text, /Heute:/);
  assert.match(text, /165/, 'the tokens recorded above show up');
  assert.ok(text.includes(content.commands.spend.budgetOff), 'no budget = no limit');
  assert.match(text, /`chat`/);
  assert.equal(/\{[a-z]/i.test(text), false, `unsubstituted placeholder: ${text}`);
});

test('/mod spend is staff-only', async () => {
  const body = await route(spend({ user: { id: TEST_USER }, permissions: '0' }));
  assert.equal(body.data.content, content.commands.forbidden);
});

test('failed enforcement attempts are counted on the row', () => {
  enqueue({
    messageId: 'stuck-1',
    guildId: TEST_GUILD,
    channelId: 'c1',
    userId: 'u1',
    categories: ['spam'],
    warnedAt: '2026-07-26T10:00:00.000Z',
    dueAt: '2026-07-26T10:00:00.000Z',
    scoldMessageId: null,
  });

  const row = dueRows('2026-07-26T11:00:00.000Z').find((entry) => entry.messageId === 'stuck-1');
  assert.equal(row.attempts, 0, 'a fresh row has none');

  assert.equal(bumpAttempts('stuck-1'), 1);
  assert.equal(bumpAttempts('stuck-1'), 2);

  const bumped = dueRows('2026-07-26T11:00:00.000Z').find((entry) => entry.messageId === 'stuck-1');
  assert.equal(bumped.attempts, 2, 'the count survives a re-read');

  remove('stuck-1');
});

test('bumping a row that is already gone does not throw', () => {
  assert.equal(bumpAttempts('never-existed'), 0);
});
