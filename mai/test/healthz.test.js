/**
 * The liveness probe.
 *
 * `/healthz` is a real probe, not a 200 that proves the event loop turns: the
 * two things that fail silently are the database and the moderation tick loop,
 * and a wedged enforcer means flagged messages are never deleted while HTTP
 * keeps answering cheerfully. The Docker healthcheck hits this every 30 s, so it
 * also has to stay cheap.
 */
import './setup-moderation.js';
import { openTestDatabase } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createServer } from '../src/http/server.js';
import { runTick } from '../src/moderation/enforcer.js';

await openTestDatabase();

const app = createServer();

/** A client with nothing to do: the tick runs against an empty queue. */
const idleClient = {
  user: { id: '870000000000000001' },
  channels: { fetch: async () => null },
  users: { fetch: async () => ({ send: async () => ({ id: 'dm' }) }) },
  guilds: { cache: new Map(), fetch: async () => null },
};

const get = (url = '/healthz') =>
  new Promise((resolve) => {
    const req = {
      method: 'GET',
      url,
      headers: { host: 'x' },
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

const health = async () => {
  const response = await get();
  return { status: response.status, body: JSON.parse(response.body) };
};

test('before the first tick the probe allows a startup grace period', async () => {
  // The gateway has to connect before the enforcer can run at all, so a fresh
  // process reporting "no tick yet" is not a broken one.
  const { status, body } = await health();

  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.database, true);
  assert.equal(body.enforcer.enabled, true);
  assert.equal(body.enforcer.lastTickAt, null);
  assert.equal(body.enforcer.tickAgeMs, null);
});

test('after the grace period, a process that never ticked is degraded', async () => {
  const realUptime = process.uptime;
  process.uptime = () => 3600;

  try {
    const { status, body } = await health();

    assert.equal(status, 503);
    assert.equal(body.status, 'degraded');
    assert.equal(body.database, true, 'the database is fine, the enforcer is not');
  } finally {
    process.uptime = realUptime;
  }
});

test('a tick that just ran makes the probe healthy', async () => {
  await runTick(idleClient);

  const { status, body } = await health();

  assert.equal(status, 200);
  assert.match(body.enforcer.lastTickAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(body.enforcer.tickAgeMs >= 0 && body.enforcer.tickAgeMs < 5000);
  assert.equal(body.enforcer.running, false);
});

test('three missed ticks are what counts as broken', async () => {
  await runTick(idleClient);
  const realNow = Date.now;
  const startedAt = realNow();

  try {
    // Just inside the window: two and a half missed ticks.
    Date.now = () => startedAt + config.moderation.tickMs * 2.5;
    assert.equal((await health()).status, 200);

    // Past it.
    Date.now = () => startedAt + config.moderation.tickMs * 3 + 1000;
    const late = await health();
    assert.equal(late.status, 503);
    assert.equal(late.body.status, 'degraded');
    assert.ok(late.body.enforcer.tickAgeMs > config.moderation.tickMs * 3);
  } finally {
    Date.now = realNow;
  }
});

test('an unreachable database is degraded even with a fresh tick', async () => {
  await runTick(idleClient);
  closeDatabase();

  try {
    const { status, body } = await health();

    assert.equal(status, 503);
    assert.equal(body.database, false);
  } finally {
    openDatabase();
  }
});

test('the probe answers JSON and says which half is unhappy', async () => {
  await runTick(idleClient);
  const { body } = await health();

  assert.deepEqual(Object.keys(body).sort(), ['database', 'enforcer', 'status']);
  assert.deepEqual(Object.keys(body.enforcer).sort(), ['enabled', 'lastTickAt', 'running', 'tickAgeMs']);
});
