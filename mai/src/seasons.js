/**
 * Seasons: the days of the year Mai is a different cat on. Up the Christmas
 * tree in December, under the bed while the fireworks go off, flat on the
 * kitchen tiles in August.
 *
 * Like the naps, a pure function of the clock, so there is no state here to
 * lose or drift: `season()` reads today's date and looks it up in
 * `content.seasons`, which is validated at startup (both ends inclusive, a
 * season may run over new year, and two seasons on one day are refused). The
 * only timer exists so the presence can change at midnight instead of at the
 * next scheduled rotation, which may be hours later.
 *
 * Process-wide on the deployment's `TZ`, and not a per-guild setting, for the
 * same reason as the naps and the zoomies: this is a property of the cat, it
 * sits next to the reaction triggers and the presence statuses, and the custom
 * status is one status for the whole bot.
 *
 * What a season touches: one directive added to the chat prompt (never in place
 * of the tone in force) and, if the season brings its own, the statuses she
 * rotates through. What it must never touch: moderation. Nothing on that path
 * reads this module.
 */
import { content, seasonCovers } from './content.js';
import { logger } from './logger.js';

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Told when a season starts or ends, so the presence can flip at midnight. A
 * listener that throws is that listener's problem.
 *
 * @param {() => void} listener
 */
export function onSeasonChange(listener) {
  listeners.add(listener);
}

const announce = () => {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger.debug({ err: error }, 'Season listener failed');
    }
  }
};

/**
 * @param {Date} [now]
 * @param {typeof content.seasons} [seasons] The validated list; the shipped one
 *   unless a test hands in its own.
 * @returns {(typeof content.seasons)[number] | null} The season today belongs
 *   to, or null on an ordinary day.
 */
export function season(now = new Date(), seasons = content.seasons) {
  if (seasons.length === 0) return null;

  const day = (now.getMonth() + 1) * 100 + now.getDate();
  return seasons.find((entry) => seasonCovers(entry, day)) ?? null;
}

/**
 * Milliseconds until the next local midnight, built from the calendar fields
 * rather than by adding 24 hours, so a daylight-saving day (23 or 25 hours
 * long) still ends at midnight. Never less than a second: a timer that fires a
 * hair early finds the old day, and re-arms for just after the new one.
 *
 * @param {Date} now
 */
const untilMidnight = (now) => {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(next.getTime() - now.getTime(), 1_000);
};

/**
 * Watches for the edges of the seasons. Called once, from the gateway's ready
 * handler, because the one thing an edge changes on its own is the presence,
 * which needs a connected gateway to be seen. The chat directive needs no
 * timer: it is looked up on every turn.
 *
 * @param {() => Date} [clock] The real clock unless a test hands in its own.
 */
export function startSeasons(clock = () => new Date()) {
  if (content.seasons.length === 0) return;

  let current = season(clock())?.name ?? null;
  logger.info({ season: current }, 'Seasons');

  const arm = () => {
    const timer = setTimeout(tick, untilMidnight(clock()));
    // A calendar is never a reason to keep the process alive.
    timer.unref?.();
  };

  const tick = () => {
    const today = season(clock())?.name ?? null;
    if (today !== current) {
      current = today;
      logger.info({ season: current }, current ? 'Season started' : 'Season over');
      announce();
    }
    arm();
  };

  arm();
}
