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
    'exempt-channels': true,
    threshold: true,
    categories: true,
    'invite-filter': true,
    'link-policy': true,
    'link-domains': true,
    'mention-cap': true,
    flood: true,
    evidence: true,
    'name-check': true,
    shadow: true,
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

test('a typo is refused, not read up to the first bad character', () => {
  const id = guild();
  updateSettings(id, { grace: 30, 'strike-window': 14, 'timeout-ladder': '0,10' });

  // Each of these parses as a plausible number if the digits are simply read
  // off the front, which is what a moderator would then live with unnoticed.
  for (const bad of ['1O', '10min', '10.5', '1 0', '0x10']) {
    assert.throws(() => updateSettings(id, { grace: bad }), RangeError, `accepted grace ${bad}`);
    assert.throws(() => updateSettings(id, { 'strike-window': bad }), RangeError, `accepted window ${bad}`);
    assert.throws(
      () => updateSettings(id, { 'timeout-ladder': `0,${bad}` }),
      RangeError,
      `accepted ladder step ${bad}`,
    );
  }

  const settings = effectiveSettings(id);
  assert.equal(settings.gracePeriodMinutes, 30, 'nothing changed');
  assert.equal(settings.strikeWindowDays, 14);
  assert.deepEqual(settings.timeoutLadder, [0, 10]);
});

test('a threshold is refused the same way', () => {
  const id = guild();
  updateSettings(id, { threshold: '0.7' });

  for (const bad of ['0.7abc', '0,7', 'null']) {
    assert.throws(() => updateSettings(id, { threshold: bad }), RangeError, `accepted ${bad}`);
  }
  assert.equal(effectiveSettings(id).threshold, 0.7);
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
    'exempt-channels': true,
    threshold: true,
    categories: true,
    'invite-filter': true,
    'link-policy': true,
    'link-domains': true,
    'mention-cap': true,
    flood: true,
    evidence: true,
    'name-check': true,
    shadow: true,
  });
});

test('a link allowlist is normalized, and a URL is refused as a domain', () => {
  const id = guild();

  // A moderator typing a full URL would otherwise store an entry that can
  // never match a host, and see no reason why links keep getting flagged.
  for (const bad of ['https://example.com', 'example .com', 'not_a_domain', 'localhost']) {
    assert.throws(() => updateSettings(id, { 'link-domains': bad }), RangeError, `accepted ${bad}`);
  }

  const settings = updateSettings(id, { 'link-domains': ' Example.COM , www.github.io ,example.com' });
  assert.deepEqual(settings.linkDomains, ['example.com', 'github.io'], 'lower-cased, deduplicated');
});

test('an empty allowlist is a stricter rule, not an absent one', () => {
  const id = guild();
  const settings = updateSettings(id, { 'link-policy': 'allowlist', 'link-domains': '' });

  assert.deepEqual(settings.linkDomains, []);
  assert.equal(settings.inherited['link-domains'], false, 'no domain is allowed here, deliberately');
});

test('the flood rule is validated as count/seconds', () => {
  const id = guild();
  assert.deepEqual(updateSettings(id, { flood: '6/10' }).floodRule, { messages: 6, seconds: 10 });

  for (const bad of ['6', '6/', '/10', '6/10/2', 'sechs/10', '1/10', '51/10', '6/0', '6/3601']) {
    assert.throws(() => updateSettings(id, { flood: bad }), RangeError, `accepted ${bad}`);
  }
  assert.deepEqual(effectiveSettings(id).floodRule, { messages: 6, seconds: 10 }, 'nothing changed');

  assert.equal(updateSettings(id, { flood: 'off' }).floodRule, null);
});

test('the mention cap and the link policy take only what they can act on', () => {
  const id = guild();

  assert.equal(updateSettings(id, { 'mention-cap': 0 }).mentionCap, 0, '0 is off, not invalid');
  assert.equal(updateSettings(id, { 'mention-cap': 5 }).mentionCap, 5);
  for (const bad of [-1, 101, 'viele']) {
    assert.throws(() => updateSettings(id, { 'mention-cap': bad }), RangeError, `accepted ${bad}`);
  }

  assert.equal(updateSettings(id, { 'link-policy': 'allowlist' }).linkPolicy, 'allowlist');
  assert.throws(() => updateSettings(id, { 'link-policy': 'blocklist' }), RangeError);
});

test('name-check takes only the three modes it can act on', () => {
  const id = guild();

  assert.equal(updateSettings(id, { 'name-check': 'reset' }).nameCheck, 'reset');
  assert.equal(updateSettings(id, { 'name-check': 'off' }).nameCheck, 'off');
  assert.equal(updateSettings(id, { 'name-check': ' LOG ' }).nameCheck, 'log', 'normalized');

  for (const bad of ['ban', 'kick', 'löschen']) {
    assert.throws(() => updateSettings(id, { 'name-check': bad }), RangeError, `accepted ${bad}`);
  }
});

test('evidence stays off while the operator keeps no retention window', () => {
  const id = guild();
  const settings = updateSettings(id, { evidence: true });

  // The guild's consent is stored, but MODERATION_EVIDENCE_HOURS is 0 here, so
  // nothing is kept: whether the database holds a member's deleted words is not
  // a decision one server gets to make on its own.
  assert.equal(settings.evidenceEnabled, false);
  assert.equal(settings.inherited.evidence, false, 'the guild did decide, it just has no effect');
  assert.equal(rawSettings(id).evidence_enabled, 1);
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
