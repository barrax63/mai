/**
 * Staff acting *through* Mai rather than only undoing her: the context-menu
 * deletion, `/mod warn` and `/mod note`.
 *
 * Two properties carry the weight here. A manual deletion has to leave the
 * record in the same state an automatic one would, including cleaning up a row
 * Mai was still holding, or the next tick reads the missing message as the
 * author having fixed it and silently downgrades the strike. And a warning from
 * a human must **not** be a strike: `strikeCount` counts enforced deletions, so
 * a moderator having a word cannot move somebody up a ladder that ends in a
 * timeout.
 */
import { interaction, openTestDatabase, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { getDb } from '../src/db/index.js';
import { notesFor } from '../src/db/notes.js';
import { enqueue, findRow } from '../src/db/queue.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import {
  ACTION_WARNED,
  historyFor,
  strikeCount,
  totalsFor,
} from '../src/db/violations.js';
import { setGatewayClient } from '../src/gateway/client.js';
import { routeInteraction } from '../src/interactions/router.js';
import { clearOwnDeletions, isOwnDeletion } from '../src/moderation/cleanup.js';

await openTestDatabase();

const CHANNEL = '900000000000000001';
const LOG_CHANNEL = '900000000000000002';
const MESSAGE = '900000000000000003';
const OFFENDER = '900000000000000004';
const STAFF_ID = '900000000000000005';
const STAFF = { user: { id: STAFF_ID, username: 'staff' }, permissions: String(1n << 13n) };

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

/**
 * The context-menu deletion is deferred for staff, so its real answer arrives
 * as an edit through the interaction webhook. Captured here, both to read those
 * answers and because no test may reach the network.
 */
const edits = [];
stubFetch((url, options) => {
  edits.push({ url, body: JSON.parse(options.body ?? '{}') });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
});

const wipe = () => {
  getDb().exec('DELETE FROM violations');
  getDb().exec('DELETE FROM member_notes');
  getDb().exec('DELETE FROM moderation_queue');
  edits.length = 0;
  clearOwnDeletions();
};

/** Everything Mai reaches Discord through, and what she did with it. */
function stubGateway({ deleteFails = false, dmFails = false, channelGuildId = TEST_GUILD } = {}) {
  const record = { posted: [], deleted: [], dms: [] };

  setGatewayClient({
    guilds: { cache: new Map([[TEST_GUILD, { id: TEST_GUILD, name: 'Katzenhaus' }]]) },
    channels: {
      fetch: async (id) => ({
        id,
        guildId: channelGuildId,
        isTextBased: () => true,
        send: async (payload) => record.posted.push({ channelId: id, ...payload }),
        messages: {
          delete: async (messageId) => {
            if (deleteFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
            record.deleted.push(messageId);
          },
        },
      }),
    },
    users: {
      fetch: async (userId) => ({
        send: async (payload) => {
          if (dmFails) throw Object.assign(new Error('Cannot send messages'), { code: 50007 });
          record.dms.push({ userId, ...payload });
        },
      }),
    },
  });

  return record;
}

const route = async (payload) => {
  let body;
  await routeInteraction(payload, (sent) => {
    body = sent;
  });
  return body;
};

const removeCommand = ({ member = STAFF, messageId = MESSAGE, bot = false } = {}) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    channel_id: CHANNEL,
    member,
    data: {
      name: 'Löschen (Mai)',
      type: 3,
      target_id: messageId,
      resolved: {
        messages: {
          [messageId]: {
            id: messageId,
            author: { id: bot ? 'bot-1' : OFFENDER, bot },
            content: 'der inhalt',
            attachments: [],
          },
        },
      },
    },
  });

const modCommand = (options, member = STAFF) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    member,
    data: { name: 'mod', options },
  });

const warnCommand = (reason) =>
  modCommand([
    {
      name: 'warn',
      type: 1,
      options: [
        { name: 'user', value: OFFENDER },
        ...(reason ? [{ name: 'reason', value: reason }] : []),
      ],
    },
  ]);

const noteCommand = (name, options) =>
  modCommand([{ name: 'note', type: 2, options: [{ name, type: 1, options }] }]);

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a staff deletion removes the message and records the strike', async () => {
  wipe();
  const record = stubGateway();

  const body = await route(removeCommand());
  await settle();

  assert.equal(body.type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(body.data.flags, 64, 'ephemeral is fixed at defer time, not by the edit');
  assert.deepEqual(record.deleted, [MESSAGE]);
  assert.match(edits.at(-1).body.content, new RegExp(`<@${OFFENDER}>`));

  // On the record like any other enforced deletion, so the ladder counts it.
  assert.equal(strikeCount(TEST_GUILD, OFFENDER, '2000-01-01T00:00:00.000Z'), 1);
  // And registered as Mai's own work, or the gateway's delete event would
  // record the author as having fixed it themselves.
  assert.equal(isOwnDeletion(MESSAGE), true);
});

test('a message Mai was still holding does not resolve as a self-deletion', async () => {
  wipe();
  const record = stubGateway();
  enqueue({
    messageId: MESSAGE,
    guildId: TEST_GUILD,
    channelId: CHANNEL,
    userId: OFFENDER,
    categories: ['harassment'],
    warnedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + 600_000).toISOString(),
    scoldMessageId: '900000000000000009',
  });

  await route(removeCommand());
  await settle();

  // The row has to go with the message: the next tick would otherwise fetch a
  // message that is gone, read 10008 as "the author deleted it" and write a
  // self-deletion over the strike this click just recorded.
  assert.equal(findRow(MESSAGE), null);
  assert.ok(record.deleted.includes('900000000000000009'), 'the scold reply goes too');
  assert.equal(totalsFor(TEST_GUILD, OFFENDER).selfDeleted, 0);
  assert.equal(totalsFor(TEST_GUILD, OFFENDER).deleted, 1);
});

test('a staff deletion is refused to everyone else', async () => {
  wipe();
  const record = stubGateway();

  const body = await route(removeCommand({ member: { user: { id: TEST_USER }, permissions: '0' } }));

  // Refused immediately rather than through the deferral: a placeholder plus a
  // webhook edit for somebody who was never allowed to do anything is two
  // round trips for one line.
  assert.equal(body.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(body.data.content, content.commands.forbidden);
  assert.deepEqual(record.deleted, []);
});

test('a bot message earns no file', async () => {
  wipe();
  const record = stubGateway();

  await route(removeCommand({ bot: true }));
  await settle();

  assert.deepEqual(record.deleted, []);
  assert.equal(totalsFor(TEST_GUILD, 'bot-1').total, 0);
  assert.equal(edits.at(-1).body.content, content.commands.remove.botMessage);
});

test('a failed deletion records nothing', async () => {
  wipe();
  stubGateway({ deleteFails: true });

  await route(removeCommand());
  await settle();

  assert.equal(totalsFor(TEST_GUILD, OFFENDER).total, 0, 'no strike for a message still standing');
});

test('/mod warn DMs the member and stays off the ladder', async () => {
  wipe();
  const record = stubGateway();

  await route(warnCommand('Hör auf, Leute vollzuspammen.'));
  await settle();

  assert.equal(record.dms.length, 1);
  assert.equal(record.dms[0].userId, OFFENDER);
  assert.match(record.dms[0].content, /Hör auf/);
  assert.match(record.dms[0].content, /Katzenhaus/, 'the DM names the server it is about');
  assert.equal(record.dms[0].components, undefined, 'no appeal button: this is not a strike');

  // On the record, visible to the next moderator, and worth no timeout.
  assert.equal(historyFor(TEST_GUILD, OFFENDER)[0].action, ACTION_WARNED);
  assert.equal(strikeCount(TEST_GUILD, OFFENDER, '2000-01-01T00:00:00.000Z'), 0);

  const entry = record.posted.at(-1).embeds[0];
  assert.equal(entry.title, content.moderation.log.titles.warned);
  const value = (label) => entry.fields.find((field) => field.name === label)?.value;
  assert.equal(value(content.moderation.log.fields.actor), `<@${STAFF_ID}>`);
  assert.match(value(content.moderation.log.fields.reason), /Hör auf/);
});

test('a warning that cannot be delivered says so, and still counts as said', async () => {
  wipe();
  const record = stubGateway({ dmFails: true });

  const body = await route(warnCommand('Letzte Warnung.'));
  await settle();

  assert.match(body.data.content, /DM/, 'the moderator is told to say it in the channel instead');
  assert.equal(historyFor(TEST_GUILD, OFFENDER).length, 1, 'the record has it either way');
  assert.equal(
    record.posted.at(-1).embeds[0].fields.find(
      (field) => field.name === content.moderation.log.fields.resolution,
    ).value,
    content.commands.warn.notDelivered,
  );
});

test('/mod note writes to the file the next moderator reads', async () => {
  wipe();
  stubGateway();

  await route(
    noteCommand('add', [
      { name: 'user', value: OFFENDER },
      { name: 'text', value: 'Hat sich im Voice entschuldigt.' },
    ]),
  );

  const notes = notesFor(TEST_GUILD, OFFENDER);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].note, 'Hat sich im Voice entschuldigt.');
  assert.equal(notes[0].authorId, STAFF_ID);

  // The point of a note is that it is where somebody will look.
  const history = await route(
    modCommand([{ name: 'history', type: 1, options: [{ name: 'user', value: OFFENDER }] }]),
  );
  assert.match(history.data.content, /Hat sich im Voice entschuldigt/);
  assert.equal(/\{[a-z]/i.test(history.data.content), false, 'every placeholder substituted');
});

test('notes are per member and per guild, and clearable', async () => {
  wipe();
  stubGateway();

  await route(
    noteCommand('add', [
      { name: 'user', value: OFFENDER },
      { name: 'text', value: 'eins' },
    ]),
  );
  await route(
    noteCommand('add', [
      { name: 'user', value: TEST_USER },
      { name: 'text', value: 'zwei' },
    ]),
  );

  assert.equal(notesFor(TEST_GUILD, OFFENDER).length, 1);
  assert.equal(notesFor('999000000000000001', OFFENDER).length, 0, 'another guild sees nothing');

  const cleared = await route(noteCommand('clear', [{ name: 'user', value: OFFENDER }]));
  assert.match(cleared.data.content, /1/);
  assert.equal(notesFor(TEST_GUILD, OFFENDER).length, 0);
  assert.equal(notesFor(TEST_GUILD, TEST_USER).length, 1, 'the other member keeps theirs');
});

test('notes and warnings are staff-only', async () => {
  wipe();
  stubGateway();
  const plain = { user: { id: TEST_USER, username: 'tester' }, permissions: '0' };

  for (const payload of [
    warnCommand('nope'),
    noteCommand('add', [{ name: 'user', value: OFFENDER }, { name: 'text', value: 'nope' }]),
  ]) {
    const body = await route({ ...payload, member: plain });
    assert.equal(body.data.content, content.commands.forbidden);
  }

  assert.equal(notesFor(TEST_GUILD, OFFENDER).length, 0);
  assert.equal(totalsFor(TEST_GUILD, OFFENDER).total, 0);
});

test('acting on a channel in another guild is refused', async () => {
  wipe();
  const record = stubGateway({ channelGuildId: '999000000000000002' });

  await route(removeCommand());
  await settle();

  // Same rule as the report buttons: the bot's client reaches every guild Mai
  // is in, so the target's guild is proven rather than assumed.
  assert.deepEqual(record.deleted, []);
  assert.equal(totalsFor(TEST_GUILD, OFFENDER).total, 0);
});

test('/mod warn and /mod note need a guild', async () => {
  wipe();
  stubGateway();

  for (const payload of [
    warnCommand('x'),
    noteCommand('add', [{ name: 'user', value: OFFENDER }, { name: 'text', value: 'x' }]),
  ]) {
    const body = await route({
      ...payload,
      guild_id: undefined,
      member: undefined,
      user: { id: STAFF_ID },
    });
    // No member object in a DM means no Manage Messages, so the permission
    // check answers before the guild check does.
    assert.equal(body.data.content, content.commands.forbidden);
  }
});
