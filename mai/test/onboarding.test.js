/**
 * The three things Mai does about her own setup: notice a wedged tick loop,
 * notice a permission she has not got, and introduce herself to a new server
 * with a configuration on a button.
 *
 * The onboarding half is about *not* repeating: an introduction is a one-time
 * event, and a gateway reconnect, a restart or a re-join must not produce a
 * second one, which is why it is written to the database rather than kept in
 * memory.
 */
import './setup-onboarding.js';
import { interaction, openTestDatabase, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { getDb } from '../src/db/index.js';
import {
  configuredGuildCount,
  countShadowHit,
  effectiveSettings,
  expireShadowWindows,
  markOnboarded,
  resetSettings,
  updateSettings,
  wasOnboarded,
} from '../src/db/settings.js';
import { onGuildCreate } from '../src/gateway/events/guild-create.js';
import { setGatewayClient } from '../src/gateway/client.js';
import { routeInteraction } from '../src/interactions/router.js';
import { isWedged } from '../src/moderation/enforcer.js';
import { preset, PRESETS, PRESET_NAMES } from '../src/moderation/presets.js';
import { auditPermissions, missingPermissions, resetPermissionAudit } from '../src/permissions.js';

await openTestDatabase();

const SYSTEM_CHANNEL = '830000000000000001';
const OTHER_CHANNEL = '830000000000000002';
const LOG_CHANNEL = '830000000000000003';
const STAFF = { user: { id: TEST_USER, username: 'tester' }, permissions: String(1n << 13n) };

const wipe = () => {
  getDb().exec('DELETE FROM guild_settings');
  resetPermissionAudit();
};

/**
 * @param {{ permissions?: bigint, systemChannel?: boolean, writableOther?: boolean,
 *   guildId?: string, uncachedMe?: boolean }} [options]
 */
function fakeGuild({
  permissions = PermissionFlagsBits.Administrator,
  systemChannel = true,
  writableOther = true,
  guildId = TEST_GUILD,
  uncachedMe = false,
} = {}) {
  const record = { sent: [] };

  const me = {
    id: 'bot-1',
    permissions: {
      // discord.js answers `missing` from a bitfield; the Administrator bit
      // covers everything, which is what a normally invited bot has.
      missing: (required) =>
        required
          .filter((bit) => (permissions & bit) !== bit && permissions !== PermissionFlagsBits.Administrator)
          .map((bit) => nameOf(bit)),
    },
  };

  const channel = (id, writable) => ({
    id,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({
      has: () => writable,
      missing: (required) => (writable ? [] : required.map((bit) => nameOf(bit))),
    }),
    send: async (payload) => record.sent.push({ channelId: id, ...payload }),
  });

  const channels = new Map([[OTHER_CHANNEL, channel(OTHER_CHANNEL, writableOther)]]);
  channels.set(LOG_CHANNEL, channel(LOG_CHANNEL, writableOther));

  return {
    record,
    guild: {
      id: guildId,
      memberCount: 12,
      systemChannel: systemChannel ? channel(SYSTEM_CHANNEL, true) : null,
      members: { me: uncachedMe ? null : me },
      channels: { cache: channels },
    },
  };
}

/** Reverse lookup so a test can read the names discord.js would report. */
const nameOf = (bit) =>
  Object.entries(PermissionFlagsBits).find(([, value]) => value === bit)?.[0] ?? 'Unknown';

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

const setupCommand = (preset, logChannelId) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    member: STAFF,
    data: {
      name: 'mod',
      options: [
        {
          name: 'setup',
          type: 1,
          options: [
            { name: 'preset', value: preset },
            ...(logChannelId ? [{ name: 'log-channel', value: logChannelId }] : []),
          ],
        },
      ],
    },
  });

const configSet = (options) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    member: STAFF,
    data: {
      name: 'mod',
      options: [{ name: 'config', type: 2, options: [{ name: 'set', type: 1, options }] }],
    },
  });

const presetClick = (preset, member = STAFF) =>
  interaction({
    type: InteractionType.MESSAGE_COMPONENT,
    member,
    message: { id: 'intro-1' },
    data: { custom_id: `setup:${preset}`, component_type: 2 },
  });

test('a wedged tick loop is measured by progress, not by completion', () => {
  const tick = config.moderation.tickMs;
  const limit = config.moderation.stuckRestartTicks;
  assert.ok(limit > 0, 'the default is a watchdog that watches');

  const startedAt = 1_000_000;
  // Nothing has happened yet, but not for long enough.
  assert.equal(isWedged({ lastProgressAt: null, startedAt, now: startedAt + tick }), false);
  assert.equal(
    isWedged({ lastProgressAt: null, startedAt, now: startedAt + tick * limit + 1 }),
    true,
  );

  // A long pass through a backlog keeps reporting progress: killing that would
  // restart into the same backlog forever.
  const busy = startedAt + tick * limit * 3;
  assert.equal(isWedged({ lastProgressAt: busy, startedAt, now: busy + tick }), false);
  assert.equal(isWedged({ lastProgressAt: busy, startedAt, now: busy + tick * limit + 1 }), true);
});

test('permissions are reported per guild, and only for what is switched on', () => {
  wipe();
  const { guild } = fakeGuild({ permissions: PermissionFlagsBits.SendMessages });

  const report = missingPermissions(guild);
  assert.equal(report.known, true);
  assert.ok(report.guild.includes('ManageMessages'), 'deleting a flagged message');
  assert.ok(report.guild.includes('AddReactions'), 'the warning reaction');
  // Escalation is on by default, so the timeout permission counts.
  assert.ok(report.guild.includes('ModerateMembers'));
  assert.equal(report.guild.includes('ManageNicknames'), false, 'name-check is off here');

  updateSettings(TEST_GUILD, { escalation: false, 'name-check': 'reset' });
  const narrowed = missingPermissions(guild);
  assert.equal(narrowed.guild.includes('ModerateMembers'), false, 'no timeouts, no need');
  assert.ok(narrowed.guild.includes('ManageNicknames'), 'but resets need this');
});

test('a bot that cannot see itself says so instead of reporting all clear', () => {
  wipe();
  const { guild } = fakeGuild({ uncachedMe: true });
  const report = missingPermissions(guild);

  assert.equal(report.known, false);
  assert.deepEqual(report.guild, []);
});

test('the audit reports once per guild per process', () => {
  wipe();
  resetPermissionAudit();
  const { guild } = fakeGuild({ permissions: PermissionFlagsBits.SendMessages });

  // Both calls answer; the second simply does not log again. What matters here
  // is that the answer never changes shape.
  assert.deepEqual(auditPermissions(guild).guild, auditPermissions(guild).guild);
});

test('joining a server produces one introduction with the presets on it', async () => {
  wipe();
  const { guild, record } = fakeGuild();

  await onGuildCreate(guild);

  assert.equal(record.sent.length, 1);
  assert.equal(record.sent[0].channelId, SYSTEM_CHANNEL, 'the server\'s own system channel first');
  assert.equal(record.sent[0].content, content.commands.setup.introduction);
  assert.deepEqual(record.sent[0].allowedMentions, { parse: [] }, 'an introduction pings nobody');

  const buttons = record.sent[0].components[0].components;
  assert.deepEqual(
    buttons.map((button) => button.custom_id),
    PRESET_NAMES.map((name) => `setup:${name}`),
  );
  assert.equal(buttons[0].style, 1, 'the recommended first step leads');
});

test('she says hello exactly once, whatever the gateway does', async () => {
  wipe();
  const { guild, record } = fakeGuild();

  await onGuildCreate(guild);
  await onGuildCreate(guild);
  await onGuildCreate(guild);

  assert.equal(record.sent.length, 1, 'a reconnect or a re-join is not a new server');
  assert.equal(wasOnboarded(TEST_GUILD), true);
});

test('a greeting alone does not make a server look configured', async () => {
  wipe();
  const { guild } = fakeGuild();

  await onGuildCreate(guild);
  assert.equal(configuredGuildCount(), 0, 'the row exists, but nothing was set');

  updateSettings(TEST_GUILD, { grace: 20 });
  assert.equal(configuredGuildCount(), 1);
});

test('a server outside the allowlist is not spoken to', async () => {
  wipe();
  const { guild, record } = fakeGuild({ guildId: OTHER_GUILD });

  await onGuildCreate(guild);

  assert.deepEqual(record.sent, []);
  assert.equal(wasOnboarded(OTHER_GUILD), false, 'and it stays un-greeted, in case it is allowed later');
});

test('with no writable channel she stays quiet, and does not try again forever', async () => {
  wipe();
  const { guild, record } = fakeGuild({ systemChannel: false, writableOther: false });

  await onGuildCreate(guild);

  assert.deepEqual(record.sent, []);
  assert.equal(wasOnboarded(TEST_GUILD), true, 'marked anyway: a retry loop is worse');
});

test('the introduction names what is missing for her to work at all', async () => {
  wipe();
  const { guild, record } = fakeGuild({ permissions: PermissionFlagsBits.SendMessages });

  await onGuildCreate(guild);

  assert.match(record.sent[0].content, /ManageMessages/);
});

test('a preset button applies a whole configuration and shows the server which', async () => {
  wipe();
  const body = await route(presetClick('observe'));

  assert.equal(body.type, InteractionResponseType.UPDATE_MESSAGE);
  assert.match(body.data.content, new RegExp(content.commands.setup.presets.observe.summary));
  assert.deepEqual(body.data.components, [], 'nobody picks a second preset an hour later');
  // The point of a preset: one click is a working configuration.
  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.shadowMode, true);
  assert.equal(settings.inviteFilter, true);
  assert.deepEqual(settings.floodRule, { messages: 6, seconds: 10 });
  assert.equal(settings.nameCheck, 'log');
  // And it says what is still missing, because that one has no sane default.
  assert.match(body.data.content, new RegExp(content.commands.setup.needsLogChannel.slice(0, 20)));
});

test('the buttons sit in a public channel, so they check the clicker', async () => {
  wipe();
  const body = await route(presetClick('strict', { user: { id: TEST_USER }, permissions: '0' }));

  assert.equal(body.data.content, content.commands.forbidden);
  assert.equal(effectiveSettings(TEST_GUILD).inherited.threshold, true, 'nothing was changed');
});

test('a forged preset name changes nothing', async () => {
  wipe();
  const body = await route(presetClick('constructor'));

  assert.equal(body.data.content, content.commands.setup.unknownPreset);
  assert.equal(effectiveSettings(TEST_GUILD).inherited.shadow, true);
});

test('/mod setup does the same thing, with the log channel in one go', async () => {
  wipe();
  const body = await route(setupCommand('standard', LOG_CHANNEL));

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.logChannelId, LOG_CHANNEL);
  assert.equal(settings.shadowMode, false);
  assert.equal(settings.escalationEnabled, true);
  // Nothing left to nag about, so the reminder is gone.
  assert.equal(body.data.content.includes(content.commands.setup.needsLogChannel), false);
  assert.equal(/\{[a-z]/i.test(body.data.content), false, 'every placeholder substituted');
});

test('a preset never touches the kill switch or the threshold it cannot know', () => {
  for (const name of PRESET_NAMES) {
    assert.equal('enabled' in preset(name).settings, false, `${name} must not undo /mod off`);
  }

  // Only the preset that has already decided its line is lower sets one:
  // guessing a threshold for a server nobody has looked at is the tuning by
  // deletion that shadow mode exists to replace.
  assert.equal('threshold' in PRESETS.observe.settings, false);
  assert.equal('threshold' in PRESETS.standard.settings, false);
  assert.equal(PRESETS.strict.settings.threshold, 0.3);

  // And exactly one of them is a period rather than a state.
  assert.deepEqual(PRESET_NAMES.filter((name) => preset(name).observing), ['observe']);
});

test('observe starts a window that ends by itself', async () => {
  wipe();
  await route(setupCommand('observe'));

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.shadowMode, true);
  assert.ok(settings.shadowUntil, 'a promise with a date on it');

  const days = (new Date(settings.shadowUntil).getTime() - Date.now()) / 86_400_000;
  assert.ok(Math.abs(days - config.moderation.shadowDays) < 0.01, `window was ${days} days`);
});

test('any other statement about shadow mode cancels the window', async () => {
  // A leftover end date would otherwise fire days later and announce the end of
  // an observation nobody was running.
  for (const cancel of [
    () => route(setupCommand('standard')),
    () => route(configSet([{ name: 'shadow', value: true }])),
    () => route(configSet([{ name: 'shadow', value: false }])),
  ]) {
    wipe();
    await route(setupCommand('observe'));
    assert.ok(effectiveSettings(TEST_GUILD).shadowUntil, 'window open');

    await cancel();
    assert.equal(effectiveSettings(TEST_GUILD).shadowUntil, null);
  }
});

test('an explicit shadow:true is open ended, and stays that way', async () => {
  wipe();
  await route(configSet([{ name: 'shadow', value: true }]));

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.shadowMode, true);
  assert.equal(settings.shadowUntil, null, 'a decision somebody made, not a period');
  assert.deepEqual(expireShadowWindows(new Date(Date.now() + 400 * 86_400_000)), []);
  assert.equal(effectiveSettings(TEST_GUILD).shadowMode, true, 'and it is never ended for them');
});

test('when the window runs out she switches herself back to enforcing', async () => {
  wipe();
  await route(setupCommand('observe'));
  countShadowHit(TEST_GUILD);
  countShadowHit(TEST_GUILD);

  // Nothing happens a minute in.
  assert.deepEqual(expireShadowWindows(new Date(Date.now() + 60_000)), []);
  assert.equal(effectiveSettings(TEST_GUILD).shadowMode, true);

  const after = new Date(Date.now() + (config.moderation.shadowDays + 1) * 86_400_000);
  assert.deepEqual(expireShadowWindows(after), [{ guildId: TEST_GUILD, hits: 2 }]);

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.shadowMode, false, 'enforcing from now on, without anybody remembering');
  assert.equal(settings.shadowUntil, null);

  // Once, not once per tick: the switch is made by the statement that finds it.
  assert.deepEqual(expireShadowWindows(after), []);
});

test('a preset is a starting point, not a mode', () => {
  wipe();
  markOnboarded(TEST_GUILD);
  updateSettings(TEST_GUILD, preset('strict').settings, 'admin-1');

  // Everything it wrote is an ordinary override, changeable and resettable.
  assert.equal(effectiveSettings(TEST_GUILD).gracePeriodMinutes, 5);
  updateSettings(TEST_GUILD, { grace: 30 });
  assert.equal(effectiveSettings(TEST_GUILD).gracePeriodMinutes, 30);
  resetSettings(TEST_GUILD, 'grace');
  assert.equal(effectiveSettings(TEST_GUILD).inherited.grace, true);
});
