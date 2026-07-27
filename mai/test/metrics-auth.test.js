/**
 * The /metrics bearer check.
 *
 * Its own file because `METRICS_TOKEN` has to be set before `config.js` freezes
 * the environment, and every other test runs with the endpoint disabled.
 *
 * The gate matters: the HTTP server is public through the cloudflared tunnel,
 * and these numbers span every guild Mai serves.
 */
import './setup-metrics.js';
import { openTestDatabase } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/http/server.js';

await openTestDatabase();

const app = createServer();

const get = (headers = {}) =>
  new Promise((resolve) => {
    const req = {
      method: 'GET',
      url: '/metrics',
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
      type() {
        return this;
      },
      send(body) {
        resolve({ status: res.statusCode, body: String(body) });
      },
      end() {
        resolve({ status: res.statusCode, body: '' });
      },
    };
    app(req, res);
  });

test('the right bearer token gets the metrics', async () => {
  const response = await get({ authorization: 'Bearer test-metrics-token' });

  assert.equal(response.status, 200);
  assert.match(response.body, /^mai_up 1$/m);
});

test('anything else gets nothing', async () => {
  for (const headers of [
    {},
    { authorization: 'Bearer wrong-token-x' },
    { authorization: 'Bearer test-metrics-toke' }, // one byte short
    { authorization: 'test-metrics-token' }, // no scheme
    { authorization: 'Basic test-metrics-token' },
  ]) {
    const response = await get(headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(response.body, '', 'no metrics leak in the refusal');
  }
});
