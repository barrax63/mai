import { openTestDatabase, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import {
  effectiveSettings,
  rawSettings,
  resetSettings,
  updateSettings,
} from '../src/db/settings.js';

await openTestDatabase();

// Each test uses its own guild id so order never matters.
let counter = 0;
const guild = () => `9000000000000000${(counter += 1).toString().padStart(2, '0')}`;

test('a guild without a row inherits every default', () => {
  const settings = effectiveSettings(guild());

  assert.equal(settings.logChannelId, null, 'no mod log without an explicit channel');
  assert.equal(settings.welcomeChannelId, null);
  assert.equal(settings.gracePeriodMinutes, config.moderation.gracePeriodMinutes);
  assert.deepEqual(settings.inherited, {
    'log-channel': true,
    'welcome-channel': true,
    grace: true,
  });
});

test('a missing guild id (DM) still yields usable defaults', () => {
  const settings = effectiveSettings(null);
  assert.equal(settings.gracePeriodMinutes, config.moderation.gracePeriodMinutes);
  assert.equal(settings.logChannelId, null);
});

test('setting one value leaves the others inherited', () => {
  const id = guild();
  const settings = updateSettings(id, { 'log-channel': '4711' }, 'admin-1');

  assert.equal(settings.logChannelId, '4711');
  assert.equal(settings.inherited['log-channel'], false);
  assert.equal(settings.inherited.grace, true);
  assert.equal(settings.gracePeriodMinutes, config.moderation.gracePeriodMinutes);
  assert.equal(rawSettings(id).updated_by, 'admin-1');
});

test('a second update merges instead of replacing the row', () => {
  const id = guild();
  updateSettings(id, { 'log-channel': '4711' });
  const settings = updateSettings(id, { grace: 3 }, 'admin-2');

  assert.equal(settings.logChannelId, '4711', 'earlier override survives');
  assert.equal(settings.gracePeriodMinutes, 3);
  assert.equal(rawSettings(id).updated_by, 'admin-2');
});

test('grace is validated, and a bad value changes nothing', () => {
  const id = guild();
  updateSettings(id, { grace: 30 });

  for (const bad of [0, -5, 1441, 'viele']) {
    assert.throws(() => updateSettings(id, { grace: bad }), RangeError, `accepted ${bad}`);
  }
  assert.equal(effectiveSettings(id).gracePeriodMinutes, 30);
});

test('grace accepts the boundaries', () => {
  const id = guild();
  assert.equal(updateSettings(id, { grace: 1 }).gracePeriodMinutes, 1);
  assert.equal(updateSettings(id, { grace: 1440 }).gracePeriodMinutes, 1440);
});

test('unknown keys in a patch are ignored', () => {
  const id = guild();
  const settings = updateSettings(id, { nonsense: 'x', grace: 7 });

  assert.equal(settings.gracePeriodMinutes, 7);
  assert.equal('nonsense' in rawSettings(id), false);
});

test('reset clears a single setting back to inherited', () => {
  const id = guild();
  updateSettings(id, { 'log-channel': '4711', grace: 5 });
  const settings = resetSettings(id, 'grace', 'admin-3');

  assert.equal(settings.gracePeriodMinutes, config.moderation.gracePeriodMinutes);
  assert.equal(settings.inherited.grace, true);
  assert.equal(settings.logChannelId, '4711', 'other overrides untouched');
});

test('reset without a name clears everything', () => {
  const id = guild();
  updateSettings(id, { 'log-channel': '4711', 'welcome-channel': '4712', grace: 5 });
  const settings = resetSettings(id);

  assert.deepEqual(settings.inherited, {
    'log-channel': true,
    'welcome-channel': true,
    grace: true,
  });
});

test('reset rejects an unknown setting name', () => {
  assert.throws(() => resetSettings(guild(), 'nope'), RangeError);
});

test('settings are per guild', () => {
  const a = guild();
  const b = guild();
  updateSettings(a, { grace: 2 });

  assert.equal(effectiveSettings(a).gracePeriodMinutes, 2);
  assert.equal(effectiveSettings(b).gracePeriodMinutes, config.moderation.gracePeriodMinutes);
  assert.equal(effectiveSettings(TEST_GUILD).gracePeriodMinutes, config.moderation.gracePeriodMinutes);
});
