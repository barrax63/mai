/**
 * Cat naps: hours of the day Mai spends asleep.
 *
 * The sibling of `zoomies.js` and its opposite in every way that matters. A
 * burst is random, short and rolled; a nap is the same hours every day, which
 * is why there is no state here at all: `napping()` is a function of the clock,
 * and the only timer exists so the presence can change at the edges instead of
 * at the next scheduled rotation.
 *
 * Process-wide, on the deployment's own `TZ`, and deliberately **not** a
 * per-guild setting. The question that decides it is where the tell lives: a
 * bot that stops answering with no explanation reads as broken, so a nap has to
 * be visible, and the one place it is visible is the custom status, which is
 * one status for the whole bot. A per-guild nap could not be shown in the only
 * place anybody would look. The cost is accepted and worth naming: one
 * deployment sleeps on one timezone, so a bot serving servers twelve hours
 * apart should set `NAP_HOURS` empty and let her stay up.
 *
 * What a nap touches: the presence, chat replies and `/mai ask`. What it must
 * never touch: moderation, in any form. The enforcer tick, the deletions, the
 * strikes, the warning DMs and the log entries all keep running while she
 * sleeps, because the alternative is a window every night in which the rules do
 * not apply, which is a different and much worse feature. Ambient reactions
 * keep working too: a reaction is a reflex, a reply is effort.
 */
import { config } from './config.js';
import { logger } from './logger.js';

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Told when she falls asleep and when she wakes up, so the presence can flip at
 * both edges. A listener that throws is that listener's problem.
 *
 * @param {() => void} listener
 */
export function onNapChange(listener) {
  listeners.add(listener);
}

const announce = () => {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger.debug({ err: error }, 'Nap listener failed');
    }
  }
};

/**
 * @param {Date} [now]
 * @returns {boolean} Whether Mai is asleep right now.
 */
export function napping(now = new Date()) {
  const { startHour, endHour } = config.naps;
  if (startHour === null) return false;

  const hour = now.getHours();
  // A window that crosses midnight (23 to 6) is the normal case for a cat, so
  // it is the branch to get right rather than an edge case: the hours in it are
  // the ones at or after the start *or* before the end, not between them.
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
};

/** Milliseconds until the start of the next hour, recomputed every time. */
const untilNextHour = (now = new Date()) => {
  const next = new Date(now.getTime());
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return Math.max(next.getTime() - now.getTime(), 1_000);
};

/**
 * Watches for the edges of the nap window.
 *
 * Re-armed to the next hour boundary rather than scheduled straight to the next
 * edge, and recomputed from the clock each time: that costs 24 wake-ups a day
 * doing a boolean comparison, and in exchange a daylight-saving change, a
 * suspended laptop or a corrected clock cannot leave her asleep for an extra
 * hour. Called once, from the gateway's ready handler, because everything a nap
 * changes needs a connected gateway to be seen.
 */
export function startNaps() {
  if (config.naps.startHour === null) return;

  let asleep = napping();
  logger.info({ ...config.naps, asleep }, 'Nap hours');

  const tick = () => {
    const now = napping();
    if (now !== asleep) {
      asleep = now;
      logger.info({ asleep }, asleep ? 'Mai is asleep' : 'Mai woke up');
      announce();
    }
    arm();
  };

  const arm = () => {
    const timer = setTimeout(tick, untilNextHour());
    // A sleeping cat is never a reason to keep the process alive.
    timer.unref?.();
  };

  arm();
}
