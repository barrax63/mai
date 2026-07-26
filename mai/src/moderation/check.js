/**
 * Moderation check for a single message: classify, react, scold, enqueue.
 *
 * Called inline from the gateway handler, so the verdict is available
 * immediately: a flagged message that also addressed Mai gets the scold reply
 * instead of a chat answer.
 *
 * Fails open. If classification is unavailable (API down, key revoked), the
 * message passes — Mai stays a chatting cat instead of a broken moderator.
 */
import { classify } from '../ai/moderation.js';
import { config, isGuildAllowed } from '../config.js';
import { content, pick } from '../content.js';
import { enqueue } from '../db/queue.js';
import { effectiveSettings } from '../db/settings.js';
import { logger } from '../logger.js';
import { LOG_FLAGGED, postModerationLog } from './log.js';

const OK = Object.freeze({ action: 'ok' });

/**
 * @param {import('discord.js').Message} message
 * @returns {Promise<{ action: 'ok' } | { action: 'flagged', categories: string[], dueAt: string }>}
 */
export async function checkMessage(message) {
  if (!config.moderation.enabled) return OK;

  // A bot cannot delete a user's DM, so the grace-period pipeline has nothing
  // to enforce there.
  if (!message.guildId) return OK;

  // Defense in depth — onMessageCreate already gates un-whitelisted guilds.
  if (!isGuildAllowed(message.guildId)) {
    logger.debug(
      { messageId: message.id, guildId: message.guildId },
      'Skipping moderation: guild not in allowlist',
    );
    return OK;
  }

  const attachments = message.attachments.map((attachment) => ({
    url: attachment.url,
    contentType: attachment.contentType,
  }));

  if (!message.content?.trim() && !config.moderation.classifyImages) {
    logger.debug({ messageId: message.id }, 'Skipping moderation: empty content');
    return OK;
  }

  let verdict;
  try {
    verdict = await classify(message.content, attachments);
  } catch (error) {
    logger.error(
      { messageId: message.id, err: error },
      'Classification failed, letting the message pass',
    );
    return OK;
  }

  if (!verdict.flagged) {
    logger.info({ messageId: message.id, flagged: false }, 'Message classified');
    return OK;
  }

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
      categories: verdict.categories,
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
      categories: verdict.categories,
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
    categories: verdict.categories,
    dueAt: dueAt.toISOString(),
  });

  return { action: 'flagged', categories: verdict.categories, dueAt: dueAt.toISOString() };
}
