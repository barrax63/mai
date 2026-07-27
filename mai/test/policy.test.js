/**
 * The per-guild moderation policy: how hard Mai judges, and where she looks.
 *
 * Both exist because the provider's defaults are not universal — its `flagged`
 * boolean is tuned for English, and no bot should be moderating a vent channel
 * just because it can read it.
 */
import './setup-moderation.js';
import { openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPolicy, classify } from '../src/ai/moderation.js';
import { parseCategoryList, parseThreshold } from '../src/config.js';
import { content } from '../src/content.js';
import { dueCount, dueRows, enqueue } from '../src/db/queue.js';
import { effectiveSettings, resetSettings, updateSettings } from '../src/db/settings.js';
import { isExemptChannel } from '../src/moderation/check.js';

await openTestDatabase();

const CHANNEL = '810000000000000001';
const THREAD = '810000000000000002';

// A German insult the provider does not flag on its own: measured at
// harassment 0.20, against 0.88 for the same words in English.
const germanVerdict = {
  flagged: false,
  categories: { harassment: false, hate: false },
  scores: { harassment: 0.2, hate: 0.02 },
};

test('without a threshold the provider decides, as before', () => {
  assert.deepEqual(applyPolicy(germanVerdict, {}), { flagged: false, categories: [] });

  const flaggedByProvider = {
    flagged: true,
    categories: { harassment: true },
    scores: { harassment: 0.88 },
  };
  assert.deepEqual(applyPolicy(flaggedByProvider, {}), {
    flagged: true,
    categories: ['harassment'],
  });
});

test('a threshold lets a guild catch what the provider misses', () => {
  // The whole point: 0.20 is under the provider's own line but over this
  // server's. A German-speaking guild can now be moderated at all.
  assert.deepEqual(applyPolicy(germanVerdict, { threshold: 0.15 }), {
    flagged: true,
    categories: ['harassment'],
  });
  assert.deepEqual(applyPolicy(germanVerdict, { threshold: 0.5 }), {
    flagged: false,
    categories: [],
  });
});

test('a threshold takes the decision over from the provider entirely', () => {
  // Otherwise raising the threshold could never make anything pass: the
  // provider's `flagged` would keep voting yes.
  const loudButAllowed = {
    flagged: true,
    categories: { harassment: true },
    scores: { harassment: 0.6 },
  };
  assert.deepEqual(applyPolicy(loudButAllowed, { threshold: 0.9 }), {
    flagged: false,
    categories: [],
  });
});

test('a category allowlist narrows what counts', () => {
  const mixed = {
    flagged: true,
    categories: { harassment: true, hate: true },
    scores: { harassment: 0.9, hate: 0.8 },
  };

  assert.deepEqual(applyPolicy(mixed, { categories: ['hate'] }), {
    flagged: true,
    categories: ['hate'],
  });
  // Nothing left after filtering means nothing to enforce, even though the
  // provider flagged the message.
  assert.deepEqual(applyPolicy(mixed, { categories: ['sexual/minors'] }), {
    flagged: false,
    categories: [],
  });
});

test('the policy reaches classify() from the guild settings', async () => {
  const restore = stubFetch(() =>
    new Response(
      JSON.stringify({
        results: [{
          flagged: false,
          categories: { harassment: false },
          category_scores: { harassment: 0.3 },
        }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

  try {
    assert.equal((await classify('x', [], {})).flagged, false, 'provider default');
    assert.equal(
      (await classify('x', [], { policy: { threshold: 0.25 } })).flagged,
      true,
      'the guild draws its own line',
    );
  } finally {
    restore();
  }
});

test('thresholds and category lists are validated at the edge', () => {
  assert.equal(parseThreshold('0.5'), 0.5);
  assert.throws(() => parseThreshold('2'), RangeError);
  assert.throws(() => parseThreshold('nope'), RangeError);

  assert.deepEqual(parseCategoryList('hate, sexual/minors ,hate'), ['hate', 'sexual/minors']);
  assert.deepEqual(parseCategoryList(''), [], 'empty means every category');
  assert.throws(() => parseCategoryList('hate;drop table'), RangeError);
});

test('an exempt channel covers its threads too', () => {
  const guildId = '820000000000000001';
  updateSettings(guildId, { 'exempt-channels': CHANNEL });

  assert.equal(isExemptChannel(guildId, CHANNEL), true);
  assert.equal(isExemptChannel(guildId, THREAD, CHANNEL), true, 'a thread of an exempt channel');
  assert.equal(isExemptChannel(guildId, THREAD), false, 'a thread elsewhere');
  assert.equal(isExemptChannel(guildId, '810000000000000009'), false);

  resetSettings(guildId, 'exempt-channels');
  assert.equal(isExemptChannel(guildId, CHANNEL), false);
});

test('exempt channels are validated as channel ids', () => {
  const guildId = '820000000000000002';
  assert.throws(() => updateSettings(guildId, { 'exempt-channels': 'not-an-id' }), RangeError);
  assert.deepEqual(effectiveSettings(guildId).exemptChannels, []);
});

test('a tick only takes as many rows as it can work through', () => {
  const guildId = '830000000000000001';
  const past = new Date(Date.now() - 60_000).toISOString();

  for (let i = 0; i < 5; i++) {
    enqueue({
      messageId: `84000000000000000${i}`,
      guildId,
      channelId: CHANNEL,
      userId: TEST_USER,
      categories: [],
      warnedAt: past,
      dueAt: past,
      scoldMessageId: null,
    });
  }

  const now = new Date().toISOString();
  assert.ok(dueCount(now) >= 5);
  assert.equal(dueRows(now, 2).length, 2, 'capped');
  // Oldest first, so a capped tick still drains in the order the backlog built.
  const capped = dueRows(now, 3);
  assert.deepEqual([...capped].sort((a, b) => a.dueAt.localeCompare(b.dueAt)), capped);
});

test('reaction triggers cannot be made stateful by a YAML flag', () => {
  // `g` or `y` would make .test() walk lastIndex, so the same message would
  // match, then not match, then match again.
  for (const trigger of content.reactions) {
    assert.equal(trigger.pattern.global, false, trigger.pattern.source);
    assert.equal(trigger.pattern.sticky, false, trigger.pattern.source);

    const sample = 'fisch katze miau gute katze';
    assert.equal(
      trigger.pattern.test(sample),
      trigger.pattern.test(sample),
      'the same input must give the same answer twice',
    );
  }
});
