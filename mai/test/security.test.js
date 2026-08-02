/**
 * The authorization and containment boundaries, as opposed to the moderation
 * pipeline itself:
 *
 *   - `/mai ask` republishes a member's text under Mai's name, so the question
 *     is classified first, and fails closed, unlike the message pipeline.
 *   - what Mai says herself is deliberately *not* classified: the persona is
 *     built to insult repeat offenders, and a filter would eat exactly that.
 *   - a pardon and the operational counters stop at the guild border.
 *   - the public interactions endpoint is capped before the signature check.
 */
import './setup-security.js';
import { interaction, openTestDatabase, stubFetch, OTHER_GUILD, TEST_GUILD, TEST_USER } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionType } from 'discord-interactions';
import { config, isOperator } from '../src/config.js';
import { content } from '../src/content.js';
import { appendTurns, stats as historyStats } from '../src/db/history.js';
import { depth, enqueue, forgiveUser } from '../src/db/queue.js';
import { resetSettings, updateSettings } from '../src/db/settings.js';
import { recordUsage, totalsFor, dayKey } from '../src/db/usage.js';
import { setGatewayClient } from '../src/gateway/client.js';
import { routeInteraction } from '../src/interactions/router.js';
import { screenInput } from '../src/moderation/screen.js';
import { mayModerate } from '../src/permissions.js';

await openTestDatabase();

const STAFF_PERMISSIONS = String(1n << 13n); // Manage Messages
const OPERATOR = '900000000000000001';
const MEMBER = '910000000000000001';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const verdictResponse = (flagged, categories = []) =>
  jsonResponse({
    results: [{ flagged, categories: Object.fromEntries(categories.map((c) => [c, true])) }],
  });

// ---------------------------------------------------------------- fix 2 + 5

test('a flagged question is never repeated, and costs no completion', async () => {
  const calls = [];
  const restore = stubFetch((url) => {
    calls.push(url);
    if (url.includes('/moderations')) return verdictResponse(true, ['harassment']);
    return jsonResponse({ choices: [{ message: { content: 'sollte nie passieren' } }] });
  });

  const sent = [];
  const edits = [];
  try {
    await routeInteraction(
      interaction({
        type: InteractionType.APPLICATION_COMMAND,
        member: { user: { id: MEMBER, username: 'tester' }, permissions: '0' },
        data: { name: 'mai', options: [{ name: 'ask', options: [{ name: 'frage', value: 'du wicht' }] }] },
      }),
      (body) => sent.push(body),
    );
  } finally {
    restore();
  }

  for (const url of calls) {
    if (url.includes('/messages/@original')) edits.push(url);
  }
  assert.equal(calls.some((url) => url.includes('/chat/completions')), false, 'no tokens spent');
  assert.equal(edits.length, 1, 'the deferred placeholder was still filled in');
});

test('staff is decided in one place, from the payload Discord signed', () => {
  const MANAGE_MESSAGES = 1n << 13n;
  const at = (bits) => ({ member: { permissions: String(bits) } });

  assert.equal(mayModerate(at(MANAGE_MESSAGES)), true);
  assert.equal(mayModerate(at(MANAGE_MESSAGES | (1n << 3n))), true, 'a superset still counts');

  assert.equal(mayModerate(at(0n)), false);
  assert.equal(mayModerate(at(1n << 3n)), false, 'a different permission is not this one');
  // No member object at all: a DM, where there is nothing to moderate anyway.
  assert.equal(mayModerate({ user: { id: MEMBER } }), false);
  assert.equal(mayModerate({}), false);
  assert.equal(mayModerate(undefined), false);
  // A value BigInt refuses throws rather than returning, and a throw here would
  // be an unhandled rejection on a public endpoint, not a refusal.
  assert.equal(mayModerate({ member: { permissions: 'alle' } }), false);
  assert.equal(mayModerate({ member: { permissions: null } }), false);
});

test('the guild decides where its line is here too, but only downwards', async () => {
  // `applyPolicy` exists because omni-moderation scores the same insult 0.88 in
  // English and 0.20 in German, so a German server lowering its threshold to 0.2
  // has told Mai where its line is. This was the one path ignoring it, on the
  // command that publishes a member's words under her name with no deletion
  // available afterwards.
  const scored = (flagged, scores) =>
    jsonResponse({ results: [{ flagged, categories: {}, category_scores: scores }] });

  const restore = stubFetch(() => scored(false, { harassment: 0.3, violence: 0.01 }));
  try {
    updateSettings(TEST_GUILD, { threshold: 0.2 });
    const refused = await screenInput('eine Beleidigung', { guildId: TEST_GUILD });
    assert.equal(refused.ok, false, 'over the guild line, though the provider passed it');
    assert.deepEqual(refused.categories, ['harassment'], 'the top score names itself');

    // Above the guild's line is a refusal; below it is not, so the threshold
    // really is what decided rather than the call always refusing.
    updateSettings(TEST_GUILD, { threshold: 0.9 });
    assert.equal((await screenInput('eine Beleidigung', { guildId: TEST_GUILD })).ok, true);
  } finally {
    resetSettings(TEST_GUILD, 'threshold');
    restore();
  }

  // And the provider's own verdict still refuses on top of that, rather than
  // being replaced by the guild's line the way it is for ordinary messages: a
  // server that raised its threshold must not loosen the one guard that fails
  // closed. Stricter of the two, never the guild's alone.
  const restoreFlagged = stubFetch(() => scored(true, { harassment: 0.05 }));
  try {
    updateSettings(TEST_GUILD, { threshold: 0.9 });
    const refused = await screenInput('etwas anderes', { guildId: TEST_GUILD });
    assert.equal(refused.ok, false, 'the provider flagged it, so the answer is still no');
  } finally {
    resetSettings(TEST_GUILD, 'threshold');
    restoreFlagged();
  }
});

test('screenInput fails closed when the classifier is unreachable', async () => {
  const restore = stubFetch(() => new Response('boom', { status: 500 }));
  try {
    const screened = await screenInput('irgendwas', { guildId: TEST_GUILD });
    // Deliberately the opposite of the message pipeline: Mai would be
    // republishing this text herself, and there is no deletion to fall back on.
    assert.equal(screened.ok, false);
  } finally {
    restore();
  }
});

test('Mai is never classified on the way out', async () => {
  // Her persona escalates into outright insults at the top of the ladder
  // ("Beleidigungen erwünscht"), which a classifier scores as harassment
  // 0.89-0.98: screening her output would replace the angry cat with a canned
  // line exactly when she is supposed to be angry. The guard against a
  // prompt-injected model is the prompt, not a filter on the way out.
  const { generateReply } = await import('../src/ai/chat.js');

  const calls = [];
  const restore = stubFetch((url) => {
    calls.push(url);
    if (url.includes('/chat/completions')) {
      return jsonResponse({
        choices: [{ message: { content: '*faucht* Verschwinde, du Idiot.' } }],
      });
    }
    return verdictResponse(true, ['harassment']);
  });

  let reply;
  try {
    reply = await generateReply([{ role: 'system', content: 'x' }], {
      userId: MEMBER,
      guildId: TEST_GUILD,
    });
  } finally {
    restore();
  }

  assert.equal(reply.text, '*faucht* Verschwinde, du Idiot.', 'posted verbatim');
  assert.equal(
    calls.some((url) => url.includes('/moderations')),
    false,
    'no outbound classification call at all',
  );
});

// -------------------------------------------------------------------- fix 3

test('a pardon stops at the guild border', () => {
  const row = (guildId, messageId) => ({
    messageId,
    guildId,
    channelId: '920000000000000001',
    userId: MEMBER,
    categories: ['harassment'],
    warnedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + 600_000).toISOString(),
    scoldMessageId: null,
  });

  enqueue(row(TEST_GUILD, '930000000000000001'));
  enqueue(row(OTHER_GUILD, '930000000000000002'));

  const forgiven = forgiveUser(TEST_GUILD, MEMBER);

  assert.equal(forgiven.length, 1, 'only this guild’s rows');
  assert.equal(depth(TEST_GUILD), 0);
  assert.equal(depth(OTHER_GUILD), 1, 'the other server’s enforcement is untouched');
});

// -------------------------------------------------------------------- fix 4

test('counters are scoped to the calling guild', () => {
  appendTurns([
    { channelId: 'c-here', guildId: TEST_GUILD, userId: MEMBER, username: 'a', role: 'user', content: 'hi' },
  ]);
  appendTurns([
    { channelId: 'c-there', guildId: OTHER_GUILD, userId: MEMBER, username: 'b', role: 'user', content: 'hi' },
  ]);
  recordUsage({ guildId: TEST_GUILD, model: 'm', purpose: 'chat', usage: { total_tokens: 10 } });
  recordUsage({ guildId: OTHER_GUILD, model: 'm', purpose: 'chat', usage: { total_tokens: 90 } });

  assert.equal(historyStats(TEST_GUILD).rows, 1);
  assert.equal(totalsFor(dayKey(), TEST_GUILD).totalTokens, 10);
  // Unscoped is the operator view and still sees everything.
  assert.ok(historyStats().rows >= 2);
  assert.equal(totalsFor(dayKey()).totalTokens, 100);
});

test('only a configured operator gets the cross-guild view', () => {
  assert.equal(isOperator(OPERATOR), true);
  assert.equal(isOperator(TEST_USER), false);
  assert.equal(isOperator(undefined), false);
});

test('/mod spend hides the budget figures from guild staff', async () => {
  setGatewayClient(null);
  const spend = async (userId) => {
    const sent = [];
    await routeInteraction(
      interaction({
        type: InteractionType.APPLICATION_COMMAND,
        member: { user: { id: userId, username: 'staff' }, permissions: STAFF_PERMISSIONS },
        data: { name: 'mod', options: [{ name: 'spend', type: 1 }] },
      }),
      (body) => sent.push(body),
    );
    return sent[0].data.content;
  };

  const staffView = await spend(TEST_USER);
  const operatorView = await spend(OPERATOR);

  assert.equal(
    staffView.includes(String(config.openai.monthlyTokenBudget)),
    false,
    'the budget figure belongs to whoever pays the bill',
  );
  assert.ok(staffView.includes(content.commands.spend.budgetHidden));
  assert.equal(staffView.includes(content.commands.status.allGuilds), false);

  assert.ok(operatorView.includes(content.commands.status.allGuilds), 'marked as spanning all guilds');
});

// -------------------------------------------------------------------- fix 8

test('the DM membership gate asks Discord once per member, then remembers', async () => {
  const { clearDmGateCache, isDmAuthorInAllowedGuild } = await import(
    '../src/gateway/events/mai-chat.js'
  );
  clearDmGateCache();

  const fetched = [];
  const dm = (userId, isMember) => ({
    author: { id: userId },
    client: {
      guilds: {
        cache: {
          get: () => ({
            members: {
              fetch: async (id) => {
                fetched.push(id);
                if (!isMember) throw new Error('Unknown Member');
                return { id };
              },
            },
          }),
        },
      },
    },
  });

  const member = dm('940000000000000001', true);
  assert.equal(await isDmAuthorInAllowedGuild(member), true);
  assert.equal(await isDmAuthorInAllowedGuild(member), true);
  assert.equal(fetched.length, 1, 'the second DM costs no Discord round trip');

  // A refusal is cached too, otherwise a stranger's spam is a free REST call
  // per message, made before any chat rate limit applies.
  const stranger = dm('940000000000000002', false);
  assert.equal(await isDmAuthorInAllowedGuild(stranger), false);
  const after = fetched.length;
  for (let i = 0; i < 5; i++) await isDmAuthorInAllowedGuild(stranger);
  assert.equal(fetched.length, after, 'five more DMs, no further lookups');
});

// -------------------------------------------------------------------- fix 7

test('the interactions endpoint refuses oversized and unmeasured bodies', async () => {
  const { createServer } = await import('../src/http/server.js');
  const app = createServer();

  const post = (headers) =>
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
        end: () => resolve(res.statusCode),
      };
      app(req, res);
    });

  assert.equal(await post({ 'content-length': String(config.http.maxBodyBytes + 1) }), 413);
  assert.equal(await post({}), 413, 'a body with no declared length is refused, not streamed');
});
