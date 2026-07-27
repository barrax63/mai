/**
 * Describing an error for somewhere permanent and readable by people who are
 * not the operator: the alert channel and the per-guild moderation log. Both
 * are Discord channels, which means storage anyone with access can scroll back
 * through, so the same rule applies to both.
 *
 * **Never `error.message`.** A message is free text with no contract: a config
 * parse error quotes the config, a database error can quote a value, an HTTP
 * client can quote the request body. The full message stays in the container
 * log, which is where an operator debugging this already is.
 *
 * Two audiences, so two functions. `describeError` is for the operator, who
 * wants the error identified. `explainError` is for a guild's staff, who want
 * to know what to *do*, and to whom `DiscordAPIError code=50013` says nothing:
 * it maps the codes that actually occur onto sentences in the content config,
 * and falls back to `describeError` for anything unmapped.
 */
import { content, fill } from './content.js';

/** Codes are short by nature; this only guards against an absurd one. */
const MAX_CODE_CHARS = 60;

const short = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_CODE_CHARS ? `${text.slice(0, MAX_CODE_CHARS - 1)}…` : text;
};

/**
 * @param {unknown} error
 * @returns {string} e.g. `DiscordAPIError code=50013`, or `OpenAiError status=429 code=http_error`.
 */
export function describeError(error) {
  // A thrown non-object (or null) has no name to report, and its string form is
  // free text just like a message.
  if (!error || typeof error !== 'object') return 'Error';

  const name = error.name ?? error.constructor?.name ?? 'Error';
  const codes = [
    error.status !== undefined && error.status !== null && `status=${short(error.status)}`,
    error.code !== undefined && error.code !== null && `code=${short(error.code)}`,
  ].filter(Boolean);

  return [short(name) || 'Error', ...codes].join(' ');
}

/**
 * The same failure, for the staff of the guild it happened in.
 *
 * A moderator reading the log channel needs "Mai lacks the permission", not
 * `code=50013`. The code still rides along, because it is the thing they hand
 * to whoever runs the bot. Anything not in the map degrades to `describeError`,
 * so an unmapped code is still safe, just less helpful.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function explainError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === undefined || code === null) return describeError(error);

  const known = content.moderation.errors[String(code)];
  if (!known) return describeError(error);

  return fill(content.moderation.errorLine, { reason: known, code: short(code) });
}
