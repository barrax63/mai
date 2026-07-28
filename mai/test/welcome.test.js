/**
 * Welcoming a new member.
 *
 * The handler is small, but it sits behind both guild gates and it is the one
 * place Mai pings somebody who did not talk to her first, so the ping is scoped
 * to exactly that member and everything that can go wrong (no channel, wrong
 * channel type, missing permission, failed send) has to end in silence rather
 * than in an exception on the gateway.
 */
import './setup-welcome.js';
import { openTestDatabase, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { content } from '../src/content.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { onGuildMemberAdd } from '../src/gateway/events/guild-member-add.js';

await openTestDatabase();

// Greeting is a per-guild setting now; the environment variable only says the
// intent is available at all. `resetSettings` therefore switches it off along
// with everything else, so the tests that start from a clean guild opt back in
// through this rather than calling `resetSettings` directly.
const freshGuild = (guildId = TEST_GUILD) => {
  resetSettings(guildId);
  updateSettings(guildId, { welcome: true });
};

freshGuild(TEST_GUILD);
freshGuild(OTHER_GUILD);

const WELCOME_CHANNEL = '860000000000000001';
const SYSTEM_CHANNEL = '860000000000000002';
const BOT = '860000000000000003';

/**
 * @param {object} options
 */
function fakeMember({
  guildId = TEST_GUILD,
  bot = false,
  systemChannel = true,
  configuredChannel = null,
  channelFails = false,
  textBased = true,
  canSend = true,
} = {}) {
  const record = { sent: [], fetched: [] };

  const channel = (id) => ({
    id,
    isTextBased: () => textBased,
    permissionsFor: () => ({ has: (flag) => (flag === PermissionFlagsBits.SendMessages ? canSend : true) }),
    send: async (payload) => {
      record.sent.push({ channelId: id, ...payload });
      return { id: 'welcome-message' };
    },
  });

  const guild = {
    id: guildId,
    systemChannel: systemChannel ? channel(SYSTEM_CHANNEL) : null,
    members: { me: { id: BOT } },
    channels: {
      fetch: async (id) => {
        record.fetched.push(id);
        if (channelFails) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return configuredChannel === null ? null : channel(id);
      },
    },
  };

  return { member: { id: TEST_USER, user: { id: TEST_USER, bot }, guild }, record };
}

test('a new member is greeted in the guild system channel by default', async () => {
  freshGuild();
  const { member, record } = fakeMember();

  await onGuildMemberAdd(member);

  assert.equal(record.sent.length, 1);
  assert.equal(record.sent[0].channelId, SYSTEM_CHANNEL);
  assert.deepEqual(record.fetched, [], 'no channel to look up when none is configured');
});

test('the greeting is one of the configured lines, with the mention filled in', async () => {
  freshGuild();
  const { member, record } = fakeMember();

  await onGuildMemberAdd(member);

  const line = record.sent[0].content;
  assert.ok(line.includes(`<@${TEST_USER}>`), line);
  assert.doesNotMatch(line, /\{member\}/, 'the placeholder was substituted, not printed');

  const shapes = content.welcome.lines.map((template) => template.replace('{member}', `<@${TEST_USER}>`));
  assert.ok(shapes.includes(line), 'nothing Mai says is written in the handler');
});

test('the new member is the only thing a welcome may ping', async () => {
  freshGuild();
  const { member, record } = fakeMember();

  await onGuildMemberAdd(member);

  assert.deepEqual(record.sent[0].allowedMentions, { users: [TEST_USER] });
});

test('a configured welcome channel wins over the system channel', async () => {
  updateSettings(TEST_GUILD, { 'welcome-channel': WELCOME_CHANNEL });
  const { member, record } = fakeMember({ configuredChannel: WELCOME_CHANNEL });

  await onGuildMemberAdd(member);

  assert.deepEqual(record.fetched, [WELCOME_CHANNEL]);
  assert.equal(record.sent[0].channelId, WELCOME_CHANNEL);
  freshGuild();
});

test('an unreachable configured channel falls back instead of failing', async () => {
  updateSettings(TEST_GUILD, { 'welcome-channel': WELCOME_CHANNEL });
  const { member, record } = fakeMember({ configuredChannel: WELCOME_CHANNEL, channelFails: true });

  await onGuildMemberAdd(member);

  assert.equal(record.sent[0].channelId, SYSTEM_CHANNEL);
  freshGuild();
});

test('a configured channel that holds no messages falls back too', async () => {
  updateSettings(TEST_GUILD, { 'welcome-channel': WELCOME_CHANNEL });
  const { member, record } = fakeMember({ configuredChannel: WELCOME_CHANNEL, textBased: false });

  await onGuildMemberAdd(member);

  assert.equal(record.sent[0].channelId, SYSTEM_CHANNEL);
  freshGuild();
});

test('with nowhere to write, nothing is written', async () => {
  freshGuild();
  const { member, record } = fakeMember({ systemChannel: false });

  await onGuildMemberAdd(member);

  assert.deepEqual(record.sent, []);
});

test('without Send Messages Mai stays quiet rather than throwing on the gateway', async () => {
  freshGuild();
  const { member, record } = fakeMember({ canSend: false });

  await onGuildMemberAdd(member);

  assert.deepEqual(record.sent, []);
});

test('a failing send is survivable', async () => {
  freshGuild();
  const { member } = fakeMember();
  member.guild.systemChannel.send = async () => {
    throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
  };

  await assert.doesNotReject(() => onGuildMemberAdd(member));
});

test('bots are not welcomed', async () => {
  freshGuild();
  const { member, record } = fakeMember({ bot: true });

  await onGuildMemberAdd(member);

  assert.deepEqual(record.sent, []);
});

test('a guild outside the allowlist gets no behaviour at all', async () => {
  const { member, record } = fakeMember({ guildId: OTHER_GUILD });

  await onGuildMemberAdd(member);

  assert.deepEqual(record.sent, []);
});

test('a paused guild is not welcomed into either: /mod off means off', async () => {
  updateSettings(TEST_GUILD, { enabled: 'false' });
  const { member, record } = fakeMember();

  await onGuildMemberAdd(member);

  assert.deepEqual(record.sent, []);
  updateSettings(TEST_GUILD, { enabled: 'true' });
});
