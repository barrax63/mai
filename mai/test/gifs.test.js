/**
 * GIFs: the search behind them, the two switches in front of it, and what ends
 * up in the channel and in her memory.
 */
import './setup-gifs.js';
import { openTestDatabase, stubFetch, TEST_GUILD, OTHER_GUILD } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessages, generateReply } from '../src/ai/chat.js';
import { config } from '../src/config.js';
import { clearGifCache, normalizeQuery } from '../src/chat/gif-search.js';
import { gifEmbeds, rememberExchange } from '../src/chat/reply.js';
import { runTool, toolsFor } from '../src/chat/tools.js';
import { content } from '../src/content.js';
import { recentTurns } from '../src/db/history.js';
import { effectiveSettings, updateSettings } from '../src/db/settings.js';

await openTestDatabase();

const NO_VIOLATIONS = { count: 0, categories: [] };
const GIF = 'https://media2.giphy.com/media/cat-in-a-box/giphy.gif';

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const completion = (message) => jsonResponse({ choices: [{ message }] });

/**
 * One GIPHY result. What is read is a *rendition* under `images`, never the
 * view page under `url`: a page link would go into the message as a link.
 */
const giphyResult = (url, rendition = 'downsized_medium') => ({
  id: '1',
  url: 'https://giphy.com/gifs/some-page-1',
  images: { [rendition]: { url } },
});

const searchCall = (query) => ({
  id: 'call-search',
  type: 'function',
  function: { name: 'search_gif', arguments: JSON.stringify({ query }) },
});

const names = (tools) => tools.map((tool) => tool.function.name);
const hasSearch = (tools) => names(tools).includes('search_gif');

updateSettings(TEST_GUILD, { gifs: true }, 'admin-gifs');
// OTHER_GUILD is left alone: never configured, which is the other state.

test('the tool is offered per guild, not per process', () => {
  const offered = toolsFor(TEST_GUILD);
  assert.equal(hasSearch(offered), true);

  assert.equal(hasSearch(toolsFor(OTHER_GUILD)), false);
  // A DM has no server to ask, so it falls to the base, which is off.
  assert.equal(hasSearch(toolsFor(null)), false);

  // Everything else is the same list either way.
  assert.deepEqual(
    names(toolsFor(OTHER_GUILD)).sort(),
    names(offered).filter((name) => name !== 'search_gif').sort(),
  );
});

test('the search tool takes a query and nothing else', () => {
  const tool = toolsFor(TEST_GUILD).find((entry) => entry.function.name === 'search_gif');

  assert.deepEqual(Object.keys(tool.function.parameters.properties), ['query']);
  assert.deepEqual(tool.function.parameters.required, ['query']);
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.equal(tool.function.description, content.chat.gifSearchInstruction);

  // Every other tool still refuses arguments outright.
  for (const other of toolsFor(TEST_GUILD)) {
    if (other.function.name === 'search_gif') continue;
    assert.deepEqual(other.function.parameters.properties, {}, other.function.name);
  }
});

test('the setting is folded against the operator key', () => {
  assert.equal(effectiveSettings(TEST_GUILD).gifsEnabled, true);
  assert.equal(effectiveSettings(TEST_GUILD).inherited.gifs, false);
  assert.equal(effectiveSettings(OTHER_GUILD).gifsEnabled, false);
  assert.equal(effectiveSettings(OTHER_GUILD).inherited.gifs, true, 'never set here');
});

test('a guild that did not switch GIFs on is refused inside the handler too', async () => {
  // Which tools were offered is not an authorization: the name of a tool call
  // comes from the client like any other, so the gate is checked again here.
  const called = [];
  const restore = stubFetch((url) => {
    called.push(url);
    return jsonResponse({ data: [] });
  });

  const context = { userId: 'u', guildId: OTHER_GUILD, client: null };
  try {
    assert.deepEqual(await runTool(searchCall('cat in a box'), context), { error: 'gifs_disabled' });
  } finally {
    restore();
  }

  assert.deepEqual(called, [], 'refused before anything left the process');
  assert.equal(context.pendingGif, undefined);
});

test('a search result is resolved here and handed over by the context', async () => {
  clearGifCache();
  const requests = [];
  const restore = stubFetch((url) => {
    requests.push(url);
    return jsonResponse({
      data: [
        giphyResult(GIF),
        giphyResult('https://media3.giphy.com/media/cat-in-a-box-2/giphy.gif'),
      ],
    });
  });

  const context = { userId: 'u', guildId: TEST_GUILD, client: null };
  let result;
  try {
    result = await runTool(searchCall('cat in a box'), context);
  } finally {
    restore();
  }

  assert.deepEqual(result, { found: true });
  assert.match(context.pendingGif, /^https:\/\/media[23]\.giphy\.com\/media\/cat-in-a-box(-2)?\/giphy\.gif$/);
  // The query goes out; the answer never reaches the model as an address.
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes('q=cat+in+a+box'));
  // Whatever GIF_SEARCH_RATING is set to: the point is that the provider is
  // asked to filter its own side, not which line the operator picked.
  assert.ok(
    requests[0].includes(`rating=${config.chat.gifSearch.rating}`),
    'the provider filters its own side',
  );
  assert.equal(JSON.stringify(result).includes('giphy'), false);
});

test('a result on any other host is not a result', async () => {
  clearGifCache();
  const restore = stubFetch(() =>
    jsonResponse({
      data: [
        giphyResult('https://evil.example/tracker.gif'),
        giphyResult('http://media1.giphy.com/media/insecure-3/giphy.gif'),
        // The view page is on giphy.com, which is not a media host: a link
        // there would be posted as text, which is the thing being avoided.
        { url: 'https://giphy.com/gifs/page-only-4', images: {} },
        { images: { original: { url: 42 } } },
      ],
    }),
  );

  const context = { userId: 'u', guildId: TEST_GUILD, client: null };
  let result;
  try {
    result = await runTool(searchCall('something'), context);
  } finally {
    restore();
  }

  // Nothing survivable came back, which is a normal answer and not an error.
  assert.deepEqual(result, { found: false });
  assert.equal(context.pendingGif, undefined);
});

test('a query has to look like a query before it costs a request', async () => {
  clearGifCache();
  const called = [];
  const restore = stubFetch((url) => {
    called.push(url);
    return jsonResponse({ data: [] });
  });

  const context = { userId: 'u', guildId: TEST_GUILD, client: null };
  try {
    for (const bad of ['', '   ', 'x'.repeat(51), 'katze https://evil.example', '<img src=x>']) {
      assert.deepEqual(await runTool(searchCall(bad), context), { found: false }, bad);
    }
    // Not a string at all: the arguments are model output, not a contract.
    assert.deepEqual(await runTool(searchCall(['katze']), context), { found: false });
  } finally {
    restore();
  }

  assert.deepEqual(called, [], 'nothing left the process');
  assert.equal(context.pendingGif, undefined);
});

test('normalizeQuery keeps the shape the provider is given', () => {
  assert.equal(normalizeQuery('  cat   in a  box '), 'cat in a box');
  // Whitespace is a formatting accident, so it is collapsed rather than refused.
  assert.equal(normalizeQuery('zeile\neins'), 'zeile eins');
  assert.equal(normalizeQuery('katze https://evil.example'), null);
  assert.equal(normalizeQuery('<script>'), null);
  // 50 is the provider's own maximum for the query parameter.
  assert.equal(normalizeQuery('x'.repeat(50)).length, 50);
  assert.equal(normalizeQuery('x'.repeat(51)), null);
  assert.equal(normalizeQuery(undefined), null);
  // String-ish is not a string: the arguments object is model output.
  assert.equal(normalizeQuery(['katze']), null);
  assert.equal(normalizeQuery({ toString: () => 'katze' }), null);
});

test('the same query twice costs one request', async () => {
  clearGifCache();
  let requests = 0;
  const restore = stubFetch(() => {
    requests += 1;
    return jsonResponse({ data: [giphyResult('https://media2.giphy.com/media/repeat-9/giphy.gif')] });
  });

  const context = { userId: 'u', guildId: TEST_GUILD, client: null };
  try {
    await runTool(searchCall('running joke'), context);
    await runTool(searchCall('RUNNING JOKE'), context);
  } finally {
    restore();
  }

  assert.equal(requests, 1, 'cached, case-insensitively');
  assert.equal(context.pendingGif, 'https://media2.giphy.com/media/repeat-9/giphy.gif');
});

test('a failing search costs a GIF, never the reply', async () => {
  clearGifCache();
  const restore = stubFetch(() => {
    throw new Error('network is gone');
  });

  const context = { userId: 'u', guildId: TEST_GUILD, client: null };
  let result;
  try {
    result = await runTool(searchCall('anything at all'), context);
  } finally {
    restore();
  }

  assert.deepEqual(result, { found: false });
  assert.equal(context.pendingGif, undefined);
});

test('the GIF is an embed, so no address lands in the text', () => {
  // A URL in the message body is rendered as a link *and* unfurled underneath
  // it, which put a raw giphy.com address in the middle of her sentence.
  assert.deepEqual(gifEmbeds(GIF), [
    { image: { url: GIF }, footer: { text: content.chat.gifAttribution } },
  ]);
  assert.deepEqual(gifEmbeds(null), []);
  assert.deepEqual(gifEmbeds(undefined), []);
});

test('a placeholder she narrated is not left in the text', async () => {
  const restore = stubFetch(() =>
    completion({ role: 'assistant', content: 'Hier, ein witziges Katzen-GIF! *schnurrt* [GIF]' }));

  let reply;
  try {
    reply = await generateReply(
      buildMessages({ history: [], username: 'noah', content: 'schick mal ein gif', violations: NO_VIOLATIONS }),
      { userId: 'u', guildId: TEST_GUILD, client: null, pendingGif: GIF },
    );
  } finally {
    restore();
  }

  // Calling the tool is how a GIF is sent; a marker in the text is litter.
  assert.equal(reply.text, 'Hier, ein witziges Katzen-GIF! *schnurrt*');
  assert.equal(reply.gifUrl, GIF);
});

test('a reply carries the text and the GIF, and the model never sees the URL', async () => {
  clearGifCache();
  const requests = [];
  const restore = stubFetch((url, options) => {
    if (!url.includes('/chat/completions')) {
      return jsonResponse({ data: [giphyResult(GIF)] });
    }

    requests.push(JSON.parse(options.body));
    return requests.length === 1
      ? completion({ role: 'assistant', content: null, tool_calls: [searchCall('funny cat')] })
      : completion({ role: 'assistant', content: 'Hier, bitte. *schnurrt*' });
  });

  let reply;
  try {
    reply = await generateReply(
      buildMessages({ history: [], username: 'noah', content: 'schick mal ein gif', violations: NO_VIOLATIONS }),
      { userId: 'u', guildId: TEST_GUILD, client: null },
    );
  } finally {
    restore();
  }

  assert.equal(reply.text, 'Hier, bitte. *schnurrt*');
  assert.equal(reply.gifUrl, GIF);
  // The follow-up request carries the tool result, and it is not the address.
  assert.equal(JSON.stringify(requests[1].messages).includes('giphy.com'), false);
});

test('a GIF on its own is an answer: no fallback line under it', async () => {
  const restore = stubFetch(() =>
    // A model that sends the GIF and says nothing at all.
    completion({ role: 'assistant', content: '   ', tool_calls: undefined }));

  let reply;
  try {
    reply = await generateReply(
      buildMessages({ history: [], username: 'noah', content: 'gif bitte', violations: NO_VIOLATIONS }),
      { userId: 'u', guildId: TEST_GUILD, client: null, pendingGif: GIF },
    );
  } finally {
    restore();
  }

  assert.equal(reply.text, '', 'no staring-cat fallback next to a GIF');
  assert.equal(reply.gifUrl, GIF);
});

test('an empty answer with no GIF is still the fallback line', async () => {
  const restore = stubFetch(() => completion({ role: 'assistant', content: '' }));

  let reply;
  try {
    reply = await generateReply(
      buildMessages({ history: [], username: 'noah', content: 'hm', violations: NO_VIOLATIONS }),
      { userId: 'u', guildId: TEST_GUILD, client: null },
    );
  } finally {
    restore();
  }

  assert.equal(reply.text, content.chat.fallbackReply);
  assert.equal(reply.gifUrl, null);
});

test('her memory keeps that she sent one, not which one', () => {
  const channelId = '900000000000000042';
  rememberExchange(
    { channelId, guildId: TEST_GUILD, userId: '333333333333333333', username: 'noah', content: 'gif bitte' },
    { text: '', gifUrl: GIF },
  );

  const turns = recentTurns(channelId, 10);
  assert.deepEqual(
    turns.map((turn) => [turn.role, turn.content]),
    [['user', 'gif bitte'], ['assistant', content.chat.prompt.gifPlaceholder]],
  );
  // A CDN link expires, and it was never hers to remember anyway.
  assert.equal(JSON.stringify(turns).includes('giphy.com'), false);
});
