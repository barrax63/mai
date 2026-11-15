/**
 * The rotating custom status.
 *
 * Small, but it owns two things worth pinning down: the status text comes from
 * the content config like everything else Mai says, and the rotation interval is
 * clamped to what a Node timer can actually hold. It also must never keep the
 * process alive: a cat status is not a reason for the container to refuse to
 * shut down. And for the first half hour of a process she is back from the vet,
 * which ends on its own rather than at the next rotation.
 */
import './setup-presence.js';
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityType } from 'discord.js';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { startPresenceRotation } from '../src/gateway/presence.js';
import { season } from '../src/seasons.js';
import { rollZoomies } from '../src/zoomies.js';

const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Starts the rotation with both timers captured instead of armed, and fires the
 * interval `rotations` times before anything is restored.
 *
 * `uptime` is how long the process has been running, in seconds, which is the
 * clock the vet window reads. An hour by default, so a test about something
 * else is not looking at a cat who just got back from the vet.
 *
 * @param {{ random?: () => number, rotations?: number, uptime?: number }} [options]
 */
function startCaptured({ random, rotations = 0, uptime = 3600 } = {}) {
  const presences = [];
  const intervals = [];
  const timeouts = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realUptime = process.uptime;
  const realRandom = Math.random;

  const fakeTimer = () => ({ unrefs: 0, unref() { this.unrefs += 1; return this; } });
  globalThis.setInterval = (callback, ms) => {
    const timer = fakeTimer();
    intervals.push({ ms, callback, timer });
    return timer;
  };
  globalThis.setTimeout = (callback, ms) => {
    const timer = fakeTimer();
    timeouts.push({ ms, callback, timer });
    return timer;
  };
  process.uptime = () => uptime;
  if (random) Math.random = random;

  try {
    startPresenceRotation({ user: { setPresence: (payload) => presences.push(payload) } });
    for (let round = 0; round < rotations; round++) intervals[0].callback();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    process.uptime = realUptime;
    Math.random = realRandom;
  }

  return { presences, intervals, timeouts };
}

const stateOf = (presence) => presence.activities[0].state;

test('a status is set immediately, not only after the first interval', () => {
  const { presences } = startCaptured();

  assert.equal(presences.length, 1);
  assert.equal(presences[0].status, 'online');
});

test('the status text comes from the content config, as a custom activity', () => {
  const { presences } = startCaptured();
  const [activity] = presences[0].activities;
  // The everyday list, unless today belongs to a season that brings its own:
  // read off the calendar rather than assumed, or this test would start
  // failing every December.
  const ordinary = season()?.statuses ?? content.presence.statuses;

  assert.equal(activity.type, ActivityType.Custom);
  assert.ok(ordinary.includes(activity.state), activity.state);
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

test('a freshly started process is back from the vet, and says so', () => {
  const { presences, timeouts } = startCaptured({ uptime: 5 });

  assert.ok(content.presence.vet.includes(stateOf(presences[0])), stateOf(presences[0]));
  // Measured from when the process started, not from when the status was set.
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, config.presence.vetMs - 5_000);
  assert.equal(timeouts[0].timer.unrefs, 1, 'getting over it keeps nobody alive');
});

test('she gets over it on her own, without waiting hours for the next rotation', () => {
  const { presences, timeouts } = startCaptured({ uptime: 5 });
  const ordinary = season()?.statuses ?? content.presence.statuses;

  timeouts[0].callback();

  assert.equal(presences.length, 2, 'the status changed when the vet trip ended');
  assert.ok(ordinary.includes(stateOf(presences[1])), stateOf(presences[1]));
});

test('a process that has been up a while was never at the vet', () => {
  const { presences, timeouts } = startCaptured({ uptime: config.presence.vetMs / 1000 + 1 });
  const ordinary = season()?.statuses ?? content.presence.statuses;

  assert.ok(ordinary.includes(stateOf(presences[0])), stateOf(presences[0]));
  assert.equal(timeouts.length, 0, 'and has nothing to get over');
});

test('a burst beats the vet in the status, and the vet comes back after it', () => {
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  let end = null;

  const { presences } = startCaptured({ uptime: 5 });
  globalThis.setTimeout = (callback) => {
    end = callback;
    return { unref() { return this; } };
  };
  try {
    Math.random = () => 0;
    assert.equal(rollZoomies(), true, 'the roll started a burst');
    Math.random = realRandom;
    end();
  } finally {
    Math.random = realRandom;
    globalThis.setTimeout = realSetTimeout;
  }

  const [before, during, after] = presences.map(stateOf);
  assert.ok(content.presence.vet.includes(before), before);
  assert.ok(content.presence.zoomies.includes(during), during);
  assert.ok(content.presence.vet.includes(after), after);
});
