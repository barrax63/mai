/**
 * Rotating custom status for Mai. A random status is set on gateway ready and
 * replaced every PRESENCE_ROTATE_HOURS (immediate repeats avoided; 0 disables
 * rotation). Presence is gateway-side only: no Discord API rate limit
 * concerns at this frequency.
 */
import { ActivityType } from 'discord.js';
import { config } from '../config.js';
import { content } from '../content.js';
import { logger } from '../logger.js';

const STATUSES = content.presence.statuses;

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
  let current = -1;

  const rotate = () => {
    let next;
    do {
      next = Math.floor(Math.random() * STATUSES.length);
    } while (next === current && STATUSES.length > 1);
    current = next;

    client.user.setPresence({
      status: 'online',
      activities: [
        {
          type: ActivityType.Custom,
          name: 'mai-status',
          state: STATUSES[current],
        },
      ],
    });
    logger.debug({ state: STATUSES[current] }, 'Presence rotated');
  };

  rotate();

  const { rotateHours } = config.presence;
  if (rotateHours > 0) {
    const timer = setInterval(rotate, Math.min(rotateHours * 60 * 60 * 1000, MAX_INTERVAL_MS));
    // Rotating a status is never a reason to keep the process alive.
    timer.unref?.();
  }
}
