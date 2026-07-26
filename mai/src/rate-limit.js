/**
 * Sliding-window rate limiting, per key (usually a user id).
 *
 * Used wherever a member can make Mai spend something — model tokens for chat,
 * staff attention for reports and appeals. Buckets live in memory: a restart
 * forgives everyone, which is the right trade for limits this small.
 */
import { logger } from './logger.js';

const SWEEP_AT_SIZE = 1000;

/**
 * @param {{ max: number, windowMs: number, name: string }} options
 * @returns {{ consume: (key: string) => boolean, size: () => number }}
 */
export function createRateLimiter({ max, windowMs, name }) {
  /** key -> timestamps (ms) of recent grants */
  const buckets = new Map();

  return {
    /**
     * @param {string} key
     * @returns {boolean} Whether this call is allowed.
     */
    consume(key) {
      const now = Date.now();
      const cutoff = now - windowMs;

      if (buckets.size > SWEEP_AT_SIZE) {
        for (const [existing, stamps] of buckets) {
          if (stamps.every((stamp) => stamp <= cutoff)) buckets.delete(existing);
        }
      }

      const stamps = (buckets.get(key) ?? []).filter((stamp) => stamp > cutoff);
      if (stamps.length >= max) {
        buckets.set(key, stamps);
        logger.info({ limiter: name, key, max, windowMs }, 'Rate limit hit');
        return false;
      }

      stamps.push(now);
      buckets.set(key, stamps);
      return true;
    },

    size() {
      return buckets.size;
    },
  };
}
