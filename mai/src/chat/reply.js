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
import { content, pick } from '../content.js';
import { appendTurns, recentTurns } from '../db/history.js';
import { openViolations } from '../db/queue.js';
import { logger } from '../logger.js';
import { takeGrudgeRelease } from './grudges.js';
import { territoryFor } from './territory.js';

/**
 * @param {{ messageId: string, channelId: string, parentId?: string | null,
 *   guildId: string | null, userId: string, username: string, content: string,
 *   replyTo?: object | null, threadTitle?: string | null, images?: string[],
 *   client?: object }} input
 * @returns {Promise<{ text: string, gifUrl: string | null, memory?: string } | null>}
 *   What to post, or null when generation failed. `memory`, when present, is
 *   what to remember of it instead of `text`.
 */
export async function generateChatReply(input) {
  const history = recentTurns(input.channelId, config.chat.historyTurns);
  // Any guild: Mai is one persona, so a strike anywhere makes her mad at that
  // user everywhere, DMs included. Categories are slugs, never content.
  const violations = openViolations(input.userId);
  // Their last strike in this server has aged out, so she says once that she is
  // over it. Never while she is hissing at them about something open, and
  // decided here rather than by the model: the model is never told, so it
  // cannot say what it was about (see chat/grudges.js).
  const lettingGo = violations.count === 0 && takeGrudgeRelease(input.guildId, input.userId);

  const messages = buildMessages({
    history,
    username: input.username,
    content: input.content,
    violations,
    replyTo: input.replyTo,
    threadTitle: input.threadTitle,
    images: input.images ?? [],
    // Only so the prompt knows whether her nose is working here: a DM has no
    // guild and is therefore never under the weather.
    guildId: input.guildId,
    // The channel she has claimed in this server, and whether this is it.
    territory: territoryFor(input.client, input.guildId, {
      channelId: input.channelId,
      parentId: input.parentId,
    }),
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
        lettingGo,
      },
      'Generated chat reply',
    );
    // Ahead of her answer, on a line of its own, and stored with it, so the
    // next turn knows she has already said it.
    if (lettingGo) {
      return { ...reply, text: [pick(content.chat.letGo), reply.text].filter(Boolean).join('\n') };
    }

    return walkAcrossTheKeyboard(input, reply);
  } catch (error) {
    logger.error({ messageId: input.messageId, err: error }, 'Chat generation failed');
    return null;
  }
}

/**
 * Now and then she walks across the keyboard on her way to answering: a line
 * of key smash, then the reply she was going to give anyway.
 *
 * Three limits, and each is what keeps it funny rather than broken:
 *
 * - **Never instead of the reply.** Only in front of a reply that has text, so
 *   a GIF sent without words is not turned into a smash and a GIF.
 * - **Chat only.** This is the one place it happens: not `/mai ask`, which
 *   quotes a question back and has no room for a stray line, and never a
 *   scold, a warning DM or a log entry, none of which go through here.
 * - **Never on top of the let-go line**, which the caller has already decided
 *   by the time this is asked: that is a moment, and a smash in front of it
 *   would trample it. It also keeps the sum in budget, since both prefixes
 *   are capped to fit in front of a reply at the length cap, but not together.
 *
 * Not remembered: her memory keeps the reply without the smash, or the model
 * would read a history of assistant turns opening with "asdfghjkl" and start
 * writing them itself.
 *
 * @param {{ messageId: string, guildId: string | null }} input
 * @param {{ text: string, gifUrl: string | null }} reply
 * @returns {{ text: string, gifUrl: string | null, memory?: string }}
 */
export function walkAcrossTheKeyboard(input, reply) {
  const { chance, smashes } = content.chat.keyboard;
  if (!reply.text || Math.random() >= chance) return reply;

  logger.info(
    { messageId: input.messageId, guildId: input.guildId },
    'Mai walked across the keyboard',
  );
  return { ...reply, text: `${pick(smashes)}\n${reply.text}`, memory: reply.text };
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
 * @param {{ text: string, gifUrl?: string | null, memory?: string }} reply `memory`
 *   replaces `text` where what was posted is not what she should remember
 *   saying (a walk across the keyboard).
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
  const assistantContent = (reply.memory ?? reply.text).trim()
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
