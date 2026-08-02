import { openTestDatabase, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { BASE_SETTINGS } from '../src/moderation/presets.js';
import {
  configuredGuildCount,
  effectiveSettings,
  rawSettings,
  resetSettings,
  setProfile,
  updateSettings,
} from '../src/db/settings.js';
import { getDb } from '../src/db/index.js';

await openTestDatabase();

// Each test uses its own guild id so order never matters.
let counter = 0;
const guild = () => `9000000000000000${(counter += 1).toString().padStart(2, '0')}`;

test('a guild without a row inherits every default', () => {
  const settings = effectiveSettings(guild());

  assert.equal(settings.logChannelId, null, 'no mod log without an explicit channel');
  assert.equal(settings.welcomeChannelId, null);
  assert.equal(settings.gracePeriodMinutes, BASE_SETTINGS.grace);
  assert.deepEqual(settings.timeoutLadder, [0, 5, 15, 30, 60]);
  assert.equal(settings.strikeWindowDays, BASE_SETTINGS['strike-window']);
  assert.deepEqual(settings.inherited, {
    enabled: true,
    escalation: true,
    'log-channel': true,
    'welcome-channel': true,
    welcome: true,
    gifs: true,
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
  assert.equal(settings.gracePeriodMinutes, BASE_SETTINGS.grace);
  assert.equal(settings.logChannelId, null);
});

test('setting one value leaves the others inherited', () => {
  const id = guild();
  const settings = updateSettings(id, { 'log-channel': '940000000000004711' }, 'admin-1');

  assert.equal(settings.logChannelId, '940000000000004711');
  assert.equal(settings.inherited['log-channel'], false);
  assert.equal(settings.inherited.grace, true);
  assert.equal(settings.gracePeriodMinutes, BASE_SETTINGS.grace);
  assert.equal(rawSettings(id).updated_by, 'admin-1');
});

test('a second update merges instead of replacing the row', () => {
  const id = guild();
  updateSettings(id, { 'log-channel': '940000000000004711' });
  const settings = updateSettings(id, { grace: 3 }, 'admin-2');

  assert.equal(settings.logChannelId, '940000000000004711', 'earlier override survives');
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
  updateSettings(id, { 'log-channel': '940000000000004711', grace: 5 });
  const settings = resetSettings(id, 'grace', 'admin-3');

  assert.equal(settings.gracePeriodMinutes, BASE_SETTINGS.grace);
  assert.equal(settings.inherited.grace, true);
  assert.equal(settings.logChannelId, '940000000000004711', 'other overrides untouched');
});

test('reset without a name clears everything', () => {
  const id = guild();
  updateSettings(id, {
    'log-channel': '940000000000004711',
    'welcome-channel': '940000000000004712',
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
    welcome: true,
    gifs: true,
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

test('the two singular channel settings take a channel id and nothing else', () => {
  const id = guild();

  // Both arrive from a Discord CHANNEL option today, so the value is inside a
  // signature-verified payload. They are validated anyway because that is not
  // the only writer: `setProfile`'s extra and `ensureLogChannel` reach the same
  // columns, and a bad value becomes a `<#garbage>` mention in
  // `/mod config view` plus a `channels.fetch` that throws on every log write.
  for (const bad of ['#mod-log', '4711', 'not an id', '9400000000000047110000000000']) {
    for (const name of ['log-channel', 'welcome-channel']) {
      assert.throws(() => updateSettings(id, { [name]: bad }), RangeError, `${name} accepted ${bad}`);
    }
  }

  // A list is not a single channel either, however well formed its entries are.
  assert.throws(
    () => updateSettings(id, { 'log-channel': '940000000000004711,940000000000004712' }),
    RangeError,
  );

  const settings = updateSettings(id, { 'log-channel': ' 940000000000004711 ' });
  assert.equal(settings.logChannelId, '940000000000004711', 'trimmed, and stored as given');
  assert.equal(updateSettings(id, { 'log-channel': null }).logChannelId, null, 'null still clears');
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

  // Asserted on the stored value: `effectiveSettings` folds in the operator's
  // `DISCORD_MEMBER_EVENTS`, which is off in this file's environment, so what
  // it *reports* is covered by the test below instead.
  updateSettings(id, { 'name-check': 'reset' });
  assert.equal(rawSettings(id).name_check, 'reset');
  updateSettings(id, { 'name-check': ' LOG ' });
  assert.equal(rawSettings(id).name_check, 'log', 'normalized');

  for (const bad of ['ban', 'kick', 'löschen']) {
    assert.throws(() => updateSettings(id, { 'name-check': bad }), RangeError, `accepted ${bad}`);
  }
});

test('the two member-event settings are stored, but report what actually happens', () => {
  // Both ride the privileged GuildMembers intent, which only the operator can
  // request and which this file's environment does not. Storing the value
  // anyway is the point: the server is configured the moment that changes, and
  // `/mod config set` says plainly that nothing is happening yet. What the
  // settings *read* as has to be the truth, though, or a server believes it is
  // screening names when no member event will ever arrive.
  const id = guild();
  assert.equal(config.discord.memberEventsEnabled, false, 'the premise of this test');

  const settings = updateSettings(id, { 'name-check': 'reset', welcome: true });
  assert.equal(settings.nameCheck, 'off', 'reported as what happens');
  assert.equal(settings.welcomeEnabled, false);

  assert.equal(rawSettings(id).name_check, 'reset', 'but the decision is kept');
  assert.equal(rawSettings(id).welcome_enabled, 1);
  assert.equal(settings.inherited['name-check'], false, 'the guild did decide');
  assert.equal(settings.inherited.welcome, false);
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
  assert.equal(effectiveSettings(b).gracePeriodMinutes, BASE_SETTINGS.grace);
  assert.equal(effectiveSettings(TEST_GUILD).gracePeriodMinutes, BASE_SETTINGS.grace);
});

// --- The profile layer ---------------------------------------------------
//
// `/mod setup` stores a name, not a copy of six values. These cover the three
// ways that can go wrong: the profile not being read, an override not beating
// it, and a stale override surviving a switch to a different profile.

test('a profile decides the settings it covers, and says so', () => {
  const id = guild();
  const settings = setProfile(id, 'standard');

  assert.equal(settings.profile, 'standard');
  assert.equal(settings.mentionCap, 6, 'from the bundle, not the base');
  assert.equal(settings.inviteFilter, true);
  assert.deepEqual(settings.floodRule, { messages: 6, seconds: 10 });
  assert.equal(settings.source['mention-cap'], 'profile');
  // Untouched by every bundle, so it still comes from the base.
  assert.equal(settings.strikeWindowDays, BASE_SETTINGS['strike-window']);
  assert.equal(settings.source['strike-window'], 'default');
  // The whole point: one stored value, not six.
  assert.equal(rawSettings(id).mention_cap, null, 'the bundle is resolved, not copied');
  assert.equal(rawSettings(id).profile, 'standard');
});

test('an explicit setting beats the profile under it', () => {
  const id = guild();
  setProfile(id, 'standard');
  updateSettings(id, { 'mention-cap': 20 });

  const settings = effectiveSettings(id);
  assert.equal(settings.mentionCap, 20);
  assert.equal(settings.source['mention-cap'], 'set');
  assert.equal(settings.inviteFilter, true, 'the rest still comes from the profile');
});

test('switching profile drops the old overrides but keeps the channels', () => {
  const id = guild();
  const channel = '424242424242424242';
  setProfile(id, 'standard', undefined, { 'log-channel': channel });
  updateSettings(id, { 'mention-cap': 20, 'exempt-channels': channel });

  const settings = setProfile(id, 'strict');

  // Without this, a server that had run `standard` would sit on `strict` while
  // still enforcing `standard`'s cap, with `/mod config view` showing neither.
  assert.equal(settings.mentionCap, 5, 'the stale override is gone');
  assert.equal(settings.source['mention-cap'], 'profile');
  assert.equal(settings.threshold, 0.3);
  // Facts about the server, not a stance on moderation: these survive.
  assert.equal(settings.logChannelId, channel);
  assert.deepEqual(settings.exemptChannels, [channel]);
});

test('an observation window ends above the profile that started it', () => {
  const id = guild();
  const settings = setProfile(id, 'observe');
  assert.equal(settings.shadowMode, true, 'the bundle switches it on');

  // What the enforcer writes when the window runs out. The `observe` bundle
  // underneath still says true, so the explicit 0 has to win or the observation
  // period could never end.
  updateSettings(id, { shadow: false });
  assert.equal(effectiveSettings(id).shadowMode, false);
  assert.equal(effectiveSettings(id).source.shadow, 'set');
});

test('an unknown profile is refused, and a stale one falls through to the base', () => {
  const id = guild();
  assert.equal(setProfile(id, 'nope'), null);
  assert.equal(setProfile(id, 'constructor'), null, 'not a property of Object.prototype either');

  // A name that was valid when it was written and is not any more: the server
  // gets the base rather than an exception on every flagged message.
  updateSettings(id, { grace: 3 });
  getDb().prepare('UPDATE guild_settings SET profile = ? WHERE guild_id = ?').run('retired', id);

  const settings = effectiveSettings(id);
  assert.equal(settings.profile, null);
  assert.equal(settings.mentionCap, BASE_SETTINGS['mention-cap']);
  assert.equal(settings.gracePeriodMinutes, 3, 'the explicit override still applies');
});

test('a guild that only picked a profile counts as configured', () => {
  const before = configuredGuildCount();
  setProfile(guild(), 'standard');
  assert.equal(configuredGuildCount(), before + 1);
});

test('a ladder can be named instead of spelled out', () => {
  const id = guild();

  // The names are values the existing option accepts, not a new setting: what
  // is stored and what `/mod config view` shows are still the minutes.
  assert.deepEqual(updateSettings(id, { 'timeout-ladder': 'firm' }).timeoutLadder, [0, 15, 60, 360, 1440]);
  assert.equal(rawSettings(id).timeout_ladder, '0,15,60,360,1440');
  assert.deepEqual(updateSettings(id, { 'timeout-ladder': ' Gentle ' }).timeoutLadder, [0, 5, 10, 30]);

  // Still a raw list, and still refused when it is neither.
  assert.deepEqual(updateSettings(id, { 'timeout-ladder': '0,7' }).timeoutLadder, [0, 7]);
  for (const bad of ['streng', 'constructor', 'toString']) {
    assert.throws(() => updateSettings(id, { 'timeout-ladder': bad }), RangeError, `accepted ${bad}`);
  }
});
