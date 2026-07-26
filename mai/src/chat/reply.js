/**
 * Mai's chat turn.
 *
 * Reads her short-term memory for the channel, checks whether the author has an
 * open violation (which flips her tone), asks the model — which may call tools
 * along the way — and remembers the exchange. Discord I/O stays in the gateway
 * handler, which also resolves the reply and thread context.
 */
import { buildMessages, generateReply } from '../ai/chat.js';
import { config } from '../config.js';
import { content } from '../content.js';
import { appendTurns, recentTurns } from '../db/history.js';
import { openViolations } from '../db/queue.js';
import { logger } from '../logger.js';

/**
 * @param {{ messageId: string, channelId: string, guildId: string | null, userId: string,
 *   username: string, content: string, replyTo?: object | null, threadTitle?: string | null,
 *   images?: string[], client?: object }} input
 * @returns {Promise<string | null>} Reply to post, or null when generation failed.
 */
export async function generateChatReply(input) {
  const history = recentTurns(input.channelId, config.chat.historyTurns);
  // Any guild: Mai is one persona, so a strike anywhere makes her mad at that
  // user everywhere, DMs included. Categories are slugs, never content.
  const violations = openViolations(input.userId);

  const messages = buildMessages({
    history,
    username: input.username,
    content: input.content,
    violations,
    replyTo: input.replyTo,
    threadTitle: input.threadTitle,
    images: input.images ?? [],
  });

  logger.debug({ messageId: input.messageId, messages }, 'Chat prompt');

  try {
    const reply = await generateReply(messages, {
      userId: input.userId,
      guildId: input.guildId,
      client: input.client,
    });

    logger.info(
      {
        messageId: input.messageId,
        historyTurns: history.length,
        openViolations: violations.count,
        images: input.images?.length ?? 0,
        repliedTo: Boolean(input.replyTo),
        inThread: Boolean(input.threadTitle),
        model: config.openai.chatModel,
        replyLength: reply.length,
      },
      'Generated chat reply',
    );
    return reply;
  } catch (error) {
    logger.error({ messageId: input.messageId, err: error }, 'Chat generation failed');
    return null;
  }
}

/**
 * Stores the exchange as Mai's memory. Only what the member actually wrote is
 * kept: the quoted reply context and the images are prompt-time context, not
 * theirs to persist.
 *
 * @param {{ channelId: string, guildId: string | null, userId: string, username: string,
 *   content: string, images?: string[] }} input
 * @param {string} reply
 */
export function rememberExchange(input, reply) {
  const userContent = String(input.content ?? '').trim()
    || (input.images?.length ? content.chat.prompt.imagePlaceholder : '');
  const turns = [];

  if (userContent) {
    turns.push({
      channelId: input.channelId,
      guildId: input.guildId,
      userId: input.userId,
      username: input.username,
      role: 'user',
      content: userContent,
    });
  }

  turns.push({
    channelId: input.channelId,
    guildId: input.guildId,
    userId: null,
    username: content.chat.prompt.assistantLabel,
    role: 'assistant',
    content: reply,
  });

  try {
    appendTurns(turns);
  } catch (error) {
    // Memory loss is survivable; the reply was already delivered.
    logger.error({ channelId: input.channelId, err: error }, 'Storing chat history failed');
  }
}
