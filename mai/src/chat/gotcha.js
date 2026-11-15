/**
 * Gotcha day: the anniversary of the day Mai moved into a server, the way
 * people celebrate the day a cat came home rather than a birthday nobody knows.
 * On it she is extra smug in that server, and `/mai mood` says why.
 *
 * No new data and no migration: the date is `onboarded_at`, which she writes
 * the first time she introduces herself in a server, so a server she was
 * already in before introductions existed simply has no gotcha day. It is
 * bookkeeping about the server, not about anybody in it.
 *
 * A pure function of the date like the seasons, on the deployment's own clock
 * (`TZ`), so the day she joined and the day it comes round again are read on
 * the same calendar. Nothing about moderation reads it, and a failure to read
 * the date costs the celebration, never the reply.
 */
import { onboardedAt } from '../db/settings.js';
import { logger } from '../logger.js';

const isLeapYear = (year) => new Date(year, 1, 29).getMonth() === 1;

/**
 * How many years ago she moved in, if today is the day; 0 on every other day,
 * including the day itself (that is a move, not an anniversary). Somebody who
 * joined on 29 February celebrates on the 28th in the years without one.
 *
 * @param {string | null | undefined} joinedIso
 * @param {Date} [now]
 * @returns {number}
 */
export function gotchaYears(joinedIso, now = new Date()) {
  const joined = new Date(joinedIso ?? Number.NaN);
  if (Number.isNaN(joined.getTime())) return 0;

  const years = now.getFullYear() - joined.getFullYear();
  if (years < 1) return 0;

  const month = joined.getMonth();
  let day = joined.getDate();
  if (month === 1 && day === 29 && !isLeapYear(now.getFullYear())) day = 28;

  return now.getMonth() === month && now.getDate() === day ? years : 0;
}

/**
 * The same, for a server.
 *
 * @param {string | null | undefined} guildId Null in a DM, which has no move-in day.
 * @param {Date} [now]
 * @returns {number}
 */
export function gotchaDay(guildId, now = new Date()) {
  if (!guildId) return 0;
  try {
    return gotchaYears(onboardedAt(guildId), now);
  } catch (error) {
    logger.debug({ guildId, err: error }, 'Gotcha day lookup failed');
    return 0;
  }
}
