/**
 * Ambient cat behavior: Mai reacts with an emoji when a message matches one
 * of her trigger words. At most one reaction per message; `chance` keeps the
 * common triggers from firing on every single message (cats are aloof).
 */
import { logger } from '../../logger.js';

const TRIGGERS = [
  {
    emoji: '❤️',
    chance: 1,
    pattern: /good\s+(girl|kitty|cat)|gute\s+(katze|miez\w*)|brave?s?\s+(katze|miez\w*)/i,
  },
  {
    emoji: '🐟',
    chance: 1,
    pattern: /\bfisch\w*\b|\bfish(es)?\b|🐟|🐠|🍣/i,
  },
  {
    emoji: '😺',
    chance: 0.5,
    pattern: /\b(miau\w*|meow\w*|maunz\w*|schnurr\w*|purr\w*)\b/i,
  },
  {
    emoji: '🐱',
    chance: 0.2,
    pattern: /\b(katzen?|kater|cats?|kitt(y|ies)|kitten|kätzchen)\b/i,
  },
];

/**
 * @param {import('discord.js').Message} message
 */
export async function maybeReactAsCat(message) {
  if (!message.content) return;

  for (const trigger of TRIGGERS) {
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
