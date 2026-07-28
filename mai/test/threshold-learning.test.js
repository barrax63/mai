/**
 * Reading a threshold off a server's own traffic.
 *
 * This is the number `/mod setup observe` is run to find out, and the one that
 * used to be picked by hand from a documentation line amounting to "start around
 * 0.2 and watch", which meant finding out you were wrong by deleting things
 * people meant. The provider scores the same insult 0.88 in English and 0.20 in
 * German, so no shipped constant is right for both and the only honest source is
 * the week of real messages the observation period already watches.
 *
 * What is checked here is mostly the refusals: the cases where a week does not
 * support a number are more dangerous than the cases where it does, because a
 * confident wrong threshold deletes messages nobody complained about.
 */
import './setup-onboarding.js';
import { openTestDatabase, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKETS,
  MIN_SAMPLES,
  bucketOf,
  clearScores,
  histogram,
  recordScore,
  suggestThreshold,
} from '../src/db/shadow-scores.js';

await openTestDatabase();

/** A histogram with `count` messages in the bucket that holds `score`. */
const at = (score, count) => {
  const counts = new Array(BUCKETS).fill(0);
  counts[bucketOf(score)] = count;
  return counts;
};

const merge = (...parts) =>
  parts.reduce((total, part) => total.map((value, index) => value + part[index]));

test('a score lands in the bucket that covers it', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(0.049), 0);
  assert.equal(bucketOf(0.05), 1);
  assert.equal(bucketOf(0.99), BUCKETS - 1);
  // A score outside 0-1 is a provider surprise, not a crash.
  assert.equal(bucketOf(1), BUCKETS - 1);
  assert.equal(bucketOf(1.5), BUCKETS - 1);
  assert.equal(bucketOf(-1), 0);
});

test('a quiet week suggests nothing at all', () => {
  // Forty messages is not evidence. A percentile off this many would carry the
  // confidence of a measurement and the content of a coin flip.
  assert.equal(suggestThreshold(at(0.9, MIN_SAMPLES - 1)), null);
});

test('the threshold is the edge of the bucket holding the worst one percent', () => {
  // 990 harmless messages, 10 that score around 0.3: exactly 1%, so the line
  // lands at the bottom edge of that bucket and keeps all ten.
  const counts = merge(at(0.01, 990), at(0.32, 10));
  const suggestion = suggestThreshold(counts);

  assert.equal(suggestion.threshold, 0.3);
  assert.equal(suggestion.samples, 1000);
  assert.ok(suggestion.share >= 0.01);
});

test('a German-scoring server is met where it actually scores', () => {
  // The case the whole feature exists for: nothing here would clear the
  // provider's own `flagged`, and its worst 1% sits around 0.2.
  const counts = merge(at(0.02, 970), at(0.22, 30));
  assert.equal(suggestThreshold(counts).threshold, 0.2);
});

test('a polite server is not taught that its mildest one percent is a violation', () => {
  // Everything scores near nothing, so the percentile lands under the floor.
  // Proposing 0.05 here would turn every borderline message into a violation.
  assert.equal(suggestThreshold(at(0.01, 5000)), null);
});

test('a terrible week does not raise the bar out of reach either', () => {
  // If the worst 1% is 0.95, the ceiling refuses rather than concluding that
  // nothing short of that counts.
  assert.equal(suggestThreshold(at(0.97, 5000)), null);
});

test('the histogram is per guild and drops when it is read', () => {
  clearScores(TEST_GUILD);
  for (const score of [0.1, 0.1, 0.92]) recordScore(TEST_GUILD, score);
  recordScore('990000000000000001', 0.5);

  const counts = histogram(TEST_GUILD);
  assert.equal(counts[bucketOf(0.1)], 2);
  assert.equal(counts[bucketOf(0.92)], 1);
  assert.equal(counts[bucketOf(0.5)], 0, 'another server\'s traffic is not this one\'s');

  clearScores(TEST_GUILD);
  assert.deepEqual(histogram(TEST_GUILD), new Array(BUCKETS).fill(0));
});

test('a score that is not a number is ignored rather than stored', () => {
  clearScores(TEST_GUILD);
  for (const bad of [undefined, null, Number.NaN, 'hoch']) recordScore(TEST_GUILD, bad);

  assert.deepEqual(histogram(TEST_GUILD), new Array(BUCKETS).fill(0));
});

// --- The end of an observation period -------------------------------------

test('the window ending applies the number and offers to take it back', async () => {
  const { getDb } = await import('../src/db/index.js');
  const { effectiveSettings, startShadowWindow, updateSettings } = await import(
    '../src/db/settings.js'
  );
  const { runTick } = await import('../src/moderation/enforcer.js');

  getDb().exec('DELETE FROM guild_settings');
  clearScores(TEST_GUILD);

  // A week of German-scoring traffic: nothing the provider would flag, worst
  // 1% around 0.2.
  for (let index = 0; index < 970; index++) recordScore(TEST_GUILD, 0.02);
  for (let index = 0; index < 30; index++) recordScore(TEST_GUILD, 0.22);

  updateSettings(TEST_GUILD, { 'log-channel': '870000000000000001' });
  startShadowWindow(TEST_GUILD, 7);
  // Wind the window back so this tick is the one that finds it expired.
  getDb()
    .prepare('UPDATE guild_settings SET shadow_until = ? WHERE guild_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), TEST_GUILD);

  const sent = [];
  await runTick({
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        guildId: TEST_GUILD,
        send: async (payload) => sent.push(payload),
      }),
    },
  });

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.shadowMode, false, 'the period still ends');
  assert.equal(settings.threshold, 0.2, 'and it ends with a number read off the week');
  assert.equal(settings.source.threshold, 'set');

  const entry = sent.at(-1);
  assert.ok(entry, 'staff are told');
  assert.equal(entry.components[0].components[0].custom_id, `threshold-undo:${TEST_GUILD}`);

  // Read once and dropped: the next observation period starts from nothing
  // rather than inheriting this one's traffic.
  assert.deepEqual(histogram(TEST_GUILD), new Array(BUCKETS).fill(0));
});

test('a server that already chose a threshold is not overruled by the week', async () => {
  const { getDb } = await import('../src/db/index.js');
  const { effectiveSettings, startShadowWindow, updateSettings } = await import(
    '../src/db/settings.js'
  );
  const { runTick } = await import('../src/moderation/enforcer.js');

  getDb().exec('DELETE FROM guild_settings');
  clearScores(TEST_GUILD);
  for (let index = 0; index < 970; index++) recordScore(TEST_GUILD, 0.02);
  for (let index = 0; index < 30; index++) recordScore(TEST_GUILD, 0.22);

  updateSettings(TEST_GUILD, { threshold: 0.45 }, 'admin-1');
  startShadowWindow(TEST_GUILD, 7);
  getDb()
    .prepare('UPDATE guild_settings SET shadow_until = ? WHERE guild_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), TEST_GUILD);

  await runTick({ channels: { fetch: async () => null } });

  assert.equal(effectiveSettings(TEST_GUILD).threshold, 0.45, 'their number, not hers');
});

test('the undo button is one click, and only for this server\'s staff', async () => {
  const { interaction, TEST_USER } = await import('./setup.js');
  const { getDb } = await import('../src/db/index.js');
  const { effectiveSettings, updateSettings } = await import('../src/db/settings.js');
  const { routeInteraction } = await import('../src/interactions/router.js');

  getDb().exec('DELETE FROM guild_settings');
  updateSettings(TEST_GUILD, { threshold: 0.2 });

  const click = (overrides = {}) =>
    interaction({
      type: 3, // MESSAGE_COMPONENT
      member: { user: { id: TEST_USER, username: 'staff' }, permissions: String(1n << 13n) },
      message: { id: 'entry-1' },
      data: { custom_id: `threshold-undo:${TEST_GUILD}`, component_type: 2 },
      ...overrides,
    });

  const route = async (payload) => {
    let body;
    await routeInteraction(payload, (sent) => {
      body = sent;
    });
    return body;
  };

  // Someone without Manage Messages cannot take back a server's moderation line.
  const outsider = await route(
    click({ member: { user: { id: '999' }, permissions: '0' } }),
  );
  assert.equal(outsider.data.flags, 64, 'refused, and only to them');
  assert.equal(effectiveSettings(TEST_GUILD).threshold, 0.2, 'unchanged');

  const body = await route(click());
  assert.equal(body.type, 7, 'the entry itself is edited, so everyone sees the outcome');
  assert.deepEqual(body.data.components, [], 'and cannot be clicked twice');

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.source.threshold, 'default', 'back to profile or base');
  assert.equal(settings.inherited.threshold, true);
});
