/**
 * The rules Mai enforces herself, before any classifier is asked.
 *
 * A moderation endpoint scores what a message *means*, and none of these are
 * about meaning: an advertisement is a perfectly polite invite link, a raid is
 * twenty harmless lines in five seconds, a mass ping is one word plus fifty
 * mentions. All four were invisible to the pipeline until here.
 *
 * Three properties make them worth having as their own layer:
 *   - they cost nothing (no API call, no tokens), so they run *first* and a
 *     message they trip on is never sent to the provider at all;
 *   - they keep working while the provider is down, which is exactly when a
 *     raid is cheapest to run;
 *   - they are a server's own house rules rather than a safety floor, so every
 *     one of them is off by default and turned on per guild.
 *
 * What they produce is an ordinary list of category slugs, so a trip goes
 * through the same `flagMessage` path as a classified violation: warning
 * reaction, scold reply, grace period, queue row, log entry, strike. There is
 * deliberately no separate "instant delete" route: one pipeline, one set of
 * rules about what happens to a member, and a false positive is undoable in
 * exactly the same way.
 *
 * Pure except for the flood window, which is the one rule that is about a
 * sequence of messages rather than a single one.
 */
import { logger } from '../logger.js';

/** Category slugs these rules report. Shaped like the provider's own. */
export const CATEGORY_INVITE = 'invite';
export const CATEGORY_LINK = 'link';
export const CATEGORY_MENTIONS = 'mentions';
export const CATEGORY_FLOOD = 'flood';

/**
 * Invite links, with or without a scheme: Discord renders `discord.gg/abc` as a
 * link whether or not anyone typed `https://`.
 *
 * No `g` flag: this is used with `.test()`, and `g` would carry `lastIndex`
 * between calls, so the same message would match, then not, then match again
 * (the same trap the reaction triggers document in content.js).
 */
const INVITE = /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg|invite\.gg)\/[\w-]+/i;

/**
 * URLs, for the link policy. `g` is required by `matchAll`, which is safe: it
 * works on an internal clone and never advances this object's `lastIndex`.
 */
const URLS = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi;

/** User and role mentions. Channel links (`<#id>`) ping nobody and do not count. */
const MENTIONS = /<@[!&]?\d+>/g;
const MASS_MENTIONS = /@(?:everyone|here)\b/g;

/**
 * @param {string} url
 * @returns {string | null} Lower-case host without `www.`, or null when the
 *   URL does not parse (a bare `https://` in a sentence, for instance).
 */
function hostOf(url) {
  try {
    // Trailing punctuation is part of the sentence, not of the URL.
    const host = new URL(url.replace(/[.,;:!?)]+$/, '')).hostname.toLowerCase();
    return host.replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} host
 * @param {string[]} domains
 * @returns {boolean} Whether the host is the domain itself or below it, so
 *   allowing `example.com` also allows `cdn.example.com`.
 */
const hostAllowed = (host, domains) =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * The rules that judge one message on its own.
 *
 * @param {string} text Raw message content (mention markup included: `<@123>`
 *   is what a mention looks like before Discord renders it).
 * @param {ReturnType<typeof import('../db/settings.js').effectiveSettings>} settings
 * @returns {string[]} Category slugs, empty when nothing tripped.
 */
export function contentViolations(text, settings) {
  const content = String(text ?? '');
  if (!content) return [];

  const categories = [];

  if (settings.inviteFilter && INVITE.test(content)) categories.push(CATEGORY_INVITE);

  if (settings.linkPolicy === 'allowlist') {
    const hosts = [...content.matchAll(URLS)].map((match) => hostOf(match[0])).filter(Boolean);
    // An invite link is already covered by its own rule; reporting both would
    // put two slugs on one message for a single thing the member did.
    const offending = hosts.filter((host) => !hostAllowed(host, settings.linkDomains));
    if (offending.length > 0 && !categories.includes(CATEGORY_INVITE)) {
      categories.push(CATEGORY_LINK);
    }
  }

  if (settings.mentionCap > 0) {
    const count =
      [...content.matchAll(MENTIONS)].length + [...content.matchAll(MASS_MENTIONS)].length;
    if (count > settings.mentionCap) categories.push(CATEGORY_MENTIONS);
  }

  return categories;
}

/**
 * Recent message timestamps per member, for the flood rule.
 *
 * In memory on purpose: a burst is a question about the last few seconds, and a
 * restart forgiving everyone is the right trade for a window this short. The
 * key is guild *and* user, like every other per-member decision Mai makes.
 *
 * @type {Map<string, { stamps: number[], cooldownUntil: number }>}
 */
const windows = new Map();

/** Above this many tracked members, drop the ones whose window has passed. */
const SWEEP_AT_SIZE = 1000;

/**
 * Counts this message and reports whether it broke the guild's flood rule.
 *
 * **One trip per burst, not one per message.** Flagging every message of a
 * flood would mean a scold reply per message (Mai out-spamming the spammer),
 * a queue row per message and a strike per message for what is one incident.
 * So a trip starts a cooldown of one window, during which the member's messages
 * are still counted but cannot trip again.
 *
 * Only called for messages that are moderated at all, so a burst in an exempt
 * channel does not count: an exemption is a statement about scope, and "Mai
 * does not moderate here" has to include her rate rules.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {ReturnType<typeof import('../db/settings.js').effectiveSettings>} settings
 * @param {number} [now] Injectable for tests.
 * @returns {boolean}
 */
export function floodViolation(guildId, userId, settings, now = Date.now()) {
  const rule = settings.floodRule;
  if (!rule) return false;

  const windowMs = rule.seconds * 1000;
  const key = `${guildId}:${userId}`;

  if (windows.size > SWEEP_AT_SIZE) {
    for (const [existing, entry] of windows) {
      const idle = entry.stamps.every((stamp) => stamp <= now - windowMs);
      if (idle && entry.cooldownUntil <= now) windows.delete(existing);
    }
  }

  const entry = windows.get(key) ?? { stamps: [], cooldownUntil: 0 };
  const stamps = entry.stamps.filter((stamp) => stamp > now - windowMs);
  stamps.push(now);

  if (now < entry.cooldownUntil) {
    windows.set(key, { stamps, cooldownUntil: entry.cooldownUntil });
    return false;
  }

  if (stamps.length > rule.messages) {
    // Counting starts over: the messages that made up this burst have been
    // answered for, and keeping them would trip again on the first message
    // after the cooldown.
    windows.set(key, { stamps: [], cooldownUntil: now + windowMs });
    logger.info(
      { guildId, userId, messages: stamps.length, seconds: rule.seconds },
      'Flood rule tripped',
    );
    return true;
  }

  windows.set(key, { stamps, cooldownUntil: entry.cooldownUntil });
  return false;
}

/** Drops every tracked window. For tests, and for nothing else. */
export function resetFloodWindows() {
  windows.clear();
}

/**
 * Everything above, for one message.
 *
 * Never throws: these are the guild's own rules and a bug in one of them must
 * not take the classifier down with it. A failure means "nothing tripped",
 * which is the same way the rest of moderation fails.
 *
 * @param {import('discord.js').Message} message
 * @param {ReturnType<typeof import('../db/settings.js').effectiveSettings>} settings
 * @param {{ rate?: boolean }} [options] `rate: false` for an edit: editing a
 *   message is not sending one, so it must not count towards a flood.
 * @returns {string[]}
 */
export function localViolations(message, settings, { rate = true } = {}) {
  try {
    const categories = contentViolations(message.content ?? '', settings);
    if (rate && floodViolation(message.guildId, message.author?.id, settings)) {
      categories.push(CATEGORY_FLOOD);
    }
    return categories;
  } catch (error) {
    logger.error({ messageId: message.id, err: error }, 'Local moderation rules failed');
    return [];
  }
}
