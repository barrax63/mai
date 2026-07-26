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
import { bumpAttempts, dueRows, remove } from '../db/queue.js';
import { isGuildActive } from '../db/settings.js';
import {
  ACTION_DELETED,
  ACTION_SELF_DELETED,
  pruneOlderThan as pruneViolations,
  recordViolation,
} from '../db/violations.js';
import { logger } from '../logger.js';
import { appealComponents } from './appeal.js';
import { applyTimeout, decideEscalation } from './escalation.js';
import {
  LOG_ABANDONED,
  LOG_DELETED,
  LOG_SELF_DELETED,
  LOG_STUCK,
  LOG_TIMEOUT,
  LOG_TIMEOUT_FAILED,
  postModerationLog,
} from './log.js';
import { buildWarning, groupByUser } from './warning.js';

// Discord REST error codes (discord.js exposes them as error.code).
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/**
 * A row that cannot be enforced retries every tick. These thresholds turn that
 * silent loop into two visible events: one report when it is clearly not
 * transient, and one when Mai stops trying.
 */
const REPORT_AFTER_ATTEMPTS = 5;
const GIVE_UP_AFTER_ATTEMPTS = 60;

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
 * Counts a failed attempt and, at the thresholds, makes the failure visible:
 * once when it stops looking transient, once when Mai gives up. Silence would
 * mean a message stays up forever because of a missing permission nobody sees.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof dueRows>[number]} row
 * @param {Error} error
 * @returns {Promise<{ enforced: null, keepRow: boolean }>}
 */
async function reportFailure(client, row, error) {
  const attempts = bumpAttempts(row.messageId);
  const event = {
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    userId: row.userId,
    attempts,
    reason: error?.message ?? String(error),
  };

  if (attempts >= GIVE_UP_AFTER_ATTEMPTS) {
    // `error` level: this also reaches the alert channel via the logger hook.
    logger.error(
      { messageId: row.messageId, guildId: row.guildId, attempts },
      'Giving up on a queue row after repeated failures',
    );
    await postModerationLog(client, { ...event, type: LOG_ABANDONED });
    return { enforced: null, keepRow: false };
  }

  if (attempts === REPORT_AFTER_ATTEMPTS) {
    logger.error(
      { messageId: row.messageId, guildId: row.guildId, channelId: row.channelId, attempts },
      'A queue row keeps failing to enforce — check Mai\'s permissions in that channel',
    );
    await postModerationLog(client, { ...event, type: LOG_STUCK });
  }

  return { enforced: null, keepRow: true };
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

  // Paused by its own staff (/mod off): a pause, not an amnesty. The row waits
  // instead of being enforced or dropped, and resumes when they switch back on.
  if (!isGuildActive(row.guildId)) {
    logger.debug(
      { messageId: row.messageId, guildId: row.guildId },
      'Skipping queue row: Mai is paused in this guild',
    );
    return { enforced: null, keepRow: true, paused: true };
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
      // On the record, but deliberately not a strike: the grace period worked.
      recordViolation({
        guildId: row.guildId,
        userId: row.userId,
        messageId: row.messageId,
        categories: row.categories,
        action: ACTION_SELF_DELETED,
      });
      logger.info(
        { messageId: row.messageId, userId: row.userId },
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
      return { enforced: null, keepRow: false };
    }

    // Missing permissions or a transient failure: retry next tick.
    logger.warn(
      { messageId: row.messageId, channelId: row.channelId, err: error },
      'Could not look up flagged message, keeping queue row',
    );
    return reportFailure(client, row, error);
  }

  // Capture before deleting — this content is only ever used for the DM and is
  // never persisted. cleanContent resolves <@id>/<#id>/<@&id> to readable names.
  const record = {
    userId: row.userId,
    guildId: row.guildId,
    content: message.cleanContent ?? message.content ?? '',
    // Count only — the attachments themselves are never fetched or stored.
    attachments: message.attachments?.size ?? 0,
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
    return reportFailure(client, row, error);
  }

  await deleteMessageById(client, row.channelId, row.scoldMessageId);

  recordViolation({
    guildId: row.guildId,
    userId: row.userId,
    messageId: row.messageId,
    categories: row.categories,
    action: ACTION_DELETED,
  });

  logger.info(
    { messageId: row.messageId, guildId: row.guildId, userId: row.userId, categories: row.categories },
    'Deleted flagged message after grace period',
  );

  await postModerationLog(client, {
    type: LOG_DELETED,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    userId: row.userId,
    categories: row.categories,
  });

  return { enforced: record, keepRow: false };
}

/**
 * Escalation runs once per member and guild per tick, not once per deleted
 * message: three messages removed in one sweep is one incident, not three
 * timeouts.
 *
 * @param {import('discord.js').Client} client
 * @param {{ userId: string, guildId: string, categories: string[] }[]} enforced
 * @returns {Promise<Map<string, { minutes: number, until: Date | null, applied: boolean }>>}
 *   Keyed by `guildId:userId`, for the warning DM to mention.
 */
async function escalate(client, enforced) {
  const members = new Map();
  for (const record of enforced) {
    members.set(`${record.guildId}:${record.userId}`, record);
  }

  const results = new Map();

  for (const [key, record] of members) {
    const { strikes, minutes } = decideEscalation(record.guildId, record.userId);
    if (minutes <= 0) {
      logger.debug({ ...record, strikes }, 'No timeout for this strike count');
      continue;
    }

    const reason = `Mai: ${strikes}. Verstoß (${record.categories.join(', ') || 'Regelverstoß'})`;
    const outcome = await applyTimeout(client, {
      guildId: record.guildId,
      userId: record.userId,
      minutes,
      reason,
    });

    results.set(key, { ...outcome, minutes, strikes });

    await postModerationLog(client, {
      type: outcome.applied ? LOG_TIMEOUT : LOG_TIMEOUT_FAILED,
      guildId: record.guildId,
      userId: record.userId,
      minutes,
      strikes,
      until: outcome.until?.toISOString() ?? null,
      reason: outcome.error ?? null,
      categories: record.categories,
    });
  }

  return results;
}

/**
 * @param {import('discord.js').Client} client
 * @param {{ userId: string, guildId: string, violations: object[], categories: string[] }} group
 * @param {{ minutes: number, until: Date | null, applied: boolean } | undefined} timeout
 */
async function warnAuthor(client, group, timeout) {
  const body = buildWarning(group, timeout);
  try {
    const user = await client.users.fetch(group.userId);
    await user.send({
      content: body,
      // Only present when the guild can actually receive appeals.
      components: appealComponents(group.guildId),
      allowedMentions: { parse: [] },
    });
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

  // Escalate before the DMs go out, so the warning can name the timeout.
  const timeouts = await escalate(client, enforced);

  for (const group of groupByUser(enforced)) {
    await warnAuthor(client, group, timeouts.get(`${group.guildId}:${group.userId}`));
  }

  const cutoff = new Date(now.getTime() - config.chat.historyMaxAgeHours * 3_600_000).toISOString();
  const pruned = pruneOlderThan(cutoff);
  const violationCutoff = new Date(
    now.getTime() - config.moderation.violationRetentionDays * 86_400_000,
  ).toISOString();
  const violationsPruned = pruneViolations(violationCutoff);

  status.lastTickAt = now.toISOString();
  status.lastTickMs = Date.now() - startedAt;
  status.lastError = null;

  if (enforced.length > 0 || pruned > 0 || violationsPruned > 0) {
    logger.info(
      {
        enforced: enforced.length,
        timeouts: timeouts.size,
        historyRowsPruned: pruned,
        violationsPruned,
        ms: status.lastTickMs,
      },
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
