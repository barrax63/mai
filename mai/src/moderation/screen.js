/**
 * Classifying text a member handed Mai to **repeat**.
 *
 * `/mai ask` quotes the question back into the channel, which makes that command
 * the one path where a member's words get published by the bot without the
 * message pipeline ever seeing them. So the question is classified first.
 *
 * Fails **closed**, unlike `check.js`. A posted message that slips through can
 * still be deleted afterwards; text Mai has already repeated under her own name
 * cannot be taken back the same way, and there is no queue row for it. Refusing
 * costs a member one command.
 *
 * There is deliberately **no outbound screen on Mai's own replies.** Her persona
 * escalates with a member's open violations and at the top of that ladder she is
 * instructed to insult them outright ("Beleidigungen erwünscht" in
 * `chat.flagged.tones`). A classifier scores exactly that as harassment: the
 * tones measured 0.89–0.98, so screening her output would replace the angry cat
 * with a canned line almost every time she is supposed to be angry. The
 * behaviour is the feature, and the guard against a prompt-injected model is the
 * prompt itself: see `fenced()` and `prompt.untrustedNotice` in `ai/chat.js`.
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
