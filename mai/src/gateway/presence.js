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
  if (Number.isFinite(rotateHours) && rotateHours > 0) {
    setInterval(rotate, rotateHours * 60 * 60 * 1000);
  }
}
