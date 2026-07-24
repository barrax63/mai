/**
 * Mai chat: users talk to the bot by mentioning it or replying to one of its
 * messages. The message is forwarded to the n8n "Mai Chat" workflow, which
 * answers in character (cat persona, conversation memory per channel); the
 * workflow response body ({ reply }) is posted back into the channel as a
 * reply to the triggering message.
 */
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { isChatEnabled, sendChatMessageToN8n } from '../../n8n/webhook.js';

// Discord's typing indicator expires after ~10 s; refresh while the workflow
// (LLM call) is still running.
const TYPING_REFRESH_MS = 8_000;

/**
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} Whether this message is addressed to Mai.
 */
export async function isMaiChatTrigger(message) {
  if (!isChatEnabled()) return false;

  const botId = message.client.user?.id;
  if (!botId) return false;

  // Same guild allowlist as moderation forwarding.
  const { guildIds } = config.discord;
  if (guildIds.size > 0 && !guildIds.has(message.guildId)) return false;

  // Direct @mention (also covers replies with the mention toggle on).
  if (message.mentions.users?.has(botId)) return true;

  // Reply to one of Mai's messages with the mention toggle off.
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      return referenced?.author?.id === botId;
    } catch (error) {
      logger.debug(
        { messageId: message.id, err: error },
        'Could not fetch referenced message',
      );
      return false;
    }
  }

  return false;
}

/**
 * @param {import('discord.js').Message} message
 */
export async function handleMaiChat(message) {
  const botId = message.client.user.id;

  // Strip the bot mention; an empty remainder is a bare poke — the workflow
  // treats it as a greeting.
  const content = (message.content ?? '')
    .replaceAll(`<@${botId}>`, '')
    .replaceAll(`<@!${botId}>`, '')
    .trim();

  const payload = {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    username: message.author.username,
    content,
    createdAt: message.createdAt.toISOString(),
  };

  await message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, TYPING_REFRESH_MS);

  let result;
  try {
    result = await sendChatMessageToN8n(payload);
  } finally {
    clearInterval(typing);
  }

  const reply = typeof result?.reply === 'string' ? result.reply.trim() : '';
  if (!reply) {
    logger.warn({ messageId: message.id }, 'Chat workflow returned no reply');
    return;
  }

  // parse: [] blocks @everyone/role/user pings inside the LLM reply; the
  // reply-ping to the author is allowed explicitly.
  await message.reply({
    content: reply,
    allowedMentions: { parse: [], repliedUser: true },
  });

  logger.info(
    { messageId: message.id, replyLength: reply.length },
    'Mai replied',
  );
  logger.debug({ messageId: message.id, reply }, 'Mai reply content');
}
