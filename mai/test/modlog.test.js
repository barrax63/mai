import { openTestDatabase, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { content } from '../src/content.js';
import { updateSettings } from '../src/db/settings.js';
import {
  buildLogEmbed,
  LOG_CLEARED,
  LOG_DELETED,
  LOG_FLAGGED,
  LOG_FORGIVEN,
  LOG_SELF_DELETED,
  postModerationLog,
} from '../src/moderation/log.js';

await openTestDatabase();

const GUILD = '910000000000000001';
const CHANNEL = '920000000000000001';
const MESSAGE = '930000000000000001';

const flagged = {
  type: LOG_FLAGGED,
  guildId: GUILD,
  channelId: CHANNEL,
  messageId: MESSAGE,
  userId: TEST_USER,
  categories: ['harassment'],
  dueAt: '2026-07-26T12:00:00.000Z',
};

const fieldValue = (embed, label) => embed.fields.find((field) => field.name === label)?.value;

test('a flagged entry carries ids, categories, deadline and a jump link', () => {
  const embed = buildLogEmbed(flagged);
  const labels = content.moderation.log.fields;

  assert.equal(embed.title, content.moderation.log.titles.flagged);
  assert.equal(fieldValue(embed, labels.user), `<@${TEST_USER}> \`${TEST_USER}\``);
  assert.equal(fieldValue(embed, labels.channel), `<#${CHANNEL}>`);
  assert.equal(fieldValue(embed, labels.categories), 'harassment');
  // 2026-07-26T12:00:00Z as a Discord relative timestamp.
  assert.equal(fieldValue(embed, labels.due), '<t:1785067200:R>');
  // The id first, always, then a jump link while the message still exists.
  assert.equal(
    fieldValue(embed, labels.message),
    `\`${MESSAGE}\`\n[${content.moderation.log.jump}](https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE})`,
  );
  assert.equal(embed.footer, undefined, 'no boilerplate footer on every entry');
  assert.ok(embed.timestamp, 'but a log entry still says when');
});

test('every message-scoped entry carries the id in the same field', () => {
  // The point of the shared layout: following one incident across
  // markiert -> gelöscht -> korrigiert must not mean hunting for the id.
  for (const type of [LOG_FLAGGED, LOG_DELETED, LOG_SELF_DELETED, LOG_CLEARED]) {
    const embed = buildLogEmbed({ ...flagged, type });
    const value = fieldValue(embed, content.moderation.log.fields.message);

    assert.ok(value, `${type} has no message field`);
    assert.ok(value.includes(`\`${MESSAGE}\``), `${type} does not show the id: ${value}`);
  }
});

test('a jump link only appears while there is something to jump to', () => {
  const gone = buildLogEmbed({ ...flagged, type: LOG_DELETED });
  assert.equal(
    fieldValue(gone, content.moderation.log.fields.message).includes('discord.com'),
    false,
    'a deleted message would 404',
  );

  const alive = buildLogEmbed({ ...flagged, type: LOG_CLEARED });
  assert.ok(fieldValue(alive, content.moderation.log.fields.message).includes('discord.com'));
});

test('no message content ever reaches an entry', () => {
  const embed = buildLogEmbed({ ...flagged, content: 'geheimer inhalt', cleanContent: 'auch das' });
  assert.equal(JSON.stringify(embed).includes('geheimer'), false);
  assert.equal(JSON.stringify(embed).includes('auch das'), false);
});

test('a deleted entry drops the jump link and keeps the id', () => {
  const embed = buildLogEmbed({ ...flagged, type: LOG_DELETED });
  const value = fieldValue(embed, content.moderation.log.fields.message);

  assert.equal(value, `\`${MESSAGE}\``);
  assert.equal(value.includes('discord.com'), false, 'the message no longer exists');
});

test('a self-deleted entry keeps the id but needs no deadline', () => {
  const embed = buildLogEmbed({ ...flagged, type: LOG_SELF_DELETED });
  const labels = content.moderation.log.fields;

  // It used to have no message field at all, which broke correlation for the
  // one outcome staff most want to trace back.
  assert.equal(fieldValue(embed, labels.message), `\`${MESSAGE}\``);
  assert.equal(fieldValue(embed, labels.due), undefined);
  assert.equal(fieldValue(embed, labels.categories), 'harassment');
});

test('a forgiven entry names the actor and the count', () => {
  const embed = buildLogEmbed({
    type: LOG_FORGIVEN,
    guildId: GUILD,
    userId: TEST_USER,
    actorId: '940000000000000001',
    count: 2,
  });
  const labels = content.moderation.log.fields;

  assert.equal(fieldValue(embed, labels.actor), '<@940000000000000001>');
  assert.equal(fieldValue(embed, labels.count), '2');
});

test('missing categories render as the configured placeholder', () => {
  const embed = buildLogEmbed({ ...flagged, categories: [] });
  assert.equal(fieldValue(embed, content.moderation.log.fields.categories), content.moderation.log.none);
});

test('every event kind has its own colour and title', () => {
  const kinds = [LOG_FLAGGED, LOG_DELETED, LOG_SELF_DELETED, LOG_FORGIVEN];
  const embeds = kinds.map((type) => buildLogEmbed({ ...flagged, type }));

  assert.equal(new Set(embeds.map((embed) => embed.color)).size, kinds.length);
  assert.equal(new Set(embeds.map((embed) => embed.title)).size, kinds.length);
});

test('posting is skipped when the guild has no log channel', async () => {
  let called = false;
  const client = { channels: { fetch: async () => { called = true; return null; } } };

  assert.equal(await postModerationLog(client, flagged), false);
  assert.equal(called, false, 'no Discord call without a configured channel');
});

test('posting sends one embed with pings disabled', async () => {
  updateSettings(GUILD, { 'log-channel': CHANNEL });

  const sent = [];
  const client = {
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => sent.push(payload),
      }),
    },
  };

  assert.equal(await postModerationLog(client, flagged), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('a broken log channel is survivable', async () => {
  updateSettings(GUILD, { 'log-channel': CHANNEL });

  const throwing = { channels: { fetch: async () => { throw new Error('Missing Access'); } } };
  assert.equal(await postModerationLog(throwing, flagged), false);

  const voiceChannel = { channels: { fetch: async () => ({ isTextBased: () => false }) } };
  assert.equal(await postModerationLog(voiceChannel, flagged), false);

  assert.equal(await postModerationLog(null, flagged), false);
});
