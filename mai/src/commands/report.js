/**
 * "Mai: melden" — the message context-menu report.
 *
 * Right-click a message -> Apps -> the entry below -> a modal asks why -> the
 * report lands in the guild's moderation log with Approve / Dismiss buttons for
 * staff. Without a configured log channel there is nowhere to report to, and
 * the command says so instead of swallowing the report.
 *
 * Like the rest of the log, the entry is metadata plus the reporter's own words:
 * the reported message itself is only linked, never copied.
 */
import { PermissionFlagsBits } from 'discord.js';
import { content, fill } from '../content.js';
import { effectiveSettings } from '../db/settings.js';
import { getGatewayClient } from '../gateway/client.js';
import { modalValue, targetMessage } from '../interactions/options.js';
import {
  ephemeralResponse,
  modalResponse,
  PARAGRAPH_INPUT,
  textInput,
  updateResponse,
} from '../interactions/respond.js';
import { logger } from '../logger.js';
import { LOG_REPORTED, postModerationLog } from '../moderation/log.js';
import { createRateLimiter } from '../rate-limit.js';

const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_DANGER = 4;
const STYLE_SECONDARY = 2;

const REASON_INPUT = 'reason';
const REASON_MAX_LENGTH = 500;

// Staff attention is the scarce resource here, so this is deliberately tight.
const reportLimiter = createRateLimiter({ max: 5, windowMs: 10 * 60_000, name: 'report' });

const actor = (interaction) => interaction.member?.user ?? interaction.user ?? {};

const mayModerate = (interaction) => {
  const raw = interaction.member?.permissions;
  if (!raw) return false;
  try {
    return (BigInt(raw) & PermissionFlagsBits.ManageMessages) === PermissionFlagsBits.ManageMessages;
  } catch {
    return false;
  }
};

/**
 * Buttons under a fresh report.
 *
 * @param {string} channelId
 * @param {string} messageId
 */
const reviewButtons = (channelId, messageId) => [
  {
    type: ACTION_ROW,
    components: [
      {
        type: BUTTON,
        style: STYLE_DANGER,
        label: content.commands.report.approveButton,
        custom_id: `report-approve:${channelId}:${messageId}`,
      },
      {
        type: BUTTON,
        style: STYLE_SECONDARY,
        label: content.commands.report.dismissButton,
        custom_id: `report-dismiss:${channelId}:${messageId}`,
      },
    ],
  },
];

/**
 * Marks a report as handled: the buttons go away and the entry keeps a record of
 * who decided what.
 *
 * @param {object} interaction
 * @param {string} resolution
 */
function resolveReport(interaction, resolution) {
  const embed = interaction.message?.embeds?.[0];
  const fields = [
    ...(embed?.fields ?? []),
    { name: content.moderation.log.fields.resolution, value: resolution, inline: false },
  ];

  return updateResponse(null, {
    components: [],
    embeds: [{ ...embed, fields }],
  });
}

export const reportComponents = {
  /** Staff agreed: delete the reported message. */
  async 'report-approve'(interaction, [channelId, messageId]) {
    if (!mayModerate(interaction)) return ephemeralResponse(content.commands.forbidden);

    const staff = actor(interaction);
    let deleted = false;
    try {
      const channel = await getGatewayClient()?.channels?.fetch(channelId);
      await channel?.messages?.delete(messageId);
      deleted = true;
    } catch (error) {
      // Already gone, or Mai lacks the permission — both are worth showing in
      // the entry rather than failing the click.
      logger.warn(
        { channelId, messageId, err: error },
        'Could not delete a reported message',
      );
    }

    logger.info(
      { channelId, messageId, byUserId: staff.id, deleted },
      'Report approved',
    );

    return resolveReport(
      interaction,
      fill(
        deleted ? content.commands.report.approved : content.commands.report.approvedFailed,
        { userId: staff.id },
      ),
    );
  },

  /** Staff disagreed: keep the message, close the entry. */
  'report-dismiss'(interaction, [channelId, messageId]) {
    if (!mayModerate(interaction)) return ephemeralResponse(content.commands.forbidden);

    const staff = actor(interaction);
    logger.info({ channelId, messageId, byUserId: staff.id }, 'Report dismissed');

    return resolveReport(
      interaction,
      fill(content.commands.report.dismissed, { userId: staff.id }),
    );
  },
};

export const reportModals = {
  /**
   * The reason modal was submitted — publish the report.
   */
  async report(interaction, [channelId, messageId, authorId]) {
    const reporter = actor(interaction);
    const reason = modalValue(interaction, REASON_INPUT);

    const posted = await postModerationLog(
      getGatewayClient(),
      {
        type: LOG_REPORTED,
        guildId: interaction.guild_id,
        channelId,
        messageId,
        userId: authorId,
        reporterId: reporter.id,
        reason: reason || null,
      },
      { components: reviewButtons(channelId, messageId) },
    );

    logger.info(
      { guildId: interaction.guild_id, channelId, messageId, reporterId: reporter.id, posted },
      'Message reported',
    );
    logger.debug({ messageId, reason }, 'Report reason');

    return ephemeralResponse(
      posted ? content.commands.report.thanks : content.commands.report.failed,
    );
  },
};

export const report = {
  definition: {
    // Context-menu entries carry no description and show their name verbatim.
    name: 'Mai: melden',
    type: 3, // MESSAGE
  },

  /**
   * @param {object} interaction
   * @returns {object} A modal asking for the reason, or a refusal.
   */
  execute(interaction) {
    if (!interaction.guild_id) return ephemeralResponse(content.commands.report.guildOnly);

    // No log channel means the report would go nowhere.
    if (!effectiveSettings(interaction.guild_id).logChannelId) {
      return ephemeralResponse(content.commands.report.unavailable);
    }

    const reporter = actor(interaction);
    if (!reportLimiter.consume(reporter.id)) {
      return ephemeralResponse(content.commands.report.busy);
    }

    const message = targetMessage(interaction);
    const channelId = interaction.channel_id;
    const messageId = interaction.data?.target_id;
    const authorId = message?.author?.id ?? '';

    return modalResponse({
      // Everything the submit handler needs: there is no server-side session.
      customId: `report:${channelId}:${messageId}:${authorId}`,
      title: content.commands.report.modalTitle,
      components: [
        textInput({
          customId: REASON_INPUT,
          label: content.commands.report.reasonLabel,
          style: PARAGRAPH_INPUT,
          required: false,
          maxLength: REASON_MAX_LENGTH,
          placeholder: content.commands.report.reasonPlaceholder,
        }),
      ],
    });
  },
};
