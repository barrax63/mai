/**
 * Ambient cat behavior: Mai reacts with an emoji when a message matches one
 * of her trigger words. At most one reaction per message; `chance` keeps the
 * common triggers from firing on every single message (cats are aloof).
 *
 * The triggers themselves live in the content config (`reactions:`).
 */
import { content } from '../../content.js';
import { logger } from '../../logger.js';

/**
 * @param {import('discord.js').Message} message
 */
export async function maybeReactAsCat(message) {
  if (!message.content) return;

  for (const trigger of content.reactions) {
    if (!trigger.pattern.test(message.content)) continue;

    // Matched but stayed aloof — no fallthrough to weaker triggers.
    if (Math.random() > trigger.chance) return;

    try {
      await message.react(trigger.emoji);
      logger.debug(
        { messageId: message.id, emoji: trigger.emoji },
        'Reacted to trigger word',
      );
    } catch (error) {
      // Missing Add Reactions permission or deleted message — not worth noise.
      logger.debug(
        { messageId: message.id, err: error },
        'Reaction failed',
      );
    }
    return;
  }
}
