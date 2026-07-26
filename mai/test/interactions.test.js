import { interaction, openTestDatabase, OTHER_GUILD, stubFetch, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { EPHEMERAL } from '../src/interactions/respond.js';
import { parseCustomId } from '../src/interactions/registry.js';
import { routeInteraction } from '../src/interactions/router.js';

await openTestDatabase();

/**
 * Collects what the router sends as the HTTP response.
 */
function collector() {
  const sent = [];
  const send = (body, status = 200) => sent.push({ body, status });
  return { send, sent, get first() { return sent[0]; } };
}

const command = (name, options = [], overrides = {}) =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    data: { name, options },
    ...overrides,
  });

test('answers a ping with a pong', async () => {
  const res = collector();
  await routeInteraction({ type: InteractionType.PING }, res.send);

  assert.equal(res.sent.length, 1);
  assert.deepEqual(res.first.body, { type: InteractionResponseType.PONG });
});

test('rejects an unknown interaction type with 400', async () => {
  const res = collector();
  await routeInteraction({ type: 99 }, res.send);
  assert.equal(res.first.status, 400);
});

test('rejects an unknown command with 400', async () => {
  const res = collector();
  await routeInteraction(command('nope'), res.send);
  assert.equal(res.first.status, 400);
});

test('refuses commands from a guild outside the allowlist', async () => {
  const res = collector();
  await routeInteraction(command('ping', [], { guild_id: OTHER_GUILD }), res.send);

  assert.equal(res.first.body.data.content, content.commands.notActive);
  assert.equal(res.first.body.data.flags, EPHEMERAL);
});

test('runs a non-deferred command and sends its response directly', async () => {
  const res = collector();
  await routeInteraction(command('ping'), res.send);

  assert.equal(res.sent.length, 1);
  assert.equal(res.first.body.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.match(res.first.body.data.content, /^Pong!/);
});

test('defers a slow command and edits the placeholder afterwards', async () => {
  const calls = [];
  const restore = stubFetch((url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const res = collector();
  try {
    // CHAT_ENABLED=false, so /mai ask short-circuits without touching OpenAI —
    // the deferral path itself is what this exercises.
    await routeInteraction(
      command('mai', [{ name: 'ask', options: [{ name: 'frage', value: 'Wo ist der Fisch?' }] }]),
      res.send,
    );
  } finally {
    restore();
  }

  assert.equal(res.sent.length, 1, 'exactly one HTTP response');
  assert.equal(
    res.first.body.type,
    InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  );

  assert.equal(calls.length, 1, 'one webhook call to fill the placeholder');
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/webhooks\/app-1\/interaction-token\/messages\/@original$/);
  assert.equal(calls[0].body.content, content.commands.ask.disabled);
  // Ephemerality is fixed at defer time; sending flags again would be rejected.
  assert.equal('flags' in calls[0].body, false);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
});

test('refuses a staff command to a member without Manage Messages', async () => {
  const res = collector();
  await routeInteraction(command('mod', [{ name: 'status' }]), res.send);

  assert.equal(res.first.body.data.content, content.commands.forbidden);
  assert.equal(res.first.body.data.flags, EPHEMERAL);
});

test('runs a staff command for a member with Manage Messages', async () => {
  const res = collector();
  await routeInteraction(
    command('mod', [{ name: 'status' }], {
      member: { user: { id: TEST_USER, username: 'tester' }, permissions: String(1n << 13n) },
    }),
    res.send,
  );

  assert.match(res.first.body.data.content, /Offene Verstöße/);
  assert.ok(res.first.body.data.content.includes(content.commands.status.never));
});

test('routes a button to its handler and updates the message', async () => {
  const res = collector();
  await routeInteraction(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: `forget:${TEST_USER}`, component_type: 2 },
    }),
    res.send,
  );

  assert.equal(res.first.body.type, InteractionResponseType.UPDATE_MESSAGE);
  assert.match(res.first.body.data.content, /Vergessen/);
});

test('a button may only be used by the member it was created for', async () => {
  const res = collector();
  await routeInteraction(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: 'forget:999', component_type: 2 },
    }),
    res.send,
  );

  assert.equal(res.first.body.data.content, content.commands.forbidden);
});

test('tells the user when a component has no handler any more', async () => {
  const res = collector();
  await routeInteraction(
    interaction({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: 'gone:1', component_type: 2 },
    }),
    res.send,
  );

  assert.equal(res.first.body.data.content, content.commands.expired);
});

test('answers autocomplete with an empty list when the command has none', async () => {
  const res = collector();
  await routeInteraction(
    interaction({ type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE, data: { name: 'ping' } }),
    res.send,
  );

  assert.equal(
    res.first.body.type,
    InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
  );
  assert.deepEqual(res.first.body.data.choices, []);
});

test('modal submits are routed (no modal is registered yet)', async () => {
  const res = collector();
  await routeInteraction(
    interaction({ type: InteractionType.MODAL_SUBMIT, data: { custom_id: 'appeal:1' } }),
    res.send,
  );

  assert.equal(res.first.body.data.content, content.commands.expired);
});

test('parseCustomId splits the handler name from its arguments', () => {
  assert.deepEqual(parseCustomId('forget:123:extra'), { name: 'forget', args: ['123', 'extra'] });
  assert.deepEqual(parseCustomId('plain'), { name: 'plain', args: [] });
  assert.deepEqual(parseCustomId(undefined), { name: '', args: [] });
});
