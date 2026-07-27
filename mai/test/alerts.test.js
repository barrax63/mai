/**
 * Error alerting. `setup-alerts.js` must come first, it configures the channel
 * and a log level that actually emits errors, before config.js is loaded.
 */
import './setup-alerts.js';
import { openTestDatabase } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setGatewayClient } from '../src/gateway/client.js';
import { logger } from '../src/logger.js';

await openTestDatabase();

const ALERT_CHANNEL = '950000000000000001';

/** Alerts are fire-and-forget; give the microtask queue a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function captureAlerts() {
  const sent = [];
  setGatewayClient({
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => sent.push({ channelId: id, ...payload }),
      }),
    },
  });
  return sent;
}

test('an error log reaches the alert channel', async () => {
  const sent = captureAlerts();

  logger.error({ messageId: 'm1', guildId: 'g1', err: new TypeError('boom') }, 'Something broke');
  await settle();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, ALERT_CHANNEL);
  assert.match(sent[0].content, /\*\*error\*\*: Something broke/);
  assert.match(sent[0].content, /messageId=m1/);
  assert.match(sent[0].content, /guildId=g1/);
  // The error's *name* identifies it; its message is free text that can quote
  // config, a database value or a request body, and the alert channel is
  // permanent Discord storage. It stays in the container log only.
  assert.match(sent[0].content, /err=TypeError/);
  assert.equal(sent[0].content.includes('boom'), false, 'no exception message in the channel');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('machine-readable error codes still reach the channel', async () => {
  const sent = captureAlerts();

  const error = Object.assign(new Error('upstream said no'), {
    name: 'OpenAiError',
    status: 500,
    code: 'http_error',
  });
  logger.error({ err: error }, 'OpenAI is unhappy');
  await settle();

  assert.match(sent[0].content, /err=OpenAiError status=500 code=http_error/);
  assert.equal(sent[0].content.includes('upstream said no'), false);
});

test('info and warn stay out of the channel', async () => {
  const sent = captureAlerts();

  logger.info({ userId: 'u1' }, 'nothing to see');
  logger.warn({ userId: 'u1' }, 'also fine');
  await settle();

  assert.equal(sent.length, 0);
});

test('only whitelisted keys are forwarded: a record may carry content', async () => {
  const sent = captureAlerts();

  logger.error(
    { messageId: 'm2', content: 'geheimer text', reply: 'auch geheim', username: 'noah' },
    'Handler failed',
  );
  await settle();

  const [alert] = sent;
  assert.match(alert.content, /messageId=m2/);
  assert.equal(alert.content.includes('geheimer text'), false);
  assert.equal(alert.content.includes('auch geheim'), false);
  assert.equal(alert.content.includes('noah'), false);
});

test('a burst is throttled instead of flooding the channel', async () => {
  const sent = captureAlerts();
  const burst = 9;

  for (let i = 0; i < burst; i++) {
    logger.error({ messageId: `burst-${i}` }, 'repeated failure');
  }
  await settle();

  // The window (5 alerts / 5 minutes) is shared with the tests above, so the
  // exact number depends on what they used: the invariant is that a failing
  // subsystem cannot turn the alert channel into the outage.
  assert.ok(sent.length < burst, `all ${burst} got through`);
  assert.ok(sent.length <= 5, `${sent.length} exceeds the window allowance`);
  // What was dropped is counted and reported by the first alert of the next
  // window; that needs a clock five minutes on, so it is not asserted here.
});

test('a failing alert channel cannot take the process down', async () => {
  setGatewayClient({
    channels: {
      fetch: async () => {
        throw new Error('Missing Access');
      },
    },
  });

  // The throttle window from the previous test is still open, so this only has
  // to prove that the rejected send is swallowed.
  logger.error({ messageId: 'm3' }, 'still fine');
  await settle();
  assert.ok(true);
});

test('without a gateway client nothing is sent and nothing throws', async () => {
  setGatewayClient(null);
  logger.error({ messageId: 'm4' }, 'no client yet');
  await settle();
  assert.ok(true);
});
