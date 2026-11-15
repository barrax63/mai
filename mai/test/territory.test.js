/**
 * Territory: the one channel per server Mai has claimed for the day.
 *
 * What the claim may never be is the first thing pinned down: a restriction.
 * She answers in every channel as before, and moderation in her own channel is
 * exactly what it is anywhere else. Then which channels qualify, which is a
 * privacy question as much as a persona one: she names her channel in other
 * channels, so it has to be one everybody can already see. Then the day itself:
 * a claim lasts, is given up as soon as it stops qualifying, and a server with
 * nothing to claim is not searched on every turn.
 */
import './setup-gateway.js';
import { openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { buildMessages } from '../src/ai/chat.js';
import { resetTerritory, territoryFor } from '../src/chat/territory.js';
import { config } from '../src/config.js';
import { content, fill } from '../src/content.js';
import { depth } from '../src/db/queue.js';
import { getDb } from '../src/db/index.js';
import { updateSettings } from '../src/db/settings.js';
import { onMessageCreate } from '../src/gateway/events/message-create.js';

await openTestDatabase();

const BOT = '897000000000000000';
const ME = { id: BOT, kind: 'her own member' };
const EVERYONE = { id: TEST_GUILD, kind: 'the @everyone role' };
const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const NO_VIOLATIONS = { count: 0, categories: [] };

const GENERAL = '897100000000000001';
const MEMES = '897100000000000002';
const GAMING = '897100000000000003';

/** A permission set holding exactly these flags. */
const holding = (...flags) => ({
  has: (wanted) => [].concat(wanted).every((flag) => flags.includes(flag)),
});

function channel(id, {
  type = ChannelType.GuildText,
  everyoneSees = true,
  canSpeak = true,
  nsfw = false,
  parentId = null,
} = {}) {
  return {
    id,
    type,
    nsfw,
    parentId,
    permissionsFor: (target) => {
      if (target === ME) return canSpeak ? holding(VIEW, SEND) : holding(VIEW);
      if (target === EVERYONE) return everyoneSees ? holding(VIEW, SEND) : holding();
      throw new Error('asked about somebody unexpected');
    },
  };
}

function guildWith(channels, id = TEST_GUILD) {
  return {
    id,
    members: { me: ME },
    roles: { everyone: EVERYONE },
    channels: { cache: new Map(channels.map((entry) => [entry.id, entry])) },
    emojis: { cache: new Map() },
  };
}

const clientWith = (...guilds) => ({
  user: { id: BOT },
  guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
  channels: { fetch: async () => null },
});

const wipe = () => {
  resetTerritory();
  getDb().exec('DELETE FROM guild_settings');
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM chat_history');
};

/** Runs `fn` with every roll landing on `roll`. */
function rolling(roll, fn) {
  const realRandom = Math.random;
  Math.random = () => roll;
  try {
    return fn();
  } finally {
    Math.random = realRandom;
  }
}

const claimIn = (client, now, where = {}, guildId = TEST_GUILD) =>
  territoryFor(client, guildId, where, now)?.channelId ?? null;

test('she claims one channel per server and keeps it for the day', () => {
  wipe();
  const client = clientWith(guildWith([channel(GENERAL), channel(MEMES), channel(GAMING)]));
  const now = Date.now();

  assert.equal(rolling(0, () => claimIn(client, now)), GENERAL);
  // A different roll changes nothing while the claim stands.
  assert.equal(rolling(0.99, () => claimIn(client, now + config.territory.claimMs - 1)), GENERAL);
  // A day later she looks for a box again.
  assert.equal(rolling(0.99, () => claimIn(client, now + config.territory.claimMs)), GAMING);
});

test('only a channel everybody can see, she can speak in, and nobody set aside', () => {
  wipe();
  const CATEGORY = '897100000000000090';
  const others = [
    channel('897100000000000010', { everyoneSees: false }), // staff only
    channel('897100000000000011', { canSpeak: false }), // she is muted there
    channel('897100000000000012', { nsfw: true }),
    channel('897100000000000013', { type: ChannelType.GuildVoice }),
    channel('897100000000000014', { type: ChannelType.PublicThread }),
    channel('897100000000000015', { type: ChannelType.GuildAnnouncement }),
    channel('897100000000000016', { type: ChannelType.GuildForum }),
    channel('897100000000000017'), // the moderation log
    channel('897100000000000018'), // exempted from moderation: a vent channel
    channel('897100000000000019', { parentId: CATEGORY }), // exempted with its category
  ];
  updateSettings(TEST_GUILD, {
    'log-channel': '897100000000000017',
    'exempt-channels': `897100000000000018,${CATEGORY}`,
  });
  const client = clientWith(guildWith([...others, channel(GENERAL)]));

  for (const roll of [0, 0.25, 0.5, 0.75, 0.99]) {
    resetTerritory();
    assert.equal(rolling(roll, () => claimIn(client, Date.now())), GENERAL, `roll ${roll}`);
  }
});

test('a server with nothing to claim is not searched again on every turn', () => {
  wipe();
  const guild = guildWith([channel(GENERAL, { everyoneSees: false })]);
  const client = clientWith(guild);
  const now = Date.now();

  assert.equal(claimIn(client, now), null);

  // A public channel appears, and she notices on her next look rather than on
  // the very next message.
  guild.channels.cache.set(MEMES, channel(MEMES));
  assert.equal(claimIn(client, now + 1_000), null);
  assert.equal(claimIn(client, now + config.territory.retryMs), MEMES);
});

test('a channel that stops qualifying is given up at once, not at the end of the day', () => {
  wipe();
  const client = clientWith(guildWith([channel(GENERAL), channel(MEMES)]));
  const now = Date.now();

  assert.equal(rolling(0, () => claimIn(client, now)), GENERAL);

  // Staff exempt it: a vent channel is the last place for a smug cat.
  updateSettings(TEST_GUILD, { 'exempt-channels': GENERAL });
  assert.equal(rolling(0, () => claimIn(client, now + 1_000)), MEMES);
});

test('each server has its own, and a DM has none', () => {
  wipe();
  const OTHER_CHANNEL = '897200000000000001';
  const client = clientWith(
    guildWith([channel(GENERAL)]),
    guildWith([channel(OTHER_CHANNEL)], OTHER_GUILD),
  );
  const now = Date.now();

  assert.equal(claimIn(client, now), GENERAL);
  assert.equal(claimIn(client, now, {}, OTHER_GUILD), OTHER_CHANNEL);
  assert.equal(territoryFor(client, null, { channelId: GENERAL }, now), null);
  // Before the gateway is ready there is no client and nothing to look at.
  assert.equal(territoryFor(null, TEST_GUILD, { channelId: GENERAL }, now), null);
});

test('here means her channel, or a thread inside it', () => {
  wipe();
  const client = clientWith(guildWith([channel(GENERAL)]));
  const now = Date.now();
  const THREAD = '897100000000000050';

  assert.equal(territoryFor(client, TEST_GUILD, { channelId: GENERAL }, now).here, true);
  assert.equal(territoryFor(client, TEST_GUILD, { channelId: THREAD, parentId: GENERAL }, now).here, true);
  assert.equal(territoryFor(client, TEST_GUILD, { channelId: MEMES }, now).here, false);
  assert.equal(territoryFor(client, TEST_GUILD, {}, now).here, false);
});

test('a lookup that throws costs the claim, never the reply', () => {
  wipe();
  const broken = channel(GENERAL);
  broken.permissionsFor = () => {
    throw new Error('cache in a bad mood');
  };

  assert.equal(territoryFor(clientWith(guildWith([broken])), TEST_GUILD, {}, Date.now()), null);
});

test('in her channel she is smug, elsewhere she names it as a link, and it never replaces the tone', () => {
  const system = (territory, violations = NO_VIOLATIONS) =>
    buildMessages({ history: [], username: 'noah', content: 'hi', violations, territory })[0].content;
  const elsewhere = fill(content.chat.territory.elsewhere, { channel: `<#${GENERAL}>` });

  const here = system({ channelId: GENERAL, here: true });
  assert.ok(here.includes(content.chat.territory.here));
  assert.equal(here.includes(elsewhere), false);

  const away = system({ channelId: GENERAL, here: false });
  assert.ok(away.includes(elsewhere));
  assert.equal(away.includes(content.chat.territory.here), false);
  // Digits only: no channel name chosen by somebody else in her instructions.
  assert.equal(/\{channel\}/.test(away), false);

  const none = system(null);
  assert.equal(none.includes(content.chat.territory.here), false);
  assert.equal(none.includes(elsewhere), false);

  const hissing = system({ channelId: GENERAL, here: true }, { count: 3, categories: ['harassment'] });
  assert.ok(hissing.includes(content.chat.territory.here));
  assert.ok(hissing.includes(content.chat.flagged.tones.at(-1)), 'the tone is still in force');
  assert.ok(hissing.endsWith(content.chat.prompt.untrustedNotice));
});

/** A mention of Mai in `channelId`, through the whole handler. */
async function mention(client, channelId, { flagged = false, text = 'Mai, na?' } = {}) {
  const record = { replies: [] };
  const message = {
    id: `8973${String(Math.floor(Math.random() * 1e14)).padStart(14, '0')}`,
    guildId: TEST_GUILD,
    channelId,
    system: false,
    content: text,
    author: { id: TEST_USER, bot: false, username: 'tester' },
    attachments: { size: 0, map: () => [], values: () => [].values() },
    mentions: { users: new Map([[BOT, { id: BOT }]]) },
    reference: null,
    channel: { isThread: () => false, sendTyping: async () => {} },
    client,
    react: async () => {},
    reply: async (payload) => {
      record.replies.push(payload);
      return { id: 'reply-message' };
    },
  };

  const calls = { moderation: 0, prompts: [] };
  const restore = stubFetch((url, options) => {
    if (url.endsWith('/moderations')) {
      calls.moderation += 1;
      return Response.json({ results: [{ flagged, categories: flagged ? { harassment: true } : {} }] });
    }
    calls.prompts.push(JSON.parse(options.body).messages);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'miau' } }] });
  });
  try {
    await onMessageCreate(message);
  } finally {
    restore();
  }
  return { record, calls };
}

test('she answers in every channel, in hers with the smug line and elsewhere with a mention of it', async () => {
  wipe();
  const client = clientWith(guildWith([channel(GENERAL), channel(MEMES)]));
  rolling(0, () => territoryFor(client, TEST_GUILD, {}, Date.now()));

  const inHers = await mention(client, GENERAL);
  assert.equal(inHers.record.replies.length, 1);
  assert.ok(inHers.calls.prompts[0][0].content.includes(content.chat.territory.here));

  const elsewhere = await mention(client, MEMES);
  assert.equal(elsewhere.record.replies.length, 1, 'nobody is sent anywhere');
  assert.ok(elsewhere.calls.prompts[0][0].content.includes(`<#${GENERAL}>`));
});

test('a violation in her channel is classified and queued like anywhere else', async () => {
  wipe();
  const client = clientWith(guildWith([channel(GENERAL)]));
  rolling(0, () => territoryFor(client, TEST_GUILD, {}, Date.now()));

  const { calls } = await mention(client, GENERAL, { flagged: true, text: 'Mai, du wicht' });

  assert.equal(calls.moderation, 1);
  assert.equal(depth(), 1);
  assert.equal(calls.prompts.length, 0, 'scolded, not answered, as anywhere else');
});
