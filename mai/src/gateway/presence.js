/**
 * Rotating custom status for Mai. A random status is set on gateway ready and
 * replaced every PRESENCE_ROTATE_HOURS (immediate repeats avoided; 0 disables
 * rotation). Presence is gateway-side only: no Discord API rate limit
 * concerns at this frequency.
 *
 * During zoomies, and during her nap hours, she rotates through a different
 * list instead, and the status flips at both edges of either rather than at the
 * next scheduled rotation: a burst is minutes long and the rotation is hours
 * apart, so a status that waited for one would never show up while it was true.
 *
 * Asleep wins over the zoomies, and cannot be contradicted by one: `rollZoomies`
 * refuses to start a burst during a nap, so "asleep" and "tearing through the
 * flat" can never both be true.
 *
 * A season that brings statuses of its own replaces the everyday list for as
 * long as it lasts, and flips at midnight for the same reason. It is the
 * weakest of the three: a nap or a burst is what she is doing right now, the
 * season is only what time of year it is.
 */
import { ActivityType } from 'discord.js';
import { config } from '../config.js';
import { content } from '../content.js';
import { logger } from '../logger.js';
import { napping, onNapChange } from '../naps.js';
import { onSeasonChange, season } from '../seasons.js';
import { inZoomies, onZoomiesChange } from '../zoomies.js';

const STATUSES = content.presence.statuses;
const ZOOMIES_STATUSES = content.presence.zoomies;
const NAP_STATUSES = content.presence.naps;

/**
 * Node stores a timer delay in a 32-bit int. Anything larger overflows to 1 ms,
 * so a generous PRESENCE_ROTATE_HOURS would rotate the status in a tight loop
 * instead of rarely: the exact opposite of what was asked for. ~24.8 days.
 */
const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * @param {import('discord.js').Client<true>} client Ready client.
 */
export function startPresenceRotation(client) {
  // The status itself rather than an index into a list: which list is in use
  // changes when a burst starts, and an index would point into the other one.
  let current = '';

  const statusesNow = () => {
    if (napping()) return NAP_STATUSES;
    if (inZoomies()) return ZOOMIES_STATUSES;
    return season()?.statuses ?? STATUSES;
  };

  const rotate = () => {
    const statuses = statusesNow();
    let next;
    do {
      next = statuses[Math.floor(Math.random() * statuses.length)];
    } while (next === current && statuses.length > 1);
    current = next;

    client.user.setPresence({
      status: 'online',
      activities: [
        {
          type: ActivityType.Custom,
          name: 'mai-status',
          state: current,
        },
      ],
    });
    logger.debug({ state: current }, 'Presence rotated');
  };

  rotate();
  onZoomiesChange(rotate);
  onNapChange(rotate);
  onSeasonChange(rotate);

  const { rotateHours } = config.presence;
  if (rotateHours > 0) {
    const timer = setInterval(rotate, Math.min(rotateHours * 60 * 60 * 1000, MAX_INTERVAL_MS));
    // Rotating a status is never a reason to keep the process alive.
    timer.unref?.();
  }
}
