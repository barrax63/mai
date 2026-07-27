/**
 * The interaction response builders and the two webhook calls behind a defer.
 *
 * The traps this file pins down: every response Mai builds is silent by default
 * (`allowed_mentions: { parse: [] }`), and `flags` is fixed at defer time, so the
 * later edit must not carry one. A deferred command that tried to turn ephemeral
 * in its edit would simply be answering publicly without noticing, which is how a
 * permission refusal ends up in a channel.
 */
import './setup.js';
import { interaction, stubFetch } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType } from 'discord-interactions';
import {
  autocompleteResponse,
  deferredResponse,
  deferredUpdateResponse,
  editOriginalResponse,
  ephemeralResponse,
  EPHEMERAL,
  followUpResponse,
  messageResponse,
  modalResponse,
  PARAGRAPH_INPUT,
  SHORT_INPUT,
  textInput,
  updateResponse,
} from '../src/interactions/respond.js';

test('a plain message is public and pings nothing', () => {
  const response = messageResponse('miau');

  assert.equal(response.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(response.data.content, 'miau');
  assert.deepEqual(response.data.allowed_mentions, { parse: [] });
  assert.ok(!('flags' in response.data), 'public unless asked otherwise');
});

test('an ephemeral response is the same thing with the flag set', () => {
  const response = ephemeralResponse('nur für dich');

  assert.equal(response.data.flags, EPHEMERAL);
  assert.deepEqual(response.data.allowed_mentions, { parse: [] });
});

test('components ride along only when there are any', () => {
  const withComponents = messageResponse('x', { components: [{ type: 1, components: [] }] });

  assert.equal(withComponents.data.components.length, 1);
  assert.ok(!('components' in messageResponse('x').data));
});

test('an update with no components removes the buttons, which is how a decision closes', () => {
  const response = updateResponse('entschieden');

  assert.equal(response.type, InteractionResponseType.UPDATE_MESSAGE);
  assert.deepEqual(response.data.components, []);
  assert.deepEqual(response.data.allowed_mentions, { parse: [] });
});

test('an update may keep the message text and replace only the embed', () => {
  const response = updateResponse(null, { embeds: [{ title: 'Gemeldet' }], components: [] });

  assert.ok(!('content' in response.data), 'null means: leave what is there');
  assert.equal(response.data.embeds.length, 1);
});

test('ephemerality is decided at defer time, because the edit cannot change it', () => {
  assert.deepEqual(deferredResponse(), {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
  assert.equal(deferredResponse(true).data.flags, EPHEMERAL);
  assert.deepEqual(deferredUpdateResponse(), { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
});

test('autocomplete answers at most the 25 choices Discord accepts', () => {
  const choices = Array.from({ length: 40 }, (_, index) => ({ name: `n${index}`, value: String(index) }));
  const response = autocompleteResponse(choices);

  assert.equal(response.type, InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
  assert.equal(response.data.choices.length, 25);
  assert.equal(response.data.choices[0].value, '0');
});

test('an empty choice list is a valid answer: it is how autocomplete refuses', () => {
  assert.deepEqual(autocompleteResponse([]).data.choices, []);
});

test('a modal carries its state in the custom_id, since the interaction data is gone by then', () => {
  const response = modalResponse({
    customId: 'report:1:2:3',
    title: 'Melden',
    components: [textInput({ customId: 'reason', label: 'Warum?' })],
  });

  assert.equal(response.type, InteractionResponseType.MODAL);
  assert.equal(response.data.custom_id, 'report:1:2:3');
  assert.ok(response.data.custom_id.length <= 100, 'Discord caps a custom_id at 100 characters');
});

test('a text input is wrapped in the action row Discord insists on', () => {
  const row = textInput({
    customId: 'reason',
    label: 'Warum?',
    style: PARAGRAPH_INPUT,
    required: false,
    maxLength: 400,
    placeholder: 'optional',
  });

  assert.equal(row.type, 1);
  assert.deepEqual(row.components[0], {
    type: 4,
    custom_id: 'reason',
    label: 'Warum?',
    style: PARAGRAPH_INPUT,
    required: false,
    max_length: 400,
    placeholder: 'optional',
  });
});

test('an input leaves out what it was not given, rather than sending nulls', () => {
  const [input] = textInput({ customId: 'reason', label: 'Warum?' }).components;

  assert.equal(input.style, SHORT_INPUT);
  assert.equal(input.required, true);
  assert.ok(!('max_length' in input));
  assert.ok(!('placeholder' in input));
});

test('the edit strips flags: a deferred response cannot turn ephemeral afterwards', async () => {
  const calls = [];
  const restore = stubFetch((url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    await editOriginalResponse(interaction(), ephemeralResponse('zu spät für heimlich'));
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original');
  assert.ok(!('flags' in calls[0].body), 'Discord rejects the edit if it repeats the flag');
  assert.equal(calls[0].body.content, 'zu spät für heimlich');
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
});

test('a bare message body is accepted as well as a full response envelope', async () => {
  const bodies = [];
  const restore = stubFetch((url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    await editOriginalResponse(interaction(), { content: 'direkt', embeds: [{ title: 'x' }] });
  } finally {
    restore();
  }

  assert.equal(bodies[0].content, 'direkt');
  assert.equal(bodies[0].embeds.length, 1);
  assert.deepEqual(bodies[0].allowed_mentions, { parse: [] });
});

test('a follow-up posts instead of patching', async () => {
  const calls = [];
  const restore = stubFetch((url, options) => {
    calls.push({ url, method: options.method });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    await followUpResponse(interaction(), messageResponse('noch etwas'));
  } finally {
    restore();
  }

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://discord.com/api/v10/webhooks/app-1/interaction-token');
});

test('a failed edit is reported as null, never retried: the token expires', async () => {
  const attempts = [];
  const restore = stubFetch((url) => {
    attempts.push(url);
    return new Response('Unknown Webhook', { status: 404 });
  });

  let result;
  try {
    result = await editOriginalResponse(interaction(), messageResponse('zu spät'));
  } finally {
    restore();
  }

  assert.equal(result, null);
  assert.equal(attempts.length, 1);
});

test('a response body that is not JSON does not break the caller', async () => {
  const restore = stubFetch(() => new Response('', { status: 200 }));

  try {
    assert.deepEqual(await editOriginalResponse(interaction(), messageResponse('x')), {});
  } finally {
    restore();
  }
});
