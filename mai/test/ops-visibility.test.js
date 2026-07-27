/**
 * The things staff and operators need to be able to *see*:
 *
 *   - an appeal gets an answer that reaches both the channel and the member,
 *   - a settings change lands where the rest of the team will find it,
 *   - /metrics exists, is operator-only, and reports real numbers.
 */
import './setup-security.js';
import { interaction, openTestDatabase, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { config } from '../src/config.js';
import { content } from '../src/content.js';
import { enqueue } from '../src/db/queue.js';
import { updateSettings } from '../src/db/settings.js';
import {
  ACTION_DELETED,
  ACTION_EDITED,
  ACTION_OVERTURNED,
  ACTION_SELF_DELETED,
  historyFor,
  recordViolation,
  strikeCount,
  totalsFor as violationTotals,
} from '../src/db/violations.js';
import { setGatewayClient } from '../src/gateway/client.js';
import { renderMetrics } from '../src/http/metrics.js';
import { routeInteraction } from '../src/interactions/router.js';

await openTestDatabase();

const LOG_CHANNEL = 'b10000000000000001';
const STAFF_PERMISSIONS = String(1n << 13n); // Manage Messages
const APPELLANT = 'b20000000000000001';

updateSettings(TEST_GUILD, { 'log-channel': LOG_CHANNEL });

/** Records what Mai posts to channels and DMs. */
function stubGateway({ dmFails = false } = {}) {
  const posted = [];
  const dms = [];

  setGatewayClient({
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => posted.push({ channelId: id, ...payload }),
      }),
    },
    users: {
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          if (dmFails) throw new Error('Cannot send messages to this user');
          dms.push({ userId: id, ...payload });
        },
      }),
    },
  });

  return { posted, dms };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// ------------------------------------------------------------------- gap 15

async function clickDecision(customId, permissions = STAFF_PERMISSIONS) {
  const sent = [];
  const edits = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    edits.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await routeInteraction(
      interaction({
        type: InteractionType.MESSAGE_COMPONENT,
        member: { user: { id: TEST_USER, username: 'staff' }, permissions },
        message: { embeds: [{ title: 'appeal', fields: [{ name: 'a', value: 'b' }] }] },
        data: { custom_id: customId, component_type: 2 },
      }),
      (body) => sent.push(body),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  return { sent, edits };
}

test('granting an appeal stops the strike counting, without erasing it', async () => {
  const incident = new Date(Date.now() - 60_000);
  const since = Math.floor(incident.getTime() / 1000);

  // One older, correct strike and one from the incident being appealed.
  recordViolation({
    guildId: TEST_GUILD,
    userId: APPELLANT,
    messageId: 'b50000000000000001',
    categories: ['harassment'],
    action: ACTION_DELETED,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  recordViolation({
    guildId: TEST_GUILD,
    userId: APPELLANT,
    messageId: 'b50000000000000002',
    categories: ['harassment'],
    action: ACTION_DELETED,
    createdAt: new Date().toISOString(),
  });

  const epoch = '1970-01-01T00:00:00.000Z';
  assert.equal(strikeCount(TEST_GUILD, APPELLANT, epoch), 2);

  stubGateway();
  await clickDecision(`appeal-grant:${APPELLANT}:${since}`);

  // The appealed one no longer counts towards escalation…
  assert.equal(strikeCount(TEST_GUILD, APPELLANT, epoch), 1, 'only the appealed incident');

  // …but it is still in the record, marked as what it was.
  const history = historyFor(TEST_GUILD, APPELLANT, 20);
  const appealed = history.find((row) => row.messageId === 'b50000000000000002');
  assert.equal(appealed.action, ACTION_OVERTURNED, 'kept, not deleted');
  assert.ok(content.commands.history.actions[ACTION_OVERTURNED], 'and it has a label');

  const older = history.find((row) => row.messageId === 'b50000000000000001');
  assert.equal(older.action, ACTION_DELETED, 'an earlier, correct strike is untouched');
});

test('the record breakdown always adds up to its own total', async () => {
  const member = 'b60000000000000001';
  for (const action of [ACTION_DELETED, ACTION_SELF_DELETED, ACTION_EDITED, ACTION_OVERTURNED]) {
    recordViolation({
      guildId: TEST_GUILD,
      userId: member,
      messageId: `b7000000000000000${action.length}`,
      categories: ['harassment'],
      action,
    });
  }

  const totals = violationTotals(TEST_GUILD, member);
  const summed = Object.values(totals.byAction).reduce((sum, count) => sum + count, 0);

  // The regression: `edited` and `overturned` counted towards the total but
  // belonged to no bucket, so /mod history printed "Gesamt: 2 — 0 gelöscht,
  // 1 selbst entfernt".
  assert.equal(summed, totals.total, JSON.stringify(totals));
  assert.equal(totals.total, 4);

  // And every outcome the record can hold has a label to render it with.
  for (const action of Object.keys(totals.byAction)) {
    assert.ok(content.commands.history.actions[action], `no label for ${action}`);
  }
});

test('/mod history renders a breakdown matching the total', async () => {
  const member = 'b60000000000000002';
  recordViolation({
    guildId: TEST_GUILD,
    userId: member,
    messageId: 'b70000000000000009',
    categories: ['harassment'],
    action: ACTION_OVERTURNED,
  });

  const sent = [];
  await routeInteraction(
    interaction({
      type: InteractionType.APPLICATION_COMMAND,
      member: { user: { id: TEST_USER, username: 'staff' }, permissions: STAFF_PERMISSIONS },
      data: {
        name: 'mod',
        options: [{ name: 'history', type: 1, options: [{ name: 'user', value: member }] }],
      },
    }),
    (body) => sent.push(body),
  );

  const body = sent[0].data.content;
  assert.match(body, /\*\*Gesamt:\*\* 1 — 1 /);
  assert.ok(body.includes(content.commands.history.actions[ACTION_OVERTURNED]));
});

test('denying an appeal leaves the record alone', async () => {
  recordViolation({
    guildId: TEST_GUILD,
    userId: APPELLANT,
    messageId: 'b50000000000000003',
    categories: ['harassment'],
    action: ACTION_DELETED,
  });
  const epoch = '1970-01-01T00:00:00.000Z';
  const before = strikeCount(TEST_GUILD, APPELLANT, epoch);

  stubGateway();
  await clickDecision(`appeal-deny:${APPELLANT}:${Math.floor(Date.now() / 1000) - 60}`);

  assert.equal(strikeCount(TEST_GUILD, APPELLANT, epoch), before);
});

test('granting an appeal tells the member and the whole team', async () => {
  const { dms } = stubGateway();
  const { sent, edits } = await clickDecision(`appeal-grant:${APPELLANT}:0`);

  assert.equal(sent[0].type, InteractionResponseType.DEFERRED_UPDATE_MESSAGE);

  // The member hears back — the gap was that an appeal vanished into the log.
  assert.equal(dms.length, 1);
  assert.equal(dms[0].userId, APPELLANT);
  assert.equal(dms[0].content, content.moderation.appeal.grantedDm);

  // And the decision is written into the entry itself, not an ephemeral reply,
  // so the next moderator does not re-decide it.
  const edited = edits.at(-1).body;
  assert.deepEqual(edited.components, [], 'buttons gone once handled');
  assert.equal(edited.embeds[0].title, content.moderation.log.titles.appealGranted);
  const resolution = edited.embeds[0].fields.at(-1);
  assert.equal(resolution.name, content.moderation.log.fields.resolution);
  assert.match(resolution.value, new RegExp(`Stattgegeben von <@${TEST_USER}>`));
  assert.equal(edited.embeds[0].fields[0].value, 'b', 'the appeal text survives');
});

test('denying is recorded the same way, with the other wording', async () => {
  const { dms } = stubGateway();
  const { edits } = await clickDecision(`appeal-deny:${APPELLANT}:0`);

  assert.equal(dms[0].content, content.moderation.appeal.deniedDm);
  assert.equal(edits.at(-1).body.embeds[0].title, content.moderation.log.titles.appealDenied);
});

test('a closed DM still records the decision, and says it did not arrive', async () => {
  stubGateway({ dmFails: true });
  const { edits } = await clickDecision(`appeal-grant:${APPELLANT}:0`);

  const resolution = edits.at(-1).body.embeds[0].fields.at(-1);
  assert.match(resolution.value, /Stattgegeben/);
  assert.ok(resolution.value.includes(content.moderation.appeal.decisionNotSent));
});

test('a member cannot decide their own appeal', async () => {
  const { dms } = stubGateway();
  const { sent } = await clickDecision(`appeal-grant:${APPELLANT}:0`, '0');

  assert.equal(dms.length, 0, 'no DM went out');
  // Not deferred for a non-moderator, so the refusal stays ephemeral and cannot
  // overwrite the log entry.
  assert.equal(sent[0].type, InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(sent[0].data.content, content.commands.forbidden);
});

// ------------------------------------------------------------------- gap 17

test('a settings change is announced in the guild log', async () => {
  const { posted } = stubGateway();

  await routeInteraction(
    interaction({
      type: InteractionType.APPLICATION_COMMAND,
      member: { user: { id: TEST_USER, username: 'staff' }, permissions: STAFF_PERMISSIONS },
      data: {
        name: 'mod',
        options: [{
          name: 'config',
          type: 2,
          options: [{ name: 'set', type: 1, options: [{ name: 'grace', value: 42 }] }],
        }],
      },
    }),
    () => {},
  );
  await settle();

  const entry = posted.at(-1);
  assert.equal(entry.channelId, LOG_CHANNEL);
  assert.equal(entry.embeds[0].title, content.moderation.log.titles.config);

  const changes = entry.embeds[0].fields.find(
    (field) => field.name === content.moderation.log.fields.changes,
  );
  assert.match(changes.value, /grace/);
  assert.match(changes.value, /42/);
  assert.ok(
    entry.embeds[0].fields.some((field) => field.value.includes(TEST_USER)),
    'names who changed it',
  );
});

test('switching Mai off is announced too — that is when it matters most', async () => {
  const { posted } = stubGateway();

  await routeInteraction(
    interaction({
      type: InteractionType.APPLICATION_COMMAND,
      member: { user: { id: TEST_USER, username: 'staff' }, permissions: STAFF_PERMISSIONS },
      data: { name: 'mod', options: [{ name: 'off', type: 1 }] },
    }),
    () => {},
  );
  await settle();

  assert.equal(posted.at(-1).embeds[0].title, content.moderation.log.titles.config);
  // Put it back, the other tests share this guild.
  updateSettings(TEST_GUILD, { enabled: true });
});

// ------------------------------------------------------------------- gap 20

test('metrics render real numbers in Prometheus format', () => {
  enqueue({
    messageId: 'b30000000000000001',
    guildId: TEST_GUILD,
    channelId: 'b40000000000000001',
    userId: APPELLANT,
    categories: ['harassment'],
    warnedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + 600_000).toISOString(),
    scoldMessageId: null,
  });

  const text = renderMetrics({ lastTickAt: new Date(Date.now() - 5000).toISOString(), running: false });

  assert.match(text, /^# HELP mai_up /m);
  assert.match(text, /^# TYPE mai_queue_depth gauge$/m);
  assert.match(text, /^mai_queue_depth [1-9]/m);
  assert.match(text, /^mai_enforcer_last_tick_age_seconds [45](\.\d)?$/m);
  assert.match(text, /^mai_token_budget 1000000$/m);
  assert.equal(text.endsWith('\n'), true);

  // No per-guild or per-user labels: a metrics series must not become an
  // activity record, and those are unbounded besides.
  assert.equal(/guild(_id)?="/.test(text), false);
  assert.equal(text.includes(TEST_GUILD), false);
  assert.equal(text.includes(APPELLANT), false);
});

test('metrics are off without a token, and gated by it when set', async () => {
  const { createServer } = await import('../src/http/server.js');

  const get = (app, headers = {}) =>
    new Promise((resolve) => {
      const chunks = [];
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
          chunks.push(body);
          resolve({ status: res.statusCode, body: chunks.join('') });
        },
        end() {
          resolve({ status: res.statusCode, body: chunks.join('') });
        },
      };
      app(req, res);
    });

  assert.equal(config.http.metricsToken, '', 'the test env sets no token');
  // Off means 404, not 401: an unconfigured endpoint should not advertise that
  // it exists on a URL anyone on the internet can reach through the tunnel.
  assert.equal((await get(createServer())).status, 404);
});
