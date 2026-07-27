/**
 * The OpenAI client: retries, and the accounting that hangs off it.
 *
 * Retrying is safe here for a specific reason: an API call has no side effects
 * of its own, and every Discord action happens in our own code after it
 * returned. So a 429, a 5xx, a network error and a timeout are all retried,
 * while a 4xx that says "your request is wrong" is not: repeating it only burns
 * the rate limit.
 *
 * Token accounting is recorded here rather than at the call sites, and it is
 * wrapped: a failing counter must never fail a call that already succeeded.
 */
import './setup-openai.js';
import { openTestDatabase, stubFetch, TEST_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { createChatCompletion, createModeration, OpenAiError } from '../src/ai/openai.js';
import { closeDatabase, getDb, openDatabase } from '../src/db/index.js';
import { dayKey, totalsFor } from '../src/db/usage.js';

await openTestDatabase();

const wipeUsage = () => getDb().exec('DELETE FROM usage_daily');

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const chatBody = (text = 'miau') => ({
  choices: [{ message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

const moderationBody = (overrides = {}) => ({
  results: [{ flagged: false, categories: {}, category_scores: {}, ...overrides }],
});

/**
 * Runs `fn` with the backoff sleeps fired immediately, and reports what the
 * client asked to wait. Real backoff is half a second and up, which is the
 * right behaviour and the wrong test duration.
 *
 * @param {() => Promise<unknown>} fn
 */
async function withInstantBackoff(fn) {
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];

  globalThis.setTimeout = (callback, ms) => {
    delays.push(ms);
    return realSetTimeout(callback, 0);
  };
  try {
    return { result: await fn(), delays };
  } catch (error) {
    return { error, delays };
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test('a successful call returns the assistant message verbatim', async () => {
  wipeUsage();
  const calls = [];
  const restore = stubFetch((url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return json(chatBody());
  });

  let answer;
  try {
    answer = await createChatCompletion({ messages: [{ role: 'user', content: 'hi' }], guildId: TEST_GUILD });
  } finally {
    restore();
  }

  assert.deepEqual(answer.message, { role: 'assistant', content: 'miau' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${config.openai.baseUrl}/chat/completions`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'test-chat-model');
  assert.ok(!('tools' in calls[0].body), 'no tools key when the caller passed none');
});

test('an assistant message with tool calls comes back untouched', async () => {
  const message = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }],
  };
  const restore = stubFetch(() => json({ choices: [{ message }] }));

  try {
    const answer = await createChatCompletion({ messages: [], tools: [{ type: 'function' }] });
    assert.deepEqual(answer.message, message, 'the provider rejects a follow-up that rewrote it');
  } finally {
    restore();
  }
});

test('tools are sent only when there are any', async () => {
  const bodies = [];
  const restore = stubFetch((url, options) => {
    bodies.push(JSON.parse(options.body));
    return json(chatBody());
  });

  try {
    await createChatCompletion({ messages: [], tools: [] });
    await createChatCompletion({ messages: [], tools: [{ type: 'function', function: { name: 'x' } }] });
  } finally {
    restore();
  }

  assert.ok(!('tools' in bodies[0]));
  assert.equal(bodies[1].tools.length, 1);
});

test('a response without choices is an empty message, not a crash', async () => {
  const restore = stubFetch(() => json({}));

  try {
    const answer = await createChatCompletion({ messages: [] });
    assert.deepEqual(answer.message, {});
  } finally {
    restore();
  }
});

test('a 429 is retried, and the provider Retry-After is honored', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts += 1;
    if (attempts === 1) return json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } });
    return json(chatBody('endlich'));
  });

  const { result, delays, error } = await withInstantBackoff(() =>
    createChatCompletion({ messages: [] }),
  );
  restore();

  assert.equal(error, undefined);
  assert.equal(attempts, 2);
  assert.equal(result.message.content, 'endlich');
  assert.deepEqual(delays, [2000], 'the header wins over the exponential default');
});

test('an absurd Retry-After is capped instead of parking the call for an hour', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts += 1;
    if (attempts === 1) return json({}, { status: 503, headers: { 'retry-after': '3600' } });
    return json(chatBody());
  });

  const { delays } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
  restore();

  assert.deepEqual(delays, [30_000]);
});

test('a 5xx is retried up to the configured limit and then gives up', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts += 1;
    return json({}, { status: 500 });
  });

  const { error, delays } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
  restore();

  assert.equal(attempts, config.openai.maxRetries + 1);
  assert.ok(error instanceof OpenAiError);
  assert.equal(error.status, 500);
  assert.equal(error.code, 'http_error');
  assert.equal(delays.length, config.openai.maxRetries, 'no sleep after the last attempt');
  // Exponential, with jitter on top.
  assert.ok(delays[0] >= 500 && delays[0] < 750, String(delays[0]));
  assert.ok(delays[1] >= 1000 && delays[1] < 1250, String(delays[1]));
});

test('a 400 is not retried: repeating a wrong request only burns the rate limit', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let attempts = 0;
    const restore = stubFetch(() => {
      attempts += 1;
      return json({ error: 'nope' }, { status });
    });

    const { error } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
    restore();

    assert.equal(attempts, 1, `status ${status}`);
    assert.equal(error.status, status);
  }
});

test('a 408 and a 409 are retried, unlike their neighbours', async () => {
  for (const status of [408, 409]) {
    let attempts = 0;
    const restore = stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? json({}, { status }) : json(chatBody());
    });

    const { result } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
    restore();

    assert.equal(attempts, 2, `status ${status}`);
    assert.equal(result.message.content, 'miau');
  }
});

test('a network error is retried, and reported as unreachable when it keeps failing', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts += 1;
    throw new TypeError('fetch failed');
  });

  const { error, delays } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
  restore();

  assert.equal(attempts, config.openai.maxRetries + 1);
  assert.equal(error.code, 'network_error');
  assert.equal(error.status, undefined);
  assert.ok(error.cause instanceof TypeError);
  assert.deepEqual(delays, [500, 1000], 'no jitter on this path, unlike the HTTP one');
});

test('a timeout is retried too, and named as one', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts += 1;
    if (attempts <= 2) throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    return json(chatBody('spaet, aber da'));
  });

  const { result } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
  restore();

  assert.equal(attempts, 3);
  assert.equal(result.message.content, 'spaet, aber da');
});

test('a call that only ever times out reports code=timeout, never the message', async () => {
  const restore = stubFetch(() => {
    throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  });

  const { error } = await withInstantBackoff(() => createChatCompletion({ messages: [] }));
  restore();

  assert.equal(error.code, 'timeout');
  assert.equal(error.name, 'OpenAiError');
});

test('moderation returns the booleans and the raw scores side by side', async () => {
  const bodies = [];
  const restore = stubFetch((url, options) => {
    bodies.push({ url, body: JSON.parse(options.body) });
    return json(moderationBody({ flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.91 } }));
  });

  let verdict;
  try {
    verdict = await createModeration('du wicht', { guildId: TEST_GUILD });
  } finally {
    restore();
  }

  assert.deepEqual(verdict, { flagged: true, categories: { harassment: true }, scores: { harassment: 0.91 } });
  assert.equal(bodies[0].url, `${config.openai.baseUrl}/moderations`);
  assert.equal(bodies[0].body.model, 'test-moderation-model');
});

test('a moderation response with no result is an error, not a silent pass', async () => {
  const restore = stubFetch(() => json({ results: [] }));

  try {
    await assert.rejects(() => createModeration('irgendwas'), (error) => {
      assert.ok(error instanceof OpenAiError);
      assert.equal(error.code, 'bad_response');
      return true;
    });
  } finally {
    restore();
  }
});

test('a result without categories or scores still answers in the expected shape', async () => {
  const restore = stubFetch(() => json({ results: [{ flagged: 1 }] }));

  try {
    const verdict = await createModeration('x');
    assert.deepEqual(verdict, { flagged: true, categories: {}, scores: {} });
  } finally {
    restore();
  }
});

test('tokens are counted where the response is parsed, per guild and purpose', async () => {
  wipeUsage();
  const restore = stubFetch((url) =>
    url.endsWith('/moderations') ? json(moderationBody()) : json(chatBody()),
  );

  try {
    await createChatCompletion({ messages: [], guildId: TEST_GUILD });
    await createChatCompletion({ messages: [], guildId: TEST_GUILD });
    await createModeration('x', { guildId: TEST_GUILD });
  } finally {
    restore();
  }

  const totals = totalsFor(dayKey(), TEST_GUILD);

  assert.equal(totals.calls, 3, 'the moderation call reports no tokens but is still a call');
  assert.equal(totals.totalTokens, 28);
  assert.equal(totals.promptTokens, 20);
  assert.equal(totals.completionTokens, 8);
});

test('usage is scoped to the guild that caused it, and a DM has none', async () => {
  wipeUsage();
  const restore = stubFetch(() => json(chatBody()));

  try {
    await createChatCompletion({ messages: [], guildId: TEST_GUILD });
    await createChatCompletion({ messages: [] });
  } finally {
    restore();
  }

  assert.equal(totalsFor(dayKey(), TEST_GUILD).calls, 1);
  assert.equal(totalsFor(dayKey()).calls, 2, 'the process-wide view sees both');
});

test('a broken counter cannot fail a call that already succeeded', async () => {
  const restore = stubFetch(() => json(chatBody('trotzdem')));

  closeDatabase();
  try {
    const answer = await createChatCompletion({ messages: [], guildId: TEST_GUILD });
    assert.equal(answer.message.content, 'trotzdem');
  } finally {
    restore();
    openDatabase();
  }
});
