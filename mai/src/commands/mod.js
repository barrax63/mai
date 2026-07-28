/**
 * `/mod`: the staff commands. What Mai currently has queued, and a pardon.
 *
 * Discord hides the command from members without Manage Messages
 * (`default_member_permissions`), but the check is repeated in code: that field
 * is a UI default a server admin can widen.
 */
import { PermissionFlagsBits } from 'discord.js';
import { simulate } from '../ai/moderation.js';
import { config, isOperator, LINK_POLICIES, NAME_CHECKS } from '../config.js';
import { content, fill } from '../content.js';
import { describeError } from '../errors.js';
import { clearForUser as clearEvidenceFor } from '../db/evidence.js';
import { stats as historyStats } from '../db/history.js';
import { addNote, clearForUser as clearNotesFor, MAX_NOTE_LENGTH, notesFor } from '../db/notes.js';
import { depth, forgiveUser } from '../db/queue.js';
import {
  clearShadowWindow,
  effectiveSettings,
  resetSettings,
  setProfile,
  SETTINGS,
  startShadowWindow,
  updateSettings,
} from '../db/settings.js';
import { breakdownFor, budgetState, dayKey, monthKey, totalsFor } from '../db/usage.js';
import {
  ACTION_WARNED,
  clearForUser,
  historyFor,
  recordViolation,
  strikeCount,
  totalsFor as violationTotals,
} from '../db/violations.js';
import { contentViolations } from '../moderation/heuristics.js';
import { preset, PRESET_NAMES } from '../moderation/presets.js';
import { buildManualWarning } from '../moderation/warning.js';
import { missingPermissions, permissionsComplete } from '../permissions.js';
import { createRateLimiter } from '../rate-limit.js';
import { ladderFor, strikeWindowStart } from '../moderation/escalation.js';
import { getGatewayClient } from '../gateway/client.js';
import { logger } from '../logger.js';
import { getEnforcerStatus } from '../moderation/enforcer.js';
import { degradedGuildIds } from '../moderation/health.js';
import { LOG_CONFIG, LOG_FORGIVEN, LOG_WARNED, postModerationLog } from '../moderation/log.js';
import { optionValue, resolveSubcommand } from '../interactions/options.js';
import { ephemeralResponse, updateResponse } from '../interactions/respond.js';

/** How many category scores `/mod simulate` prints. */
const SIMULATE_SCORES = 5;

/**
 * A simulation is a real API call, and staff are the one group that can loop a
 * command deliberately. Generous, because tuning a threshold is exactly what
 * this is for.
 */
const simulateLimiter = createRateLimiter({ max: 15, windowMs: 5 * 60_000, name: 'simulate' });

/**
 * @param {object} interaction
 * @returns {boolean}
 */
function mayModerate(interaction) {
  // Absent in DMs, there is nothing to moderate there anyway.
  const raw = interaction.member?.permissions;
  if (!raw) return false;
  try {
    return (BigInt(raw) & PermissionFlagsBits.ManageMessages) === PermissionFlagsBits.ManageMessages;
  } catch {
    return false;
  }
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`]
    .filter(Boolean)
    .join(' ');
}

/**
 * The scope a caller may see. Manage Messages makes someone staff in *their*
 * guild, not an auditor of every other server Mai runs in, so the counters are
 * filtered to the calling guild unless the caller operates the bot itself.
 *
 * @param {object} interaction
 * @returns {string | undefined} A guild id to filter by, or undefined for all.
 */
const visibleScope = (interaction) =>
  isOperator(interaction.member?.user?.id ?? interaction.user?.id)
    ? undefined
    : interaction.guild_id;

/**
 * @param {object} interaction
 */
function statusResponse(interaction) {
  const enforcer = getEnforcerStatus();
  const scope = visibleScope(interaction);
  const history = historyStats(scope);

  const lastTick = enforcer.lastTickAt
    // Discord renders this as a localized relative timestamp.
    ? `<t:${Math.floor(new Date(enforcer.lastTickAt).getTime() / 1000)}:R>`
    : content.commands.status.never;

  const openai = [
    `chat \`${config.openai.chatModel}\`${config.chat.enabled ? '' : ' (aus)'}`,
    `moderation \`${config.openai.moderationModel}\`${config.moderation.enabled ? '' : ' (aus)'}`,
  ].join(', ');

  // Whether classification is currently failing open. The guild's log channel
  // gets an entry when it starts, but a guild without one has no other way to
  // find out, and "is Mai working?" is exactly what this command is asked.
  const degraded = degradedGuildIds();
  const classifier = scope
    ? (degraded.includes(scope) ? content.commands.status.degraded : content.commands.status.healthy)
    : fill(degraded.length > 0 ? content.commands.status.degradedGuilds : content.commands.status.healthy, {
        count: degraded.length,
      });

  // What she is missing to do what this server asked for. Cheap (cached guild,
  // no REST call) and exactly the question `/mod status` is opened for: every
  // one of these fails gracefully at runtime, which is why nobody notices.
  const guild = getGatewayClient()?.guilds?.cache?.get(interaction.guild_id);
  const gaps = guild ? missingPermissions(guild) : { known: false, guild: [], logChannel: [] };
  const permissions = permissionsComplete(gaps)
    ? content.commands.status.permissionsOk
    : fill(content.commands.status.permissionsMissing, {
        permissions: [...gaps.guild, ...gaps.logChannel].join(', ')
          || content.commands.status.permissionsUnknown,
      });

  return ephemeralResponse(
    fill(content.commands.status.body, {
      // Enforcer health, uptime and the model names stay unscoped: they are
      // facts about Mai herself, and every guild's staff needs to know whether
      // she is alive. Only the counters are other servers' data.
      scope: scope ? '' : ` ${content.commands.status.allGuilds}`,
      queueDepth: depth(scope),
      historyRows: history.rows,
      historyChannels: history.channels,
      lastTick,
      openai,
      classifier,
      permissions,
      uptime: formatUptime(process.uptime()),
    }),
  );
}

const formatNumber = (value) => new Intl.NumberFormat('de-DE').format(value ?? 0);

/**
 * `/mod spend`: what Mai has cost this month, from the usage the API already
 * reports back. Tokens, not currency: pricing changes and is per model.
 */
function spendResponse(interaction) {
  const scope = visibleScope(interaction);
  const today = totalsFor(dayKey(), scope);
  const month = totalsFor(monthKey(), scope);
  const { used, budget, exceeded } = budgetState();

  const breakdown = breakdownFor(monthKey(), scope)
    .map((row) =>
      // The moderations endpoint returns no `usage` object at all, so its rows
      // are genuinely tokenless rather than unmeasured. Printing "0 Tokens"
      // there reads as a broken counter.
      fill(row.totalTokens > 0 ? content.commands.spend.line : content.commands.spend.lineNoTokens, {
        purpose: row.purpose,
        model: row.model,
        calls: formatNumber(row.calls),
        tokens: formatNumber(row.totalTokens),
      }),
    )
    .join('\n');

  // The budget is a property of the process, so its numbers belong to whoever
  // pays the bill. A guild's staff still gets told when it is exhausted (that
  // is why Mai stopped talking to them), just not what the figures are.
  const { spend } = content.commands;
  let budgetLine = spend.budgetOff;
  if (budget > 0) {
    budgetLine = scope
      ? (exceeded ? spend.budgetExceededShared : spend.budgetHidden)
      : fill(exceeded ? spend.budgetExceeded : spend.budgetOk, {
          used: formatNumber(used),
          budget: formatNumber(budget),
          percent: Math.round((used / budget) * 100),
        });
  }

  return ephemeralResponse(
    fill(content.commands.spend.body, {
      scope: scope ? '' : ` ${content.commands.status.allGuilds}`,
      todayCalls: formatNumber(today.calls),
      todayTokens: formatNumber(today.totalTokens),
      monthCalls: formatNumber(month.calls),
      monthTokens: formatNumber(month.totalTokens),
      budget: budgetLine,
      breakdown: breakdown || content.commands.spend.nothing,
    }),
  );
}

/**
 * @param {number} minutes
 * @param {boolean} escalationEnabled
 * @returns {string}
 */
const nextConsequence = (minutes, escalationEnabled) => {
  if (!escalationEnabled) return content.commands.history.nextDisabled;
  return minutes > 0
    ? fill(content.commands.history.nextTimeout, { minutes })
    : content.commands.history.nextNothing;
};

/**
 * `/mod on` and `/mod off`: the kill switch. Deliberately its own subcommand
 * rather than only a config flag: switching Mai off is the thing an admin wants
 * to do quickly, and `/mod` keeps answering while she is off.
 *
 * @param {object} interaction
 * @param {boolean} enabled
 */
function powerResponse(interaction, enabled) {
  if (!interaction.guild_id) return ephemeralResponse(content.commands.power.guildOnly);

  const already = effectiveSettings(interaction.guild_id).enabled === enabled;
  if (already) {
    return ephemeralResponse(
      enabled ? content.commands.power.onAlready : content.commands.power.offAlready,
    );
  }

  const actorId = interaction.member?.user?.id;
  updateSettings(interaction.guild_id, { enabled }, actorId);
  logger.info(
    { guildId: interaction.guild_id, enabled, byUserId: actorId },
    enabled ? 'Mai was switched on for a guild' : 'Mai was switched off for a guild',
  );
  // Posted even for `off`: the log channel is exactly where the rest of the
  // team should find out that Mai stopped moderating.
  announceConfigChange(interaction.guild_id, actorId, describeChanges({ enabled }));

  return ephemeralResponse(enabled ? content.commands.power.on : content.commands.power.off);
}

/**
 * `/mod history <user>`: the strike record this guild has on a member, and
 * what the next enforced deletion would cost them.
 *
 * @param {object} interaction
 */
function historyResponse(interaction) {
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const userId = String(optionValue(resolveSubcommand(interaction).options, 'user') ?? '');
  if (!userId) return ephemeralResponse(content.commands.error);

  const guildId = interaction.guild_id;
  const strikes = strikeCount(guildId, userId, strikeWindowStart(guildId));
  const totals = violationTotals(guildId, userId);
  const entries = historyFor(guildId, userId, 10);

  const settings = effectiveSettings(guildId);
  const ladder = ladderFor(guildId);
  // What the *next* enforced deletion would trigger.
  const next = settings.escalationEnabled
    ? ladder[Math.min(strikes + 1, ladder.length) - 1] ?? 0
    : 0;

  const actionLabel = (action) => content.commands.history.actions[action] ?? action;

  const lines = entries
    .map((entry) =>
      fill(content.commands.history.line, {
        when: `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:d>`,
        action: actionLabel(entry.action),
        categories: entry.categories.join(', ') || content.moderation.log.none,
      }),
    )
    .join('\n');

  // Built from whatever outcomes the record actually holds, so the parts always
  // add up to the total: a fixed list of buckets silently stopped matching
  // every time a new outcome was added.
  const breakdown = Object.entries(totals.byAction)
    .sort(([, a], [, b]) => b - a)
    .map(([action, count]) => `${count} ${actionLabel(action)}`)
    .join(', ');

  // The team's own memory of this member, next to what Mai did about them: the
  // whole point of a note is that the next moderator finds it where they are
  // already looking.
  const notes = notesFor(guildId, userId, 5)
    .map((entry) =>
      fill(content.commands.note.line, {
        when: `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:d>`,
        actorId: entry.authorId,
        note: entry.note,
      }),
    )
    .join('\n');

  return ephemeralResponse(
    fill(content.commands.history.body, {
      userId,
      strikes,
      window: settings.strikeWindowDays,
      total: totals.total,
      breakdown: breakdown ? ` (${breakdown})` : '',
      next: nextConsequence(next, settings.escalationEnabled),
      entries: lines || content.commands.history.empty,
      notes: notes || content.commands.note.empty,
    }),
  );
}

/**
 * Puts the guild on a preset (moderation/presets.js), which is one stored
 * decision rather than the six writes this used to be: `effectiveSettings`
 * resolves through the bundle, so the values stay changeable with
 * `/mod config set` and improving a bundle reaches servers already on it.
 *
 * @param {string} guildId
 * @param {string} name Preset name, which may have come from a `custom_id`.
 * @param {string|undefined} actorId
 * @param {string} [logChannelId] Set at the same time, because a server without
 *   one has no moderation log, no reports and no appeals.
 * @returns {{ applied: boolean, needsLogChannel: boolean }}
 */
function applyPreset(guildId, name, actorId, logChannelId) {
  const chosen = preset(name);
  if (!chosen) return { applied: false, needsLogChannel: false };

  const extra = logChannelId ? { 'log-channel': logChannelId } : {};
  if (!setProfile(guildId, name, actorId, extra)) {
    return { applied: false, needsLogChannel: false };
  }

  // `observe` is a period, not a state: it ends by itself and says so. Every
  // other preset is a statement of intent about shadow mode, so a window left
  // over from an earlier `observe` has to go, or it fires days later and
  // announces the end of an observation nobody was running.
  //
  // The explicit `shadow` column written here sits *above* the profile on
  // purpose: it is how the window ends, since the tick flips it to 0 and the
  // `observe` bundle underneath still says true.
  let until = null;
  if (chosen.observing && config.moderation.shadowDays > 0) {
    until = startShadowWindow(guildId, config.moderation.shadowDays);
  } else {
    clearShadowWindow(guildId);
  }

  logger.info({ guildId, preset: name, byUserId: actorId, until }, 'Applied a settings preset');
  announceConfigChange(guildId, actorId, describeChanges({ profile: name, ...extra }));

  return {
    applied: true,
    until,
    // Everything else has a working default; this one does not, and staff have
    // to be told rather than left wondering why reports go nowhere.
    needsLogChannel: !effectiveSettings(guildId).logChannelId,
  };
}

/**
 * `/mod setup <preset> [log-channel]`: the whole configuration in one command.
 *
 * @param {object} interaction
 */
function setupResponse(interaction) {
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const { options } = resolveSubcommand(interaction);
  // `name` here, not `preset`: that identifier is the imported lookup.
  const name = String(optionValue(options, 'preset') ?? '');
  const logChannelId = optionValue(options, 'log-channel');
  const actorId = interaction.member?.user?.id;

  const { applied, needsLogChannel, until } = applyPreset(
    interaction.guild_id,
    name,
    actorId,
    logChannelId ? String(logChannelId) : undefined,
  );
  if (!applied) return ephemeralResponse(content.commands.setup.unknownPreset);

  const { setup } = content.commands;
  const note = needsLogChannel ? `\n${setup.needsLogChannel}` : '';

  return ephemeralResponse(
    `${fill(setup.applied, { summary: setup.presets[name].summary })}${observationNote(until)}${note}\n\n`
      + `${configView(interaction.guild_id).data.content}`,
  );
}

/**
 * The end of an observation period, as a Discord timestamp so every reader
 * sees it in their own timezone.
 *
 * @param {string | null} until
 * @returns {string}
 */
const observationNote = (until) =>
  until
    ? ` ${fill(content.commands.setup.observationEnds, {
        until: `<t:${Math.floor(new Date(until).getTime() / 1000)}:R>`,
      })}`
    : '';

/**
 * The same thing from the introduction message Mai posts when she joins.
 *
 * The buttons sit in an ordinary channel where anyone can click them, so the
 * clicker's permissions are checked here rather than assumed from the fact that
 * the message exists. The answer replaces that message for everyone: which
 * preset a server chose is not a private fact about the person who clicked, and
 * it stops a second admin from picking a different one an hour later.
 */
export const setupComponents = {
  setup(interaction, [name]) {
    if (!mayModerate(interaction)) return ephemeralResponse(content.commands.forbidden);
    if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

    const actorId = interaction.member?.user?.id;
    const { applied, needsLogChannel, until } = applyPreset(interaction.guild_id, name, actorId);
    if (!applied) return ephemeralResponse(content.commands.setup.unknownPreset);

    const { setup } = content.commands;
    const note = needsLogChannel ? `\n${setup.needsLogChannel}` : '';

    return updateResponse(
      `${fill(setup.appliedPublic, {
        userId: actorId,
        summary: setup.presets[name].summary,
      })}${observationNote(until)}${note}`,
    );
  },
};

/**
 * `/mod simulate <text>`: what would happen to this message here?
 *
 * The answer to "where do I put the threshold?" without finding out by
 * deletion. It runs the guild's own policy over text the moderator typed
 * themselves and shows the score vector that produced the verdict, plus whether
 * a local rule would have caught it before the classifier was ever asked.
 *
 * The vector is the one place a full set of scores is shown (see `simulate` in
 * ai/moderation.js): the text is staff's own, the answer is ephemeral to them,
 * and nothing is stored or logged. Never point this at a member's message with
 * the intention of profiling them.
 *
 * @param {object} interaction
 */
async function simulateResponse(interaction) {
  const { simulate: lines } = content.commands;
  if (!config.moderation.enabled) return ephemeralResponse(lines.disabled);

  const text = String(optionValue(resolveSubcommand(interaction).options, 'text') ?? '').trim();
  if (!text) return ephemeralResponse(lines.empty);

  const userId = interaction.member?.user?.id ?? '';
  if (!simulateLimiter.consume(userId)) return ephemeralResponse(lines.busy);

  // `effectiveSettings(null)` in a DM yields the process defaults, which is a
  // useful thing for an operator to be able to check.
  const settings = effectiveSettings(interaction.guild_id);

  let verdict;
  try {
    verdict = await simulate(text, {
      guildId: interaction.guild_id,
      policy: { threshold: settings.threshold, categories: settings.categories },
    });
  } catch (error) {
    logger.error({ guildId: interaction.guild_id, err: error }, '/mod simulate failed');
    return ephemeralResponse(fill(lines.failed, { reason: describeError(error) }));
  }

  const local = contentViolations(text, settings);
  const scores = Object.entries(verdict.scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, SIMULATE_SCORES)
    .map(([category, score]) =>
      fill(lines.line, { category, score: Number(score).toFixed(3) }),
    )
    .join('\n');

  // Metadata only, and no text: the categories are worth having in the log, the
  // moderator's test string is not.
  logger.info(
    { guildId: interaction.guild_id, byUserId: userId, categories: verdict.categories, local },
    'Ran /mod simulate',
  );

  return ephemeralResponse(
    fill(lines.body, {
      verdict: local.length > 0 || verdict.flagged ? lines.wouldFlag : lines.wouldPass,
      local: local.length > 0 ? local.join(', ') : lines.noLocal,
      categories: verdict.categories.join(', ') || content.moderation.log.none,
      threshold: settings.threshold > 0 ? settings.threshold : content.commands.config.thresholdOff,
      scores: scores || content.moderation.log.none,
    }),
  );
}

/**
 * `/mod warn <user> [reason]`: a warning from staff, in Mai's voice.
 *
 * Mai could only ever warn somebody as a consequence of her own verdict, so a
 * moderator who wanted to say "stop that" either did it in the channel in front
 * of everyone or in their own DMs, where the rest of the team never sees it.
 *
 * On the record as `warned`, which is deliberately **not** a strike:
 * `strikeCount` only counts enforced deletions, so a human having a word cannot
 * silently move somebody up a ladder that ends in a timeout.
 *
 * @param {object} interaction
 */
async function warnResponse(interaction) {
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const { options } = resolveSubcommand(interaction);
  const userId = String(optionValue(options, 'user') ?? '');
  if (!userId) return ephemeralResponse(content.commands.error);

  const reason = String(optionValue(options, 'reason') ?? '').trim();
  const actorId = interaction.member?.user?.id;
  const client = getGatewayClient();

  const guildName = client?.guilds?.cache?.get(interaction.guild_id)?.name ?? '';
  const body = buildManualWarning({ reason, guildName });

  let delivered = false;
  try {
    const user = await client?.users?.fetch(userId);
    if (user) {
      await user.send({ content: body, allowedMentions: { parse: [] } });
      delivered = true;
    }
  } catch (error) {
    // Closed DMs are a normal outcome; the moderator is told in the reply and
    // the entry, so they can decide to say it in the channel instead.
    logger.info({ guildId: interaction.guild_id, userId, err: error }, 'Manual warning not delivered');
  }

  recordViolation({
    guildId: interaction.guild_id,
    userId,
    // No message behind this one: the record's message id is the actor's mark.
    messageId: `warn:${actorId ?? 'unknown'}`,
    categories: [],
    action: ACTION_WARNED,
  });

  logger.info(
    { guildId: interaction.guild_id, userId, byUserId: actorId, delivered, hasReason: Boolean(reason) },
    'Warned a member manually',
  );
  logger.debug({ userId, reason }, 'Manual warning reason');

  void postModerationLog(client, {
    type: LOG_WARNED,
    guildId: interaction.guild_id,
    userId,
    actorId,
    // Staff's own words, deliberately handed to staff: the same exception the
    // report reason falls under.
    reason: reason || undefined,
    resolution: delivered
      ? content.commands.warn.delivered
      : content.commands.warn.notDelivered,
  });

  return ephemeralResponse(
    fill(delivered ? content.commands.warn.done : content.commands.warn.undelivered, { userId }),
  );
}

/**
 * `/mod note add|clear <user>`: the team's own memory of a member.
 *
 * Its own store rather than a column on the strike record, because it answers a
 * different question: the record says what Mai did, a note says what the team
 * decided. Shown in `/mod history`, where the next moderator will look.
 *
 * @param {object} interaction
 */
function noteResponse(interaction) {
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const { name, options } = resolveSubcommand(interaction);
  const userId = String(optionValue(options, 'user') ?? '');
  if (!userId) return ephemeralResponse(content.commands.error);

  const actorId = interaction.member?.user?.id;
  const { note: lines } = content.commands;

  if (name === 'clear') {
    const removed = clearNotesFor(interaction.guild_id, userId);
    logger.info({ guildId: interaction.guild_id, userId, removed, byUserId: actorId }, 'Cleared member notes');
    return ephemeralResponse(fill(removed > 0 ? lines.cleared : lines.nothing, { count: removed, userId }));
  }

  const text = String(optionValue(options, 'text') ?? '').trim();
  if (!text) return ephemeralResponse(content.commands.error);

  addNote({ guildId: interaction.guild_id, userId, authorId: actorId ?? 'unknown', note: text });
  // The note itself only at debug, like every other piece of free text.
  logger.info({ guildId: interaction.guild_id, userId, byUserId: actorId }, 'Added a member note');
  logger.debug({ userId, note: text }, 'Member note');

  return ephemeralResponse(fill(lines.added, { userId }));
}

/**
 * Best-effort cleanup of the scold replies belonging to forgiven rows. Runs
 * detached: the interaction must be answered within Discord's 3 s window.
 *
 * @param {{ channelId: string, scoldMessageId: string | null }[]} rows
 */
function cleanUpScolds(rows) {
  const client = getGatewayClient();
  if (!client) return;

  for (const row of rows.filter((entry) => entry.scoldMessageId)) {
    client.channels
      .fetch(row.channelId)
      .then((channel) => channel?.messages?.delete(row.scoldMessageId))
      .catch((error) => {
        logger.debug(
          { channelId: row.channelId, messageId: row.scoldMessageId, err: error },
          'Deleting forgiven scold reply failed',
        );
      });
  }
}

/**
 * @param {object} interaction
 */
function forgiveResponse(interaction) {
  // A pardon is an act of authority, and authority stops at the guild border.
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const { options } = resolveSubcommand(interaction);
  const userId = optionValue(options, 'user');
  if (!userId) return ephemeralResponse(content.commands.error);

  const rows = forgiveUser(interaction.guild_id, String(userId));
  cleanUpScolds(rows);

  // Optional second step: also wipe the strike record, so the escalation ladder
  // starts from zero for this member in this guild. Any evidence kept for an
  // appeal goes with it: a pardon that leaves the member's deleted words in the
  // database is not a pardon.
  const clearStrikes = optionValue(options, 'strikes') === true;
  const strikesCleared = clearStrikes ? clearForUser(interaction.guild_id, String(userId)) : 0;
  if (clearStrikes) clearEvidenceFor(interaction.guild_id, String(userId));

  const actorId = interaction.member?.user?.id;
  logger.info(
    { guildId: interaction.guild_id, userId, forgiven: rows.length, strikesCleared, byUserId: actorId },
    'Forgave open violations',
  );

  if (rows.length > 0) {
    // Detached: the interaction must be answered inside Discord's window.
    void postModerationLog(getGatewayClient(), {
      type: LOG_FORGIVEN,
      guildId: interaction.guild_id,
      userId: String(userId),
      actorId,
      count: rows.length,
    });
  }

  const template = rows.length > 0 || strikesCleared > 0
    ? content.commands.forgive.done
    : content.commands.forgive.nothing;
  const strikeNote = strikesCleared > 0
    ? ` ${fill(content.commands.forgive.strikesCleared, { count: strikesCleared })}`
    : '';

  return ephemeralResponse(`${fill(template, { count: rows.length, userId })}${strikeNote}`);
}

/**
 * `/mod config view`: the effective settings of this guild, marking which ones
 * are inherited from the process defaults.
 *
 * @param {string} guildId
 */
function configView(guildId) {
  const settings = effectiveSettings(guildId);
  // Three layers, so three answers. An unmarked line is one this server set
  // itself, which is the one a moderator reading this most needs to spot.
  const marker = { profile: content.commands.config.fromProfile, default: content.commands.config.inherited };
  const inherited = (key) => (marker[settings.source[key]] ? ` ${marker[settings.source[key]]}` : '');
  const { unset, systemChannel, thresholdOff, allCategories, noExemptChannels, guardOff, noDomains } =
    content.commands.config;
  const yesNo = (value) => (value ? content.commands.config.on : content.commands.config.off);

  return ephemeralResponse(
    fill(content.commands.config.body, {
      profile: settings.profile ? `\`${settings.profile}\`` : content.commands.config.noProfile,
      enabled: yesNo(settings.enabled),
      enabledSource: inherited('enabled'),
      escalation: yesNo(settings.escalationEnabled),
      escalationSource: inherited('escalation'),
      // No log channel = no moderation log; no welcome channel = system channel.
      logChannel: settings.logChannelId ? `<#${settings.logChannelId}>` : unset,
      logChannelSource: inherited('log-channel'),
      // Already folded against the operator's intent switch, so this line says
      // what happens rather than what was asked for.
      welcome: yesNo(settings.welcomeEnabled),
      welcomeSource: inherited('welcome'),
      welcomeChannel: settings.welcomeChannelId ? `<#${settings.welcomeChannelId}>` : systemChannel,
      welcomeChannelSource: inherited('welcome-channel'),
      ladder: settings.timeoutLadder.join(', '),
      ladderSource: inherited('timeout-ladder'),
      strikeWindow: settings.strikeWindowDays,
      strikeWindowSource: inherited('strike-window'),
      grace: settings.gracePeriodMinutes,
      graceSource: inherited('grace'),
      // 0 means the provider's own `flagged` decides and no score is compared.
      threshold: settings.threshold > 0 ? settings.threshold : thresholdOff,
      thresholdSource: inherited('threshold'),
      categories: settings.categories.length ? settings.categories.join(', ') : allCategories,
      categoriesSource: inherited('categories'),
      exemptChannels: settings.exemptChannels.length
        ? settings.exemptChannels.map((id) => `<#${id}>`).join(' ')
        : noExemptChannels,
      exemptChannelsSource: inherited('exempt-channels'),
      // The rules Mai applies without a classifier. Each renders as its own
      // "off" rather than a bare 0 or an empty string: a moderator reading this
      // has to be able to tell "not set up" from "set to nothing".
      inviteFilter: yesNo(settings.inviteFilter),
      inviteFilterSource: inherited('invite-filter'),
      linkPolicy: settings.linkPolicy === 'off' ? guardOff : settings.linkPolicy,
      linkPolicySource: inherited('link-policy'),
      linkDomains: settings.linkDomains.length ? settings.linkDomains.join(', ') : noDomains,
      linkDomainsSource: inherited('link-domains'),
      mentionCap: settings.mentionCap > 0 ? settings.mentionCap : guardOff,
      mentionCapSource: inherited('mention-cap'),
      flood: settings.floodRule
        ? fill(content.commands.config.floodRule, settings.floodRule)
        : guardOff,
      floodSource: inherited('flood'),
      nameCheck: settings.nameCheck === 'off' ? guardOff : settings.nameCheck,
      nameCheckSource: inherited('name-check'),
      // `effectiveSettings` already folds in the operator's retention window,
      // so this line is what actually happens, not what was asked for.
      evidence: settings.evidenceEnabled
        ? fill(content.commands.config.evidenceOn, { hours: config.moderation.evidenceHours })
        : guardOff,
      evidenceSource: inherited('evidence'),
      // An observation period says when it ends; an open-ended one does not,
      // and the difference is the whole point of having both.
      shadow: settings.shadowMode
        ? `${content.commands.config.on}${
            settings.shadowUntil
              ? ` ${fill(content.commands.config.shadowUntil, {
                  until: `<t:${Math.floor(new Date(settings.shadowUntil).getTime() / 1000)}:R>`,
                })}`
              : ''
          }`
        : content.commands.config.off,
      shadowSource: inherited('shadow'),
    }),
  );
}

/**
 * Announces a settings change in the guild's own log channel.
 *
 * Staff change the rules on each other: a raised threshold, an exempted
 * channel, a pause. Without this the only trace is `updated_by` in a database
 * nobody can read from Discord, so the next moderator sees Mai behaving
 * differently with no way to find out why. Detached and best effort: the
 * interaction has ~3 s and a settings change must not fail on a log channel.
 *
 * @param {string} guildId
 * @param {string|undefined} actorId
 * @param {string} changes Already-formatted summary.
 */
function announceConfigChange(guildId, actorId, changes) {
  void postModerationLog(getGatewayClient(), {
    type: LOG_CONFIG,
    guildId,
    actorId,
    changes,
  });
}

/**
 * Renders a settings patch for the log entry. Every value here is metadata:
 * ids, numbers, booleans, category slugs, so it may go into a Discord channel.
 *
 * @param {Record<string, unknown>} patch
 * @returns {string}
 */
const describeChanges = (patch) =>
  Object.entries(patch)
    .map(([name, value]) => {
      if (value === null) return `\`${name}\` → ${content.commands.config.inherited}`;
      const rendered = name.endsWith('channel') || name.endsWith('channels')
        ? String(value).split(',').filter(Boolean).map((id) => `<#${id}>`).join(' ')
        : `\`${value}\``;
      return `\`${name}\` → ${rendered || content.moderation.log.none}`;
    })
    .join('\n');

/**
 * `/mod config set [log-channel] [welcome-channel] [grace]`: any subset.
 *
 * @param {object} interaction
 * @param {string} guildId
 */
function configSet(interaction, guildId) {
  const { options } = resolveSubcommand(interaction);
  const patch = {};
  for (const name of Object.keys(SETTINGS)) {
    const value = optionValue(options, name);
    if (value !== undefined) patch[name] = value;
  }

  if (Object.keys(patch).length === 0) {
    return ephemeralResponse(content.commands.config.nothing);
  }

  // Saying what shadow mode should be is a decision of its own, so it ends any
  // observation period that was running: otherwise the window fires later and
  // announces the end of something this moderator already settled by hand.
  if ('shadow' in patch) clearShadowWindow(guildId);

  try {
    updateSettings(guildId, patch, interaction.member?.user?.id);
  } catch (error) {
    if (error instanceof RangeError) {
      return ephemeralResponse(fill(content.commands.config.invalid, { reason: error.message }));
    }
    throw error;
  }

  const actorId = interaction.member?.user?.id;
  logger.info({ guildId, changed: Object.keys(patch), byUserId: actorId }, 'Updated guild settings');
  announceConfigChange(guildId, actorId, describeChanges(patch));

  // Two settings need something only the operator can switch on. The value is
  // stored either way (so it takes effect the moment they do), but staff have
  // to be told that nothing is happening yet: silently storing a setting that
  // does nothing is how a server ends up believing it is protected.
  const notes = unavailableNotes(patch);
  const view = configView(guildId);
  return notes.length > 0
    ? ephemeralResponse(`${notes.join('\n')}\n\n${view.data.content}`)
    : view;
}

/**
 * @param {Record<string, unknown>} patch
 * @returns {string[]}
 */
function unavailableNotes(patch) {
  const notes = [];

  // An intent is requested once, at login, for the whole process: a guild
  // cannot turn on the member events these two ride on. Stored anyway, so the
  // server is already configured the moment the operator flips the variable.
  if (patch['name-check'] && patch['name-check'] !== 'off' && !config.discord.memberEventsEnabled) {
    notes.push(content.commands.config.nameCheckUnavailable);
  }
  if (patch.welcome === true && !config.discord.memberEventsEnabled) {
    notes.push(content.commands.config.welcomeUnavailable);
  }
  // Retention is the operator's call, because it is their database.
  if (patch.evidence === true && config.moderation.evidenceHours === 0) {
    notes.push(content.commands.config.evidenceUnavailable);
  }

  return notes;
}

/**
 * `/mod config reset <setting>`: back to the inherited default.
 *
 * @param {object} interaction
 * @param {string} guildId
 */
function configReset(interaction, guildId) {
  const name = optionValue(resolveSubcommand(interaction).options, 'setting');

  try {
    resetSettings(guildId, name ? String(name) : undefined, interaction.member?.user?.id);
  } catch (error) {
    if (error instanceof RangeError) {
      return ephemeralResponse(fill(content.commands.config.invalid, { reason: error.message }));
    }
    throw error;
  }

  const actorId = interaction.member?.user?.id;
  logger.info({ guildId, reset: name ?? 'all', byUserId: actorId }, 'Reset guild settings');
  announceConfigChange(
    guildId,
    actorId,
    describeChanges(Object.fromEntries((name ? [name] : Object.keys(SETTINGS)).map((key) => [key, null]))),
  );

  return configView(guildId);
}

/**
 * @param {object} interaction
 */
function configResponse(interaction) {
  // Settings are per guild, so there is nothing to configure in a DM.
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const { name } = resolveSubcommand(interaction);
  if (name === 'set') return configSet(interaction, interaction.guild_id);
  if (name === 'reset') return configReset(interaction, interaction.guild_id);
  return configView(interaction.guild_id);
}

/**
 * `/mod exempt add|remove|list`: channels the delete/scold pipeline ignores.
 *
 * The underlying setting is a comma-separated list, which is unusable through
 * `/mod config set` (nobody types channel ids). These subcommands edit the same
 * value with a real channel picker; `/mod config view` and
 * `/mod config reset exempt-channels` keep working on it.
 *
 * @param {object} interaction
 */
function exemptResponse(interaction) {
  if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

  const { name, options } = resolveSubcommand(interaction);
  const guildId = interaction.guild_id;
  const current = effectiveSettings(guildId).exemptChannels;
  const { exempt } = content.commands;

  if (name === 'list') {
    const lines = current.map((channelId) => fill(exempt.line, { channelId })).join('\n');
    return ephemeralResponse(fill(exempt.body, { channels: lines || exempt.empty }));
  }

  const channelId = String(optionValue(options, 'channel') ?? '');
  if (!channelId) return ephemeralResponse(content.commands.error);

  const adding = name === 'add';
  if (adding && current.includes(channelId)) {
    return ephemeralResponse(fill(exempt.alreadyAdded, { channelId }));
  }
  if (!adding && !current.includes(channelId)) {
    return ephemeralResponse(fill(exempt.notExempt, { channelId }));
  }

  const next = adding
    ? [...current, channelId]
    : current.filter((id) => id !== channelId);

  const actorId = interaction.member?.user?.id;
  try {
    // null clears the override entirely, which is what an empty list means.
    updateSettings(guildId, { 'exempt-channels': next.length ? next.join(',') : null }, actorId);
  } catch (error) {
    if (error instanceof RangeError) return ephemeralResponse(exempt.limit);
    throw error;
  }

  logger.info({ guildId, channelId, exempt: adding, byUserId: actorId }, 'Updated exempt channels');
  announceConfigChange(guildId, actorId, describeChanges({ 'exempt-channels': next.join(',') }));

  return ephemeralResponse(fill(adding ? exempt.added : exempt.removed, { channelId }));
}

const settingChoices = Object.keys(SETTINGS).map((name) => ({ name, value: name }));

export const mod = {
  definition: {
    name: 'mod',
    description: "Mai's moderation state",
    type: 1, // CHAT_INPUT
    // Hides the command from members without Manage Messages.
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      {
        name: 'status',
        description: 'Queue depth, chat memory, last moderation run, missing permissions',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'setup',
        description: 'Configure this server in one go, from a preset',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'preset',
            description: 'observe = watch only (start here), standard = enforce, strict = harder',
            type: 3, // STRING
            required: true,
            choices: PRESET_NAMES.map((value) => ({ name: value, value })),
          },
          {
            name: 'log-channel',
            description: 'Where Mai posts moderation entries (needed for reports and appeals)',
            type: 7, // CHANNEL
            channel_types: [0, 5], // text, announcement
          },
        ],
      },
      {
        name: 'forgive',
        description: 'Drop a member’s open violations (Mai calms down)',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'user',
            description: 'The member to forgive',
            type: 6, // USER
            required: true,
          },
          {
            name: 'strikes',
            description: 'Also wipe their strike record, resetting the escalation ladder',
            type: 5, // BOOLEAN
          },
        ],
      },
      {
        name: 'history',
        description: 'A member’s strike record, staff notes, and what the next violation would cost',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'user',
            description: 'The member to look up',
            type: 6, // USER
            required: true,
          },
        ],
      },
      {
        name: 'warn',
        description: 'Send a member a warning from the team, in Mai’s voice (not a strike)',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'user',
            description: 'The member to warn',
            type: 6, // USER
            required: true,
          },
          {
            name: 'reason',
            description: 'What they should stop doing (goes into the DM and the log)',
            type: 3, // STRING
            max_length: 400,
          },
        ],
      },
      {
        name: 'simulate',
        description: 'What would happen to this text here? Scores, categories, local rules',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'text',
            description: 'The message to judge (nothing is stored)',
            type: 3, // STRING
            required: true,
            max_length: 400,
          },
        ],
      },
      {
        name: 'note',
        description: 'The team’s own notes about a member',
        type: 2, // SUB_COMMAND_GROUP
        options: [
          {
            name: 'add',
            description: 'Write down something the next moderator should know',
            type: 1,
            options: [
              {
                name: 'user',
                description: 'The member the note is about',
                type: 6, // USER
                required: true,
              },
              {
                name: 'text',
                description: 'The note itself',
                type: 3, // STRING
                required: true,
                max_length: MAX_NOTE_LENGTH,
              },
            ],
          },
          {
            name: 'clear',
            description: 'Remove every note about a member',
            type: 1,
            options: [
              {
                name: 'user',
                description: 'The member whose notes go',
                type: 6,
                required: true,
              },
            ],
          },
        ],
      },
      {
        name: 'off',
        description: 'Switch Mai off in this server completely (kill switch)',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'on',
        description: 'Switch Mai back on in this server',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'spend',
        description: 'OpenAI usage today and this month',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'exempt',
        description: 'Channels Mai does not moderate (chat and reactions keep working)',
        type: 2, // SUB_COMMAND_GROUP
        options: [
          {
            name: 'add',
            description: 'Stop moderating a channel',
            type: 1,
            options: [
              {
                name: 'channel',
                description: 'The channel to leave alone',
                type: 7, // CHANNEL
                required: true,
              },
            ],
          },
          {
            name: 'remove',
            description: 'Moderate a channel again',
            type: 1,
            options: [
              {
                name: 'channel',
                description: 'The channel to moderate again',
                type: 7,
                required: true,
              },
            ],
          },
          {
            name: 'list',
            description: 'Which channels are currently exempt',
            type: 1,
          },
        ],
      },
      {
        name: 'config',
        description: 'Per-server settings',
        type: 2, // SUB_COMMAND_GROUP
        options: [
          {
            name: 'view',
            description: 'Show the settings in effect here',
            type: 1,
          },
          {
            name: 'set',
            description: 'Change one or more settings',
            type: 1,
            options: [
              {
                name: 'log-channel',
                description: 'Where Mai posts moderation entries (metadata only)',
                type: 7, // CHANNEL
                channel_types: [0, 5], // text, announcement
              },
              {
                name: 'welcome',
                description: 'Greet new members at all (needs DISCORD_MEMBER_EVENTS)',
                type: 5, // BOOLEAN
              },
              {
                name: 'welcome-channel',
                description: 'Where new members are greeted (default: system channel)',
                type: 7,
                channel_types: [0, 5],
              },
              {
                name: 'grace',
                description: 'Minutes an author has to delete a flagged message (1-1440)',
                type: 4, // INTEGER
                min_value: 1,
                max_value: 1440,
              },
              {
                name: 'timeout-ladder',
                description: 'Timeout minutes per strike, e.g. 0,10,60,1440 (last step repeats)',
                type: 3, // STRING
              },
              {
                name: 'strike-window',
                description: 'Days a strike counts towards escalation (1-365)',
                type: 4, // INTEGER
                min_value: 1,
                max_value: 365,
              },
              {
                name: 'escalation',
                description: 'Hand out timeouts at all (strikes are recorded either way)',
                type: 5, // BOOLEAN
              },
              {
                name: 'enabled',
                description: 'Mai active in this server (the same switch as /mod off)',
                type: 5, // BOOLEAN
              },
              {
                name: 'threshold',
                description: 'Min. score 0-1 that counts as a violation (0 = let the provider decide)',
                type: 10, // NUMBER
                min_value: 0,
                max_value: 1,
              },
              {
                name: 'categories',
                description: 'Only these categories count, comma-separated (empty = all)',
                type: 3, // STRING
              },
              {
                name: 'invite-filter',
                description: 'Treat Discord invite links as a violation',
                type: 5, // BOOLEAN
              },
              {
                name: 'link-policy',
                description: 'What to do with links: off, or allow only link-domains',
                type: 3, // STRING
                choices: LINK_POLICIES.map((value) => ({ name: value, value })),
              },
              {
                name: 'link-domains',
                description: 'Allowed hosts, comma-separated (subdomains included)',
                type: 3, // STRING
              },
              {
                name: 'mention-cap',
                description: 'Most mentions one message may carry, @everyone included (0 = off)',
                type: 4, // INTEGER
                min_value: 0,
                max_value: 100,
              },
              {
                name: 'flood',
                description: 'Message burst rule as count/seconds, e.g. 6/10 (or off)',
                type: 3, // STRING
              },
              {
                name: 'name-check',
                description: 'Screen display names: off, log, or reset (removes the nickname)',
                type: 3, // STRING
                choices: NAME_CHECKS.map((value) => ({ name: value, value })),
              },
              {
                name: 'evidence',
                description: 'Keep deleted messages briefly, encrypted, so staff can review appeals',
                type: 5, // BOOLEAN
              },
              {
                name: 'shadow',
                description: 'Report verdicts in the log and act on none of them (threshold tuning)',
                type: 5, // BOOLEAN
              },
            ],
          },
          {
            name: 'reset',
            description: 'Back to the default (omit the setting to reset all)',
            type: 1,
            options: [
              {
                name: 'setting',
                description: 'Which setting to reset',
                type: 3, // STRING
                choices: settingChoices,
              },
            ],
          },
        ],
      },
    ],
  },

  // Only `simulate` waits for anything: it is a model call. Everything else
  // answers from the database inside Discord's window.
  deferred: (interaction) => resolveSubcommand(interaction).name === 'simulate',
  // Every `/mod` answer is staff-only, and for the deferred one the flag has to
  // be set at defer time: the later edit cannot turn a public message private.
  ephemeral: true,

  /**
   * @param {object} interaction Raw interaction payload from Discord.
   * @returns {Promise<object> | object} Interaction response body.
   */
  execute(interaction) {
    if (!mayModerate(interaction)) {
      logger.debug(
        { userId: interaction.member?.user?.id ?? interaction.user?.id },
        'Refusing /mod: missing Manage Messages',
      );
      return ephemeralResponse(content.commands.forbidden);
    }

    const { group, name } = resolveSubcommand(interaction);
    if (group === 'config') return configResponse(interaction);
    if (group === 'exempt') return exemptResponse(interaction);
    if (group === 'note') return noteResponse(interaction);
    if (name === 'setup') return setupResponse(interaction);
    if (name === 'on') return powerResponse(interaction, true);
    if (name === 'off') return powerResponse(interaction, false);
    if (name === 'forgive') return forgiveResponse(interaction);
    if (name === 'history') return historyResponse(interaction);
    if (name === 'warn') return warnResponse(interaction);
    if (name === 'simulate') return simulateResponse(interaction);
    if (name === 'spend') return spendResponse(interaction);
    return statusResponse(interaction);
  },
};
