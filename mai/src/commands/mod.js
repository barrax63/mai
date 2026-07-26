/**
 * `/mod` — the staff commands: what Mai currently has queued, and a pardon.
 *
 * Discord hides the command from members without Manage Messages
 * (`default_member_permissions`), but the check is repeated in code: that field
 * is a UI default a server admin can widen.
 */
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { content, fill } from '../content.js';
import { stats as historyStats } from '../db/history.js';
import { depth, forgiveUser } from '../db/queue.js';
import { effectiveSettings, resetSettings, SETTINGS, updateSettings } from '../db/settings.js';
import { breakdownFor, budgetState, dayKey, monthKey, totalsFor } from '../db/usage.js';
import {
  clearForUser,
  historyFor,
  strikeCount,
  totalsFor as violationTotals,
} from '../db/violations.js';
import { ladderFor, strikeWindowStart } from '../moderation/escalation.js';
import { getGatewayClient } from '../gateway/client.js';
import { logger } from '../logger.js';
import { getEnforcerStatus } from '../moderation/enforcer.js';
import { LOG_FORGIVEN, postModerationLog } from '../moderation/log.js';
import { optionValue, resolveSubcommand } from '../interactions/options.js';
import { ephemeralResponse } from '../interactions/respond.js';

/**
 * @param {object} interaction
 * @returns {boolean}
 */
function mayModerate(interaction) {
  // Absent in DMs — there is nothing to moderate there anyway.
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

function statusResponse() {
  const enforcer = getEnforcerStatus();
  const history = historyStats();

  const lastTick = enforcer.lastTickAt
    // Discord renders this as a localized relative timestamp.
    ? `<t:${Math.floor(new Date(enforcer.lastTickAt).getTime() / 1000)}:R>`
    : content.commands.status.never;

  const openai = [
    `chat \`${config.openai.chatModel}\`${config.chat.enabled ? '' : ' (aus)'}`,
    `moderation \`${config.openai.moderationModel}\`${config.moderation.enabled ? '' : ' (aus)'}`,
  ].join(', ');

  return ephemeralResponse(
    fill(content.commands.status.body, {
      queueDepth: depth(),
      historyRows: history.rows,
      historyChannels: history.channels,
      lastTick,
      openai,
      uptime: formatUptime(process.uptime()),
    }),
  );
}

const formatNumber = (value) => new Intl.NumberFormat('de-DE').format(value ?? 0);

/**
 * `/mod spend` — what Mai has cost this month, from the usage the API already
 * reports back. Tokens, not currency: pricing changes and is per model.
 */
function spendResponse() {
  const today = totalsFor(dayKey());
  const month = totalsFor(monthKey());
  const { used, budget, exceeded } = budgetState();

  const breakdown = breakdownFor(monthKey())
    .map((row) =>
      fill(content.commands.spend.line, {
        purpose: row.purpose,
        model: row.model,
        calls: formatNumber(row.calls),
        tokens: formatNumber(row.totalTokens),
      }),
    )
    .join('\n');

  const budgetLine = budget > 0
    ? fill(exceeded ? content.commands.spend.budgetExceeded : content.commands.spend.budgetOk, {
        used: formatNumber(used),
        budget: formatNumber(budget),
        percent: Math.round((used / budget) * 100),
      })
    : content.commands.spend.budgetOff;

  return ephemeralResponse(
    fill(content.commands.spend.body, {
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
 * `/mod on` and `/mod off` — the kill switch. Deliberately its own subcommand
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

  updateSettings(interaction.guild_id, { enabled }, interaction.member?.user?.id);
  logger.info(
    { guildId: interaction.guild_id, enabled, byUserId: interaction.member?.user?.id },
    enabled ? 'Mai was switched on for a guild' : 'Mai was switched off for a guild',
  );

  return ephemeralResponse(enabled ? content.commands.power.on : content.commands.power.off);
}

/**
 * `/mod history <user>` — the strike record this guild has on a member, and
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

  const lines = entries
    .map((entry) =>
      fill(content.commands.history.line, {
        when: `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:d>`,
        action: content.commands.history.actions[entry.action] ?? entry.action,
        categories: entry.categories.join(', ') || content.moderation.log.none,
      }),
    )
    .join('\n');

  return ephemeralResponse(
    fill(content.commands.history.body, {
      userId,
      strikes,
      window: settings.strikeWindowDays,
      total: totals.total,
      deleted: totals.deleted,
      selfDeleted: totals.selfDeleted,
      next: nextConsequence(next, settings.escalationEnabled),
      entries: lines || content.commands.history.empty,
    }),
  );
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
  const { options } = resolveSubcommand(interaction);
  const userId = optionValue(options, 'user');
  if (!userId) return ephemeralResponse(content.commands.error);

  const rows = forgiveUser(String(userId));
  cleanUpScolds(rows);

  // Optional second step: also wipe the strike record, so the escalation ladder
  // starts from zero for this member in this guild.
  const clearStrikes = optionValue(options, 'strikes') === true && interaction.guild_id;
  const strikesCleared = clearStrikes ? clearForUser(interaction.guild_id, String(userId)) : 0;

  const actorId = interaction.member?.user?.id;
  logger.info(
    { userId, forgiven: rows.length, strikesCleared, byUserId: actorId },
    'Forgave open violations',
  );

  if (rows.length > 0 && interaction.guild_id) {
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
 * `/mod config view` — the effective settings of this guild, marking which ones
 * are inherited from the process defaults.
 *
 * @param {string} guildId
 */
function configView(guildId) {
  const settings = effectiveSettings(guildId);
  const inherited = (key) => (settings.inherited[key] ? ` ${content.commands.config.inherited}` : '');
  const { unset, systemChannel } = content.commands.config;
  const yesNo = (value) => (value ? content.commands.config.on : content.commands.config.off);

  return ephemeralResponse(
    fill(content.commands.config.body, {
      enabled: yesNo(settings.enabled),
      enabledSource: inherited('enabled'),
      escalation: yesNo(settings.escalationEnabled),
      escalationSource: inherited('escalation'),
      // No log channel = no moderation log; no welcome channel = system channel.
      logChannel: settings.logChannelId ? `<#${settings.logChannelId}>` : unset,
      logChannelSource: inherited('log-channel'),
      welcomeChannel: settings.welcomeChannelId ? `<#${settings.welcomeChannelId}>` : systemChannel,
      welcomeChannelSource: inherited('welcome-channel'),
      ladder: settings.timeoutLadder.join(', '),
      ladderSource: inherited('timeout-ladder'),
      strikeWindow: settings.strikeWindowDays,
      strikeWindowSource: inherited('strike-window'),
      grace: settings.gracePeriodMinutes,
      graceSource: inherited('grace'),
    }),
  );
}

/**
 * `/mod config set [log-channel] [welcome-channel] [grace]` — any subset.
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

  try {
    updateSettings(guildId, patch, interaction.member?.user?.id);
  } catch (error) {
    if (error instanceof RangeError) {
      return ephemeralResponse(fill(content.commands.config.invalid, { reason: error.message }));
    }
    throw error;
  }

  logger.info(
    { guildId, changed: Object.keys(patch), byUserId: interaction.member?.user?.id },
    'Updated guild settings',
  );
  return configView(guildId);
}

/**
 * `/mod config reset <setting>` — back to the inherited default.
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

  logger.info(
    { guildId, reset: name ?? 'all', byUserId: interaction.member?.user?.id },
    'Reset guild settings',
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
        description: 'Queue depth, chat memory, last moderation run',
        type: 1, // SUB_COMMAND
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
        description: 'A member’s strike record and what the next violation would cost',
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
                description: 'Mai active in this server — the same switch as /mod off',
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

  /**
   * @param {object} interaction Raw interaction payload from Discord.
   * @returns {object} Interaction response body.
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
    if (name === 'on') return powerResponse(interaction, true);
    if (name === 'off') return powerResponse(interaction, false);
    if (name === 'forgive') return forgiveResponse(interaction);
    if (name === 'history') return historyResponse(interaction);
    if (name === 'spend') return spendResponse();
    return statusResponse();
  },
};
