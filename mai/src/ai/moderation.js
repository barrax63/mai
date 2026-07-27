/**
 * Content classification: is this message a policy violation?
 *
 * The endpoint answers twice over: a `categories` map of booleans and a
 * `category_scores` map of numbers, and which of the two decides is a per-guild
 * choice (`policy`). Category slugs are metadata, never message content, so they
 * may be logged and stored; scores are metadata too but are only ever logged at
 * debug, because a score is a fact about the text.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createModeration } from './openai.js';

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp)$/i;

/**
 * Turns a raw provider verdict into the categories that count *here*.
 *
 * Two knobs, both per guild:
 *
 *   - `threshold` above 0 replaces the provider's own `flagged` boolean with
 *     "any category scoring at least this much". That boolean is tuned for
 *     English: the same insult measures 0.88 in English and 0.20 in German
 *     against omni-moderation-latest, so a server that is not English-speaking
 *     needs to be able to draw its own line.
 *   - `categories`, when non-empty, is an allowlist: everything outside it is
 *     ignored, so a server can drop a category without switching moderation off.
 *
 * @param {{ flagged: boolean, categories: Record<string, boolean>, scores: Record<string, number> }} verdict
 * @param {{ threshold?: number, categories?: string[] }} [policy]
 * @returns {{ flagged: boolean, categories: string[] }}
 */
export function applyPolicy(verdict, policy = {}) {
  const threshold = policy.threshold ?? 0;
  const allowed = policy.categories ?? [];

  let hits = threshold > 0
    ? Object.entries(verdict.scores ?? {})
        .filter(([, score]) => Number(score) >= threshold)
        .map(([category]) => category)
    : Object.entries(verdict.categories ?? {})
        .filter(([, isFlagged]) => isFlagged === true)
        .map(([category]) => category);

  if (allowed.length > 0) {
    const wanted = new Set(allowed);
    hits = hits.filter((category) => wanted.has(category));
  }

  // With a threshold the guild has taken the decision over from the provider,
  // so its `flagged` no longer gets a vote, otherwise raising the threshold
  // could never make anything pass.
  const flagged = threshold > 0
    ? hits.length > 0
    : hits.length > 0 || (verdict.flagged && allowed.length === 0);

  return { flagged, categories: hits };
}

/**
 * @param {string} text
 * @param {{ url: string, contentType?: string | null }[]} [attachments]
 * @param {{ guildId?: string | null, policy?: { threshold?: number, categories?: string[] } }} [options]
 *   `guildId` is for accounting; `policy` is the guild's own thresholds.
 * @returns {Promise<{ flagged: boolean, categories: string[] }>}
 * @throws {import('./openai.js').OpenAiError} Callers decide how to fail.
 */
export async function classify(text, attachments = [], { guildId, policy } = {}) {
  const trimmed = String(text ?? '').trim();
  const images = config.moderation.classifyImages
    ? attachments.filter((attachment) => IMAGE_TYPES.test(attachment.contentType ?? ''))
    : [];

  if (!trimmed && images.length === 0) {
    return { flagged: false, categories: [] };
  }

  // Multimodal input is an array of content parts; plain text stays a string so
  // providers without multimodal support keep working.
  const input = images.length > 0
    ? [
        ...(trimmed ? [{ type: 'text', text: trimmed }] : []),
        ...images.map((attachment) => ({ type: 'image_url', image_url: { url: attachment.url } })),
      ]
    : trimmed;

  const result = await createModeration(input, { guildId });
  const decided = applyPolicy(result, policy);

  logger.debug(
    {
      providerFlagged: result.flagged,
      flagged: decided.flagged,
      categories: decided.categories,
      threshold: policy?.threshold ?? 0,
      images: images.length,
      // Only the highest score: enough to tune a threshold against, without
      // turning the log into a profile of the message.
      topScore: Math.max(0, ...Object.values(result.scores ?? {}).map(Number)),
    },
    'Classification result',
  );

  return decided;
}
