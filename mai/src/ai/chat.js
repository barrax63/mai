/**
 * Prompt assembly, the tool loop, and output normalization for Mai's replies.
 *
 * The conversation is a real `messages[]` array: one entry per turn with its
 * own role, rather than a rendered transcript inside a single user message.
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

/** Quoted context is trimmed, it is background, not the message being answered. */
const QUOTE_MAX_CHARS = 300;

/**
 * Delimiters around text Mai did not receive from the person she is answering:
 * a quoted message someone else wrote, a thread title anyone can set. The
 * current speaker chooses *which* of those ends up in the prompt, which is what
 * makes them an injection vector: "reply to this message containing
 * instructions" costs nothing to set up.
 *
 * The fence characters are stripped from the value before it is wrapped, so the
 * text cannot close its own fence, and the persona is told (via
 * `prompt.untrustedNotice`) that anything inside is quoted material rather than
 * something to obey.
 */
const FENCE_OPEN = '⟪';
const FENCE_CLOSE = '⟫';

/** Kept out of a `Name:` prefix so a username cannot forge a second speaker. */
const SPEAKER_UNSAFE = /[\r\n:]+/g;

const speaker = (username) =>
  String(username ?? '').replace(SPEAKER_UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  || content.chat.prompt.unknownUserLabel;

const truncate = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

/**
 * @param {string} text
 * @returns {string} `text` wrapped in fences it cannot break out of.
 */
const fenced = (text) =>
  `${FENCE_OPEN}${String(text ?? '').replaceAll(FENCE_OPEN, '').replaceAll(FENCE_CLOSE, '')}${FENCE_CLOSE}`;

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

  // Both of these are other people's text, pulled in by whoever is speaking:
  // fenced so an instruction inside them reads as quoted material.
  if (turn.threadTitle) {
    lines.push(
      fill(content.chat.prompt.threadContext, { title: fenced(truncate(turn.threadTitle, 100)) }),
    );
  }

  if (turn.replyTo) {
    lines.push(
      fill(content.chat.prompt.replyContext, {
        username: speaker(turn.replyTo.username),
        content: fenced(
          truncate(turn.replyTo.content, QUOTE_MAX_CHARS) || content.chat.prompt.imagePlaceholder,
        ),
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

  // The notice goes in the system message, the only turn Mai should treat as
  // instructions: everything below it is text members wrote.
  const messages = [
    {
      role: 'system',
      content: `${content.chat.persona}\n\n${directive}\n\n${content.chat.prompt.untrustedNotice}`,
    },
  ];

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
 * A custom emote as Discord parses it: `<:name:id>`, `<a:name:id>` animated.
 * Used with `.replace()`, which starts at 0 and resets `lastIndex` itself, so
 * the `g` flag is not the stateful trap it is for the `.test()` patterns in
 * content.js.
 */
const CUSTOM_EMOTE = /<(a?):(\w{2,32}):(\d{15,25})>/g;

/**
 * Drops custom-emote codes whose id does not exist where the reply is going.
 *
 * `get_server_emotes` is what stops the model inventing these, but a model that
 * saw one in the channel history (or simply made a plausible id up) can still
 * emit one, and Discord does not fail loudly: an id it cannot resolve is posted
 * as the literal text `<:catjam:123>` in the middle of her sentence.
 *
 * The set to check against is the set she can actually render: in a guild, that
 * guild's own emotes, since using another server's needs Use External Emojis in
 * the channel; in a DM, every emote the bot can reach. No client (before the
 * gateway is ready, or `/mai ask` answering early) means nothing is verifiable,
 * and an unverifiable code is dropped rather than posted broken.
 *
 * @param {string} raw
 * @param {{ guildId?: string | null, client?: object }} [context]
 * @returns {string}
 */
export function pruneInventedEmotes(raw, context) {
  const text = String(raw ?? '');
  if (!text.includes('<')) return text;

  const known = context?.guildId
    ? context.client?.guilds?.cache?.get(context.guildId)?.emojis?.cache
    : context?.client?.emojis?.cache;

  let dropped = 0;
  const pruned = text.replace(CUSTOM_EMOTE, (match, animated, name, id) => {
    if (known?.has?.(id)) return match;
    dropped += 1;
    return '';
  });

  if (dropped === 0) return text;

  logger.debug({ dropped, guildId: context?.guildId ?? null }, 'Dropped unknown emote codes');
  // Removing one leaves the spaces that surrounded it: a double space
  // mid-sentence, a dangling one at the end of the line. Horizontal whitespace
  // only, or the cleanup would eat her line breaks along with it.
  return pruned
    .replace(/[^\S\r\n]{2,}/g, ' ')
    .replace(/[^\S\r\n]+(?=\r?\n|$)/g, '');
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
 * A tool result travels back to the provider as a JSON string. Serializing it
 * sits outside `runTool`'s own error handling, so a result that cannot be
 * stringified (anything cyclic, a BigInt) would throw here and take the entire
 * reply down with it rather than costing one tool call. The model gets an
 * error payload instead and answers without that tool.
 *
 * @param {{ id: string, function?: { name?: string } }} call
 * @param {{ userId: string, guildId: string | null, client?: object }} context
 * @returns {string}
 */
function toolPayload(call, context) {
  try {
    return JSON.stringify(runTool(call, context));
  } catch (error) {
    logger.error(
      { tool: call?.function?.name, err: error },
      'Tool result could not be serialized',
    );
    return JSON.stringify({ error: 'tool_failed' });
  }
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
    // Pruned before the length cap, so the cap applies to what is posted.
    if (calls.length === 0) return normalizeReply(pruneInventedEmotes(message?.content, context));

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
        content: toolPayload(call, context),
      });
    }
  }

  // Cap reached and still no prose: give up rather than loop.
  logger.warn({ rounds: MAX_TOOL_ROUNDS }, 'Model kept asking for tools, answering without');
  return normalizeReply('');
}
