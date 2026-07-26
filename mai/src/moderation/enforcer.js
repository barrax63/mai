/**
 * Grace-period enforcement. Runs in-process every MODERATION_TICK_MS.
 *
 * Per due queue row:
 *   - author deleted the message themselves -> drop the orphaned scold reply,
 *     drop the row, no DM. The grace period did its job.
 *   - message still there -> delete it and its scold reply, drop the row, and
 *     DM the author (one grouped DM per author per tick).
 *   - message lookup failed for any other reason -> keep the row and retry on
 *     the next tick.
 *
 * The same tick also enforces chat-history retention, so pruning no longer
 * depends on somebody talking to Mai.
 */
import { config, isGuildAllowed } from '../config.js';
import { pruneOlderThan } from '../db/history.js';
import { dueRows, remove } from '../db/queue.js';
import { logger } from '../logger.js';
import { buildWarning, groupByUser } from './warning.js';

// Discord REST error codes (discord.js exposes them as error.code).
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/** @type {{ lastTickAt: string | null, lastTickMs: number | null, running: boolean, lastError: string | null }} */
const status = { lastTickAt: null, lastTickMs: null, running: false, lastError: null };

/**
 * @returns {typeof status}
 */
export function getEnforcerStatus() {
  return { ...status };
}

/**
 * Deletes a message by id without fetching it first. Best effort — a manually
 * removed scold reply must never block queue cleanup.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {string | null} messageId
 */
async function deleteMessageById(client, channelId, messageId) {
  if (!messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel?.messages?.delete(messageId);
  } catch (error) {
    logger.debug({ channelId, messageId, err: error }, 'Deleting message failed');
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof dueRows>[number]} row
 * @returns {Promise<{ enforced: object | null, keepRow: boolean }>}
 */
async function processRow(client, row) {
  // A guild dropped from the allowlist gets no behavior at all, including
  // pending enforcement — forget the row instead of acting in it.
  if (!isGuildAllowed(row.guildId)) {
    logger.info(
      { messageId: row.messageId, guildId: row.guildId },
      'Dropping queue row: guild no longer in allowlist',
    );
    return { enforced: null, keepRow: false };
  }

  let message = null;
  try {
    const channel = await client.channels.fetch(row.channelId);
    if (!channel?.messages) throw Object.assign(new Error('Channel has no messages'), { code: UNKNOWN_CHANNEL });
    message = await channel.messages.fetch(row.messageId);
  } catch (error) {
    if (error.code === UNKNOWN_MESSAGE || error.code === UNKNOWN_CHANNEL) {
      // Self-deleted (or the whole channel is gone): clean up and stay quiet.
      await deleteMessageById(client, row.channelId, row.scoldMessageId);
      logger.info(
        { messageId: row.messageId, userId: row.userId },
        'Flagged message was removed by the author, no warning sent',
      );
      return { enforced: null, keepRow: false };
    }

    // Missing permissions or a transient failure: retry next tick.
    logger.warn(
      { messageId: row.messageId, channelId: row.channelId, err: error },
      'Could not look up flagged message, keeping queue row',
    );
    return { enforced: null, keepRow: true };
  }

  // Capture before deleting — this content is only ever used for the DM and is
  // never persisted. cleanContent resolves <@id>/<#id>/<@&id> to readable names.
  const record = {
    userId: row.userId,
    guildId: row.guildId,
    content: message.cleanContent ?? message.content ?? '',
    timestamp: message.createdAt,
    categories: row.categories,
  };

  try {
    await message.delete();
  } catch (error) {
    logger.warn(
      { messageId: row.messageId, err: error },
      'Deleting flagged message failed, keeping queue row',
    );
    return { enforced: null, keepRow: true };
  }

  await deleteMessageById(client, row.channelId, row.scoldMessageId);

  logger.info(
    { messageId: row.messageId, guildId: row.guildId, userId: row.userId, categories: row.categories },
    'Deleted flagged message after grace period',
  );

  return { enforced: record, keepRow: false };
}

/**
 * @param {import('discord.js').Client} client
 * @param {{ userId: string, guildId: string, violations: object[], categories: string[] }} group
 */
async function warnAuthor(client, group) {
  const body = buildWarning(group);
  try {
    const user = await client.users.fetch(group.userId);
    await user.send({ content: body, allowedMentions: { parse: [] } });
    logger.info(
      { userId: group.userId, violations: group.violations.length, categories: group.categories },
      'Sent warning DM',
    );
  } catch (error) {
    // Closed DMs are a normal outcome, not an error worth alerting on.
    logger.info(
      { userId: group.userId, err: error },
      'Could not deliver warning DM',
    );
  }
  logger.debug({ userId: group.userId, warning: body }, 'Warning DM content');
}

/**
 * One enforcement pass. Exported for the /mai status command and tests.
 *
 * @param {import('discord.js').Client} client
 */
export async function runTick(client) {
  const startedAt = Date.now();
  const now = new Date();
  const enforced = [];

  for (const row of dueRows(now.toISOString())) {
    try {
      const { enforced: record, keepRow } = await processRow(client, row);
      if (!keepRow) remove(row.messageId);
      if (record) enforced.push(record);
    } catch (error) {
      // One bad row must never stall the queue.
      logger.error({ messageId: row.messageId, err: error }, 'Enforcing queue row failed');
    }
  }

  for (const group of groupByUser(enforced)) {
    await warnAuthor(client, group);
  }

  const cutoff = new Date(now.getTime() - config.chat.historyMaxAgeHours * 3_600_000).toISOString();
  const pruned = pruneOlderThan(cutoff);

  status.lastTickAt = now.toISOString();
  status.lastTickMs = Date.now() - startedAt;
  status.lastError = null;

  if (enforced.length > 0 || pruned > 0) {
    logger.info(
      { enforced: enforced.length, historyRowsPruned: pruned, ms: status.lastTickMs },
      'Moderation tick finished',
    );
  }
}

/**
 * Starts the tick loop. Overlapping runs are skipped, so a slow tick cannot
 * pile up on itself.
 *
 * @param {import('discord.js').Client} client
 * @returns {{ stop: () => void }}
 */
export function startEnforcer(client) {
  const tick = async () => {
    if (status.running) {
      logger.warn('Previous moderation tick still running, skipping this one');
      return;
    }
    status.running = true;
    try {
      await runTick(client);
    } catch (error) {
      status.lastError = error.message;
      logger.error({ err: error }, 'Moderation tick failed');
    } finally {
      status.running = false;
    }
  };

  const timer = setInterval(tick, config.moderation.tickMs);
  logger.info({ tickMs: config.moderation.tickMs }, 'Moderation enforcer started');
  void tick();

  return {
    stop() {
      clearInterval(timer);
      logger.info('Moderation enforcer stopped');
    },
  };
}
