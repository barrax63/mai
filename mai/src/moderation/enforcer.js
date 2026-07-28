/**
 * Grace-period enforcement. Runs in-process every MODERATION_TICK_MS.
 *
 * Per due queue row:
 *   - author deleted the message themselves -> drop the orphaned scold reply,
 *     drop the row, no DM. The grace period did its job.
 *   - message still there -> delete it and its scold reply, drop the row, and
 *     DM the author (one grouped DM per author per tick). A DM that bounces is
 *     reported in the guild's log: the member was enforced without ever being
 *     told, and never saw the appeal button (`/mai appeal` is their way back).
 *   - message lookup failed for any other reason -> keep the row and retry on
 *     the next tick.
 *
 * The same tick also enforces chat-history retention, so pruning no longer
 * depends on somebody talking to Mai.
 */
import { config, isGuildAllowed } from '../config.js';
import { content, fill } from '../content.js';
import { pruneOlderThan as pruneEvidence, recordEvidence } from '../db/evidence.js';
import { pruneOlderThan } from '../db/history.js';
import { pruneOlderThan as pruneNotes } from '../db/notes.js';
import { bumpAttempts, dueCount, dueRows, remove } from '../db/queue.js';
import {
  effectiveSettings,
  expireShadowWindows,
  isGuildActive,
  pausedGuildIds,
  updateSettings,
} from '../db/settings.js';
import { clearScores, histogram, suggestThreshold } from '../db/shadow-scores.js';
import {
  ACTION_DELETED,
  pruneOlderThan as pruneViolations,
  recordViolation,
} from '../db/violations.js';
import { explainError } from '../errors.js';
import { logger } from '../logger.js';
import { appealComponents } from './appeal.js';
import { isExemptChannel, recordSelfDeletion } from './check.js';
import { deleteMessageById, markOwnDeletion } from './cleanup.js';
import { applyTimeout, decideEscalation } from './escalation.js';
import {
  LOG_ABANDONED,
  LOG_DELETED,
  LOG_SHADOW_ENDED,
  LOG_STUCK,
  LOG_TIMEOUT,
  LOG_TIMEOUT_FAILED,
  LOG_WARNING_UNDELIVERED,
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

/**
 * `lastProgressAt` is the watchdog's heartbeat (see below): epoch ms, bumped by
 * anything that proves the loop is alive, which is every resolved row and every
 * finished pass. Deliberately not the same thing as `lastTickAt`, which only
 * moves when a whole pass completes.
 *
 * @type {{ lastTickAt: string | null, lastTickMs: number | null, running: boolean,
 *   lastError: string | null, lastProgressAt: number | null }}
 */
const status = {
  lastTickAt: null,
  lastTickMs: null,
  running: false,
  lastError: null,
  lastProgressAt: null,
};

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
    // Goes into the guild's log channel, so staff get the code in words, never
    // the raw message (errors.js). The full one is in the container log.
    reason: explainError(error),
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
  } catch (error) {
    return handleLookupError(client, row, error);
  }

  // Not found. discord.js usually throws 10003 for this, but it can also answer
  // with null, which means the same thing and deserves the same resolution:
  // the channel is not coming back, so retrying it for an hour before giving up
  // would be a slower route to a worse outcome (a LOG_ABANDONED entry instead
  // of the truthful self-deletion one). This is a deliberate exception to
  // "any other lookup failure must keep the row": a null here is not a failure
  // to look up, it is a successful lookup that found nothing.
  if (!channel) {
    return handleLookupError(
      client,
      row,
      Object.assign(new Error('Channel not found'), { code: UNKNOWN_CHANNEL }),
    );
  }

  // Found, but not something messages live in (a category, a voice channel, a
  // forum's parent). Deliberately *not* treated as UNKNOWN_CHANNEL: that means
  // "the author deleted it" and would record a self-deletion, silently
  // downgrading a strike over what is really an unenforceable row. Reported as
  // the failure it is, so it counts attempts and eventually gives up.
  if (!channel.messages) {
    return reportFailure(
      client,
      row,
      Object.assign(new Error('Channel holds no messages'), { code: 'not_text_channel' }),
    );
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

  keepEvidence(row, record);

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
 * Keeps what the deleted message said, if this guild asked for that.
 *
 * The text is in hand anyway (the warning DM quotes it), and this is the only
 * moment it still exists: a minute later the message is gone from Discord and
 * nobody, staff included, can find out what an appeal is actually about.
 *
 * Never allowed to break enforcement: the message is already deleted and the
 * strike already recorded, so a failure here costs a review, not a moderation
 * decision.
 *
 * @param {ReturnType<typeof dueRows>[number]} row
 * @param {{ content: string, attachments: number }} record
 */
function keepEvidence(row, record) {
  if (!effectiveSettings(row.guildId).evidenceEnabled) return;

  try {
    recordEvidence({
      messageId: row.messageId,
      guildId: row.guildId,
      userId: row.userId,
      channelId: row.channelId,
      content: record.content,
      attachments: record.attachments,
      categories: row.categories,
    });
  } catch (error) {
    logger.error({ messageId: row.messageId, err: error }, 'Could not keep appeal evidence');
  }
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

    // Discord shows this next to the timeout in the audit log, so it is text
    // Mai says: it lives in the YAML like everything else she says.
    const reason = fill(content.moderation.timeoutReason, {
      strikes,
      categories: group.categories.join(', ') || content.moderation.timeoutReasonUnknown,
    });
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
    // Closed DMs are a normal outcome, not an error worth alerting on: this
    // stays at `info` and never reaches the alert hook.
    logger.info(
      { userId: group.userId, err: error },
      'Could not deliver warning DM',
    );

    // But it is not a normal outcome for the *member*: their messages were
    // deleted, they may have been timed out, and the one channel that would
    // have told them why (and carried the appeal button) never opened. Staff
    // are the only remaining route, so the guild's log says so explicitly
    // rather than leaving a `deleted` entry that looks fully handled.
    await postModerationLog(client, {
      type: LOG_WARNING_UNDELIVERED,
      guildId: group.guildId,
      userId: group.userId,
      count: group.violations.length,
      categories: group.categories,
      reason: explainError(error),
    });
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
  // Only guilds that are *still allowlisted*. A guild that is both paused and
  // no longer allowlisted has to stay in the query: `processRow` checks the
  // allowlist before the pause and drops those rows, and skipping them here
  // would strand them in the database forever.
  const paused = pausedGuildIds().filter((guildId) => isGuildAllowed(guildId));
  const overdue = dueCount(now.toISOString(), paused);
  if (overdue > config.moderation.maxRowsPerTick) {
    logger.warn(
      { overdue, limit: config.moderation.maxRowsPerTick },
      'More overdue rows than one tick handles, the rest follow next tick',
    );
  }

  for (const row of dueRows(now.toISOString(), config.moderation.maxRowsPerTick, paused)) {
    // Every row is a sign of life for the watchdog, so a long but working pass
    // through a backlog is never mistaken for a hung one.
    status.lastProgressAt = Date.now();
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

  await endObservationPeriods(client);

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
  // Staff notes ride on the same window as the record they annotate.
  const notesPruned = pruneNotes(violationCutoff);
  // Hours, and unconditional: with MODERATION_EVIDENCE_HOURS at 0 the cutoff is
  // *now*, so switching the feature off also clears what is left behind instead
  // of leaving quoted messages in the database indefinitely.
  const evidencePruned = pruneEvidence(
    new Date(now.getTime() - config.moderation.evidenceHours * 3_600_000).toISOString(),
  );

  status.lastTickAt = now.toISOString();
  status.lastTickMs = Date.now() - startedAt;
  status.lastProgressAt = Date.now();
  status.lastError = null;

  if (enforced.length > 0 || pruned > 0 || violationsPruned > 0 || evidencePruned > 0 || notesPruned > 0) {
    logger.info(
      {
        enforced: enforced.length,
        timeouts: timeouts.size,
        historyRowsPruned: pruned,
        violationsPruned,
        evidencePruned,
        notesPruned,
        ms: status.lastTickMs,
      },
      'Moderation tick finished',
    );
  }
}

/**
 * Ends the observation periods that have run out, and tells each guild.
 *
 * This is the half of `/mod setup observe` that makes it a promise rather than
 * a flag: Mai said she would watch and then start acting, so the switch happens
 * without anybody remembering it, and the entry says how much she would have
 * done, which is the number the week was run to find out.
 *
 * On the tick because the tick is the only thing that already runs on its own.
 * The switch is made by the same statement that finds the expired window, so
 * two overlapping runs cannot both announce it.
 *
 * @param {import('discord.js').Client} client
 */
async function endObservationPeriods(client) {
  for (const { guildId, hits } of expireShadowWindows()) {
    // An un-allowlisted guild gets no behaviour at all, including this. Its
    // window is already closed in the database, which is the right state.
    if (!isGuildAllowed(guildId)) continue;

    const learned = learnThreshold(guildId);

    logger.info(
      { guildId, hits, threshold: learned?.threshold, samples: learned?.samples },
      'Observation period ended, enforcing from now on',
    );
    await postModerationLog(
      client,
      {
        type: LOG_SHADOW_ENDED,
        guildId,
        count: hits,
        threshold: learned?.threshold,
        samples: learned?.samples,
      },
      // The undo lives on the entry itself, where staff are already reading
      // about it, rather than in a command they would have to be told about.
      learned ? { components: thresholdUndoButton(guildId) } : {},
    );
  }
}

/**
 * Reads a threshold off the week's own traffic and applies it.
 *
 * This is the number `/mod setup observe` was run to find out. It was picked by
 * hand before, from a documentation line that amounted to "start around 0.2 and
 * watch", which meant finding out you were wrong by deleting things people
 * meant. The provider scores the same insult 0.88 in English and 0.20 in
 * German, so there is no right constant to ship, only a right way to measure.
 *
 * Applied rather than proposed, deliberately. A suggestion in a log channel is
 * a task somebody has to come back to, and a moderation bot that needs somebody
 * to come back to it is the thing the whole observation period exists to
 * replace. It is written as an ordinary explicit setting, announced with the
 * sample count behind it, and undone by one button or `/mod config reset
 * threshold`.
 *
 * Silence when the week does not support a number: too few messages, or a
 * distribution whose percentile lands outside the sane band. Nothing is written
 * and the entry simply does not mention a threshold.
 *
 * @param {string} guildId
 * @returns {{ threshold: number, samples: number } | null}
 */
function learnThreshold(guildId) {
  try {
    const suggestion = suggestThreshold(histogram(guildId));
    // Read once and dropped either way: the histogram belongs to the window it
    // was collected in, and keeping it would let the next observation period
    // inherit the last one's traffic.
    clearScores(guildId);

    if (!suggestion) return null;

    // Never overrule a server that has already decided where its line is.
    if (!effectiveSettings(guildId).inherited.threshold) return null;

    updateSettings(guildId, { threshold: suggestion.threshold });
    return suggestion;
  } catch (error) {
    // A failed measurement must not cost the guild the end of its observation
    // period: that switch is the promise, this is the bonus.
    logger.warn({ guildId, err: error }, 'Could not learn a threshold from the observation period');
    return null;
  }
}

/**
 * @param {string} guildId
 */
const thresholdUndoButton = (guildId) => [
  {
    type: 1, // ACTION_ROW
    components: [
      {
        type: 2, // BUTTON
        style: 2, // SECONDARY
        label: content.moderation.log.thresholdUndo,
        custom_id: `threshold-undo:${guildId}`,
      },
    ],
  },
];

/**
 * The overlap guard turns a *hung* tick into permanent silence: a Discord call
 * that never settles leaves `running` true, so every later tick is skipped and
 * nothing is ever enforced again. `/healthz` reports that and Docker marks the
 * container unhealthy, but a restart policy does not act on health, so an
 * unhealthy Mai simply sits there being unhealthy.
 *
 * So the loop watches itself: if the last completed tick is older than
 * `MODERATION_STUCK_RESTART_TICKS` intervals, the process exits and the
 * container's `restart: on-failure` brings back a working one. Losing an
 * in-flight tick costs nothing, because every row it had not resolved is still
 * in the queue and the next process picks it up.
 *
 * Same shape as the uncaught-exception handler in index.js: `fatal` (so the
 * alert hook forwards it), then exit after a beat so that alert can leave.
 *
 * What it measures is **progress**, not completion: a tick working through a
 * backlog under a rate limit can legitimately outlast several intervals, and
 * killing that would restart into the same backlog forever. Every resolved row
 * counts as a sign of life, so the only thing that trips this is a loop that is
 * neither finishing nor moving.
 *
 * Exported as a pure predicate so the decision can be tested without a process
 * that actually exits.
 *
 * @param {{ lastProgressAt?: number | null, startedAt: number, now?: number }} state
 * @returns {boolean}
 */
export function isWedged({ lastProgressAt, startedAt, now = Date.now() }) {
  const limit = config.moderation.stuckRestartTicks;
  if (limit <= 0) return false;

  return now - (lastProgressAt ?? startedAt) > config.moderation.tickMs * limit;
}

/**
 * @param {number} startedAt When the loop was started, for the first tick.
 * @returns {boolean} Whether the process is on its way out.
 */
function watchdog(startedAt) {
  if (!isWedged({ lastProgressAt: status.lastProgressAt, startedAt })) return false;

  const age = Date.now() - (status.lastProgressAt ?? startedAt);
  logger.fatal(
    { lastTickAt: status.lastTickAt, ageMs: age, running: status.running },
    'Moderation tick is neither finishing nor moving, exiting so the container restarts',
  );
  setTimeout(() => process.exit(1), 1_000);
  return true;
}

/**
 * Starts the tick loop. Overlapping runs are skipped, so a slow tick cannot
 * pile up on itself.
 *
 * @param {import('discord.js').Client} client
 * @returns {{ stop: () => void }}
 */
export function startEnforcer(client) {
  const startedAt = Date.now();

  const tick = async () => {
    // Before the overlap guard, deliberately: the case worth catching is the
    // one where that guard is what is keeping the loop quiet.
    if (watchdog(startedAt)) return;

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
