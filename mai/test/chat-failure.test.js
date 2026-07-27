/**
 * Failure paths of the deferred command flow, with chat switched on so the
 * OpenAI client is really exercised: against a stubbed fetch, never the network.
 */
import './setup-chat.js';
import { interaction, openTestDatabase, stubFetch } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { content } from '../src/content.js';
import { routeInteraction } from '../src/interactions/router.js';

await openTestDatabase();

// The per-user rate limit is process-wide, so each test uses its own member.
const askInteraction = (userId = '400000000000000001') =>
  interaction({
    type: InteractionType.APPLICATION_COMMAND,
    member: { user: { id: userId, username: 'tester' }, permissions: '0' },
    data: {
      name: 'mai',
      options: [{ name: 'ask', options: [{ name: 'frage', value: 'Wo ist der Fisch?' }] }],
    },
  });

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('a model reply reaches the deferred placeholder', async () => {
  const calls = [];
  const restore = stubFetch((url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.includes('/chat/completions')) {
      return jsonResponse({ choices: [{ message: { content: '*schnurrt* Im Kühlschrank.' } }] });
    }
    return jsonResponse({});
  });

  const sent = [];
  try {
    await routeInteraction(askInteraction(), (body) => sent.push(body));
  } finally {
    restore();
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);

  const [completion, edit] = calls;
  assert.match(completion.url, /\/chat\/completions$/);
  assert.deepEqual(
    completion.body.messages.map((message) => message.role),
    ['system', 'user'],
  );
  assert.match(completion.body.messages[1].content, /Wo ist der Fisch\?/);
  assert.match(edit.url, /\/messages\/@original$/);
  assert.match(edit.body.content, /Im Kühlschrank\./);
  assert.match(edit.body.content, /> Wo ist der Fisch\?/, 'quotes the question');
});

test('an API failure becomes an in-character error, not a hanging interaction', async () => {
  const attempts = [];
  const edits = [];
  const restore = stubFetch((url) => {
    if (url.includes('/chat/completions')) {
      attempts.push(url);
      return jsonResponse({ error: { message: 'boom' } }, 500);
    }
    edits.push(url);
    return jsonResponse({});
  });

  const sent = [];
  try {
    await routeInteraction(askInteraction('400000000000000002'), (body) => sent.push(body));
  } finally {
    restore();
  }

  assert.equal(sent.length, 1, 'the interaction was still acknowledged');
  // OPENAI_MAX_RETRIES=1 -> two attempts on a retryable status.
  assert.equal(attempts.length, 2);
  assert.equal(edits.length, 1);
  assert.equal(sent[0].type, InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
});

test('a rate-limited member gets a refusal instead of a model call', async () => {
  const completions = [];
  const restore = stubFetch((url) => {
    if (url.includes('/chat/completions')) {
      completions.push(url);
      return jsonResponse({ choices: [{ message: { content: 'miau' } }] });
    }
    return jsonResponse({});
  });

  try {
    // CHAT_RATE_LIMIT_MAX defaults to 5 within the window.
    for (let i = 0; i < 7; i++) {
      await routeInteraction(askInteraction('400000000000000003'), () => {});
    }
  } finally {
    restore();
  }

  assert.equal(completions.length, 5, 'stopped calling the model after the limit');
});

test('the busy reply is the configured, in-character one', () => {
  assert.match(content.commands.ask.busy, /\S/);
  assert.notEqual(content.commands.ask.busy, content.commands.error);
});
