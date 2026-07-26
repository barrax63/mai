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
import { budgetState } from '../db/usage.js';
import { logger } from '../logger.js';
import { createRateLimiter } from '../rate-limit.js';

const chatLimiter = createRateLimiter({
  max: config.chat.rateLimitMax,
  windowMs: config.chat.rateLimitWindowMs,
  name: 'chat',
});

let inFlight = 0;

/** channelId -> tail of the serialization chain. */
const chains = new Map();

/**
 * @param {string} userId
 * @returns {boolean} Whether this user may get a reply right now.
 */
export const consumeRateLimit = (userId) => chatLimiter.consume(userId);

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
 * Whether this month's token budget still allows a chat reply. Moderation is
 * never gated by this — safety is not a budget item, and the moderation
 * endpoint costs nothing anyway.
 *
 * @returns {boolean}
 */
export function withinBudget() {
  try {
    const { exceeded, used, budget } = budgetState();
    if (exceeded) {
      logger.warn({ used, budget }, 'Monthly token budget exhausted, chat is off');
      return false;
    }
    return true;
  } catch (error) {
    // A broken counter must not silence her.
    logger.warn({ err: error }, 'Could not read the token budget, allowing the call');
    return true;
  }
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
