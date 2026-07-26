/**
 * Guards around Mai's chat replies. With the LLM call in-process, the bot spends
 * the API budget directly, so three cheap limits sit in front of it:
 *
 *   - a per-user sliding-window rate limit (CHAT_RATE_LIMIT_MAX per window),
 *   - a global cap on model calls in flight (CHAT_MAX_CONCURRENT),
 *   - per-channel serialization, so two people talking to Mai at once cannot
 *     interleave their history reads and writes.
 *
 * The first two fail closed: the caller reacts with the "busy" emoji instead of
 * replying — a cat that cannot be bothered right now.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

/** userId -> timestamps of recent replies (ms). */
const buckets = new Map();
const SWEEP_AT_SIZE = 1000;

let inFlight = 0;

/** channelId -> tail of the serialization chain. */
const chains = new Map();

/**
 * @param {string} userId
 * @returns {boolean} Whether this user may get a reply right now.
 */
export function consumeRateLimit(userId) {
  const now = Date.now();
  const cutoff = now - config.chat.rateLimitWindowMs;

  if (buckets.size > SWEEP_AT_SIZE) {
    for (const [key, stamps] of buckets) {
      if (stamps.every((stamp) => stamp <= cutoff)) buckets.delete(key);
    }
  }

  const stamps = (buckets.get(userId) ?? []).filter((stamp) => stamp > cutoff);
  if (stamps.length >= config.chat.rateLimitMax) {
    buckets.set(userId, stamps);
    logger.info({ userId, window: config.chat.rateLimitWindowMs }, 'Chat rate limit hit');
    return false;
  }

  stamps.push(now);
  buckets.set(userId, stamps);
  return true;
}

/**
 * @returns {boolean} Whether a model-call slot was free (release it with
 *   `releaseSlot` when done).
 */
export function acquireSlot() {
  if (inFlight >= config.chat.maxConcurrent) {
    logger.info({ inFlight, max: config.chat.maxConcurrent }, 'Chat concurrency cap reached');
    return false;
  }
  inFlight += 1;
  return true;
}

export function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * @returns {number} Model calls currently in flight.
 */
export function slotsInUse() {
  return inFlight;
}

/**
 * Runs `task` after any earlier task for the same key has settled.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function runExclusive(key, task) {
  // The stored tail never rejects, so the next task always starts.
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(task);

  const tail = result.then(
    () => {},
    () => {},
  );
  tail.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  chains.set(key, tail);

  return result;
}
