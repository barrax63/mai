/**
 * The look she gives you after you rename yourself.
 *
 * Pure persona, and the tests are mostly about what it is not: no
 * classification call, nothing written anywhere, nothing it can do to a member,
 * and no second look for the same rename. The display-name *screen* is the
 * other feature in this area and it keeps its own ceiling; a name she had to
 * act on earns no wink on top of the entry.
 */
import './setup-names.js';
import { openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { onGuildMemberUpdate } from '../src/gateway/events/guild-member-update.js';
import { maybeReactAsCat } from '../src/gateway/events/reactions.js';
import { noteRename, resetRenames, takeRenameLook } from '../src/gateway/renames.js';

await openTestDatabase();

const LOG_CHANNEL = '810000000000000019';
let nextId = 0;
const memberId = () => String(813000000000000000n + BigInt((nextId += 1)));

/** A member who currently wears `nickname`, in a guild Mai acts in. */
function fakeMember({ nickname = 'neu', guildId = TEST_GUILD, bot = false } = {}) {
  const record = { posted: [], nicknames: [] };
  const id = memberId();

  return {
    record,
    member: {
      id,
      nickname,
      user: { id, username: 'tester', globalName: null, bot },
      guild: { id: guildId, members: { me: { id: 'bot' } }, channels: { fetch: async () => null } },
      client: {
        channels: {
          fetch: async (channelId) => ({
            id: channelId,
            guildId,
            isTextBased: () => true,
            send: async (payload) => record.posted.push({ channelId, ...payload }),
          }),
        },
      },
      setNickname: async (value) => record.nicknames.push(value),
    },
  };
}

/** The same member a moment earlier, under a different name. */
const before = (member) => ({
  id: member.id,
  nickname: 'alt',
  user: member.user,
  guild: member.guild,
});

function fakeMessage({ authorId, guildId = TEST_GUILD, text = 'hallo' } = {}) {
  const reacted = [];
  return {
    reacted,
    message: {
      id: '884000000000000001',
      guildId,
      content: text,
      author: { id: authorId },
      react: async (emoji) => reacted.push(emoji),
    },
  };
}

/** Rolls above every trigger chance, so only a rename look can react. */
async function reactWithoutLuck(message) {
  const realRandom = Math.random;
  Math.random = () => 0.999;
  try {
    await maybeReactAsCat(message);
  } finally {
    Math.random = realRandom;
  }
}

test('a rename earns the next message one look, and only one', async () => {
  resetRenames();
  const { member, record } = fakeMember();

  await onGuildMemberUpdate(before(member), member);

  const first = fakeMessage({ authorId: member.id });
  await reactWithoutLuck(first.message);
  assert.equal(first.reacted.length, 1);
  assert.ok(content.renames.looks.includes(first.reacted[0]), first.reacted[0]);

  // The look is about the rename and not about the message, so it is spent.
  const second = fakeMessage({ authorId: member.id });
  await reactWithoutLuck(second.message);
  assert.deepEqual(second.reacted, []);

  // And it is not an enforcement of any kind: nothing was posted, nothing
  // was changed about the member.
  assert.deepEqual(record.posted, []);
  assert.deepEqual(record.nicknames, []);
});

test('a rename storm is one look, not one per rename', async () => {
  resetRenames();
  const { member } = fakeMember();

  for (let i = 0; i < 10; i++) await onGuildMemberUpdate(before(member), member);

  const { message, reacted } = fakeMessage({ authorId: member.id });
  await reactWithoutLuck(message);
  assert.equal(reacted.length, 1);
});

test('a look she never got to use expires instead of waiting forever', () => {
  resetRenames();
  const now = Date.now();

  noteRename(TEST_GUILD, 'someone', now);

  assert.equal(takeRenameLook(TEST_GUILD, 'someone', now + config.renames.lookMs), false);
  // Spent either way: an expired look is not owed to anybody later.
  assert.equal(takeRenameLook(TEST_GUILD, 'someone', now), false);
});

test('the look lands on a message that is only a picture, too', async () => {
  resetRenames();
  const { member } = fakeMember();
  await onGuildMemberUpdate(before(member), member);

  // No text at all: the trigger words have nothing to match, which is exactly
  // why this check sits in front of them.
  const { message, reacted } = fakeMessage({ authorId: member.id, text: '' });
  await reactWithoutLuck(message);

  assert.equal(reacted.length, 1);
});

test('a name she had to act on gets the entry, not a wink', async () => {
  resetRenames();
  updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL, 'name-check': 'log' });
  const { member, record } = fakeMember();
  const restore = stubFetch(() =>
    new Response(
      JSON.stringify({
        results: [{ flagged: true, categories: { hate: true }, category_scores: { hate: 0.97 } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

  try {
    await onGuildMemberUpdate(before(member), member);
  } finally {
    restore();
    resetSettings(TEST_GUILD);
  }

  assert.equal(record.posted.length, 1, 'staff were told');
  const { message, reacted } = fakeMessage({ authorId: member.id });
  await reactWithoutLuck(message);
  assert.deepEqual(reacted, [], 'and that is the whole of her answer');
});

test('a bot renaming itself is not somebody she has opinions about', async () => {
  resetRenames();
  const { member } = fakeMember({ bot: true });

  await onGuildMemberUpdate(before(member), member);

  const { message, reacted } = fakeMessage({ authorId: member.id });
  await reactWithoutLuck(message);
  assert.deepEqual(reacted, []);
});

test('a guild outside the allowlist gets no behaviour, this included', async () => {
  resetRenames();
  const { member } = fakeMember({ guildId: OTHER_GUILD });

  await onGuildMemberUpdate(before(member), member);

  const { message, reacted } = fakeMessage({ authorId: member.id, guildId: OTHER_GUILD });
  await reactWithoutLuck(message);
  assert.deepEqual(reacted, []);
});

test('a paused guild is just as quiet about a new name', async () => {
  resetRenames();
  updateSettings(TEST_GUILD, { enabled: 'false' });
  const { member } = fakeMember();

  try {
    await onGuildMemberUpdate(before(member), member);
  } finally {
    updateSettings(TEST_GUILD, { enabled: 'true' });
  }

  const { message, reacted } = fakeMessage({ authorId: member.id });
  await reactWithoutLuck(message);
  assert.deepEqual(reacted, []);
});

test('a look belongs to one member in one guild', () => {
  resetRenames();
  const now = Date.now();

  noteRename(TEST_GUILD, 'renamer', now);

  assert.equal(takeRenameLook(OTHER_GUILD, 'renamer', now), false, 'not the same guild');
  assert.equal(takeRenameLook(TEST_GUILD, 'somebody-else', now), false, 'not the same member');
  assert.equal(takeRenameLook(null, 'renamer', now), false, 'a DM has no rename to look at');
  assert.equal(takeRenameLook(TEST_GUILD, 'renamer', now), true);
});
