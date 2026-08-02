/**
 * What Mai remembers, and what that memory looks like on disk.
 *
 * `chat_history` is the only place message content is persisted, a deliberate
 * exception to the no-content rule, so the guarantees around it are the point of
 * this file: content and username are ciphertext in the column, a rotated key
 * costs memory rather than crashing a reply, and `/mai forget` really removes
 * what it promises.
 */
import './setup-chat.js';
import { openTestDatabase, TEST_GUILD, TEST_USER, interaction } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { rememberExchange } from '../src/chat/reply.js';
import { decrypt, encrypt } from '../src/db/crypto.js';
import { appendTurns, deleteForUser, pruneOlderThan, recentTurns, stats } from '../src/db/history.js';
import { getDb } from '../src/db/index.js';
import { routeInteraction } from '../src/interactions/router.js';

await openTestDatabase();

const GUILD_CHANNEL = '850000000000000001';
const DM_CHANNEL = '850000000000000002';
const OTHER_USER = '850000000000000003';

const rawRows = (channelId) =>
  getDb().prepare('SELECT * FROM chat_history WHERE channel_id = ? ORDER BY id').all(channelId);

const wipe = () => getDb().exec('DELETE FROM chat_history');

/** A row written under a key that is not the configured one. */
function foreignCiphertext(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 9), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

test('a value survives the round trip, and the same text encrypts differently twice', () => {
  const plain = 'miau, wo ist der fisch?';
  const once = encrypt(plain);
  const twice = encrypt(plain);

  assert.equal(decrypt(once), plain);
  assert.notEqual(once, twice, 'a fresh IV per value, or equal messages would be linkable');
  assert.equal(once.split(':').length, 4);
  assert.ok(once.startsWith('v1:'));
  assert.ok(!once.includes(plain));
});

test('empty strings and unicode survive too', () => {
  for (const plain of ['', '🐟', 'Grüße über\nzwei Zeilen', 'a'.repeat(4000)]) {
    assert.equal(decrypt(encrypt(plain)), plain);
  }
});

test('a tampered value does not decrypt: the tag is checked, not just the format', () => {
  const [version, iv, tag, ciphertext] = encrypt('nur für Mai').split(':');
  const flipped = Buffer.from(ciphertext, 'base64');
  flipped[0] ^= 0xff;

  assert.throws(() => decrypt([version, iv, tag, flipped.toString('base64')].join(':')));
});

test('anything that is not the stored format is refused, not guessed at', () => {
  // Wrong shape or wrong version: refused before a cipher is ever built.
  for (const value of ['', 'plaintext', 'v2:a:b:c', 'v1:a:b', null, undefined]) {
    assert.throws(() => decrypt(value), /Unsupported ciphertext format/, String(value));
  }
  // Right shape, unusable parts: the cipher itself refuses it.
  assert.throws(() => decrypt('v1:a:b:c'));
});

test('what lands in the column is ciphertext, and the lookup keys stay plaintext', () => {
  wipe();
  appendTurns([
    {
      channelId: GUILD_CHANNEL,
      guildId: TEST_GUILD,
      userId: TEST_USER,
      username: 'tester',
      role: 'user',
      content: 'ein sehr eindeutiger satz',
    },
  ]);

  const [row] = rawRows(GUILD_CHANNEL);

  assert.ok(!row.content.includes('ein sehr eindeutiger satz'));
  assert.ok(!row.username.includes('tester'));
  assert.ok(row.content.startsWith('v1:'));
  assert.ok(row.username.startsWith('v1:'));
  // Lookup and pruning keys, and metadata under the logging rule.
  assert.equal(row.channel_id, GUILD_CHANNEL);
  assert.equal(row.guild_id, TEST_GUILD);
  assert.equal(row.user_id, TEST_USER);
  assert.equal(row.role, 'user');
  assert.match(row.sent_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a turn pair keeps its order, even written in the same millisecond', () => {
  wipe();
  const now = new Date('2026-01-01T12:00:00.000Z');
  appendTurns(
    [
      { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'frage' },
      { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: null, username: 'Mai', role: 'assistant', content: 'antwort' },
    ],
    now,
  );

  const turns = recentTurns(GUILD_CHANNEL, 10);

  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.deepEqual(turns.map((turn) => turn.content), ['frage', 'antwort']);
  assert.notEqual(turns[0].sentAt, turns[1].sentAt, 'spaced by a millisecond so they cannot tie');
});

test('history comes back oldest first, capped at the limit', () => {
  wipe();
  for (let index = 0; index < 6; index++) {
    appendTurns(
      [{ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: `nachricht ${index}` }],
      new Date(Date.now() + index * 1000),
    );
  }

  const turns = recentTurns(GUILD_CHANNEL, 3);

  assert.deepEqual(turns.map((turn) => turn.content), ['nachricht 3', 'nachricht 4', 'nachricht 5']);
});

test('another channel is another memory', () => {
  wipe();
  appendTurns([{ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'hier' }]);
  appendTurns([{ channelId: DM_CHANNEL, guildId: null, userId: TEST_USER, username: 'tester', role: 'user', content: 'dort' }]);

  assert.deepEqual(recentTurns(GUILD_CHANNEL, 10).map((turn) => turn.content), ['hier']);
  assert.deepEqual(recentTurns(DM_CHANNEL, 10).map((turn) => turn.content), ['dort']);
});

test('a row from another key is skipped, never thrown: a rotation costs memory, not replies', () => {
  wipe();
  appendTurns([{ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'lesbar' }]);
  getDb()
    .prepare('INSERT INTO chat_history (channel_id, guild_id, user_id, username, role, content, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(GUILD_CHANNEL, TEST_GUILD, TEST_USER, foreignCiphertext('alt'), 'user', foreignCiphertext('alter inhalt'), new Date().toISOString());

  const turns = recentTurns(GUILD_CHANNEL, 10);

  assert.deepEqual(turns.map((turn) => turn.content), ['lesbar']);
  assert.equal(rawRows(GUILD_CHANNEL).length, 2, 'the row is skipped in the prompt, not deleted on read');
});

test('a failing turn rolls the whole append back', () => {
  wipe();
  assert.throws(() =>
    appendTurns([
      { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'erste' },
      // NOT NULL on channel_id: the second insert fails.
      { channelId: null, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'zweite' },
    ]),
  );

  assert.equal(rawRows(GUILD_CHANNEL).length, 0, 'no half-written exchange');
});

test('retention drops what is older than the cutoff and nothing else', () => {
  wipe();
  appendTurns(
    [{ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'alt' }],
    new Date(Date.now() - 72 * 3_600_000),
  );
  appendTurns([{ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'neu' }]);

  const removed = pruneOlderThan(new Date(Date.now() - 48 * 3_600_000).toISOString());

  assert.equal(removed, 1);
  assert.deepEqual(recentTurns(GUILD_CHANNEL, 10).map((turn) => turn.content), ['neu']);
});

test('stats are scoped to a guild, and direct messages belong to none', () => {
  wipe();
  appendTurns([{ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'a' }]);
  appendTurns([{ channelId: DM_CHANNEL, guildId: null, userId: TEST_USER, username: 'tester', role: 'user', content: 'b' }]);

  assert.deepEqual(stats(TEST_GUILD), { rows: 1, channels: 1 });
  assert.deepEqual(stats(), { rows: 2, channels: 2 }, 'the process-wide view, operators only');
});

test('a wipe takes a DM channel whole, and only the member own turns in a guild', () => {
  wipe();
  appendTurns([
    { channelId: DM_CHANNEL, guildId: null, userId: TEST_USER, username: 'tester', role: 'user', content: 'privat' },
    { channelId: DM_CHANNEL, guildId: null, userId: null, username: 'Mai', role: 'assistant', content: 'antwort, die zitiert' },
  ]);
  appendTurns([
    { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', role: 'user', content: 'meins' },
    { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: null, username: 'Mai', role: 'assistant', content: 'oeffentlich gepostet' },
    { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: OTHER_USER, username: 'andere', role: 'user', content: 'nicht meins' },
  ]);

  const removed = deleteForUser(TEST_USER);

  assert.equal(removed, 3, 'both DM rows plus the one guild turn');
  assert.deepEqual(recentTurns(DM_CHANNEL, 10), [], 'her answers there quote him, so they go too');
  assert.deepEqual(
    recentTurns(GUILD_CHANNEL, 10).map((turn) => turn.content),
    ['oeffentlich gepostet', 'nicht meins'],
    'her public reply stays, and another member turn is not his to delete',
  );
});

test('wiping a user nobody remembers removes nothing', () => {
  wipe();
  assert.equal(deleteForUser(OTHER_USER), 0);
});

test('an exchange is remembered as the member wrote it, without the prompt context', () => {
  wipe();
  rememberExchange(
    {
      channelId: GUILD_CHANNEL,
      guildId: TEST_GUILD,
      userId: TEST_USER,
      username: 'tester',
      content: '  hallo Mai  ',
      images: ['https://cdn.example/a.png'],
    },
    { text: 'miau' },
  );

  const turns = recentTurns(GUILD_CHANNEL, 10);

  assert.deepEqual(turns.map((turn) => [turn.role, turn.content]), [
    ['user', 'hallo Mai'],
    ['assistant', 'miau'],
  ]);
  assert.equal(turns[1].username, content.chat.prompt.assistantLabel);
  // The image URL was prompt context, and a Discord CDN link expires anyway.
  assert.ok(!JSON.stringify(turns).includes('cdn.example'));
});

test('an image-only message is remembered as a placeholder, not as an empty turn', () => {
  wipe();
  rememberExchange(
    { channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', content: '   ', images: ['https://cdn.example/a.png'] },
    { text: 'was soll das sein?' },
  );

  assert.deepEqual(recentTurns(GUILD_CHANNEL, 10).map((turn) => turn.content), [
    content.chat.prompt.imagePlaceholder,
    'was soll das sein?',
  ]);
});

test('a bare poke stores only her answer', () => {
  wipe();
  rememberExchange({ channelId: GUILD_CHANNEL, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', content: '' }, { text: 'was?' });

  assert.deepEqual(recentTurns(GUILD_CHANNEL, 10).map((turn) => [turn.role, turn.content]), [['assistant', 'was?']]);
});

test('memory loss is survivable: the reply was already delivered', () => {
  wipe();
  assert.doesNotThrow(() =>
    // A NOT NULL channel id: appendTurns throws, rememberExchange swallows it.
    rememberExchange({ channelId: null, guildId: TEST_GUILD, userId: TEST_USER, username: 'tester', content: 'hallo' }, { text: 'miau' }),
  );
});

test('/mai forget builds its buttons around the caller own id', async () => {
  // The two button handlers were tested, the command that produces them was
  // not, so nothing asserted that the id in the custom_id is the caller's. It
  // is the whole basis of the check the handlers perform: a button built with
  // somebody else's id would hand them a working wipe of that person's memory.
  let body;
  await routeInteraction(
    interaction({
      type: InteractionType.APPLICATION_COMMAND,
      guild_id: undefined,
      member: undefined,
      user: { id: OTHER_USER, username: 'other' },
      data: { name: 'mai', options: [{ name: 'forget', type: 1 }] },
    }),
    (sent) => {
      body = sent;
    },
  );

  assert.equal(body.data.flags, 64, 'ephemeral: this is nobody else business');
  assert.deepEqual(
    body.data.components[0].components.map((button) => button.custom_id),
    [`forget:${OTHER_USER}`, `forget-cancel:${OTHER_USER}`],
    'the caller id, taken from the interaction rather than from anything they sent',
  );
});

test('/mai forget wipes only for the member who clicked', async () => {
  wipe();
  appendTurns([{ channelId: DM_CHANNEL, guildId: null, userId: TEST_USER, username: 'tester', role: 'user', content: 'privat' }]);

  let ownersAnswer;
  await routeInteraction(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: `forget:${OTHER_USER}` },
    }),
    (body) => {
      ownersAnswer = body;
    },
  );

  assert.ok(JSON.stringify(ownersAnswer).includes(content.commands.forbidden));
  assert.equal(recentTurns(DM_CHANNEL, 10).length, 1, 'a custom_id names a target, it never authorizes one');

  let confirmed;
  await routeInteraction(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: `forget:${TEST_USER}` },
    }),
    (body) => {
      confirmed = body;
    },
  );

  assert.equal(recentTurns(DM_CHANNEL, 10).length, 0);
  assert.ok(JSON.stringify(confirmed).includes('1'), 'the count of removed rows is reported back');
});

test('cancelling the wipe keeps the memory', async () => {
  wipe();
  appendTurns([{ channelId: DM_CHANNEL, guildId: null, userId: TEST_USER, username: 'tester', role: 'user', content: 'privat' }]);

  let answer;
  await routeInteraction(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: `forget-cancel:${TEST_USER}` },
    }),
    (body) => {
      answer = body;
    },
  );

  assert.ok(JSON.stringify(answer).includes(content.commands.forget.cancelled));
  assert.equal(recentTurns(DM_CHANNEL, 10).length, 1);
});
