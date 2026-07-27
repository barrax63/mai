/**
 * Describing an error for somewhere permanent and readable by people who are
 * not the operator.
 *
 * Two places need this: the alert channel and the per-guild moderation log.
 * Both are Discord channels, which means permanent storage anyone with access
 * can scroll back through, so the same rule applies to both.
 *
 * **Never `error.message`.** A message is free text with no contract: a config
 * parse error quotes the config, a database error can quote a value, an HTTP
 * client can quote the request body. The name plus the machine-readable codes
 * is what is actually actionable anyway, and the full message stays in the
 * container log, which is where an operator debugging this already is.
 */

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
