/**
 * Handler for new messages in every channel the bot can read.
 *
 * Logs message metadata (no content at info level, to keep container logs free
 * of user text), runs the moderation check for guild messages, and routes
 * messages addressed to Mai (mention / reply / direct message) to the chat
 * pipeline. Everything else may get an ambient cat reaction. Moderation always
 * runs for guild messages, including chat ones; direct messages skip it (a bot
 * cannot delete a DM).
 *
 * @param {import('discord.js').Message} message
 */
import { isGuildAllowed } from '../../config.js';
import { isGuildActive } from '../../db/settings.js';
import { logger } from '../../logger.js';
import { checkMessage } from '../../moderation/check.js';
import { handleMaiChat, isDmAuthorInAllowedGuild, isMaiChatTrigger } from './mai-chat.js';
import { maybeReactAsCat } from './reactions.js';

export async function onMessageCreate(message) {
  // Ignore bots (including ourselves) and system messages.
  if (message.author?.bot || message.system) return;

  // Allowlist gate. An un-whitelisted server gets NO behavior — no moderation,
  // no cat reactions, no chat. A DM has no guildId: it is allowed only when its
  // author shares a whitelisted guild with the bot, so members of
  // non-whitelisted guilds (or strangers) cannot DM Mai.
  if (message.guildId) {
    if (!isGuildAllowed(message.guildId)) {
      logger.debug(
        { messageId: message.id, guildId: message.guildId },
        'Ignoring message: guild not in allowlist',
      );
      return;
    }

    // The kill switch (/mod off). Same effect as not being allowlisted, but
    // set by the server's own staff and reversible from Discord.
    if (!isGuildActive(message.guildId)) {
      logger.debug(
        { messageId: message.id, guildId: message.guildId },
        'Ignoring message: Mai is paused in this guild',
      );
      return;
    }
  } else if (!(await isDmAuthorInAllowedGuild(message))) {
    logger.debug(
      { messageId: message.id, authorId: message.author?.id },
      'Ignoring DM: author not in a whitelisted guild',
    );
    return;
  }

  logger.info(
    {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author?.id,
      contentLength: message.content?.length ?? 0,
      attachments: message.attachments?.size ?? 0,
    },
    'New message received',
  );

  // Full content only at debug level.
  logger.debug({ messageId: message.id, content: message.content }, 'Message content');

  const wantsChat = await isMaiChatTrigger(message);

  // Not addressed to Mai: moderation and the ambient reaction are independent,
  // run them in parallel.
  if (!wantsChat) {
    await Promise.all([checkMessage(message), maybeReactAsCat(message)]);
    return;
  }

  // Addressed to Mai in a guild: await the moderation verdict first. A flagged
  // message gets the scold reply instead of a chat answer — the chat pipeline
  // (and its history table) never sees it. Fails open: no verdict (moderation
  // disabled, API error) or not flagged -> normal chat.
  //
  // Direct messages skip this: a bot cannot delete a user's DM, so the
  // moderation pipeline (grace-period delete + scold) has nothing to enforce.
  if (message.guildId) {
    const verdict = await checkMessage(message);
    if (verdict?.action === 'flagged') {
      logger.info(
        { messageId: message.id },
        'Message flagged, skipping chat reply (scolded instead)',
      );
      return;
    }
  }

  await handleMaiChat(message).catch((error) => {
    logger.error(
      { err: error, messageId: message.id },
      'Mai chat handler failed',
    );
  });
}
