/**
 * Moderation for a single message: classify, react, scold, enqueue — and, when
 * an edit changes the verdict, take all of it back again.
 *
 * `checkMessage` is called inline from the gateway handler, so the verdict is
 * available immediately: a flagged message that also addressed Mai gets the
 * scold reply instead of a chat answer. `recheckMessage` is the same pipeline
 * for an edited message, where the verdict can go either way.
 *
 * Fails open. If classification is unavailable (API down, key revoked), the
 * message passes — Mai stays a chatting cat instead of a broken moderator. The
 * one exception is a message that is *already* queued: without a verdict there
 * is no evidence the edit fixed anything, so the row stands.
 */
import { classify } from '../ai/moderation.js';
import { config, isGuildAllowed } from '../config.js';
import { content, pick } from '../content.js';
import { enqueue, findRow, remove, updateCategories } from '../db/queue.js';
import { effectiveSettings } from '../db/settings.js';
import { ACTION_EDITED, ACTION_SELF_DELETED, recordViolation } from '../db/violations.js';
import { logger } from '../logger.js';
import { deleteMessageById, removeWarningReaction } from './cleanup.js';
import { LOG_CLEARED, LOG_FLAGGED, LOG_SELF_DELETED, postModerationLog } from './log.js';

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

  // Defense in depth — the gateway handlers already gate un-whitelisted guilds.
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
 * @returns {Promise<{ flagged: boolean, categories: string[] } | null>} null when
 *   classification was unavailable — the caller decides what that means.
 */
async function classifySafely(message) {
  const attachments = message.attachments.map((attachment) => ({
    url: attachment.url,
    contentType: attachment.contentType,
  }));

  // The guild's own line on what counts, not just the provider's default.
  const { threshold, categories } = effectiveSettings(message.guildId);

  try {
    return await classify(message.content, attachments, {
      guildId: message.guildId,
      policy: { threshold, categories },
    });
  } catch (error) {
    logger.error(
      { messageId: message.id, err: error },
      'Classification failed, letting the message pass',
    );
    return null;
  }
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
 * The author edited the violation out of a flagged message. Everything the flag
 * put there comes back off — warning reaction, scold reply, queue row — and the
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
 * The author removed a flagged message themselves — the grace period doing
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

  if (!hasClassifiableContent(message)) {
    logger.debug({ messageId: message.id }, 'Skipping moderation: empty content');
    return OK;
  }

  const verdict = await classifySafely(message);
  if (!verdict) return OK;

  if (!verdict.flagged) {
    logger.info({ messageId: message.id, flagged: false }, 'Message classified');
    return OK;
  }

  return flagMessage(message, verdict.categories);
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

  const row = findRow(message.id);

  // Edited down to nothing a classifier can judge (text removed, images off):
  // there is no violation left to enforce.
  if (!hasClassifiableContent(message)) {
    logger.debug({ messageId: message.id }, 'Edited message has no classifiable content');
    return row ? clearFlag(message, row) : OK;
  }

  const verdict = await classifySafely(message);
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

  if (!row) return flagMessage(message, verdict.categories);

  // Still a violation, only a different one. The deadline deliberately stays
  // where it was — editing one slur into another must not buy a fresh grace
  // period — and re-scolding a message that is already scolded is just noise.
  updateCategories(message.id, verdict.categories);

  logger.info(
    {
      messageId: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      categories: verdict.categories,
      dueAt: row.dueAt,
    },
    'Edited message is still flagged',
  );

  return { action: 'flagged', categories: verdict.categories, dueAt: row.dueAt };
}
