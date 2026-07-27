import { interaction, openTestDatabase, OTHER_GUILD, stubFetch, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { optionValue, resolveSubcommand } from '../src/interactions/options.js';
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
    // CHAT_ENABLED=false, so /mai ask short-circuits without touching OpenAI:
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

test('autocomplete passes the same guild gates as every other interaction kind', async () => {
  // A command that actually answers, so a refusal is distinguishable from
  // "this command has no autocomplete" (both produce an empty list otherwise).
  const { commandHandlers } = await import('../src/commands/index.js');
  const { updateSettings } = await import('../src/db/settings.js');
  const choices = [{ name: 'fisch', value: 'fisch' }];
  commandHandlers.set('autotest', { definition: { name: 'autotest' }, autocomplete: () => choices });

  const suggest = async (overrides = {}) => {
    const res = collector();
    await routeInteraction(
      interaction({
        type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
        data: { name: 'autotest' },
        ...overrides,
      }),
      res.send,
    );
    return res.first.body;
  };

  try {
    const allowed = await suggest();
    assert.deepEqual(allowed.data.choices, choices, 'the baseline actually suggests something');

    const foreign = await suggest({ guild_id: OTHER_GUILD });
    assert.equal(
      foreign.type,
      InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      'refused in the autocomplete protocol, never with a message',
    );
    assert.deepEqual(foreign.data.choices, [], 'a guild outside the allowlist gets nothing');

    updateSettings(TEST_GUILD, { enabled: false });
    try {
      const paused = await suggest();
      assert.equal(paused.type, InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
      assert.deepEqual(paused.data.choices, [], 'a paused guild gets nothing either');

      // …except /mod, which stays usable while paused so a server can switch
      // Mai back on. Suggestions have to follow the command: an option that
      // will not complete is a command that cannot be typed.
      commandHandlers.get('mod').autocomplete = () => choices;
      try {
        const staff = await suggest({ data: { name: 'mod' } });
        assert.deepEqual(staff.data.choices, choices, '/mod still completes while paused');
      } finally {
        delete commandHandlers.get('mod').autocomplete;
      }
    } finally {
      updateSettings(TEST_GUILD, { enabled: true });
    }
  } finally {
    commandHandlers.delete('autotest');
  }
});

test('modal submits are routed (no modal is registered yet)', async () => {
  const res = collector();
  await routeInteraction(
    interaction({ type: InteractionType.MODAL_SUBMIT, data: { custom_id: 'appeal:1' } }),
    res.send,
  );

  assert.equal(res.first.body.data.content, content.commands.expired);
});

const STAFF = { user: { id: TEST_USER, username: 'tester' }, permissions: String(1n << 13n) };

test('resolveSubcommand flattens plain subcommands and groups alike', () => {
  assert.deepEqual(
    resolveSubcommand({ data: { options: [{ name: 'status', type: 1 }] } }),
    { group: null, name: 'status', options: [] },
  );

  const grouped = resolveSubcommand({
    data: {
      options: [
        { name: 'config', type: 2, options: [{ name: 'set', type: 1, options: [{ name: 'grace', value: 5 }] }] },
      ],
    },
  });
  assert.equal(grouped.group, 'config');
  assert.equal(grouped.name, 'set');
  assert.equal(optionValue(grouped.options, 'grace'), 5);

  // A command without subcommands keeps its options at the top level.
  const flat = resolveSubcommand({ data: { options: [{ name: 'frage', value: 'hm' }] } });
  assert.equal(flat.name, undefined);
  assert.equal(optionValue(flat.options, 'frage'), 'hm');
});

test('/mod config set stores an override and views it back', async () => {
  const set = collector();
  await routeInteraction(
    command(
      'mod',
      [{ name: 'config', type: 2, options: [{ name: 'set', type: 1, options: [{ name: 'grace', value: 42 }] }] }],
      { member: STAFF },
    ),
    set.send,
  );
  assert.match(set.first.body.data.content, /42 Minuten/);
  assert.equal(set.first.body.data.flags, EPHEMERAL);

  const view = collector();
  await routeInteraction(
    command('mod', [{ name: 'config', type: 2, options: [{ name: 'view', type: 1 }] }], {
      member: STAFF,
    }),
    view.send,
  );
  assert.match(view.first.body.data.content, /42 Minuten/);
  // The value is no longer inherited, so the default marker must be gone from
  // that line.
  const graceLine = view.first.body.data.content
    .split('\n')
    .find((line) => line.includes('Schonfrist'));
  assert.equal(graceLine.includes(content.commands.config.inherited), false);
});

test('/mod config set rejects an out-of-range value in character', async () => {
  const res = collector();
  await routeInteraction(
    command(
      'mod',
      [{ name: 'config', type: 2, options: [{ name: 'set', type: 1, options: [{ name: 'grace', value: 99999 }] }] }],
      { member: STAFF },
    ),
    res.send,
  );

  assert.match(res.first.body.data.content, /^Ungültiger Wert/);
});

test('/mod config set with no options changes nothing', async () => {
  const res = collector();
  await routeInteraction(
    command('mod', [{ name: 'config', type: 2, options: [{ name: 'set', type: 1, options: [] }] }], {
      member: STAFF,
    }),
    res.send,
  );

  assert.equal(res.first.body.data.content, content.commands.config.nothing);
});

test('/mod config reset returns a setting to inherited', async () => {
  const res = collector();
  await routeInteraction(
    command(
      'mod',
      [{ name: 'config', type: 2, options: [{ name: 'reset', type: 1, options: [{ name: 'setting', value: 'grace' }] }] }],
      { member: STAFF },
    ),
    res.send,
  );

  const graceLine = res.first.body.data.content
    .split('\n')
    .find((line) => line.includes('Schonfrist'));
  assert.ok(graceLine.includes(content.commands.config.inherited), graceLine);
});

test('/mod config is refused in a DM and to non-staff', async () => {
  const dm = collector();
  await routeInteraction(
    command('mod', [{ name: 'config', type: 2, options: [{ name: 'view', type: 1 }] }], {
      guild_id: undefined,
      member: undefined,
      user: { id: TEST_USER, username: 'tester' },
    }),
    dm.send,
  );
  // No member object in a DM means no Manage Messages, so the permission check
  // answers first.
  assert.equal(dm.first.body.data.content, content.commands.forbidden);

  const plain = collector();
  await routeInteraction(
    command('mod', [{ name: 'config', type: 2, options: [{ name: 'view', type: 1 }] }]),
    plain.send,
  );
  assert.equal(plain.first.body.data.content, content.commands.forbidden);
});

test('parseCustomId splits the handler name from its arguments', () => {
  assert.deepEqual(parseCustomId('forget:123:extra'), { name: 'forget', args: ['123', 'extra'] });
  assert.deepEqual(parseCustomId('plain'), { name: 'plain', args: [] });
  assert.deepEqual(parseCustomId(undefined), { name: '', args: [] });
});
