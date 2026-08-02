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
import { ChannelType, PermissionFlagsBits } from 'discord.js';
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
  rawSettings,
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
const ADOPTED_CHANNEL = '830000000000000004';
const CREATED_CHANNEL = '830000000000000005';
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
  // A channel Mai could adopt as the moderation log, by name.
  existingLogName = null,
  // ...and whether she may actually write in it.
  existingLogWritable = true,
  // Whether creating one succeeds, for the guild where she may not.
  canCreate = true,
} = {}) {
  const record = { sent: [], created: [] };

  const holds = (bit) =>
    permissions === PermissionFlagsBits.Administrator || (permissions & bit) === bit;

  const me = {
    id: 'bot-1',
    permissions: {
      // discord.js answers `missing` from a bitfield; the Administrator bit
      // covers everything, which is what a normally invited bot has.
      missing: (required) => required.filter((bit) => !holds(bit)).map((bit) => nameOf(bit)),
      has: (bit) => holds(bit),
    },
  };

  const channel = (id, writable, { name = `channel-${id}`, type = ChannelType.GuildText } = {}) => ({
    id,
    name,
    type,
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
  if (existingLogName) {
    channels.set(
      ADOPTED_CHANNEL,
      channel(ADOPTED_CHANNEL, existingLogWritable, { name: existingLogName }),
    );
  }

  return {
    record,
    guild: {
      id: guildId,
      memberCount: 12,
      systemChannel: systemChannel ? channel(SYSTEM_CHANNEL, true) : null,
      members: { me: uncachedMe ? null : me },
      roles: { everyone: { id: 'everyone-1' } },
      channels: {
        cache: channels,
        create: async (options) => {
          if (!canCreate) throw new Error('Missing Permissions');
          record.created.push(options);
          const made = channel(CREATED_CHANNEL, true, { name: options.name });
          channels.set(CREATED_CHANNEL, made);
          return made;
        },
      },
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
  // Escalation off, so the timeout permission is out of the picture and the
  // report is the same list twice: both calls answer, the second simply does
  // not log again.
  updateSettings(TEST_GUILD, { escalation: false }, 'admin-1');
  const { guild } = fakeGuild({ permissions: PermissionFlagsBits.SendMessages });

  assert.deepEqual(auditPermissions(guild).guild, auditPermissions(guild).guild);
});

test('a ladder she cannot carry out is switched off, not retried forever', () => {
  wipe();
  resetPermissionAudit();
  const { guild } = fakeGuild({ permissions: PermissionFlagsBits.SendMessages });

  const first = auditPermissions(guild);
  assert.ok(first.guild.includes('ModerateMembers'), 'reported once, so staff can grant it');

  // Every timeout would have failed at `error` level, which reaches the alert
  // channel, on every second strike, forever.
  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.escalationEnabled, false);
  assert.ok(settings.escalationSuspendedAt, 'and it is recorded as hers to undo');
  // Strikes keep counting: this is a pause, not an amnesty.
  assert.equal(rawSettings(TEST_GUILD).escalation_enabled, 0);
});

test('the view says who switched escalation off', async () => {
  wipe();
  resetPermissionAudit();
  auditPermissions(fakeGuild({ permissions: PermissionFlagsBits.SendMessages }).guild);

  // Not `set`: reading it as a colleague's decision is the wrong thing for the
  // next moderator to believe. One of those is undone by granting a permission.
  assert.equal(effectiveSettings(TEST_GUILD).source.escalation, 'self');

  const view = await route(
    interaction({
      type: InteractionType.APPLICATION_COMMAND,
      member: STAFF,
      data: {
        name: 'mod',
        options: [{ name: 'config', type: 2, options: [{ name: 'view', type: 1 }] }],
      },
    }),
  );
  const line = view.data.content.split('\n').find((row) => row.includes('Eskalation'));
  assert.ok(line.includes(content.commands.config.bySelf), line);

  // Staff switching it off themselves reads as theirs, unmarked.
  updateSettings(TEST_GUILD, { escalation: false }, 'admin-1');
  assert.equal(effectiveSettings(TEST_GUILD).source.escalation, 'set');
});

test('the ladder comes back by itself when the permission does', () => {
  wipe();
  resetPermissionAudit();
  auditPermissions(fakeGuild({ permissions: PermissionFlagsBits.SendMessages }).guild);
  assert.equal(effectiveSettings(TEST_GUILD).escalationEnabled, false);

  auditPermissions(fakeGuild().guild);

  const settings = effectiveSettings(TEST_GUILD);
  assert.equal(settings.escalationEnabled, true);
  assert.equal(settings.escalationSuspendedAt, null);
  assert.equal(settings.inherited.escalation, true, 'back to the profile, not to an override');
});

test('the ladder stays off while the permission is still missing', () => {
  wipe();
  resetPermissionAudit();
  const missing = () => fakeGuild({ permissions: PermissionFlagsBits.SendMessages }).guild;

  // Three audits, one per process start, with the permission never granted.
  // Deriving this from the missing-permission report instead of the permission
  // made the suspension erase its own evidence: escalation off meant Moderate
  // Members left the required list, which read as "she can time out again", so
  // every second restart handed the ladder back and every timeout failed at
  // `error` into the alert channel. Exactly what the suspension exists to stop.
  for (const attempt of [1, 2, 3]) {
    auditPermissions(missing());
    const settings = effectiveSettings(TEST_GUILD);
    assert.equal(settings.escalationEnabled, false, `still off after audit ${attempt}`);
    assert.ok(settings.escalationSuspendedAt, `still hers to undo after audit ${attempt}`);
  }
});

test('she does not overrule staff who switched escalation off themselves', () => {
  wipe();
  resetPermissionAudit();
  updateSettings(TEST_GUILD, { escalation: false }, 'admin-1');

  // Permission present, escalation off: that is a decision, not a suspension.
  auditPermissions(fakeGuild().guild);
  assert.equal(effectiveSettings(TEST_GUILD).escalationEnabled, false, 'left alone');
});

test('a human deciding about escalation ends her suspension of it', () => {
  wipe();
  resetPermissionAudit();
  auditPermissions(fakeGuild({ permissions: PermissionFlagsBits.SendMessages }).guild);
  assert.ok(effectiveSettings(TEST_GUILD).escalationSuspendedAt);

  // Staff say "on" while she still cannot do it. Their call: the marker goes,
  // so finding the permission restored later cannot undo what they typed.
  updateSettings(TEST_GUILD, { escalation: true }, 'admin-1');
  assert.equal(effectiveSettings(TEST_GUILD).escalationSuspendedAt, null);
});

test('an uncached member is not evidence of a missing permission', () => {
  wipe();
  resetPermissionAudit();
  auditPermissions(fakeGuild({ uncachedMe: true }).guild);

  // Acting on `known: false` would switch the ladder off on every cold start.
  assert.equal(effectiveSettings(TEST_GUILD).escalationEnabled, true);
});

test('joining a server produces one introduction with the presets on it', async () => {
  wipe();
  const { guild, record } = fakeGuild();

  await onGuildCreate(guild);

  assert.equal(record.sent.length, 1);
  assert.equal(record.sent[0].channelId, SYSTEM_CHANNEL, 'the server\'s own system channel first');
  assert.ok(
    record.sent[0].content.startsWith(content.commands.setup.introduction),
    'the introduction itself is unchanged, with what she set up appended',
  );
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
  // No adoptable channel and no permission to make one, so the greeting is the
  // only thing that happens: `onboarded_at` is bookkeeping, not a setting.
  const { guild } = fakeGuild({ canCreate: false });

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

// --- Finding somewhere to write -------------------------------------------
//
// `log-channel` is the only setting with no working default, and four features
// are silently absent without one. She looks for it herself on join.

test('an existing mod-log channel is adopted rather than duplicated', async () => {
  wipe();
  const { guild, record } = fakeGuild({ existingLogName: 'mod-log' });

  await onGuildCreate(guild);

  assert.equal(effectiveSettings(TEST_GUILD).logChannelId, ADOPTED_CHANNEL);
  assert.deepEqual(record.created, [], 'the server already had one');
  assert.match(record.sent[0].content, new RegExp(`<#${ADOPTED_CHANNEL}>`), 'and she says so');
});

test('only names that mean a moderation log are adopted', async () => {
  for (const name of ['mod-log', 'mod_logs', 'moderation-log', 'mai-log', 'ModLog']) {
    wipe();
    const { guild } = fakeGuild({ existingLogName: name });
    await onGuildCreate(guild);
    assert.equal(effectiveSettings(TEST_GUILD).logChannelId, ADOPTED_CHANNEL, `missed ${name}`);
  }

  // Adopting one of these would start posting member ids and category slugs
  // into a channel nobody meant for that, which is a decision she does not get
  // to make on a guess.
  for (const name of ['changelog', 'logs', 'general', 'mod-chat', 'blog']) {
    wipe();
    const { guild, record } = fakeGuild({ existingLogName: name, canCreate: false });
    await onGuildCreate(guild);
    assert.equal(effectiveSettings(TEST_GUILD).logChannelId, null, `adopted ${name}`);
    assert.deepEqual(record.created, []);
  }
});

test('a channel she cannot write in is not an answer', async () => {
  wipe();
  // Named right, but no permission there: adopting it would move the problem
  // rather than solve it, so she makes her own instead.
  const { guild, record } = fakeGuild({
    existingLogName: 'mod-log',
    existingLogWritable: false,
  });

  await onGuildCreate(guild);

  assert.equal(record.created.length, 1);
  assert.equal(effectiveSettings(TEST_GUILD).logChannelId, CREATED_CHANNEL);
});

test('a created log channel starts closed, not open', async () => {
  wipe();
  const { guild, record } = fakeGuild();

  await onGuildCreate(guild);

  const [options] = record.created;
  assert.equal(options.name, content.moderation.log.channelName);
  // A moderation log names members and what they were flagged for. A server
  // that has not chosen who reads that has not agreed to everyone reading it.
  const everyone = options.permissionOverwrites.find((entry) => entry.id === 'everyone-1');
  assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel));
});

test('without Manage Channels she asks instead of failing', async () => {
  wipe();
  const { guild, record } = fakeGuild({ permissions: PermissionFlagsBits.SendMessages });

  await onGuildCreate(guild);

  assert.deepEqual(record.created, [], 'she may not, so she does not try');
  assert.equal(effectiveSettings(TEST_GUILD).logChannelId, null);
  assert.match(record.sent[0].content, new RegExp(content.commands.setup.logChannelMissing.slice(0, 20)));
});

test('a server that already chose a log channel is not overruled', async () => {
  wipe();
  updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });
  const { guild, record } = fakeGuild({ existingLogName: 'mod-log' });

  await onGuildCreate(guild);

  assert.equal(effectiveSettings(TEST_GUILD).logChannelId, LOG_CHANNEL);
  assert.deepEqual(record.created, []);
});
