/**
 * The nap window itself: the arithmetic, and what the environment refuses.
 *
 * A window that crosses midnight is the normal case for a cat and the one that
 * is easy to get wrong, so it gets its own file with fixed hours (23 to 6) and
 * dates handed in rather than read off the clock.
 */
import './setup-naps-night.js';
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { napping } from '../src/naps.js';

/** A local-time date at the given hour, which is what `napping` reads. */
const at = (hour) => new Date(2026, 0, 15, hour, 30, 0);

test('the window is read as "after the start or before the end", not "between"', () => {
  assert.deepEqual({ ...config.naps }, { startHour: 23, endHour: 6 });

  for (const hour of [23, 0, 1, 3, 5]) {
    assert.equal(napping(at(hour)), true, `asleep at ${hour}`);
  }
  for (const hour of [6, 7, 12, 18, 22]) {
    assert.equal(napping(at(hour)), false, `awake at ${hour}`);
  }
});

test('the edges belong to the hours they are written as', () => {
  // Inclusive at the start, exclusive at the end, the same way "23-6" reads to
  // somebody writing it: she goes to sleep at 23:00 and is up at 06:00.
  assert.equal(napping(at(22)), false);
  assert.equal(napping(new Date(2026, 0, 15, 23, 0, 0)), true);
  assert.equal(napping(new Date(2026, 0, 16, 5, 59, 59)), true);
  assert.equal(napping(new Date(2026, 0, 16, 6, 0, 0)), false);
});

test('a window the operator cannot have meant is refused at startup', async () => {
  const previous = process.env.NAP_HOURS;
  // "3-3" is either no nap or a permanent one, and a bot that went silent
  // forever over a typo is the reason this is not guessed at.
  for (const raw of ['3-3', '25-6', '-1-6', 'abc', '23', '1-2-3', '23-6.5']) {
    process.env.NAP_HOURS = raw;
    try {
      await assert.rejects(
        () => import(`../src/config.js?naps=${encodeURIComponent(raw)}`),
        /NAP_HOURS/,
        raw,
      );
    } finally {
      process.env.NAP_HOURS = previous;
    }
  }
});

test('no window at all means she never sleeps', async () => {
  const previous = process.env.NAP_HOURS;
  process.env.NAP_HOURS = '';
  try {
    const { config: fresh } = await import('../src/config.js?naps=empty');
    assert.equal(fresh.naps.startHour, null);
  } finally {
    process.env.NAP_HOURS = previous;
  }
});
