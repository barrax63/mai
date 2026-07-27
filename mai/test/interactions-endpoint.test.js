/**
 * The two gates in front of the Ed25519 signature check.
 *
 * `/interactions` is public through the tunnel and verifying a signature is the
 * expensive part of answering, so a flood has to be turned away *before* it, not
 * by it. That is why `limitRate` and `limitBody` are the only middleware allowed
 * to run ahead of `verifyKeyMiddleware`, in that order, and why the limiter keys
 * on `CF-Connecting-IP`: every request otherwise carries the cloudflared
 * container's address and one caller would spend everyone's budget.
 */
import './setup-http.js';
import { openTestDatabase } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { createServer } from '../src/http/server.js';

await openTestDatabase();

const app = createServer();

/**
 * @param {object} headers
 * @returns {Promise<number | { status: number, body: string }>} Status, or both
 *   when `detailed` is set.
 */
const request = (headers = {}, detailed = false) =>
  new Promise((resolve) => {
    const req = {
      method: 'POST',
      url: '/interactions',
      headers: { host: 'x', ...headers },
      socket: { remoteAddress: '10.0.0.1' },
      on: () => {},
      get(name) {
        return this.headers[name.toLowerCase()];
      },
    };
    const res = {
      statusCode: 200,
      setHeader: () => {},
      getHeader: () => undefined,
      removeHeader: () => {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      end: (body) =>
        resolve(detailed ? { status: res.statusCode, body: body === undefined ? '' : String(body) } : res.statusCode),
    };
    app(req, res);
  });

/** @param {object} headers */
const post = (headers = {}) => request(headers);

const sized = (ip) => ({ 'cf-connecting-ip': ip, 'content-length': '128' });

test('the limiter runs before the body check, which runs before the signature check', async () => {
  // A request with no declared length is refused by limitBody with 413, which
  // is only reachable once limitRate has let it through: the 429 below replaces
  // that 413, so the order is visible in the status alone.
  assert.equal(await post({ 'cf-connecting-ip': '1.1.1.1' }), 413);
  assert.equal(await post({ 'cf-connecting-ip': '1.1.1.1' }), 413);
  assert.equal(await post({ 'cf-connecting-ip': '1.1.1.1' }), 429, 'the third one never reaches limitBody');
});

test('a well-formed body is refused just as cheaply once the budget is gone', async () => {
  const flooder = '2.2.2.2';

  assert.notEqual(await post(sized(flooder)), 429);
  assert.notEqual(await post(sized(flooder)), 429);
  assert.equal(await post(sized(flooder)), 429);
  assert.equal(await post(sized(flooder)), 429, 'a refusal does not refill the bucket');
});

test('one caller cannot spend another callers budget', async () => {
  const loud = '3.3.3.3';
  for (let index = 0; index < config.http.rateLimitMax + 2; index++) await post(sized(loud));

  assert.equal(await post(sized(loud)), 429);
  assert.notEqual(await post(sized('4.4.4.4')), 429, 'a different client has its own bucket');
});

test('a forged header only ever splits the forger own budget into more buckets', async () => {
  // The header is unreachable to spoof in this deployment (cloudflared
  // overwrites it and the port is published on the internal network only), and
  // even if it were not, faking one buys a fresh bucket rather than someone
  // else's.
  assert.notEqual(await post(sized('5.5.5.5')), 429);
  assert.notEqual(await post(sized('5.5.5.6')), 429);
});

test('without the header every caller shares one bucket, which is survivable, not silent', async () => {
  // Deployed without Cloudflare in front, req.ip is the same for everybody, so
  // the per-client limit becomes a global one. The operator is warned once at
  // startup rather than per request; here the point is only that the endpoint
  // still answers instead of failing.
  const withoutHeader = { 'content-length': '128' };

  const statuses = [await post(withoutHeader), await post(withoutHeader), await post(withoutHeader)];

  assert.ok(statuses.includes(429), 'the shared bucket is still a limit');
  assert.ok(statuses.every((status) => status !== 200));
});

test('an oversized body is refused before the signature check reads it', async () => {
  assert.equal(await post({ 'cf-connecting-ip': '6.6.6.6', 'content-length': String(config.http.maxBodyBytes + 1) }), 413);
});

test('a refusal carries no body: nothing to learn from probing the endpoint', async () => {
  const tooLarge = await request(
    { 'cf-connecting-ip': '7.7.7.7', 'content-length': String(config.http.maxBodyBytes + 1) },
    true,
  );
  assert.deepEqual(tooLarge, { status: 413, body: '' });

  for (let index = 0; index < config.http.rateLimitMax; index++) await post(sized('7.7.7.7'));
  const limited = await request(sized('7.7.7.7'), true);

  assert.deepEqual(limited, { status: 429, body: '' });
});
