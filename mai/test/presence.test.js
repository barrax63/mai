/**
 * The rotating custom status.
 *
 * Small, but it owns two things worth pinning down: the status text comes from
 * the content config like everything else Mai says, and the rotation interval is
 * clamped to what a Node timer can actually hold. It also must never keep the
 * process alive: a cat status is not a reason for the container to refuse to
 * shut down.
 */
import './setup-presence.js';
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityType } from 'discord.js';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { startPresenceRotation } from '../src/gateway/presence.js';

const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Starts the rotation with the timer captured instead of armed, and fires that
 * timer `rotations` times before anything is restored.
 *
 * @param {{ random?: () => number, rotations?: number }} [options]
 */
function startCaptured({ random, rotations = 0 } = {}) {
  const presences = [];
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  const realRandom = Math.random;

  globalThis.setInterval = (callback, ms) => {
    const timer = { unrefs: 0, unref() { this.unrefs += 1; return this; } };
    intervals.push({ ms, callback, timer });
    return timer;
  };
  if (random) Math.random = random;

  try {
    startPresenceRotation({ user: { setPresence: (payload) => presences.push(payload) } });
    for (let round = 0; round < rotations; round++) intervals[0].callback();
  } finally {
    globalThis.setInterval = realSetInterval;
    Math.random = realRandom;
  }

  return { presences, intervals };
}

test('a status is set immediately, not only after the first interval', () => {
  const { presences } = startCaptured();

  assert.equal(presences.length, 1);
  assert.equal(presences[0].status, 'online');
});

test('the status text comes from the content config, as a custom activity', () => {
  const { presences } = startCaptured();
  const [activity] = presences[0].activities;

  assert.equal(activity.type, ActivityType.Custom);
  assert.ok(content.presence.statuses.includes(activity.state), activity.state);
  // Discord requires a name on a custom activity even though it shows `state`.
  assert.ok(activity.name);
});

test('the same status is never picked twice in a row', () => {
  // Second draw lands on the status that is already showing: the picker has to
  // draw again rather than "rotate" to the same line.
  const draws = [0, 0, 0.5, 0];
  const { presences } = startCaptured({ random: () => draws.shift() ?? 0.9, rotations: 2 });

  const states = presences.map((presence) => presence.activities[0].state);

  assert.equal(states.length, 3);
  assert.notEqual(states[0], states[1]);
  assert.notEqual(states[1], states[2]);
});

test('an absurd interval is clamped instead of overflowing into a tight loop', () => {
  assert.ok(config.presence.rotateHours * 3_600_000 > MAX_INTERVAL_MS, 'the test asks for an absurd one');

  const { intervals } = startCaptured();

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, MAX_INTERVAL_MS);
});

test('the rotation timer never keeps the process alive', () => {
  const { intervals } = startCaptured();

  assert.equal(intervals[0].timer.unrefs, 1);
});
