/**
 * Zoomies: the burst Mai gets for no reason and loses again on her own.
 *
 * Four things worth pinning down. It is bounded (a burst ends without anybody
 * ending it, and rolling again while one runs does not extend it), it is
 * visible (presence, reactions and the chat directive all read the same
 * switch), it is additive rather than a replacement (a hissing cat with the
 * zoomies still hisses), and it never keeps the process alive.
 *
 * The clock is an argument to `rollZoomies`/`inZoomies`, so none of this waits
 * on a real timer or needs a test-only setter in production code.
 */
import './setup-chat.js';
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityType } from 'discord.js';
import { buildMessages } from '../src/ai/chat.js';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { maybeReactAsCat } from '../src/gateway/events/reactions.js';
import { startPresenceRotation } from '../src/gateway/presence.js';
import { inZoomies, onZoomiesChange, rollZoomies, startZoomies } from '../src/zoomies.js';

const NO_VIOLATIONS = { count: 0, categories: [] };
const BURST_MS = () => config.zoomies.minutes * 60_000;

/** A roll that lands under the configured chance, with the end timer captured. */
function burst(now = Date.now()) {
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  let end = null;

  globalThis.setTimeout = (callback) => {
    end = callback;
    return { unrefs: 0, unref() { this.unrefs += 1; return this; } };
  };
  Math.random = () => 0;

  try {
    assert.equal(rollZoomies(now), true, 'the roll started a burst');
  } finally {
    Math.random = realRandom;
    globalThis.setTimeout = realSetTimeout;
  }

  return { end: () => end() };
}

test('a roll over the chance is an ordinary quarter hour of being a cat', () => {
  const now = Date.now();
  const realRandom = Math.random;
  Math.random = () => 0.9;

  try {
    assert.ok(config.zoomies.chance < 0.9, 'the shipped chance is well under this');
    assert.equal(rollZoomies(now), false);
    assert.equal(inZoomies(now), false);
  } finally {
    Math.random = realRandom;
  }
});

test('a burst runs out on its own, and rolling into one does not extend it', () => {
  const now = Date.now();
  const { end } = burst(now);

  assert.equal(inZoomies(now), true);
  assert.equal(inZoomies(now + BURST_MS() - 1), true);
  assert.equal(inZoomies(now + BURST_MS()), false, 'over when the window is over');

  // A second roll mid-burst is refused, so a burst cannot be walked forward
  // roll by roll into one that never ends.
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(rollZoomies(now + 1), false);
  } finally {
    Math.random = realRandom;
  }
  assert.equal(inZoomies(now + BURST_MS()), false, 'still the original window');

  end();
});

test('both edges are announced, so a status does not wait for the next rotation', () => {
  const changes = [];
  onZoomiesChange(() => changes.push(inZoomies()));

  const { end } = burst();
  assert.deepEqual(changes, [true], 'the start');

  end();
  assert.deepEqual(changes, [true, false], 'and the end');
});

test('a listener that throws is that listener\u2019s problem, not the burst\u2019s', () => {
  onZoomiesChange(() => {
    throw new Error('presence exploded');
  });

  const { end } = burst();
  assert.equal(inZoomies(), true);
  end();
});

test('the presence switches to the zoomies statuses and back', () => {
  const presences = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() { return this; } });

  let end;
  try {
    startPresenceRotation({ user: { setPresence: (payload) => presences.push(payload) } });
    // The rotation registered itself as a listener, so the burst is what
    // rotates the status here, not the interval.
    ({ end } = burst());
    end();
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  const states = presences.map((presence) => presence.activities[0].state);
  assert.equal(states.length, 3, 'startup, burst, calmed down');
  assert.ok(content.presence.statuses.includes(states[0]), states[0]);
  assert.ok(content.presence.zoomies.includes(states[1]), states[1]);
  assert.ok(content.presence.statuses.includes(states[2]), states[2]);
  assert.equal(presences[1].activities[0].type, ActivityType.Custom);
});

test('mid-burst she is far less aloof about a trigger word', async () => {
  const weakest = content.reactions
    .filter((trigger) => trigger.pattern && trigger.chance < 1)
    .sort((a, b) => a.chance - b.chance)[0];
  assert.ok(weakest, 'there is a trigger she usually ignores');

  // A roll between the normal chance and the boosted one: ignored on a calm
  // day, reacted to during a burst. Nothing else about the message changes.
  const roll = (weakest.chance + Math.min(weakest.chance * config.zoomies.reactionBoost, 1)) / 2;
  const text = 'schau mal, eine katze';
  assert.equal(weakest.pattern.test(text), true, 'the sample trips the weakest trigger');

  const react = async () => {
    const reacted = [];
    const realRandom = Math.random;
    Math.random = () => roll;
    try {
      await maybeReactAsCat({
        id: '1',
        content: text,
        react: async (emoji) => reacted.push(emoji),
      });
    } finally {
      Math.random = realRandom;
    }
    return reacted;
  };

  assert.deepEqual(await react(), [], 'calm: not worth getting up for');

  const { end } = burst();
  assert.deepEqual(await react(), [weakest.emoji], 'mid-burst: worth it');
  end();
});

test('the directive is added to the tone in force, never in place of it', () => {
  const calm = buildMessages({
    history: [],
    username: 'noah',
    content: 'hi',
    violations: NO_VIOLATIONS,
  })[0].content;
  assert.equal(calm.includes(content.chat.zoomiesDirective), false);

  const { end } = burst();
  const hissing = buildMessages({
    history: [],
    username: 'noah',
    content: 'hi',
    violations: { count: 3, categories: ['harassment'] },
  })[0].content;
  end();

  assert.ok(hissing.includes(content.chat.zoomiesDirective), 'the burst is in there');
  assert.ok(hissing.includes(content.chat.flagged.tones.at(-1)), 'and so is the tone');
  assert.equal(hissing.includes(content.chat.friendlyDirective), false);
  // The notice stays last: everything after it is the conversation.
  assert.ok(hissing.endsWith(content.chat.prompt.untrustedNotice));
});

test('neither timer keeps the process alive', () => {
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, ms) => {
    const timer = { unrefs: 0, unref() { this.unrefs += 1; return this; } };
    intervals.push({ ms, timer });
    return timer;
  };

  try {
    startZoomies();
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, config.zoomies.rollMinutes * 60_000);
  assert.equal(intervals[0].timer.unrefs, 1);
});
