/**
 * Mai's chat turn.
 *
 * Reads her short-term memory for the channel, checks whether the author has an
 * open violation (which flips her tone), asks the model, and remembers the
 * exchange. Discord I/O stays in the gateway handler.
 */
import { buildPrompt, generateReply } from '../ai/chat.js';
import { config } from '../config.js';
import { content } from '../content.js';
import { appendTurns, recentTurns } from '../db/history.js';
import { openViolations } from '../db/queue.js';
import { logger } from '../logger.js';

/**
 * @param {{ messageId: string, channelId: string, guildId: string | null, userId: string,
 *   username: string, content: string }} input
 * @returns {Promise<string | null>} Reply to post, or null when generation failed.
 */
export async function generateChatReply(input) {
  const history = recentTurns(input.channelId, config.chat.historyTurns);
  // Any guild: Mai is one persona, so a strike anywhere makes her mad at that
  // user everywhere, DMs included. Categories are slugs, never content.
  const violations = openViolations(input.userId);

  const prompt = buildPrompt({
    history,
    username: input.username,
    content: input.content,
    violations,
  });

  logger.debug({ messageId: input.messageId, prompt }, 'Chat prompt');

  try {
    const reply = await generateReply(prompt);
    logger.info(
      {
        messageId: input.messageId,
        historyTurns: history.length,
        openViolations: violations.count,
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
 * Stores the exchange as Mai's memory. The user turn is skipped when it was a
 * bare mention with no text.
 *
 * @param {{ channelId: string, guildId: string | null, userId: string, username: string,
 *   content: string }} input
 * @param {string} reply
 */
export function rememberExchange(input, reply) {
  const userContent = String(input.content ?? '').trim();
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
