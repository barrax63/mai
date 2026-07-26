/**
 * Prompt assembly, the tool loop, and output normalization for Mai's replies.
 *
 * The conversation is a real `messages[]` array — one entry per turn with its
 * own role — rather than a rendered transcript inside a single user message.
 * User turns keep a `Name:` prefix because a Discord channel has many speakers
 * and the model needs to tell them apart.
 *
 * All wording comes from the content config; this module only decides structure.
 */
import { config } from '../config.js';
import { content, fill } from '../content.js';
import { runTool, toolDefinitions } from '../chat/tools.js';
import { logger } from '../logger.js';
import { createChatCompletion } from './openai.js';

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/**
 * How often the model may ask for tools before it has to answer. Two rounds is
 * enough for "look something up, then maybe look up one more thing"; the cap
 * exists so a confused model cannot bill an infinite loop.
 */
const MAX_TOOL_ROUNDS = 2;

/** Quoted context is trimmed — it is background, not the message being answered. */
const QUOTE_MAX_CHARS = 300;

const speaker = (username) => username?.trim() || content.chat.prompt.unknownUserLabel;

const truncate = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

/**
 * The moderation directive appended to the persona. Tone escalates with the
 * number of open (un-enforced) violations; the last configured tone covers
 * everything above the list length.
 *
 * @param {{ count: number, categories: string[] }} violations
 * @returns {string}
 */
function moderationDirective(violations) {
  const { flagged } = content.chat;
  const tone = flagged.tones[Math.min(violations.count, flagged.tones.length) - 1];
  const categories = violations.categories.length
    ? violations.categories.join(', ')
    : flagged.unknownCategory;

  return [
    fill(flagged.header, { count: violations.count, categories }),
    tone,
    flagged.footer,
  ].join(' ');
}

/**
 * The text of the turn Mai is answering, including the bits of context Discord
 * shows a human but does not put in `message.content`: what the message replies
 * to, and which thread it is in.
 *
 * @param {{ username: string, content: string, replyTo?: { username: string, content: string } | null,
 *   threadTitle?: string | null, hasImages?: boolean }} turn
 * @returns {string}
 */
function renderCurrentTurn(turn) {
  const lines = [];

  if (turn.threadTitle) {
    lines.push(fill(content.chat.prompt.threadContext, { title: truncate(turn.threadTitle, 100) }));
  }

  if (turn.replyTo) {
    lines.push(
      fill(content.chat.prompt.replyContext, {
        username: speaker(turn.replyTo.username),
        content: truncate(turn.replyTo.content, QUOTE_MAX_CHARS) || content.chat.prompt.imagePlaceholder,
      }),
    );
  }

  const text = String(turn.content ?? '').trim();
  const fallback = turn.hasImages
    ? content.chat.prompt.imagePlaceholder
    : content.chat.prompt.emptyMessagePlaceholder;

  lines.push(`${speaker(turn.username)}: ${text || fallback}`);
  return lines.join('\n');
}

/**
 * @param {{ history: { role: string, username: string, content: string }[],
 *   username: string, content: string,
 *   violations: { count: number, categories: string[] },
 *   replyTo?: { username: string, content: string } | null,
 *   threadTitle?: string | null,
 *   images?: string[] }} input
 * @returns {object[]} Chat-completions messages, system first.
 */
export function buildMessages({
  history = [],
  username,
  content: text,
  violations,
  replyTo = null,
  threadTitle = null,
  images = [],
}) {
  const directive = violations.count > 0
    ? moderationDirective(violations)
    : content.chat.friendlyDirective;

  const messages = [{ role: 'system', content: `${content.chat.persona}\n\n${directive}` }];

  for (const turn of history) {
    const value = String(turn.content ?? '').trim();
    if (!value) continue;
    messages.push(
      turn.role === 'assistant'
        ? { role: 'assistant', content: value }
        : { role: 'user', content: `${speaker(turn.username)}: ${value}` },
    );
  }

  const current = renderCurrentTurn({
    username,
    content: text,
    replyTo,
    threadTitle,
    hasImages: images.length > 0,
  });

  messages.push({
    role: 'user',
    // Vision: a content array mixes the text with the images she can see.
    content: images.length
      ? [
          { type: 'text', text: current },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ]
      : current,
  });

  return messages;
}

/**
 * Trims, length-caps and de-pings a model reply.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeReply(raw) {
  let reply = String(raw ?? '').trim();
  if (!reply) reply = content.chat.fallbackReply;

  const limit = config.chat.maxReplyChars;
  if (reply.length > limit) {
    reply = `${reply.slice(0, limit - 2).trimEnd()} …`;
  }

  // Defense in depth: the bot also posts with allowedMentions.parse = [].
  // A zero-width space breaks the mention without changing how it looks.
  return reply.replace(/@(everyone|here)/g, `@${ZERO_WIDTH_SPACE}$1`);
}

/**
 * Runs the completion, serving any tool calls the model makes along the way.
 *
 * @param {object[]} messages From `buildMessages`.
 * @param {{ userId: string, guildId: string | null, client?: object }} context
 *   Passed to the tools; the model never supplies these.
 * @returns {Promise<string>} Normalized reply, ready to post.
 */
export async function generateReply(messages, context) {
  const conversation = [...messages];
  const useTools = config.chat.toolsEnabled && Boolean(context?.userId);

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // The final round drops the tools, so the model has to answer in words.
    const tools = useTools && round < MAX_TOOL_ROUNDS ? toolDefinitions : undefined;
    const { message } = await createChatCompletion({
      messages: conversation,
      tools,
      guildId: context?.guildId,
    });

    const calls = message?.tool_calls ?? [];
    if (calls.length === 0) return normalizeReply(message?.content);

    logger.info(
      { round, tools: calls.map((call) => call.function?.name) },
      'Model requested tools',
    );

    // The assistant message carrying the calls has to go back verbatim, or the
    // tool results have nothing to attach to.
    conversation.push(message);
    for (const call of calls) {
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(runTool(call, context)),
      });
    }
  }

  // Cap reached and still no prose: give up rather than loop.
  logger.warn({ rounds: MAX_TOOL_ROUNDS }, 'Model kept asking for tools, answering without');
  return normalizeReply('');
}
