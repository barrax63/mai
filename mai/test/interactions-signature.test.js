/**
 * The signature gate itself, end to end over a real socket.
 *
 * `interactions-endpoint.test.js` proves the *ordering* of the two cheap gates
 * in front of it, but every request in that file stops at 413 or 429, so
 * `verifyKeyMiddleware` was never reached and the handler behind it was never
 * run. This file is the other half: an unsigned request is refused, a badly
 * signed one is refused, and a correctly signed one reaches the router and comes
 * back with an answer.
 *
 * A real listener rather than a fake req/res pair, because the middleware
 * consumes the raw request stream: faking that is faking the thing under test.
 */
import { signRequest } from './setup-signature.js';
import { openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { after } from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { createServer } from '../src/http/server.js';

await openTestDatabase();

const server = createServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/interactions`;

after(() => server.close());

/**
 * @param {object} payload
 * @param {{ sign?: boolean, timestamp?: string }} [options]
 */
async function post(payload, { sign: signIt = true, timestamp = String(Date.now()) } = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };

  if (signIt !== false) {
    headers['x-signature-ed25519'] = signIt === true ? signRequest(timestamp, body) : signIt;
    headers['x-signature-timestamp'] = timestamp;
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  // A refusal from the middleware is plain text, an answer from the router is
  // JSON: the caller reads whichever it expects.
  const json = response.headers.get('content-type')?.includes('application/json');
  return { status: response.status, body: json && text ? JSON.parse(text) : text };
}

test('a correctly signed ping is answered, so the gate is not simply refusing everything', async () => {
  const { status, body } = await post({ type: InteractionType.PING });

  assert.equal(status, 200);
  assert.equal(body.type, InteractionResponseType.PONG);
});

test('an unsigned request never reaches the router', async () => {
  const { status } = await post({ type: InteractionType.PING }, { sign: false });

  // 401 from the middleware itself. The point is not the number: it is that
  // this endpoint is public through the tunnel, and anything that answered an
  // unsigned request would be acting on a payload anybody could have written.
  assert.equal(status, 401);
});

test('a signature that is not the one for this body is refused', async () => {
  const timestamp = String(Date.now());
  const forOtherBody = signRequest(timestamp, JSON.stringify({ type: InteractionType.PING }));

  // Valid hex, valid length, genuinely produced by the right key: just not over
  // the bytes actually sent. Replaying a captured signature onto a new payload
  // is the attack this check exists for.
  const { status } = await post(
    { type: InteractionType.APPLICATION_COMMAND, data: { name: 'ping' } },
    { sign: forOtherBody, timestamp },
  );

  assert.equal(status, 401);
});

test('a signature from the wrong key is refused, however well formed', async () => {
  const { status } = await post({ type: InteractionType.PING }, { sign: 'ab'.repeat(32) });

  assert.equal(status, 401);
});

test('a signed command is routed, and its answer comes back through the endpoint', async () => {
  const { status, body } = await post({
    type: InteractionType.APPLICATION_COMMAND,
    id: '1',
    application_id: '1',
    token: 'test-token',
    guild_id: TEST_GUILD,
    channel_id: '444444444444444444',
    member: { user: { id: TEST_USER, username: 'tester' }, permissions: '0' },
    data: { id: '2', name: 'ping', type: 1 },
  });

  assert.equal(status, 200);
  assert.equal(body.type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.ok(body.data.content, 'the router answered, not the middleware');
});
