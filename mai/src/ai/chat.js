/**
 * Prompt assembly and output normalization for Mai's replies.
 *
 * All wording comes from the content config; this module only decides structure.
 */
import { config } from '../config.js';
import { content, fill } from '../content.js';
import { createChatCompletion } from './openai.js';

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/**
 * Renders stored turns as `Speaker: text` lines, oldest first.
 *
 * @param {{ role: string, username: string, content: string }[]} turns
 * @returns {string}
 */
const renderHistory = (turns) =>
  turns
    .filter((turn) => turn.content?.trim())
    .map((turn) => {
      const speaker = turn.role === 'assistant'
        ? content.chat.prompt.assistantLabel
        : turn.username?.trim() || content.chat.prompt.unknownUserLabel;
      return `${speaker}: ${turn.content}`;
    })
    .join('\n');

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
 * @param {{ history: { role: string, username: string, content: string }[],
 *   username: string, content: string,
 *   violations: { count: number, categories: string[] } }} input
 * @returns {{ system: string, user: string }}
 */
export function buildPrompt({ history, username, content: text, violations }) {
  const directive = violations.count > 0
    ? moderationDirective(violations)
    : content.chat.friendlyDirective;

  const message = String(text ?? '').trim();
  const speaker = username?.trim() || content.chat.prompt.unknownUserLabel;
  const currentTurn = `${speaker}: ${message || content.chat.prompt.emptyMessagePlaceholder}`;
  const historyText = renderHistory(history);

  const user = historyText
    ? [
        content.chat.prompt.historyHeader,
        historyText,
        '',
        content.chat.prompt.newMessageHeader,
        currentTurn,
      ].join('\n')
    : currentTurn;

  return { system: `${content.chat.persona}\n\n${directive}`, user };
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
  // Built from its code point so the character cannot be lost in an edit.
  return reply.replace(/@(everyone|here)/g, `@${ZERO_WIDTH_SPACE}$1`);
}

/**
 * @param {{ system: string, user: string }} prompt
 * @returns {Promise<string>} Normalized reply, ready to post.
 */
export async function generateReply(prompt) {
  const { text } = await createChatCompletion(prompt);
  return normalizeReply(text);
}
