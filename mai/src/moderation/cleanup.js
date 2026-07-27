/**
 * Taking back the marks a flag put on a message.
 *
 * Two places need this: the enforcer, when a queue row resolves, and the edit
 * re-check, when a flagged message was edited into something clean. Both are
 * best effort by design — a manually removed scold reply or a missing permission
 * must never block the queue from moving on.
 */
import { Routes } from 'discord.js';
import { content } from '../content.js';
import { logger } from '../logger.js';

/**
 * Deletes a message by id without fetching it first.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {string | null} messageId
 */
export async function deleteMessageById(client, channelId, messageId) {
  if (!messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel?.messages?.delete(messageId);
  } catch (error) {
    logger.debug({ channelId, messageId, err: error }, 'Deleting message failed');
  }
}

/**
 * Removes the warning reaction Mai put on a flagged message — hers only.
 *
 * The cached reaction is used when it is there, but Discord's MESSAGE_UPDATE
 * payload does not reliably carry `reactions`, so the REST route is the
 * fallback: it needs no cache, it is idempotent, and it targets `/@me`, which is
 * the one thing `removeAll()` would get wrong (that would drop the reactions of
 * every other member too).
 *
 * @param {import('discord.js').Message} message
 */
export async function removeWarningReaction(message) {
  const emoji = content.moderation.warningEmoji;
  const botId = message?.client?.user?.id;
  if (!botId) return;

  try {
    const cached = message.reactions?.cache?.get(emoji);
    if (cached) {
      await cached.users.remove(botId);
      return;
    }

    await message.client.rest.delete(
      Routes.channelMessageOwnReaction(message.channelId, message.id, encodeURIComponent(emoji)),
    );
  } catch (error) {
    logger.debug(
      { messageId: message.id, err: error },
      'Removing the warning reaction failed',
    );
  }
}
