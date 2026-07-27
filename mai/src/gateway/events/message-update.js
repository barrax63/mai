/**
 * Handler for edited messages.
 *
 * Without it the moderation pipeline has a hole the size of the edit button:
 * post something harmless, let it pass, then edit it into what you actually
 * wanted to say. So an edit is classified exactly like a new message — and the
 * verdict cuts both ways, because fixing a flagged message has to be worth
 * something: `recheckMessage` takes the reaction, the scold reply and the queue
 * row back off a message that is clean again.
 *
 * Deliberately moderation only. An edit that adds a mention of Mai does not make
 * her answer: a chat trigger is something you send, not something you retrofit
 * into a message she already saw.
 *
 * Direct messages are skipped for the same reason `onMessageCreate` skips them —
 * a bot cannot delete a user's DM, so there is nothing to enforce.
 */
import { isGuildAllowed } from '../../config.js';
import { isGuildActive } from '../../db/settings.js';
import { logger } from '../../logger.js';
import { recheckMessage } from '../../moderation/check.js';

/**
 * Discord sends MESSAGE_UPDATE for more than edits: a link preview resolving, a
 * pin, a flag change. Only a real content edit sets `edited_timestamp`, which is
 * the cache-independent half of the filter; when the previous version *was*
 * cached, comparing the content catches an update that carries a stale
 * timestamp.
 *
 * @param {import('discord.js').Message | null} oldMessage
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
function isContentEdit(oldMessage, message) {
  if (!message.editedTimestamp) return false;
  if (oldMessage && !oldMessage.partial && oldMessage.content === message.content) return false;
  return true;
}

/**
 * @param {import('discord.js').Message} oldMessage Previous version, possibly a partial.
 * @param {import('discord.js').Message} newMessage
 */
export async function onMessageUpdate(oldMessage, newMessage) {
  // MESSAGE_UPDATE arrives for uncached messages too (Partials.Message), and a
  // partial carries neither content nor author.
  let message = newMessage;
  if (message?.partial) {
    try {
      message = await message.fetch();
    } catch (error) {
      logger.debug(
        { messageId: newMessage?.id, err: error },
        'Could not fetch the edited message',
      );
      return;
    }
  }

  // Ignore bots (including ourselves) and system messages.
  if (message.author?.bot || message.system) return;

  if (!message.guildId) return;

  if (!isGuildAllowed(message.guildId)) {
    logger.debug(
      { messageId: message.id, guildId: message.guildId },
      'Ignoring edit: guild not in allowlist',
    );
    return;
  }

  // The kill switch (/mod off). A message flagged before the pause keeps its
  // row — pausing is not an amnesty — so an edit made while Mai is off is
  // re-judged when the guild switches her back on.
  if (!isGuildActive(message.guildId)) {
    logger.debug(
      { messageId: message.id, guildId: message.guildId },
      'Ignoring edit: Mai is paused in this guild',
    );
    return;
  }

  if (!isContentEdit(oldMessage, message)) return;

  logger.info(
    {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author?.id,
      contentLength: message.content?.length ?? 0,
      attachments: message.attachments?.size ?? 0,
    },
    'Message edited',
  );

  // Full content only at debug level.
  logger.debug({ messageId: message.id, content: message.content }, 'Edited message content');

  await recheckMessage(message);
}
