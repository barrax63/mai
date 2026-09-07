/**
 * `ZOOMIES_CHANCE=0` for a deployment that wants none of it.
 *
 * Its own file because config.js reads and freezes the environment once, and
 * "off" has to mean the dice are never rolled at all rather than rolled and
 * always lost: a burst that a stubbed `Math.random` could still produce is not
 * a switch anybody can rely on.
 */
import './setup-zoomies.js';
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { inZoomies, rollZoomies, startZoomies } from '../src/zoomies.js';

test('off means no burst, whatever the dice say', () => {
  assert.equal(config.zoomies.chance, 0);

  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(rollZoomies(), false);
    assert.equal(inZoomies(), false);
  } finally {
    Math.random = realRandom;
  }
});

test('off also means no timer, rather than one that rolls and always loses', () => {
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, ms) => {
    intervals.push(ms);
    return { unref() { return this; } };
  };

  try {
    startZoomies();
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  assert.deepEqual(intervals, []);
});

test('a chance outside 0 to 1 is refused at startup, not clamped', async () => {
  const previous = process.env.ZOOMIES_CHANCE;
  process.env.ZOOMIES_CHANCE = '2';
  try {
    // A fresh module instance: config.js validates once, at import.
    await assert.rejects(() => import('../src/config.js?zoomies-out-of-range'), /ZOOMIES_CHANCE/);
  } finally {
    process.env.ZOOMIES_CHANCE = previous;
  }
});
