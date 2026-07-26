/**
 * `/mai status` and `/mai forgive` — the operational window into Mai's state.
 *
 * Both subcommands need the Manage Messages permission. Discord already hides
 * the command from members without it (`default_member_permissions`), but the
 * check is repeated here: that field is a UI default a server admin can widen.
 */
import { InteractionResponseType } from 'discord-interactions';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { content, fill } from '../content.js';
import { stats as historyStats } from '../db/history.js';
import { depth, forgiveUser } from '../db/queue.js';
import { getGatewayClient } from '../gateway/client.js';
import { logger } from '../logger.js';
import { getEnforcerStatus } from '../moderation/enforcer.js';

const EPHEMERAL = 64;

const ephemeral = (text) => ({
  type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content: text, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
});

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
    : content.commands.statusNever;

  const openai = [
    `chat \`${config.openai.chatModel}\`${config.chat.enabled ? '' : ' (aus)'}`,
    `moderation \`${config.openai.moderationModel}\`${config.moderation.enabled ? '' : ' (aus)'}`,
  ].join(', ');

  return ephemeral(
    fill(content.commands.status, {
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
  const subcommand = interaction.data?.options?.[0];
  const userId = subcommand?.options?.find((option) => option.name === 'user')?.value;
  if (!userId) return ephemeral(content.commands.forbidden);

  const rows = forgiveUser(String(userId));
  cleanUpScolds(rows);

  logger.info(
    { userId, forgiven: rows.length, byUserId: interaction.member?.user?.id },
    'Forgave open violations',
  );

  const template = rows.length > 0 ? content.commands.forgiven : content.commands.forgivenNothing;
  return ephemeral(fill(template, { count: rows.length, userId }));
}

export const mai = {
  definition: {
    name: 'mai',
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
        'Refusing /mai: missing Manage Messages',
      );
      return ephemeral(content.commands.forbidden);
    }

    const subcommand = interaction.data?.options?.[0]?.name;
    if (subcommand === 'forgive') return forgiveResponse(interaction);
    return statusResponse();
  },
};
