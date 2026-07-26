/**
 * Content classification: is this message a policy violation?
 *
 * The moderation endpoint returns a `categories` object of booleans; only the
 * flagged names are kept. Category slugs are metadata, never message content,
 * so they may be logged and stored.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createModeration } from './openai.js';

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp)$/i;

/**
 * @param {string} text
 * @param {{ url: string, contentType?: string | null }[]} [attachments]
 * @returns {Promise<{ flagged: boolean, categories: string[] }>}
 * @throws {import('./openai.js').OpenAiError} Callers decide how to fail.
 */
export async function classify(text, attachments = []) {
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

  const result = await createModeration(input);
  const categories = Object.entries(result.categories)
    .filter(([, isFlagged]) => isFlagged === true)
    .map(([category]) => category);

  logger.debug(
    { flagged: result.flagged, categories, images: images.length },
    'Classification result',
  );

  return { flagged: result.flagged || categories.length > 0, categories };
}
