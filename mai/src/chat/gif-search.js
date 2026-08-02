/**
 * Looking a GIF up instead of picking one off a list.
 *
 * The catalog in `chat.gifs` has one property this cannot have: every URL in it
 * was chosen by a human. A search gives that up in exchange for Mai being able
 * to answer "such mal ein GIF von einer Katze im Karton", so the property is
 * replaced by four narrower ones, and all four matter:
 *
 * 1. **The model emits a query, never an address.** The URL is resolved here and
 *    handed to the reply through the call context, so a prompt-injected model
 *    cannot post a link it made up, only steer what is searched for.
 * 2. **The query is screened** with the same fail-closed classifier that guards
 *    `/mai ask`, because a member can steer it and the result is published in
 *    Mai's name.
 * 3. **Only an allowlisted host is posted.** A search API answering with
 *    something unexpected cannot turn into an arbitrary link in a channel.
 * 4. **It fails to nothing.** A timeout, a quota, a dead provider: no GIF, and
 *    the reply goes out without one. This is never allowed to fail a chat turn.
 *
 * What is returned is the direct media file, not GIPHY's view page. A link in
 * the message body is *shown as a link* and unfurled underneath it, so posting
 * the page put a raw URL in the middle of Mai's sentence; the file goes into an
 * embed instead, where it plays with no text at all. The attribution GIPHY's
 * terms ask for moves into that embed's footer, which is more visible than a
 * link nobody reads anyway.
 *
 * The provider is GIPHY because Tenor is gone: Google stopped accepting new API
 * clients in January 2026 and shut the API down in June. Everything specific to
 * the provider is in four places on purpose (`ENDPOINT`, the parameters in
 * `fetchResults`, `ALLOWED_HOSTS`, and the one field read in `safeUrl`), so the
 * next time one of these disappears the swap is a small edit rather than a
 * rewrite.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { screenInput } from '../moderation/screen.js';
import { createRateLimiter } from '../rate-limit.js';

const ENDPOINT = 'https://api.giphy.com/v1/gifs/search';

/**
 * Hosts a result may live on: GIPHY serves media from `media0.giphy.com` to
 * `media4.giphy.com` and `i.giphy.com`. Their own answer should never contain
 * anything else; this is the check that makes that a fact rather than a hope.
 */
const ALLOWED_HOST = /^(media\d*|i)\.giphy\.com$/;

/**
 * Renditions in the order they are preferred. `original` can be tens of
 * megabytes, which Discord will refuse to show, so a sized one comes first and
 * the full one is the fallback.
 */
const RENDITIONS = Object.freeze(['downsized_medium', 'fixed_height', 'original']);

/**
 * A query is model-supplied free text, the one place in `chat/tools.js` where
 * that is true, so it is held to a shape rather than trusted: a few words, no
 * newlines, no URL smuggled in as a "search term".
 *
 * 50 is the provider's own maximum for `q`, so a longer one is refused here
 * rather than sent and rejected.
 */
const QUERY_MAX_CHARS = 50;
// Whitespace is collapsed rather than refused (a stray newline is a formatting
// accident, not an attack); what is refused is a link pretending to be a search
// term, and the angle brackets that would make one out of an ordinary word.
const UNSAFE_QUERY = /[<>]|https?:\/\//i;

/**
 * Two buckets, because there are two things to protect.
 *
 * Per guild, so one busy server cannot spend the key for every other server on
 * the same bot (a DM has no guild and shares one bucket). And a process-wide
 * one, because the quota is not per guild at all: a GIPHY beta key allows 100
 * searches an hour for the whole deployment, so a per-guild limit alone would
 * be a limit on nothing as soon as there are three guilds. The cache in front
 * of both is what actually keeps the numbers small.
 */
const searchLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60_000, name: 'gif-search' });
const globalLimiter = createRateLimiter({ max: 60, windowMs: 60 * 60_000, name: 'gif-search-all' });

/** Answers keyed by query, so a running joke costs one call rather than ten. */
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 200;
const cache = new Map();

const cacheGet = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.urls;
};

const cacheSet = (key, urls) => {
  // Oldest first, which is insertion order for a Map: a plain bound, not an LRU.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { urls, expiresAt: Date.now() + CACHE_TTL_MS });
};

/** Test seam: the cache and its TTL are process-lifetime state. */
export function clearGifCache() {
  cache.clear();
}

/**
 * @param {unknown} raw
 * @returns {string | null} The query as it may be sent, or null if it may not.
 */
export function normalizeQuery(raw) {
  // A string, not something string-ish: `String(['katze'])` is `'katze'` and
  // `String({})` is `'[object Object]'`, so coercing here would quietly accept
  // shapes the schema said were not allowed.
  if (typeof raw !== 'string') return null;

  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value || value.length > QUERY_MAX_CHARS) return null;
  if (UNSAFE_QUERY.test(value)) return null;
  return value;
}

/**
 * @param {object} result One entry of the provider's `data`.
 * @returns {string | null} A media URL to embed, if one is on an allowed host.
 */
function safeUrl(result) {
  for (const name of RENDITIONS) {
    const raw = result?.images?.[name]?.url;
    if (typeof raw !== 'string') continue;

    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') continue;
      if (!ALLOWED_HOST.test(parsed.hostname.toLowerCase())) continue;
      return parsed.toString();
    } catch {
      // Not a URL at all: try the next rendition rather than the next result.
    }
  }
  return null;
}

/**
 * @param {string} query Already normalized.
 * @returns {Promise<string[]>} View URLs, possibly empty.
 */
async function fetchResults(query) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', config.chat.gifSearch.apiKey);
  url.searchParams.set('limit', String(config.chat.gifSearch.results));
  // Their side of the filter. The screen above catches what a query means; this
  // catches what a perfectly innocent query can return.
  url.searchParams.set('rating', config.chat.gifSearch.rating);

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(config.chat.gifSearch.timeoutMs),
  });

  if (!response.ok) {
    // The status is metadata; the body could quote anything, so it stays out.
    logger.warn({ status: response.status }, 'GIF search refused');
    return [];
  }

  const body = await response.json();
  const results = Array.isArray(body?.data) ? body.data : [];
  return results.map(safeUrl).filter(Boolean);
}

/**
 * @param {unknown} rawQuery What the model asked for.
 * @param {{ guildId: string | null }} context
 * @returns {Promise<string | null>} A URL to post, or null for "no GIF".
 */
export async function searchGif(rawQuery, { guildId }) {
  if (!config.chat.gifSearch.enabled) return null;

  const query = normalizeQuery(rawQuery);
  if (!query) {
    logger.debug({ guildId }, 'GIF search query refused by shape');
    return null;
  }

  const key = query.toLowerCase();
  const cached = cacheGet(key);
  // The screen and the limiter sit behind the cache on purpose: a query that
  // was already screened and fetched is not screened and fetched again.
  if (cached) return cached.length > 0 ? pick(cached) : null;

  // Fail-closed, like every other place a member's words steer what Mai
  // publishes. An unreachable classifier costs a GIF, not a safe one.
  const screened = await screenInput(query, { guildId });
  if (!screened.ok) {
    logger.info({ guildId, categories: screened.categories }, 'Refused a GIF search');
    return null;
  }

  if (!searchLimiter.consume(guildId ?? 'dm')) return null;
  if (!globalLimiter.consume('all')) return null;

  try {
    const urls = await fetchResults(query);
    cacheSet(key, urls);
    logger.info({ guildId, results: urls.length }, 'GIF search');
    // The query is what a member steered, so it is content: debug only.
    logger.debug({ guildId, query }, 'GIF search query');
    return urls.length > 0 ? pick(urls) : null;
  } catch (error) {
    // Timeout, DNS, malformed JSON: the reply still goes out, without a GIF.
    logger.warn({ guildId, err: error }, 'GIF search failed');
    return null;
  }
}

const pick = (urls) => urls[Math.floor(Math.random() * urls.length)];
