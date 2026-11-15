/**
 * Ambient cat behavior: Mai reacts with an emoji when a message matches one
 * of her trigger words, plus a rare one that needs no reason at all: the last
 * trigger may have no pattern, which is the cat knocking something off the
 * table. At most one reaction per message; `chance` keeps the common triggers
 * from firing on every single message (cats are aloof).
 *
 * A member who just renamed themselves jumps the queue: their next message gets
 * a look about it instead (see gateway/renames.js). It is about them rather
 * than about what they wrote, which is also why it comes first and why an
 * attachment with no text still earns one.
 *
 * The triggers themselves live in the content config (`reactions:`).
 *
 * Other bots get one reaction of their own: now and then a hiss, because a cat
 * does not share its territory gracefully (`bots:` in the content config). A
 * reaction and never a message, since two bots answering each other is a loop
 * that ends when one of them is rate-limited.
 */
import { config } from '../../config.js';
import { content, pick } from '../../content.js';
import { logger } from '../../logger.js';
import { takeRenameLook } from '../renames.js';
import { inZoomies } from '../../zoomies.js';

/**
 * `guildId:botId` -> epoch ms of her last hiss at that bot there. Bounded by
 * the bots that exist on the servers she is in, which is a short list, so
 * nothing sweeps it.
 */
const lastHiss = new Map();

/**
 * A hiss at another bot, now and then.
 *
 * The caller has already checked the allowlist and the kill switch: a paused
 * server gets no behaviour at all, a hiss included. Everything else is decided
 * here, cheapest first:
 *
 * - **Never at herself.** Her own messages come through this event too.
 * - **Never at a webhook.** A webhook message carries the bot flag, but proxy
 *   bots post *people's* messages through webhooks, so a hiss there could land
 *   on a member speaking through a proxy. Followed-channel announcements and
 *   replies to other bots' slash commands arrive the same way and are skipped
 *   with them; the cost is fewer targets, which is the safe direction.
 * - **Once an hour per bot per server at most.** A bot that posts a line per
 *   song or per level-up would otherwise be hissed at several times an hour,
 *   and the joke is a feud, not a reflex on every message.
 *
 * @param {import('discord.js').Message} message
 * @param {number} [now]
 */
export async function maybeHissAtBot(message, now = Date.now()) {
  const botId = message.author?.id;
  if (!botId || !message.guildId) return;
  if (botId === message.client?.user?.id) return;
  if (message.webhookId) return;

  const key = `${message.guildId}:${botId}`;
  const previous = lastHiss.get(key);
  if (previous !== undefined && now - previous < config.bots.hissCooldownMs) return;

  if (Math.random() >= content.bots.chance) return;
  lastHiss.set(key, now);

  const emoji = pick(content.bots.hisses);
  try {
    await message.react(emoji);
    logger.debug({ messageId: message.id, botId, emoji }, 'Hissed at another bot');
  } catch (error) {
    // Missing Add Reactions or a message already gone: not worth noise.
    logger.debug({ messageId: message.id, err: error }, 'Hiss at another bot failed');
  }
}

/** Test seam: the cooldown is process-lifetime state. */
export function resetBotHisses() {
  lastHiss.clear();
}

/**
 * @param {import('discord.js').Message} message
 */
export async function maybeReactAsCat(message) {
  // Checked before the content guard: a new name is worth a look whatever they
  // posted, including a message that is only a picture.
  if (takeRenameLook(message.guildId, message.author?.id)) {
    const emoji = pick(content.renames.looks);
    try {
      await message.react(emoji);
      logger.debug({ messageId: message.id, emoji }, 'Had a look at a new name');
    } catch (error) {
      logger.debug({ messageId: message.id, err: error }, 'Rename look failed');
    }
    return;
  }

  if (!message.content) return;

  // Mid-zoomies she is far less aloof. Capped at 1 rather than left to multiply
  // freely: a trigger that fires on every message is fine for four minutes and
  // wrong if the cap ever moves.
  const boost = inZoomies() ? config.zoomies.reactionBoost : 1;

  for (const trigger of content.reactions) {
    // A trigger without a pattern matches anything (validated in content.js:
    // at most one, and last).
    if (trigger.pattern && !trigger.pattern.test(message.content)) continue;

    // Matched but stayed aloof: no fallthrough to weaker triggers.
    if (Math.random() > Math.min(trigger.chance * boost, 1)) return;

    try {
      await message.react(trigger.emoji);
      logger.debug(
        { messageId: message.id, emoji: trigger.emoji },
        'Reacted to trigger word',
      );
    } catch (error) {
      // Missing Add Reactions permission or deleted message, not worth noise.
      logger.debug(
        { messageId: message.id, err: error },
        'Reaction failed',
      );
    }
    return;
  }
}
