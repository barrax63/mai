/**
 * Taking back the marks a flag put on a message.
 *
 * Two places need this: the enforcer, when a queue row resolves, and the edit
 * re-check, when a flagged message was edited into something clean. Both are
 * best effort by design: a manually removed scold reply or a missing permission
 * must never block the queue from moving on.
 */
import { Routes } from 'discord.js';
import { content } from '../content.js';
import { logger } from '../logger.js';

/**
 * Message ids Mai is deleting herself.
 *
 * `messageDelete` cannot tell us *who* deleted a message, and the gateway event
 * for Mai's own enforcement arrives while the queue row is still there, which
 * would otherwise be recorded as "the author removed it", the exact opposite of
 * what happened. Ids are marked just before the delete and expire on their own,
 * so a failed delete cannot leak an entry forever.
 */
const ownDeletions = new Map();
const OWN_DELETION_TTL_MS = 60_000;

/**
 * @param {string} messageId
 */
export function markOwnDeletion(messageId) {
  if (!messageId) return;
  clearTimeout(ownDeletions.get(messageId));
  const timer = setTimeout(() => ownDeletions.delete(messageId), OWN_DELETION_TTL_MS);
  timer.unref?.();
  ownDeletions.set(messageId, timer);
}

/**
 * @param {string} messageId
 * @returns {boolean} Whether Mai (or staff acting through her) did this.
 */
export function isOwnDeletion(messageId) {
  return ownDeletions.has(messageId);
}

/** Test seam: the registry is process-lifetime state. */
export function clearOwnDeletions() {
  for (const timer of ownDeletions.values()) clearTimeout(timer);
  ownDeletions.clear();
}

/**
 * Deletes a message by id without fetching it first.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {string | null} messageId
 */
export async function deleteMessageById(client, channelId, messageId) {
  if (!messageId) return;
  markOwnDeletion(messageId);
  try {
    const channel = await client.channels.fetch(channelId);
    await channel?.messages?.delete(messageId);
  } catch (error) {
    logger.debug({ channelId, messageId, err: error }, 'Deleting message failed');
  }
}

/**
 * Removes the warning reaction Mai put on a flagged message: hers only.
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

  const cached = message.reactions?.cache?.get(emoji);
  if (!cached) {
    await removeWarningReactionById(message.client, message.channelId, message.id);
    return;
  }

  try {
    await cached.users.remove(botId);
  } catch (error) {
    // Deliberately not falling back to the REST route: the cache said the
    // reaction is there, so a failure here is a permission or a network
    // problem, and a second attempt at the same thing would fail the same way.
    logger.debug(
      { messageId: message.id, err: error },
      'Removing the warning reaction failed',
    );
  }
}

/**
 * The same removal for a caller holding two ids and no message object, which is
 * every path that undoes a flag without having fetched the message: `/mod
 * forgive` walks rows out of the queue. `/@me` again, and idempotent, so a
 * message whose reaction is already gone costs one 404 at `debug`.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {string} messageId
 */
export async function removeWarningReactionById(client, channelId, messageId) {
  if (!client?.rest || !channelId || !messageId) return;

  try {
    await client.rest.delete(
      Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(
        content.moderation.warningEmoji,
      )),
    );
  } catch (error) {
    logger.debug({ channelId, messageId, err: error }, 'Removing the warning reaction failed');
  }
}
