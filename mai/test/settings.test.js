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
  assert.deepEqual(settings.timeoutLadder, config.moderation.timeoutLadder);
  assert.equal(settings.strikeWindowDays, config.moderation.strikeWindowDays);
  assert.deepEqual(settings.inherited, {
    enabled: true,
    escalation: true,
    'log-channel': true,
    'welcome-channel': true,
    grace: true,
    'timeout-ladder': true,
    'strike-window': true,
  });
});

test('the escalation ladder is validated and stored per guild', () => {
  const id = guild();

  assert.deepEqual(updateSettings(id, { 'timeout-ladder': '0, 5, 30' }).timeoutLadder, [0, 5, 30]);
  assert.equal(effectiveSettings(id).inherited['timeout-ladder'], false);

  for (const bad of ['', 'zehn', '5,-1', `5,${29 * 24 * 60}`]) {
    assert.throws(() => updateSettings(id, { 'timeout-ladder': bad }), RangeError, `accepted ${bad}`);
  }
  assert.deepEqual(effectiveSettings(id).timeoutLadder, [0, 5, 30], 'a bad ladder changed nothing');
});

test('the strike window is validated', () => {
  const id = guild();
  assert.equal(updateSettings(id, { 'strike-window': 7 }).strikeWindowDays, 7);

  for (const bad of [0, 366, 'lang']) {
    assert.throws(() => updateSettings(id, { 'strike-window': bad }), RangeError, `accepted ${bad}`);
  }
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
  updateSettings(id, {
    'log-channel': '4711',
    'welcome-channel': '4712',
    grace: 5,
    'timeout-ladder': '0,15',
    'strike-window': 14,
  });
  const settings = resetSettings(id);

  assert.deepEqual(settings.inherited, {
    enabled: true,
    escalation: true,
    'log-channel': true,
    'welcome-channel': true,
    grace: true,
    'timeout-ladder': true,
    'strike-window': true,
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
