/**
 * Appeals: the button under Mai's warning DM.
 *
 * Click -> modal -> the member's statement lands in that guild's moderation log,
 * next to the entries about their deleted messages. This is the one place where
 * a member's text is deliberately forwarded to staff, and it happens only
 * because they typed it and pressed submit.
 *
 * The button only exists when the guild has a log channel — otherwise an appeal
 * would go nowhere.
 */
import { content, fill } from '../content.js';
import { effectiveSettings } from '../db/settings.js';
import { getGatewayClient } from '../gateway/client.js';
import { modalValue } from '../interactions/options.js';
import {
  ephemeralResponse,
  modalResponse,
  PARAGRAPH_INPUT,
  textInput,
} from '../interactions/respond.js';
import { logger } from '../logger.js';
import { LOG_APPEALED, postModerationLog } from './log.js';
import { createRateLimiter } from '../rate-limit.js';

const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_SECONDARY = 2;

const APPEAL_INPUT = 'text';
const APPEAL_MAX_LENGTH = 1000;

// An appeal is read by a human, so a handful per hour is plenty.
const appealLimiter = createRateLimiter({ max: 3, windowMs: 60 * 60_000, name: 'appeal' });

const actor = (interaction) => interaction.member?.user ?? interaction.user ?? {};

/**
 * Components for the warning DM, or an empty array when the guild cannot
 * receive appeals.
 *
 * @param {string} guildId
 * @returns {object[]}
 */
export function appealComponents(guildId) {
  if (!effectiveSettings(guildId).logChannelId) return [];

  return [
    {
      type: ACTION_ROW,
      components: [
        {
          type: BUTTON,
          style: STYLE_SECONDARY,
          label: content.moderation.appeal.button,
          // A DM has no guild context — carry it in the id.
          custom_id: `appeal:${guildId}`,
        },
      ],
    },
  ];
}

export const appealButtons = {
  appeal(interaction, [guildId]) {
    const member = actor(interaction);
    if (!appealLimiter.consume(member.id)) {
      return ephemeralResponse(content.moderation.appeal.busy);
    }

    return modalResponse({
      customId: `appeal-submit:${guildId}`,
      title: content.moderation.appeal.modalTitle,
      components: [
        textInput({
          customId: APPEAL_INPUT,
          label: content.moderation.appeal.inputLabel,
          style: PARAGRAPH_INPUT,
          required: true,
          maxLength: APPEAL_MAX_LENGTH,
          placeholder: content.moderation.appeal.inputPlaceholder,
        }),
      ],
    });
  },
};

export const appealModals = {
  async 'appeal-submit'(interaction, [guildId]) {
    const member = actor(interaction);
    const text = modalValue(interaction, APPEAL_INPUT);
    if (!text) return ephemeralResponse(content.moderation.appeal.empty);

    const posted = await postModerationLog(getGatewayClient(), {
      type: LOG_APPEALED,
      guildId,
      userId: member.id,
      reason: text,
    });

    // Metadata at info, the statement itself only at debug — same rule as
    // everywhere else.
    logger.info({ guildId, userId: member.id, length: text.length, posted }, 'Appeal submitted');
    logger.debug({ userId: member.id, appeal: text }, 'Appeal text');

    return ephemeralResponse(
      posted
        ? fill(content.moderation.appeal.submitted, { userId: member.id })
        : content.moderation.appeal.failed,
    );
  },
};
