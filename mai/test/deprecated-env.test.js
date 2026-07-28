/**
 * A retired environment variable has to be *said*, not silently ignored.
 *
 * `MODERATION_SHADOW` used to switch shadow mode on for every server that had
 * not decided for itself. Shadow mode is now a per-guild decision with a shape
 * (an observation period that ends by itself and says so), and a process-wide
 * flag could only ever produce the shapeless version of it. Dropping the
 * variable quietly would mean a deployment that carries it starts *enforcing*
 * everywhere after an update, with nothing in the log to explain why.
 */
import './setup-deprecated.js';
import './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config, deprecatedEnv } from '../src/config.js';

test('a variable that no longer does anything is reported, not obeyed', () => {
  const entry = deprecatedEnv.find((item) => item.name === 'MODERATION_SHADOW');

  assert.ok(entry, 'a stale MODERATION_SHADOW is collected for the startup log');
  // The message has to say where the behaviour went, or the reader is left
  // knowing only that something they configured is gone.
  assert.match(entry.message, /\/mod setup observe/);
  assert.match(entry.message, /\/mod config set shadow/);

  // And it really is ignored: no process-wide shadow default survives.
  assert.equal('shadow' in config.moderation, false);
});

test('a clean environment reports nothing', () => {
  assert.equal(
    deprecatedEnv.some((item) => item.name !== 'MODERATION_SHADOW'),
    false,
    'only what is actually set is reported',
  );
});
