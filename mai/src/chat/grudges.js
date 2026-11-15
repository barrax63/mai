/**
 * Letting a grudge go: when somebody's last strike has aged out of the strike
 * window, the next time they talk to her in that server she says, once, that
 * she is over it, and then gets on with her answer.
 *
 * Her tone reads the *queue* (an open violation makes her hiss), so enforcement
 * already makes her friendly again on the spot. The strike record is longer,
 * and this is the moment it stops counting: a fact about a clock rather than an
 * event, which is why it is read on the member's next turn instead of being
 * announced into a channel nobody is reading.
 *
 * This is the one persona feature that touches somebody's record in front of
 * other people, so three limits are the feature rather than details of it:
 *
 * - **The line says nothing about what it was.** It is a fixed line from the
 *   YAML, not something the model writes: the model is never told there was a
 *   grudge, so it cannot name a category, a count or a date, or invent a
 *   reason. A test holds the shipped lines to that.
 * - **Only in the server the strikes were in.** Strikes are per guild, and so
 *   is this: a line in one server about another server's record would be one
 *   community hearing about a member's business in another.
 * - **Only recently.** A strike that left the window more than two weeks ago is
 *   not mentioned at all, so this cannot surface something from months back.
 *
 * What counts is what counts for escalation (`strikeCount`): an enforced
 * deletion. A message the author removed or fixed in time, a warning from
 * staff, and a strike overturned on appeal are not grudges, and a record staff
 * wiped with `/mod forgive … strikes:true` leaves nothing to let go of.
 *
 * Nothing here reaches moderation: it reads the record and writes nothing to
 * it. The memory of having said it is in memory like the zoomies and the
 * petting, which means a restart can earn somebody the line twice, inside the
 * two weeks and no more.
 */
import { config } from '../config.js';
import { strikeCount } from '../db/violations.js';
import { logger } from '../logger.js';
import { strikeWindowStart } from '../moderation/escalation.js';

/** `guildId:userId` -> epoch ms she said it at. */
const saidAt = new Map();

/** Entries are useless once the strikes they were about are past remembering. */
const SWEEP_AT_SIZE = 1000;

function sweep(now) {
  if (saidAt.size <= SWEEP_AT_SIZE) return;
  for (const [key, at] of saidAt) {
    if (now - at > config.grudges.memoryMs) saidAt.delete(key);
  }
}

/**
 * Whether this turn is the one she lets it go on, and if so, records that she
 * did: read and consumed in one call, so two turns cannot both say it. The
 * caller consumes it before the model call, which means a reply that then fails
 * costs the line rather than repeating it later.
 *
 * Cheapest question first: most members have no strikes at all, and that is
 * one query.
 *
 * @param {string | null | undefined} guildId Null in a DM, which never qualifies.
 * @param {string} userId
 * @param {number} [now]
 * @returns {boolean}
 */
export function takeGrudgeRelease(guildId, userId, now = Date.now()) {
  if (!guildId || !userId) return false;

  const windowStart = strikeWindowStart(guildId, now);
  const remembered = new Date(Date.parse(windowStart) - config.grudges.memoryMs).toISOString();

  // Nothing recent enough to remember.
  if (strikeCount(guildId, userId, remembered) === 0) return false;
  // Something still inside the window: not over it yet.
  if (strikeCount(guildId, userId, windowStart) > 0) return false;

  const key = `${guildId}:${userId}`;
  const previous = saidAt.get(key);
  // Already said it, and nothing new has happened since that she could be
  // getting over now.
  if (previous !== undefined && strikeCount(guildId, userId, new Date(previous).toISOString()) === 0) {
    return false;
  }

  saidAt.set(key, now);
  sweep(now);
  logger.info({ guildId, userId }, 'Mai let a grudge go');
  return true;
}

/** Test seam: what she has already said is process-lifetime state. */
export function resetGrudges() {
  saidAt.clear();
}
