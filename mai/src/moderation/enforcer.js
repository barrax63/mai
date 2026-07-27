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
import { bumpAttempts, dueCount, dueRows, remove } from '../db/queue.js';
import { isGuildActive, pausedGuildIds } from '../db/settings.js';
import {
  ACTION_DELETED,
  pruneOlderThan as pruneViolations,
  recordViolation,
} from '../db/violations.js';
import { logger } from '../logger.js';
import { appealComponents } from './appeal.js';
import { isExemptChannel, recordSelfDeletion } from './check.js';
import { deleteMessageById, markOwnDeletion } from './cleanup.js';
import { applyTimeout, decideEscalation } from './escalation.js';
import {
  LOG_ABANDONED,
  LOG_DELETED,
  LOG_STUCK,
  LOG_TIMEOUT,
  LOG_TIMEOUT_FAILED,
  postModerationLog,
} from './log.js';
import { buildWarning, groupByMember, memberKey } from './warning.js';

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
      'A queue row keeps failing to enforce; check Mai\'s permissions in that channel',
    );
    await postModerationLog(client, { ...event, type: LOG_STUCK });
  }

  return { enforced: null, keepRow: true };
}

/**
 * What a failed Discord lookup means for the row: "the author deleted it"
 * resolves it, anything else keeps it for the next tick. Shared by the channel
 * and the message lookup, which fail the same way for the same reasons.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof dueRows>[number]} row
 * @param {Error} error
 * @returns {Promise<{ enforced: null, keepRow: boolean }>}
 */
async function handleLookupError(client, row, error) {
  if (error.code === UNKNOWN_MESSAGE || error.code === UNKNOWN_CHANNEL) {
    // Self-deleted (or the whole channel is gone). The messageDelete handler
    // normally gets here first; this is the fallback for a deletion that
    // happened while the gateway was down.
    await recordSelfDeletion(client, row);
    return { enforced: null, keepRow: false };
  }

  // Missing permissions or a transient failure: retry next tick.
  logger.warn(
    { messageId: row.messageId, channelId: row.channelId, err: error },
    'Could not look up flagged message, keeping queue row',
  );
  return reportFailure(client, row, error);
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof dueRows>[number]} row
 * @returns {Promise<{ enforced: object | null, keepRow: boolean }>}
 */
async function processRow(client, row) {
  // A guild dropped from the allowlist gets no behavior at all, including
  // pending enforcement: forget the row instead of acting in it.
  if (!isGuildAllowed(row.guildId)) {
    logger.info(
      { messageId: row.messageId, guildId: row.guildId },
      'Dropping queue row: guild no longer in allowlist',
    );
    return { enforced: null, keepRow: false };
  }

  // Paused by its own staff (/mod off): a pause, not an amnesty. The row waits
  // instead of being enforced or dropped, and resumes when they switch back on.
  // `dueRows` already leaves paused guilds out of the query; this is the guard
  // for a guild paused between that query and this row's turn.
  if (!isGuildActive(row.guildId)) {
    logger.debug(
      { messageId: row.messageId, guildId: row.guildId },
      'Skipping queue row: Mai is paused in this guild',
    );
    return { enforced: null, keepRow: true, paused: true };
  }

  let channel = null;
  try {
    channel = await client.channels.fetch(row.channelId);
    if (!channel?.messages) throw Object.assign(new Error('Channel has no messages'), { code: UNKNOWN_CHANNEL });
  } catch (error) {
    return handleLookupError(client, row, error);
  }

  // Staff declared this channel off-limits after the message was flagged.
  // Dropped rather than paused: an exemption is a statement about *scope*:
  // "Mai does not moderate here", so leaving her to delete a message in it
  // later would contradict the setting they just made.
  //
  // After the channel lookup, not before it: exempting a channel covers the
  // threads inside it, and the parent id is only knowable from the channel
  // object. Checking on the id alone let a thread whose parent was exempted
  // *after* the flag be enforced anyway.
  if (isExemptChannel(row.guildId, row.channelId, channel.parentId)) {
    logger.info(
      { messageId: row.messageId, channelId: row.channelId, parentId: channel.parentId ?? null },
      'Dropping queue row: channel is now exempt',
    );
    return { enforced: null, keepRow: false };
  }

  let message = null;
  try {
    message = await channel.messages.fetch(row.messageId);
  } catch (error) {
    return handleLookupError(client, row, error);
  }

  // Capture before deleting, this content is only ever used for the DM and is
  // never persisted. cleanContent resolves <@id>/<#id>/<@&id> to readable names.
  const record = {
    userId: row.userId,
    guildId: row.guildId,
    content: message.cleanContent ?? message.content ?? '',
    // Count only: the attachments themselves are never fetched or stored.
    attachments: message.attachments?.size ?? 0,
    timestamp: message.createdAt,
    categories: row.categories,
  };

  try {
    // Marked first: the gateway event for this delete must not be mistaken for
    // the author having removed it themselves.
    markOwnDeletion(row.messageId);
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
 * timeouts. It takes the same groups the warning DMs are built from, so the
 * two cannot disagree about what counts as one incident, and the categories it
 * names are the union across the whole group rather than whichever message
 * happened to be last.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof groupByMember>} groups
 * @returns {Promise<Map<string, { minutes: number, until: Date | null, applied: boolean }>>}
 *   Keyed by `memberKey`, for the warning DM to mention.
 */
async function escalate(client, groups) {
  const results = new Map();

  for (const group of groups) {
    const { strikes, minutes } = decideEscalation(group.guildId, group.userId);
    if (minutes <= 0) {
      logger.debug(
        { guildId: group.guildId, userId: group.userId, strikes },
        'No timeout for this strike count',
      );
      continue;
    }

    const reason = `Mai: ${strikes}. Verstoß (${group.categories.join(', ') || 'Regelverstoß'})`;
    const outcome = await applyTimeout(client, {
      guildId: group.guildId,
      userId: group.userId,
      minutes,
      reason,
    });

    results.set(memberKey(group.guildId, group.userId), { ...outcome, minutes, strikes });

    await postModerationLog(client, {
      type: outcome.applied ? LOG_TIMEOUT : LOG_TIMEOUT_FAILED,
      guildId: group.guildId,
      userId: group.userId,
      minutes,
      strikes,
      until: outcome.until?.toISOString() ?? null,
      reason: outcome.error ?? null,
      categories: group.categories,
    });
  }

  return results;
}

/**
 * @param {import('discord.js').Client} client
 * @param {{ userId: string, guildId: string, violations: object[], categories: string[] }} group
 * @param {{ minutes: number, until: Date | null, applied: boolean } | undefined} timeout
 */
async function warnAuthor(client, group, timeout, sinceIso) {
  const body = buildWarning(group, timeout);
  try {
    const user = await client.users.fetch(group.userId);
    await user.send({
      content: body,
      // Only present when the guild can actually receive appeals. `sinceIso` is
      // this tick's start, so a granted appeal overturns exactly the strikes
      // this DM is about and no earlier ones.
      components: appealComponents(group.guildId, sinceIso),
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

  // Rows stay serial on purpose: each one is several Discord calls, and running
  // them in parallel only trades a shorter tick for a harder rate limit. The cap
  // is what keeps a backlog from outlasting the interval.
  //
  // Paused guilds are excluded from the query rather than skipped per row: their
  // rows are kept indefinitely by design, and being oldest-first they would
  // otherwise occupy the cap on every tick and starve every other guild.
  const paused = pausedGuildIds();
  const overdue = dueCount(now.toISOString(), paused);
  if (overdue > config.moderation.maxRowsPerTick) {
    logger.warn(
      { overdue, limit: config.moderation.maxRowsPerTick },
      'More overdue rows than one tick handles, the rest follow next tick',
    );
  }

  for (const row of dueRows(now.toISOString(), config.moderation.maxRowsPerTick, paused)) {
    try {
      const { enforced: record, keepRow } = await processRow(client, row);
      if (!keepRow) remove(row.messageId);
      if (record) enforced.push(record);
    } catch (error) {
      // One bad row must never stall the queue. It still has to count as a
      // failed attempt: without that, a row that *throws* (rather than
      // reporting its failure) retries every tick forever and never reaches
      // the give-up threshold.
      logger.error({ messageId: row.messageId, err: error }, 'Enforcing queue row failed');
      try {
        const { keepRow } = await reportFailure(client, row, error);
        if (!keepRow) remove(row.messageId);
      } catch (failure) {
        logger.error(
          { messageId: row.messageId, err: failure },
          'Could not record a failed enforcement attempt',
        );
      }
    }
  }

  // One grouping pass for both: a member enforced in two guilds this tick is
  // two incidents, and gets one DM per guild with that guild's own appeal
  // button. Escalate first, so each warning can name its own timeout.
  const groups = groupByMember(enforced);
  const timeouts = await escalate(client, groups);

  for (const group of groups) {
    await warnAuthor(
      client,
      group,
      timeouts.get(memberKey(group.guildId, group.userId)),
      now.toISOString(),
    );
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
