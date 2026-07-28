/**
 * Screening the name a member wears.
 *
 * The interesting parts are the edges: what Mai may do about a name (less than
 * she may do about a message), what she must not put in the log entry, that a
 * classifier outage cannot strip somebody's nickname, and that a rename storm
 * cannot turn into a classification bill.
 */
import './setup-names.js';
import { openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { onGuildMemberAdd } from '../src/gateway/events/guild-member-add.js';
import { onGuildMemberUpdate } from '../src/gateway/events/guild-member-update.js';
import { displayName, screenMemberName } from '../src/moderation/names.js';

await openTestDatabase();

const LOG_CHANNEL = '810000000000000009';
const SYSTEM_CHANNEL = '810000000000000008';

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

let nextId = 0;
const memberId = () => `812000000000000${(nextId += 1).toString().padStart(3, '0')}`;

/**
 * @param {{ nickname?: string | null, username?: string, guildId?: string,
 *   bot?: boolean, resetFails?: boolean }} [options]
 */
function fakeMember({
  nickname = null,
  username = 'tester',
  globalName = null,
  guildId = TEST_GUILD,
  bot = false,
  resetFails = false,
} = {}) {
  const record = { posted: [], nicknames: [], welcomes: [] };
  const id = memberId();

  const member = {
    id,
    nickname,
    user: { id, username, globalName, bot },
    guild: {
      id: guildId,
      systemChannel: {
        id: SYSTEM_CHANNEL,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
        send: async (payload) => record.welcomes.push(payload),
      },
      members: { me: { id: 'bot' } },
      channels: { fetch: async () => null },
    },
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
    setNickname: async (value, reason) => {
      if (resetFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      record.nicknames.push({ value, reason });
      member.nickname = value;
    },
  };

  return { member, record };
}

/** The provider says yes, with a score high enough for any threshold. */
const flagging = () =>
  stubFetch(() =>
    new Response(
      JSON.stringify({
        results: [
          { flagged: true, categories: { hate: true }, category_scores: { hate: 0.97 } },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

const clean = () =>
  stubFetch(() =>
    new Response(
      JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

const entry = (record) => record.posted.at(-1)?.embeds?.[0];
const fieldValue = (embed, label) => embed.fields.find((field) => field.name === label)?.value;

test('member events are requested as soon as names are screened', () => {
  // A guild setting cannot turn a gateway intent on, so this flag is what makes
  // the whole feature possible; without it the events never arrive.
  assert.equal(config.moderation.nameCheck, 'log');
  assert.equal(config.discord.memberEventsEnabled, true);
});

test('the display name is the nickname, then the global name, then the username', () => {
  assert.equal(displayName({ nickname: 'Nick', user: { globalName: 'Global', username: 'name' } }), 'Nick');
  assert.equal(displayName({ nickname: null, user: { globalName: 'Global', username: 'name' } }), 'Global');
  assert.equal(displayName({ nickname: null, user: { username: 'name' } }), 'name');
  assert.equal(displayName(undefined), '');
});

test('a flagged name is reported without being copied into the entry', async () => {
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'ein übler Name' });
    const verdict = await screenMemberName(member);

    assert.equal(verdict.flagged, true);
    const embed = entry(record);
    assert.equal(embed.title, content.moderation.log.titles.nameFlagged);
    assert.equal(fieldValue(embed, content.moderation.log.fields.categories), 'hate');
    // The mention renders as their current display name for whoever reads the
    // entry, so staff see the name without Mai storing a copy of it.
    assert.equal(fieldValue(embed, content.moderation.log.fields.user), `<@${member.id}> \`${member.id}\``);
    assert.equal(JSON.stringify(embed).includes('ein übler Name'), false);
  } finally {
    restore();
  }
});

test('on `log` the name is left alone: a human decides', async () => {
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'schlimm' });
    await screenMemberName(member);

    assert.deepEqual(record.nicknames, [], 'log means log');
    assert.equal(
      fieldValue(entry(record), content.moderation.log.fields.resolution),
      content.moderation.names.reportedOnly,
    );
  } finally {
    restore();
  }
});

test('on `reset` the guild nickname goes, and the entry says so', async () => {
  updateSettings(TEST_GUILD, { 'name-check': 'reset' });
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'schlimm' });
    await screenMemberName(member);

    assert.equal(record.nicknames.length, 1);
    assert.equal(record.nicknames[0].value, null, 'removed, not replaced with something of Mai\'s');
    assert.match(record.nicknames[0].reason, /hate/, 'the audit log says why');
    assert.equal(
      fieldValue(entry(record), content.moderation.log.fields.resolution),
      content.moderation.names.nicknameReset,
    );
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'name-check');
  }
});

test('a global username is not Mai\'s to change, and the entry admits it', async () => {
  updateSettings(TEST_GUILD, { 'name-check': 'reset' });
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: null, username: 'schlimm' });
    await screenMemberName(member);

    assert.deepEqual(record.nicknames, [], 'there is no nickname to remove');
    assert.equal(
      fieldValue(entry(record), content.moderation.log.fields.resolution),
      content.moderation.names.globalName,
    );
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'name-check');
  }
});

test('a refused reset is reported in words, not swallowed', async () => {
  updateSettings(TEST_GUILD, { 'name-check': 'reset' });
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'schlimm', resetFails: true });
    await screenMemberName(member);

    const resolution = fieldValue(entry(record), content.moderation.log.fields.resolution);
    assert.match(resolution, /50013/, 'staff get the code they can hand on');
    assert.equal(resolution.includes('Missing Permissions'), false, 'never the raw message');
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'name-check');
  }
});

test('an unreachable classifier leaves the name alone', async () => {
  updateSettings(TEST_GUILD, { 'name-check': 'reset' });
  const restore = stubFetch(() => {
    throw new Error('provider is down');
  });
  try {
    const { member, record } = fakeMember({ nickname: 'schlimm' });
    const verdict = await screenMemberName(member);

    // Fails open, like the message pipeline: no verdict must never become
    // "strip this member's nickname".
    assert.equal(verdict.flagged, false);
    assert.deepEqual(record.nicknames, []);
    assert.deepEqual(record.posted, []);
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'name-check');
  }
});

test('off means no classification call at all', async () => {
  updateSettings(TEST_GUILD, { 'name-check': 'off' });
  const restore = stubFetch(() => {
    throw new Error('nothing may be classified while name-check is off');
  });
  try {
    const { member } = fakeMember({ nickname: 'schlimm' });
    assert.equal((await screenMemberName(member)).flagged, false);
  } finally {
    restore();
    resetSettings(TEST_GUILD, 'name-check');
  }
});

test('a guild outside the allowlist and a paused one are both left alone', async () => {
  const restore = stubFetch(() => {
    throw new Error('no classification outside the allowlist');
  });
  try {
    const { member } = fakeMember({ nickname: 'schlimm', guildId: OTHER_GUILD });
    assert.equal((await screenMemberName(member)).flagged, false);

    updateSettings(TEST_GUILD, { enabled: false });
    const paused = fakeMember({ nickname: 'schlimm' });
    assert.equal((await screenMemberName(paused.member)).flagged, false);
  } finally {
    restore();
    updateSettings(TEST_GUILD, { enabled: true });
  }
});

test('bots keep their names', async () => {
  const restore = stubFetch(() => {
    throw new Error('a bot name is not a member name');
  });
  try {
    const { member } = fakeMember({ nickname: 'schlimm', bot: true });
    assert.equal((await screenMemberName(member)).flagged, false);
  } finally {
    restore();
  }
});

test('renaming in a loop is bounded', async () => {
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'schlimm' });
    for (let index = 0; index < 6; index += 1) {
      await screenMemberName(member);
    }

    // Three per member per ten minutes: renaming is free and instant, and every
    // check is an API call plus an entry in a channel humans read.
    assert.equal(record.posted.length, 3);
  } finally {
    restore();
  }
});

test('an update that is not a rename costs nothing', async () => {
  const restore = stubFetch(() => {
    throw new Error('a role change is not a rename');
  });
  try {
    const { member, record } = fakeMember({ nickname: 'gleich' });
    // Roles, avatars, boosts and every timeout Mai hands out fire this event.
    await onGuildMemberUpdate({ nickname: 'gleich', user: member.user }, member);
    assert.deepEqual(record.posted, []);
  } finally {
    restore();
  }
});

test('a rename is screened', async () => {
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'jetzt schlimm' });
    await onGuildMemberUpdate({ nickname: 'vorher harmlos', user: member.user }, member);

    assert.equal(entry(record).title, content.moderation.log.titles.nameFlagged);
  } finally {
    restore();
  }
});

test('a member whose name is flagged on the way in is not welcomed by it', async () => {
  const restore = flagging();
  try {
    const { member, record } = fakeMember({ nickname: 'schlimm' });
    await onGuildMemberAdd(member);

    // A welcome mentions the new member, so greeting them would put the name in
    // front of the whole server in Mai's own words.
    assert.deepEqual(record.welcomes, []);
    assert.equal(entry(record).title, content.moderation.log.titles.nameFlagged);
  } finally {
    restore();
  }
});

test('an ordinary new member is still welcomed', async () => {
  const restore = clean();
  try {
    const { member, record } = fakeMember({ nickname: 'harmlos' });
    await onGuildMemberAdd(member);

    assert.deepEqual(record.posted, [], 'nothing to report');
    assert.equal(record.welcomes.length, 1);
    assert.match(record.welcomes[0].content, new RegExp(`<@${member.id}>`));
  } finally {
    restore();
  }
});
