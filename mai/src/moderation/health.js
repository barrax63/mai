/**
 * Whether classification is currently working, per guild.
 *
 * Moderation fails open: when the provider is unreachable, the key is revoked
 * or the request times out, `checkMessage` lets the message pass and Mai keeps
 * chatting. That is deliberate (a broken classifier must not turn her into a
 * broken bot), but from inside Discord it is indistinguishable from a quiet
 * afternoon: the failure is logged for the operator and reaches the alert
 * channel, and a guild's own staff learn nothing.
 *
 * So a streak of failures is turned into exactly two events in the guild's log
 * channel: one when moderation stops working, one when it starts again. A
 * counter rather than a single failure, because one timeout is normal; the
 * `announced` flag is what keeps an hour-long outage to one entry rather than
 * one per message.
 *
 * State is in memory: after a restart the first failures count from zero again,
 * which at worst delays the notice by `MODERATION_DEGRADED_AFTER` messages.
 */
import { config } from '../config.js';

/** @type {Map<string, { failures: number, announced: boolean }>} */
const guilds = new Map();

const stateFor = (guildId) => {
  const existing = guilds.get(guildId);
  if (existing) return existing;

  const fresh = { failures: 0, announced: false };
  guilds.set(guildId, fresh);
  return fresh;
};

/**
 * @param {string} guildId
 * @returns {{ announce: boolean, failures: number }} `announce` is true exactly
 *   once per outage: on the failure that crosses the threshold.
 */
export function recordClassifierFailure(guildId) {
  const state = stateFor(guildId);
  state.failures += 1;

  const announce = !state.announced && state.failures >= config.moderation.degradedAfter;
  if (announce) state.announced = true;

  return { announce, failures: state.failures };
}

/**
 * @param {string} guildId
 * @returns {boolean} True exactly once per outage: on the first success after
 *   one was announced. A success that follows a streak too short to be
 *   announced simply clears the counter, with nothing to report.
 */
export function recordClassifierSuccess(guildId) {
  const state = guilds.get(guildId);
  if (!state) return false;

  const recovered = state.announced;
  // Dropped rather than reset: a guild whose classifier works is not something
  // this module needs to remember.
  guilds.delete(guildId);

  return recovered;
}

/**
 * Guilds where moderation is currently known to be failing open. Read by
 * `/mod status`, so staff asking "is Mai working?" get the honest answer.
 *
 * @returns {string[]}
 */
export function degradedGuildIds() {
  return [...guilds.entries()].filter(([, state]) => state.announced).map(([guildId]) => guildId);
}

/** Test seam. */
export function resetClassifierHealth() {
  guilds.clear();
}
