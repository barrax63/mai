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
import { getGatewayClient } from '../gateway/client.js';
import { logger } from '../logger.js';
import { getEnforcerStatus } from '../moderation/enforcer.js';
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
  const userId = interaction.data?.options?.[0]?.options
    ?.find((option) => option.name === 'user')?.value;
  if (!userId) return ephemeralResponse(content.commands.error);

  const rows = forgiveUser(String(userId));
  cleanUpScolds(rows);

  logger.info(
    { userId, forgiven: rows.length, byUserId: interaction.member?.user?.id },
    'Forgave open violations',
  );

  const template = rows.length > 0
    ? content.commands.forgive.done
    : content.commands.forgive.nothing;
  return ephemeralResponse(fill(template, { count: rows.length, userId }));
}

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

    const subcommand = interaction.data?.options?.[0]?.name;
    if (subcommand === 'forgive') return forgiveResponse(interaction);
    return statusResponse();
  },
};
