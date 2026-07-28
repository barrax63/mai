/**
 * The score histogram an observation period collects, and the threshold it can
 * be read off.
 *
 * Twenty buckets of 0.05, one counter each, per guild. Aggregate by
 * construction: there is nowhere in this table to put an id, a timestamp or a
 * word of what anybody wrote, which is the same shape `shadow_hits` has and for
 * the same reason. Nobody was told they were being observed because nothing
 * happened to them, so nothing about them is kept.
 */
import { getDb } from './index.js';

export const BUCKETS = 20;
const WIDTH = 1 / BUCKETS;

/**
 * Fewer samples than this and no threshold is proposed at all.
 *
 * A quiet week is not evidence. Picking a percentile off forty messages would
 * produce a number with the confidence of a measurement and the content of a
 * coin flip, and the cost of being wrong is deleting things people meant.
 */
export const MIN_SAMPLES = 200;

/**
 * How much of a server's traffic the proposed threshold would act on.
 *
 * The top 1%, which is the honest way round to state it: not "how bad is bad"
 * (unanswerable, and different in every language) but "how much of what you
 * actually say should she step in on". A number relative to the server's own
 * distribution adapts to its language for free, which is the whole problem this
 * exists to solve.
 */
const TARGET_SHARE = 0.01;

/**
 * Bounds on anything learned this way.
 *
 * The floor stops a polite server from teaching her that its mildest 1% is
 * worth deleting: on traffic that never scores anything, the percentile lands
 * near zero and every borderline message becomes a violation. The ceiling stops
 * a server having a terrible week from concluding that nothing short of 0.9
 * counts. Outside the band she proposes nothing and says so: a refusal to guess
 * is a better answer than a guess.
 */
const FLOOR = 0.15;
const CEILING = 0.6;

/**
 * @param {number} score 0-1.
 * @returns {number} Bucket index, clamped into range.
 */
export const bucketOf = (score) =>
  Math.min(BUCKETS - 1, Math.max(0, Math.floor(Number(score) / WIDTH)));

/**
 * Counts one classified message. Called for every classification during an
 * observation period, flagged or not: a histogram of what was already flagged
 * cannot show that the line is too high, because the messages that would prove
 * it are exactly the ones that did not clear it.
 *
 * @param {string} guildId
 * @param {number} topScore The highest category score of that message.
 */
export function recordScore(guildId, topScore) {
  if (!Number.isFinite(topScore)) return;

  getDb()
    .prepare(
      `INSERT INTO shadow_scores (guild_id, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT (guild_id, bucket) DO UPDATE SET count = count + 1`,
    )
    .run(String(guildId), bucketOf(topScore));
}

/**
 * @param {string} guildId
 * @returns {number[]} One count per bucket, always `BUCKETS` long.
 */
export function histogram(guildId) {
  const counts = new Array(BUCKETS).fill(0);
  for (const row of getDb()
    .prepare('SELECT bucket, count FROM shadow_scores WHERE guild_id = ?')
    .all(String(guildId))) {
    if (row.bucket >= 0 && row.bucket < BUCKETS) counts[row.bucket] = row.count;
  }
  return counts;
}

/**
 * @param {string} guildId
 */
export function clearScores(guildId) {
  getDb().prepare('DELETE FROM shadow_scores WHERE guild_id = ?').run(String(guildId));
}

/**
 * The threshold this server's own traffic suggests, or null when it does not
 * suggest one.
 *
 * Walks the buckets from the top, accumulating until `TARGET_SHARE` of all
 * classified messages is covered, and takes that bucket's lower edge. Reading
 * the edge rather than interpolating inside the bucket is deliberate: it is the
 * value that provably keeps everything counted so far, and a histogram cannot
 * honestly say more than its own resolution.
 *
 * @param {number[]} counts
 * @returns {{ threshold: number, samples: number, share: number } | null}
 */
export function suggestThreshold(counts) {
  const samples = counts.reduce((sum, count) => sum + count, 0);
  if (samples < MIN_SAMPLES) return null;

  const target = samples * TARGET_SHARE;
  let covered = 0;

  for (let bucket = BUCKETS - 1; bucket >= 0; bucket--) {
    covered += counts[bucket];
    if (covered >= target) {
      const threshold = Number((bucket * WIDTH).toFixed(2));
      // Outside the band she has learned nothing usable, and saying so is the
      // honest answer: a server whose traffic never scores anything has not
      // told her where its line is, it has told her it does not need one.
      if (threshold < FLOOR || threshold > CEILING) return null;
      return { threshold, samples, share: covered / samples };
    }
  }
  return null;
}
