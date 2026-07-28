/**
 * Moderation for a single message: apply the guild's own rules, classify,
 * react, scold, enqueue, and, when an edit changes the verdict, take all of it
 * back again.
 *
 * Two layers decide, in this order. The guild's local rules (heuristics.js:
 * invites, links, mass mentions, floods) run first because they are free and
 * catch what a score cannot; the classifier runs only on what they let past.
 * Both produce the same thing, a list of category slugs, and everything after
 * that point treats them identically.
 *
 * A guild in **shadow mode** takes the same two verdicts and does nothing with
 * them except write them to its log channel: the way to choose a threshold
 * without tuning it by deletion.
 *
 * `checkMessage` is called inline from the gateway handler, so the verdict is
 * available immediately: a flagged message that also addressed Mai gets the
 * scold reply instead of a chat answer. `recheckMessage` is the same pipeline
 * for an edited message, where the verdict can go either way.
 *
 * Fails open. If classification is unavailable (API down, key revoked), the
 * message passes: Mai stays a chatting cat instead of a broken moderator. The
 * one exception is a message that is *already* queued: without a verdict there
 * is no evidence the edit fixed anything, so the row stands.
 */
import { classify } from '../ai/moderation.js';
import { config, isGuildAllowed } from '../config.js';
import { content, pick } from '../content.js';
import { enqueue, findRow, remove, updateCategories } from '../db/queue.js';
import { countShadowHit, effectiveSettings } from '../db/settings.js';
import { recordScore } from '../db/shadow-scores.js';
import { ACTION_EDITED, ACTION_SELF_DELETED, recordViolation } from '../db/violations.js';
import { explainError } from '../errors.js';
import { logger } from '../logger.js';
import { deleteMessageById, removeWarningReaction } from './cleanup.js';
import { recordClassifierFailure, recordClassifierSuccess } from './health.js';
import { localViolations } from './heuristics.js';
import {
  LOG_CLEARED,
  LOG_DEGRADED,
  LOG_FLAGGED,
  LOG_RECOVERED,
  LOG_SELF_DELETED,
  LOG_SHADOW,
  postModerationLog,
} from './log.js';

const OK = Object.freeze({ action: 'ok' });

/**
 * Whether this message is subject to moderation at all.
 *
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
function isModeratable(message) {
  if (!config.moderation.enabled) return false;

  // A bot cannot delete a user's DM, so the grace-period pipeline has nothing
  // to enforce there.
  if (!message.guildId) return false;

  // Defense in depth: the gateway handlers already gate un-whitelisted guilds.
  if (!isGuildAllowed(message.guildId)) {
    logger.debug(
      { messageId: message.id, guildId: message.guildId },
      'Skipping moderation: guild not in allowlist',
    );
    return false;
  }

  if (isExemptChannel(message.guildId, message.channelId, message.channel?.parentId)) {
    logger.debug(
      { messageId: message.id, channelId: message.channelId },
      'Skipping moderation: channel is exempt',
    );
    return false;
  }

  return true;
}

/**
 * Whether staff have declared this channel off-limits to the delete/scold
 * pipeline (`/mod exempt add`). A thread is covered by its parent, so exempting
 * a vent channel does not leave every thread inside it moderated.
 *
 * @param {string} guildId
 * @param {string} channelId
 * @param {string | null | undefined} parentId
 * @returns {boolean}
 */
export function isExemptChannel(guildId, channelId, parentId) {
  const { exemptChannels } = effectiveSettings(guildId);
  if (exemptChannels.length === 0) return false;
  return exemptChannels.includes(channelId) || (Boolean(parentId) && exemptChannels.includes(parentId));
}

/**
 * Whether there is anything left for the classifier to judge. An image-only
 * message counts only while image classification is on.
 *
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
const hasClassifiableContent = (message) =>
  Boolean(message.content?.trim())
  || (config.moderation.classifyImages && (message.attachments?.size ?? 0) > 0);

/**
 * @param {import('discord.js').Message} message
 * @param {ReturnType<typeof effectiveSettings>} settings
 * @returns {Promise<{ flagged: boolean, categories: string[] } | null>} null when
 *   classification was unavailable: the caller decides what that means.
 */
async function classifySafely(message, settings) {
  const attachments = message.attachments.map((attachment) => ({
    url: attachment.url,
    contentType: attachment.contentType,
  }));

  try {
    const verdict = await classify(message.content, attachments, {
      guildId: message.guildId,
      // The guild's own line on what counts, not just the provider's default.
      policy: { threshold: settings.threshold, categories: settings.categories },
    });
    announceRecovery(message);
    return verdict;
  } catch (error) {
    logger.error(
      { messageId: message.id, err: error },
      'Classification failed, letting the message pass',
    );
    announceOutage(message, error);
    return null;
  }
}

/**
 * Tells the guild's staff that moderation is currently letting everything
 * through. Fires once per outage (health.js counts the streak), detached and
 * best effort like every other log entry.
 *
 * The reason goes through `explainError`: this lands in a Discord channel, so
 * an exception message never does.
 *
 * @param {import('discord.js').Message} message
 * @param {unknown} error
 */
function announceOutage(message, error) {
  const { announce, failures } = recordClassifierFailure(message.guildId);
  if (!announce) return;

  logger.error(
    { guildId: message.guildId, failures },
    'Classification keeps failing; moderation is passing everything through in this guild',
  );
  void postModerationLog(message.client, {
    type: LOG_DEGRADED,
    guildId: message.guildId,
    attempts: failures,
    reason: explainError(error),
  });
}

/**
 * @param {import('discord.js').Message} message
 */
function announceRecovery(message) {
  if (!recordClassifierSuccess(message.guildId)) return;

  logger.info({ guildId: message.guildId }, 'Classification works again');
  void postModerationLog(message.client, { type: LOG_RECOVERED, guildId: message.guildId });
}

/**
 * Marks a message as a violation: reaction, scold reply, queue row, log entry.
 *
 * @param {import('discord.js').Message} message
 * @param {string[]} categories
 * @returns {Promise<{ action: 'flagged', categories: string[], dueAt: string }>}
 */
async function flagMessage(message, categories) {
  const now = new Date();
  // The grace period is per guild (/mod config set grace), defaulting to
  // MODERATION_GRACE_PERIOD_MINUTES.
  const { gracePeriodMinutes } = effectiveSettings(message.guildId);
  const dueAt = new Date(now.getTime() + gracePeriodMinutes * 60_000);

  // Both Discord actions are best effort: a missing permission must not stop
  // the message from being queued for deletion.
  await message.react(content.moderation.warningEmoji).catch((error) => {
    logger.debug({ messageId: message.id, err: error }, 'Warning reaction failed');
  });

  const scold = await message
    .reply({
      content: `${content.moderation.scoldPrefix}${pick(content.moderation.scoldReplies)}`,
      // The reply-ping to the author is the only ping Mai sends here.
      allowedMentions: { parse: [], repliedUser: true },
    })
    .catch((error) => {
      logger.debug({ messageId: message.id, err: error }, 'Scold reply failed');
      return null;
    });

  try {
    enqueue({
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      categories,
      warnedAt: now.toISOString(),
      dueAt: dueAt.toISOString(),
      scoldMessageId: scold?.id ?? null,
    });
  } catch (error) {
    // Visible failure: the message is scolded but will never be enforced.
    logger.error(
      { messageId: message.id, err: error },
      'Could not queue flagged message for deletion',
    );
  }

  logger.info(
    {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      categories,
      dueAt: dueAt.toISOString(),
      scolded: Boolean(scold),
    },
    'Message flagged',
  );

  // Staff-visible trail. Detached: the gateway handler is waiting on this
  // verdict to decide whether Mai may chat, and a slow log channel must not
  // delay her.
  void postModerationLog(message.client, {
    type: LOG_FLAGGED,
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    categories,
    dueAt: dueAt.toISOString(),
  });

  return { action: 'flagged', categories, dueAt: dueAt.toISOString() };
}

/**
 * Shadow mode: report the verdict, act on nothing.
 *
 * Choosing a threshold used to mean tuning by deletion, which is a bad way to
 * learn that 0.2 was too low: the messages are already gone and the apologies
 * are already owed. Here the entry carries the categories and the score that
 * produced them, and the message keeps its jump link because nothing was done
 * to it, so staff can read a week of real traffic off their own log channel and
 * pick the number.
 *
 * Deliberately *not* a pause: queue rows from before shadow was switched on are
 * still enforced. Stopping everything is `/mod off`.
 *
 * @param {import('discord.js').Message} message
 * @param {string[]} categories
 * @param {number} [topScore]
 * @returns {{ action: 'ok' }} Nothing happened, so the caller must see nothing.
 */
/**
 * One classified message into the guild's histogram, never allowed to break the
 * pipeline: a counter that fails must not cost a verdict.
 *
 * @param {string} guildId
 * @param {number} [topScore]
 */
function countScore(guildId, topScore) {
  if (!Number.isFinite(topScore)) return;
  try {
    recordScore(guildId, topScore);
  } catch (error) {
    logger.warn({ guildId, err: error }, 'Could not record a shadow score');
  }
}

function shadowReport(message, categories, topScore) {
  // Counted per guild so the closing entry can say how much the week was
  // actually about. Never allowed to break the pipeline over a counter.
  try {
    countShadowHit(message.guildId);
  } catch (error) {
    logger.warn({ guildId: message.guildId, err: error }, 'Could not count a shadow verdict');
  }

  logger.info(
    {
      messageId: message.id,
      guildId: message.guildId,
      userId: message.author.id,
      categories,
      topScore,
    },
    'Shadow mode: would have flagged this message',
  );

  void postModerationLog(message.client, {
    type: LOG_SHADOW,
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    categories,
    topScore,
  });

  return OK;
}

/**
 * The author edited the violation out of a flagged message. Everything the flag
 * put there comes back off (warning reaction, scold reply, queue row) and the
 * guild's log gets a closing entry, so a `flagged` entry never just evaporates
 * with no explanation.
 *
 * @param {import('discord.js').Message} message
 * @param {ReturnType<typeof findRow>} row
 * @returns {Promise<{ action: 'cleared', categories: string[] }>}
 */
async function clearFlag(message, row) {
  // Dropped first: an enforcer tick starting right now must not still find a
  // due row for a message that is no longer a violation.
  remove(row.messageId);

  await removeWarningReaction(message);
  await deleteMessageById(message.client, row.channelId, row.scoldMessageId);

  // On the record like a self-deletion, and just as deliberately not a strike:
  // the grace period did exactly what it is for.
  recordViolation({
    guildId: row.guildId,
    userId: row.userId,
    messageId: row.messageId,
    categories: row.categories,
    action: ACTION_EDITED,
  });

  logger.info(
    {
      messageId: row.messageId,
      guildId: row.guildId,
      channelId: row.channelId,
      userId: row.userId,
      categories: row.categories,
    },
    'Flagged message was edited clean, dropping the queue row',
  );

  await postModerationLog(message.client, {
    type: LOG_CLEARED,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    userId: row.userId,
    categories: row.categories,
  });

  return { action: 'cleared', categories: row.categories };
}

/**
 * The author removed a flagged message themselves: the grace period doing
 * exactly what it is for. Shared by the enforcer (which finds it gone at the
 * deadline) and the `messageDelete` handler (which sees it happen).
 *
 * On the record, but deliberately not a strike.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof findRow>} row
 */
export async function recordSelfDeletion(client, row) {
  remove(row.messageId);
  await deleteMessageById(client, row.channelId, row.scoldMessageId);

  recordViolation({
    guildId: row.guildId,
    userId: row.userId,
    messageId: row.messageId,
    categories: row.categories,
    action: ACTION_SELF_DELETED,
  });

  logger.info(
    { messageId: row.messageId, guildId: row.guildId, userId: row.userId },
    'Flagged message was removed by the author, no warning sent',
  );

  await postModerationLog(client, {
    type: LOG_SELF_DELETED,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    userId: row.userId,
    categories: row.categories,
  });
}

/**
 * @param {import('discord.js').Message} message
 * @returns {Promise<{ action: 'ok' } | { action: 'flagged', categories: string[], dueAt: string }>}
 */
export async function checkMessage(message) {
  if (!isModeratable(message)) return OK;

  const settings = effectiveSettings(message.guildId);

  // The guild's own rules first: they cost no tokens and judge things a score
  // cannot (an invite link, a mass ping, a burst). A message they trip on is
  // never sent to the provider at all. The rate rule runs before the content
  // gate below, because an image-only message is still a message for a flood.
  const local = localViolations(message, settings);
  if (local.length > 0) {
    logger.info({ messageId: message.id, categories: local }, 'Message broke a local rule');
    return settings.shadowMode
      ? shadowReport(message, local)
      : flagMessage(message, local);
  }

  if (!hasClassifiableContent(message)) {
    logger.debug({ messageId: message.id }, 'Skipping moderation: empty content');
    return OK;
  }

  const verdict = await classifySafely(message, settings);
  if (!verdict) return OK;

  // During an observation period every classified message is counted into the
  // guild's score histogram, flagged or not. Only-the-flagged would be useless
  // for the thing it exists for: a histogram of what already cleared the line
  // cannot show that the line is too high, and "too high for German" is exactly
  // the case this is meant to catch.
  if (settings.shadowMode) countScore(message.guildId, verdict.topScore);

  if (!verdict.flagged) {
    logger.info({ messageId: message.id, flagged: false }, 'Message classified');
    return OK;
  }

  return settings.shadowMode
    ? shadowReport(message, verdict.categories, verdict.topScore)
    : flagMessage(message, verdict.categories);
}

/**
 * The same pipeline for an edited message. Unlike the first check the verdict
 * cuts both ways, because the message being judged already has a history:
 *
 *   - clean before, a violation now      -> flag it like any new message
 *   - a violation before and still one   -> refresh the categories, keep the
 *                                           deadline, stay quiet
 *   - a violation before, clean now      -> undo the flag entirely
 *   - clean before and still clean       -> nothing to do
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<{ action: 'ok' } | { action: 'flagged', categories: string[], dueAt: string }
 *   | { action: 'cleared', categories: string[] }>}
 */
export async function recheckMessage(message) {
  if (!isModeratable(message)) return OK;

  const settings = effectiveSettings(message.guildId);
  const row = findRow(message.id);

  // The guild's own rules, minus the flood one: editing a message is not
  // sending one, and counting it would let a member's own correction of a
  // burst trip the rule again. An edit that adds an invite link is exactly
  // what this catches: without it, posting clean and editing afterwards walks
  // straight past every local rule.
  const local = localViolations(message, settings, { rate: false });
  if (local.length > 0) {
    logger.info({ messageId: message.id, categories: local }, 'Edited message broke a local rule');
    // A row from before shadow mode was switched on keeps its normal treatment:
    // shadow stops new flags, it does not abandon pending ones.
    if (row) return stillFlagged(message, row, local);
    return settings.shadowMode ? shadowReport(message, local) : flagMessage(message, local);
  }

  // Edited down to nothing a classifier can judge (text removed, images off):
  // there is no violation left to enforce.
  if (!hasClassifiableContent(message)) {
    logger.debug({ messageId: message.id }, 'Edited message has no classifiable content');
    return row ? clearFlag(message, row) : OK;
  }

  const verdict = await classifySafely(message, settings);
  if (!verdict) {
    // Fails open for an unflagged message, and closed for a queued one: without
    // a verdict there is no evidence the edit fixed anything.
    return row
      ? { action: 'flagged', categories: row.categories, dueAt: row.dueAt }
      : OK;
  }

  if (!verdict.flagged) {
    logger.info({ messageId: message.id, flagged: false }, 'Edited message classified');
    return row ? clearFlag(message, row) : OK;
  }

  if (!row) {
    return settings.shadowMode
      ? shadowReport(message, verdict.categories, verdict.topScore)
      : flagMessage(message, verdict.categories);
  }

  return stillFlagged(message, row, verdict.categories);
}

/**
 * An edited message that was already queued and is still a violation, only a
 * different one.
 *
 * The deadline deliberately stays where it was: editing one slur into another
 * must not buy a fresh grace period, and re-scolding a message that is already
 * scolded is just noise.
 *
 * @param {import('discord.js').Message} message
 * @param {ReturnType<typeof findRow>} row
 * @param {string[]} categories
 * @returns {{ action: 'flagged', categories: string[], dueAt: string }}
 */
function stillFlagged(message, row, categories) {
  updateCategories(message.id, categories);

  logger.info(
    {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      categories,
      dueAt: row.dueAt,
    },
    'Edited message is still flagged',
  );

  return { action: 'flagged', categories, dueAt: row.dueAt };
}
