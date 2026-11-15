/**
 * `/mai mood`: how she is doing, asked out loud.
 *
 * The first thing pinned down is what she must never say. Her classifier
 * failing in a guild makes her snuffly in chat, where the directive forbids
 * explaining it; a command answering "how are you" is the one place that mood
 * would turn into a public notice that moderation is down. So a failing guild
 * gets exactly the answer a healthy one does, and the same holds for a member
 * with open violations and a record. Then what she does say: what she is doing,
 * in the order her status uses, the sulk for the member who earned it, and her
 * territory.
 *
 * Chat is off in this file on purpose: the answer costs nothing and calls
 * nothing, so it does not depend on the model being available.
 */
import { interaction, openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { InteractionResponseType } from 'discord-interactions';
import { describeMood } from '../src/chat/mood.js';
import { BITE, pet, resetPetting } from '../src/chat/petting.js';
import { resetTerritory } from '../src/chat/territory.js';
import { mai as maiCommand } from '../src/commands/mai.js';
import { config } from '../src/config.js';
import { content, fill } from '../src/content.js';
import { getDb } from '../src/db/index.js';
import { enqueue } from '../src/db/queue.js';
import { ACTION_DELETED, recordViolation } from '../src/db/violations.js';
import { EPHEMERAL } from '../src/interactions/respond.js';
import {
  isDegraded,
  recordClassifierFailure,
  resetClassifierHealth,
} from '../src/moderation/health.js';
import { season } from '../src/seasons.js';
import { inZoomies, rollZoomies } from '../src/zoomies.js';

await openTestDatabase();

const lines = content.commands.mood;
const BOT = '898000000000000000';
const ME = { id: BOT };
const EVERYONE = { id: TEST_GUILD };
const GENERAL = '898100000000000001';
const MEMES = '898100000000000002';

/** What she answers on a day with nothing going on: depends on the date. */
const ordinaryDay = () => season()?.mood ?? lines.everyday;

const asking = (extra = {}) =>
  interaction({ data: { name: 'mai', options: [{ name: 'mood', type: 1 }] }, ...extra });

/** Runs `fn` with every roll landing on `roll` and the process an hour old. */
function settled(fn, { roll = 0, uptime = 3600 } = {}) {
  const realRandom = Math.random;
  const realUptime = process.uptime;
  Math.random = () => roll;
  process.uptime = () => uptime;
  try {
    return fn();
  } finally {
    Math.random = realRandom;
    process.uptime = realUptime;
  }
}

/** A server with two public text channels she could claim. */
function clientWith() {
  const holding = (...flags) => ({ has: (wanted) => [].concat(wanted).every((f) => flags.includes(f)) });
  const channel = (id) => ({
    id,
    type: ChannelType.GuildText,
    nsfw: false,
    parentId: null,
    permissionsFor: (target) =>
      target === ME
        ? holding(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages)
        : holding(PermissionFlagsBits.ViewChannel),
  });
  const guild = {
    id: TEST_GUILD,
    members: { me: ME },
    roles: { everyone: EVERYONE },
    channels: { cache: new Map([[GENERAL, channel(GENERAL)], [MEMES, channel(MEMES)]]) },
  };
  return { guilds: { cache: new Map([[TEST_GUILD, guild]]) } };
}

const wipe = () => {
  resetPetting();
  resetTerritory();
  resetClassifierHealth();
  getDb().exec('DELETE FROM moderation_queue');
  getDb().exec('DELETE FROM violations');
  getDb().exec('DELETE FROM guild_settings');
};

/** Every roll a test compares across, so no single lucky line hides a difference. */
const ROLLS = [0, 0.3, 0.6, 0.99];

test('she answers in public, at once, with a configured line, and calls nothing', async () => {
  wipe();
  assert.equal(config.chat.enabled, false, 'chat is off in this file');
  const fetched = [];
  const restore = stubFetch((url) => {
    fetched.push(url);
    throw new Error('nothing should be fetched');
  });

  let response;
  try {
    response = await settled(() => maiCommand.execute(asking()));
  } finally {
    restore();
  }

  assert.equal(maiCommand.deferred(asking()), false);
  assert.equal(response.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal((response.data.flags ?? 0) & EPHEMERAL, 0, 'public');
  assert.ok(ordinaryDay().includes(response.data.content), response.data.content);
  assert.deepEqual(fetched, []);
});

test('the hairball never shows: a failing guild gets exactly the answer a healthy one does', () => {
  for (const roll of ROLLS) {
    wipe();
    const client = clientWith();
    const who = { userId: TEST_USER, guildId: TEST_GUILD, channelId: MEMES, client };
    const healthy = settled(() => describeMood(who), { roll });

    for (let i = 0; i < config.moderation.degradedAfter; i++) recordClassifierFailure(TEST_GUILD);
    assert.equal(isDegraded(TEST_GUILD), true);

    assert.equal(settled(() => describeMood(who), { roll }), healthy, `roll ${roll}`);
  }
});

test('nothing she could say about it is even in the file', () => {
  const said = [
    ...lines.everyday,
    ...lines.zoomies,
    ...lines.vet,
    ...lines.sleeping,
    lines.territoryHere,
    lines.territoryElsewhere,
    ...content.seasons.flatMap((entry) => entry.mood ?? []),
  ].join('\n').toLowerCase();

  for (const word of ['haarball', 'verschnupft', 'krank', 'moderation', 'kaputt', 'verstoß', 'strike']) {
    assert.equal(said.includes(word), false, word);
  }
});

test('an open violation and a record change nothing either', () => {
  for (const roll of ROLLS) {
    wipe();
    const who = { userId: TEST_USER, guildId: TEST_GUILD, channelId: MEMES };
    const clean = settled(() => describeMood(who), { roll });

    const now = new Date();
    // Open in another server, which is exactly what must not be told here.
    enqueue({
      messageId: '898200000000000001',
      guildId: OTHER_GUILD,
      channelId: '898200000000000002',
      userId: TEST_USER,
      categories: ['harassment'],
      warnedAt: now.toISOString(),
      dueAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    recordViolation({
      guildId: TEST_GUILD,
      userId: TEST_USER,
      messageId: '898200000000000003',
      categories: ['harassment'],
      action: ACTION_DELETED,
    });

    assert.equal(settled(() => describeMood(who), { roll }), clean, `roll ${roll}`);
  }
});

test('the zoomies beat the vet, and the vet beats an ordinary day', () => {
  wipe();
  // A month ago: a burst is "now < until" with no start, so one set in the
  // past is over by now and cannot leak into the other tests' clock.
  const earlier = Date.now() - 30 * 86_400_000;
  const who = { userId: TEST_USER };

  assert.ok(lines.vet.includes(settled(() => describeMood(who, earlier), { uptime: 60 })));

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({ unref() { return this; } });
  try {
    assert.equal(settled(() => rollZoomies(earlier)), true, 'a burst started');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(inZoomies(), false, 'and long over by now');

  assert.ok(lines.zoomies.includes(settled(() => describeMood(who, earlier), { uptime: 60 })));
});

test('a member she is sulking with gets the sulk, and only that member', () => {
  wipe();
  const now = Date.now();
  let outcome;
  for (let i = 0; i <= config.petting.patience; i++) outcome = pet(TEST_USER, now);
  assert.equal(outcome, BITE);

  const client = clientWith();
  const sulk = settled(() =>
    describeMood({ userId: TEST_USER, guildId: TEST_GUILD, channelId: GENERAL, client }, now));
  assert.ok(content.commands.pet.sulking.includes(sulk), 'the sulk and nothing else');

  const other = settled(() =>
    describeMood({ userId: 'somebody-else', guildId: TEST_GUILD, channelId: GENERAL, client }, now));
  assert.ok(ordinaryDay().includes(other.split('\n')[0]));
});

test('her territory: smug in it, named elsewhere, and nothing in a DM', () => {
  wipe();
  const client = clientWith();
  // The first channel in the cache, with every roll landing on 0.
  const inside = settled(() =>
    describeMood({ userId: TEST_USER, guildId: TEST_GUILD, channelId: GENERAL, client }));
  const [state, claim] = inside.split('\n');
  assert.ok(ordinaryDay().includes(state), state);
  assert.equal(claim, lines.territoryHere);

  const outside = settled(() =>
    describeMood({ userId: TEST_USER, guildId: TEST_GUILD, channelId: MEMES, client }));
  assert.equal(
    outside.split('\n')[1],
    fill(lines.territoryElsewhere, { channel: `<#${GENERAL}>` }),
  );

  // A thread inside her channel is her channel.
  const thread = settled(() =>
    describeMood({
      userId: TEST_USER,
      guildId: TEST_GUILD,
      channelId: '898100000000000099',
      parentId: GENERAL,
      client,
    }));
  assert.equal(thread.split('\n')[1], lines.territoryHere);

  const dm = settled(() => describeMood({ userId: TEST_USER, guildId: null, client }));
  assert.equal(dm.includes('\n'), false, 'one line, no territory');
  // Before the gateway is ready there is no client and nothing to claim.
  const early = settled(() => describeMood({ userId: TEST_USER, guildId: TEST_GUILD, client: null }));
  assert.equal(early.includes('\n'), false);
});
