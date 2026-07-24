/**
 * Handler for new messages in every channel the bot can read.
 *
 * Logs message metadata (no content at info level, to keep container logs
 * free of user text), forwards the message to the n8n moderation webhook
 * when N8N_WEBHOOK_URL is configured, and routes messages addressed to Mai
 * (mention / reply) to the chat workflow. Everything else may get an ambient
 * cat reaction. Moderation always runs, including for chat messages.
 *
 * @param {import('discord.js').Message} message
 */
import { logger } from '../../logger.js';
import { forwardMessageToN8n } from '../../n8n/webhook.js';
import { handleMaiChat, isMaiChatTrigger } from './mai-chat.js';
import { maybeReactAsCat } from './reactions.js';

export async function onMessageCreate(message) {
  // Ignore bots (including ourselves) and system messages.
  if (message.author?.bot || message.system) return;

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
    await Promise.all([forwardMessageToN8n(message), maybeReactAsCat(message)]);
    return;
  }

  // Addressed to Mai: await the moderation verdict first. A flagged message
  // gets the workflow's scold reply instead of a chat answer — the chat
  // workflow (and its history table) never sees it. Fails open: no verdict
  // (moderation disabled, timeout, error) or not flagged -> normal chat.
  const verdict = await forwardMessageToN8n(message);
  if (verdict?.action === 'flagged') {
    logger.info(
      { messageId: message.id },
      'Message flagged, skipping chat reply (workflow scolds instead)',
    );
    return;
  }

  await handleMaiChat(message).catch((error) => {
    logger.error(
      { err: error, messageId: message.id },
      'Mai chat handler failed',
    );
  });
}
