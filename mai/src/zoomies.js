/**
 * Zoomies: the burst of energy a cat gets for no reason at all, tears through
 * the flat with it, and loses again just as suddenly.
 *
 * Process-wide and deliberately not a per-guild setting. This is a property of
 * the cat rather than a policy about a server, it sits next to the reaction
 * triggers and the presence statuses (both already process-wide), and the
 * custom status is one status for the whole bot anyway: a per-guild burst could
 * not be shown in the one place people would notice it.
 *
 * Nothing about moderation reads this, and nothing here reaches the moderation
 * path. A burst changes three things and no others: the presence statuses she
 * rotates through, how readily she reacts to a trigger word, and one directive
 * line in the chat system message.
 *
 * State is in memory on purpose: a restart is a nap, and a burst that outlived
 * one would be a burst nobody saw start.
 */
import { config } from './config.js';
import { logger } from './logger.js';

/** Epoch ms the current burst ends at; 0 = not running. */
let until = 0;

/** @type {NodeJS.Timeout | null} */
let endTimer = null;

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Told whenever a burst starts or ends, so the presence can flip at both edges
 * rather than at the next roll: the rolls are a quarter of an hour apart and a
 * burst is minutes long, so a status waiting for one would outlast it.
 *
 * A listener that throws is one listener's problem, never the burst's.
 *
 * @param {() => void} listener
 */
export function onZoomiesChange(listener) {
  listeners.add(listener);
}

const announce = () => {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger.debug({ err: error }, 'Zoomies listener failed');
    }
  }
};

/**
 * @param {number} [now]
 * @returns {boolean} Whether a burst is running right now.
 */
export function inZoomies(now = Date.now()) {
  return now < until;
}

/**
 * One roll of the dice. Exported (rather than hidden in the interval) because
 * it takes the clock as an argument, which is what lets the tests reach the
 * behaviour without an environment seam or a test-only setter.
 *
 * A roll during a burst does nothing: bursts do not stack, and re-rolling into
 * one would extend it without limit.
 *
 * @param {number} [now]
 * @returns {boolean} Whether this roll started a burst.
 */
export function rollZoomies(now = Date.now()) {
  const { chance, minutes } = config.zoomies;
  if (chance <= 0 || inZoomies(now) || Math.random() >= chance) return false;

  const length = minutes * 60_000;
  until = now + length;
  logger.info({ minutes }, 'Zoomies');

  clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    until = 0;
    logger.info('Zoomies over');
    announce();
  }, length);
  // A cat calming down is never a reason to keep the process alive.
  endTimer.unref?.();

  announce();
  return true;
}

/**
 * Starts rolling. Called once, from the gateway's ready handler: the three
 * things a burst changes are all things only a connected gateway can show.
 */
export function startZoomies() {
  if (config.zoomies.chance <= 0) return;
  const timer = setInterval(() => rollZoomies(), config.zoomies.rollMinutes * 60_000);
  timer.unref?.();
}
