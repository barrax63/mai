/**
 * Mai's chat turn.
 *
 * Reads her short-term memory for the channel, checks whether the author has an
 * open violation (which flips her tone), asks the model, which may call tools
 * along the way, and remembers the exchange. Discord I/O stays in the gateway
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
 * @returns {Promise<{ text: string, gifUrl: string | null } | null>} What to post,
 *   or null when generation failed.
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
        replyLength: reply.text.length,
        // Metadata: whether one was attached, never which.
        gif: Boolean(reply.gifUrl),
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
 * The GIF as Discord message embeds, which is how it reaches a channel without
 * a URL in the text: a link in the body is rendered as a link *and* unfurled
 * underneath, so the address ends up in the middle of her sentence. An embed
 * carrying only an image shows the GIF and nothing else.
 *
 * Shared by both posting paths (chat and `/mai ask`), which build their
 * messages in completely different shapes otherwise.
 *
 * @param {string | null | undefined} gifUrl
 * @returns {object[]} Zero or one embed, ready for either API.
 */
export function gifEmbeds(gifUrl) {
  if (!gifUrl) return [];

  // Every GIF she posts came from the search, so the provider's mark belongs
  // under every one of them: their terms ask for a visible attribution.
  return [{ image: { url: gifUrl }, footer: { text: content.chat.gifAttribution } }];
}

/**
 * Stores the exchange as Mai's memory. Only what the member actually wrote is
 * kept: the quoted reply context and the images are prompt-time context, not
 * theirs to persist.
 *
 * @param {{ channelId: string, guildId: string | null, userId: string, username: string,
 *   content: string, images?: string[] }} input
 * @param {{ text: string, gifUrl?: string | null }} reply
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

  // A GIF is not stored either: the URL is a fact about a file somewhere, and
  // in a week it may be a 404. What she keeps is that she sent one, the same
  // way an image someone sent her is remembered as a placeholder.
  const assistantContent = reply.text.trim()
    || (reply.gifUrl ? content.chat.prompt.gifPlaceholder : '');

  if (assistantContent) {
    turns.push({
      channelId: input.channelId,
      guildId: input.guildId,
      userId: null,
      username: content.chat.prompt.assistantLabel,
      role: 'assistant',
      content: assistantContent,
    });
  }

  try {
    appendTurns(turns);
  } catch (error) {
    // Memory loss is survivable; the reply was already delivered.
    logger.error({ channelId: input.channelId, err: error }, 'Storing chat history failed');
  }
}
