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
 * Failing closed is also why the guild's threshold is applied *beside* the
 * provider's verdict rather than in place of it: everywhere else a guild's line
 * replaces the provider's, but here it may only make the guard stricter, never
 * looser. See the comment on the check itself.
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
import { effectiveSettings } from '../db/settings.js';
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
    const { threshold } = effectiveSettings(guildId);
    const verdict = await classify(text, [], { guildId });

    // The provider's line *and* the guild's, whichever is stricter. Passing the
    // guild's policy into `classify` instead would be the naive fix and wrong in
    // one direction: a `threshold` above 0 replaces `flagged` entirely, so a
    // server that raised its threshold above the provider's line, or narrowed
    // `categories` to an allowlist, would be loosening the one guard in the
    // system that fails closed. Taking the stricter of the two can only tighten.
    //
    // It matters because `applyPolicy` exists for a measured reason:
    // omni-moderation scores the same insult 0.88 in English and 0.20 in German,
    // so a German server that lowered its threshold to 0.2 has told Mai where
    // its line is, and this was the one path ignoring it. One API call and no
    // new score exposure: the top score is already returned to this caller.
    const overThreshold = threshold > 0 && verdict.topScore >= threshold;
    if (!verdict.flagged && !overThreshold) return CLEAN;

    // A verdict reached on the threshold alone has no flagged categories to
    // name, so the top one stands in: the caller renders these for the member.
    const categories = verdict.categories.length > 0
      ? verdict.categories
      : [verdict.topCategory].filter(Boolean);

    logger.info(
      { guildId, categories, byThreshold: !verdict.flagged },
      'Refusing to repeat a flagged question',
    );
    return { ok: false, categories };
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
