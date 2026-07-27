/**
 * Classifying text Mai is about to **say**, rather than text a member posted.
 *
 * The message pipeline (`check.js`) judges what members write and can always
 * fall back on deleting it. Nothing here can: once Mai has posted, the text
 * carries her name. So both screens run before she speaks — with deliberately
 * different failure modes:
 *
 *   - `screenInput` guards text a member handed her to repeat verbatim
 *     (`/mai ask` echoes the question back into the channel). Fails **closed**:
 *     without a verdict there is no evidence the text is safe, and unlike a
 *     posted message there is no deletion path to clean up afterwards. Refusing
 *     costs a member one command; failing open costs the guild a megaphone.
 *   - `screenReply` guards what the model produced. Fails **open**: the threat
 *     is a prompt-injected model rather than attacker text passed through
 *     unchanged, and a classifier outage should not silence Mai completely.
 */
import { classify } from '../ai/moderation.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const CLEAN = Object.freeze({ ok: true, categories: [] });

/**
 * @param {string} text
 * @param {{ guildId?: string | null }} [context]
 * @returns {Promise<{ ok: boolean, categories: string[] }>}
 */
export async function screenInput(text, { guildId } = {}) {
  if (!config.moderation.enabled) return CLEAN;
  if (!String(text ?? '').trim()) return CLEAN;

  try {
    const verdict = await classify(text, [], { guildId });
    if (!verdict.flagged) return CLEAN;

    logger.info(
      { guildId, categories: verdict.categories },
      'Refusing to repeat a flagged question',
    );
    return { ok: false, categories: verdict.categories };
  } catch (error) {
    // Deliberately not the fail-open rule the message pipeline follows: Mai
    // would be republishing this text herself.
    logger.error(
      { guildId, err: error },
      'Could not classify a question, refusing to repeat it',
    );
    return { ok: false, categories: [] };
  }
}

/**
 * @param {string} reply
 * @param {{ guildId?: string | null }} [context]
 * @returns {Promise<{ ok: boolean, categories: string[] }>}
 */
export async function screenReply(reply, { guildId } = {}) {
  if (!config.chat.screenReplies) return CLEAN;
  if (!config.moderation.enabled) return CLEAN;
  if (!String(reply ?? '').trim()) return CLEAN;

  try {
    const verdict = await classify(reply, [], { guildId });
    if (!verdict.flagged) return CLEAN;

    // Mai is the one account nothing else moderates, so this is the only place
    // a prompt-injected reply gets caught.
    logger.warn(
      { guildId, categories: verdict.categories },
      'Blocked a flagged reply before posting it',
    );
    return { ok: false, categories: verdict.categories };
  } catch (error) {
    logger.warn({ guildId, err: error }, 'Could not screen a reply, posting it anyway');
    return CLEAN;
  }
}
