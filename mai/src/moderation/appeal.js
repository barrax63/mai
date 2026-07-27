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
import { PermissionFlagsBits } from 'discord.js';
import { content, fill } from '../content.js';
import { effectiveSettings } from '../db/settings.js';
import { overturnSince } from '../db/violations.js';
import { getGatewayClient } from '../gateway/client.js';
import { modalValue } from '../interactions/options.js';
import {
  ephemeralResponse,
  modalResponse,
  PARAGRAPH_INPUT,
  textInput,
  updateResponse,
} from '../interactions/respond.js';
import { logger } from '../logger.js';
import { LOG_APPEALED, postModerationLog } from './log.js';
import { createRateLimiter } from '../rate-limit.js';

const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_SECONDARY = 2;
const STYLE_SUCCESS = 3;

/** Same check as `/mod`: the UI hides these buttons, code decides. */
const mayModerate = (interaction) => {
  const raw = interaction.member?.permissions;
  if (!raw) return false;
  try {
    return (BigInt(raw) & PermissionFlagsBits.ManageMessages) === PermissionFlagsBits.ManageMessages;
  } catch {
    return false;
  }
};

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
 * @param {string} [sinceIso] Start of the enforcement pass this DM is about.
 *   Carried all the way to the decision buttons, because granting an appeal has
 *   to know *which* strikes it overturns — the record may hold older, correct
 *   ones that this appeal says nothing about.
 * @returns {object[]}
 */
export function appealComponents(guildId, sinceIso) {
  if (!effectiveSettings(guildId).logChannelId) return [];

  // Seconds, not an ISO string: the custom_id budget is 100 characters.
  const since = Math.floor(new Date(sinceIso ?? Date.now()).getTime() / 1000) || 0;

  return [
    {
      type: ACTION_ROW,
      components: [
        {
          type: BUTTON,
          style: STYLE_SECONDARY,
          label: content.moderation.appeal.button,
          // A DM has no guild context — carry it in the id.
          custom_id: `appeal:${guildId}:${since}`,
        },
      ],
    },
  ];
}

/** @param {string} since Epoch seconds from a custom_id. */
const incidentIso = (since) => new Date(Number(since || 0) * 1000).toISOString();

export const appealButtons = {
  appeal(interaction, [guildId, since]) {
    const member = actor(interaction);
    if (!appealLimiter.consume(member.id)) {
      return ephemeralResponse(content.moderation.appeal.busy);
    }

    return modalResponse({
      customId: `appeal-submit:${guildId}:${since ?? 0}`,
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

/**
 * Buttons under a fresh appeal, so staff can answer it where the rest of the
 * team can see the answer.
 *
 * The appealing member's id rides in the `custom_id` — the log entry lives in a
 * guild channel, and by the time somebody clicks, the DM that produced the
 * appeal is long gone.
 *
 * @param {string} userId
 */
const decisionButtons = (userId, since) => [
  {
    type: ACTION_ROW,
    components: [
      {
        type: BUTTON,
        style: STYLE_SUCCESS,
        label: content.moderation.appeal.grantButton,
        custom_id: `appeal-grant:${userId}:${since}`,
      },
      {
        type: BUTTON,
        style: STYLE_SECONDARY,
        label: content.moderation.appeal.denyButton,
        custom_id: `appeal-deny:${userId}:${since}`,
      },
    ],
  },
];

/**
 * Tells the member what staff decided. Best effort: closed DMs are normal, and
 * the decision is already recorded in the channel either way.
 *
 * @param {string} userId
 * @param {string} body
 * @returns {Promise<boolean>}
 */
async function notifyMember(userId, body) {
  try {
    const user = await getGatewayClient()?.users?.fetch(userId);
    if (!user) return false;
    await user.send({ content: body, allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    logger.info({ userId, err: error }, 'Could not deliver an appeal decision');
    return false;
  }
}

/**
 * Records the decision in the log entry itself — title, colour, a resolution
 * field, buttons removed — so every moderator sees it, not just the clicker.
 * Same reasoning as the report buttons.
 *
 * @param {object} interaction
 * @param {{ title: string, color: number, resolution: string }} decision
 */
function resolveAppeal(interaction, decision) {
  const embed = interaction.message?.embeds?.[0] ?? {};
  const fields = [
    // A second click replaces the resolution instead of stacking another one.
    ...(embed.fields ?? []).filter(
      (field) => field.name !== content.moderation.log.fields.resolution,
    ),
    { name: content.moderation.log.fields.resolution, value: decision.resolution, inline: false },
  ];

  return updateResponse(null, {
    components: [],
    embeds: [{ ...embed, title: decision.title, color: decision.color, fields }],
  });
}

const GRANTED_COLOR = 0x27ae60;
const DENIED_COLOR = 0x2c3e50;

/**
 * Staff answering an appeal.
 *
 * Granting means Mai was wrong, so the strikes it is about stop counting: they
 * are marked `overturned` rather than deleted, which keeps the record honest
 * (it shows a mistake was made and corrected) while taking them out of
 * `strikeCount` and therefore out of the escalation ladder.
 *
 * Scoped to the incident the appeal names — the enforcement pass that produced
 * the warning DM, carried through the `custom_id` since the DM itself is long
 * gone by then. Appealing one incident must not clear four earlier, correct
 * strikes; staff who mean *that* run `/mod forgive <user> strikes:true`.
 */
export const appealDecisions = {
  async 'appeal-grant'(interaction, [userId, since]) {
    return decide(interaction, userId, since, true);
  },

  async 'appeal-deny'(interaction, [userId, since]) {
    return decide(interaction, userId, since, false);
  },
};

/**
 * @param {object} interaction
 * @param {string} userId The appealing member.
 * @param {string} since Epoch seconds of the incident, from the custom_id.
 * @param {boolean} granted
 */
async function decide(interaction, userId, since, granted) {
  if (!mayModerate(interaction)) return ephemeralResponse(content.commands.forbidden);

  const staff = actor(interaction);
  const { appeal } = content.moderation;

  let overturned = 0;
  if (granted && interaction.guild_id) {
    overturned = overturnSince(interaction.guild_id, userId, incidentIso(since));
  }

  const delivered = await notifyMember(userId, granted ? appeal.grantedDm : appeal.deniedDm);

  logger.info(
    { guildId: interaction.guild_id, userId, granted, overturned, delivered, byUserId: staff.id },
    'Appeal decided',
  );

  const note = granted && overturned > 0
    ? ` ${fill(appeal.strikesOverturned, { count: overturned })}`
    : '';

  return resolveAppeal(interaction, {
    title: granted ? content.moderation.log.titles.appealGranted : content.moderation.log.titles.appealDenied,
    color: granted ? GRANTED_COLOR : DENIED_COLOR,
    resolution: `${fill(granted ? appeal.granted : appeal.denied, { userId: staff.id })}`
      + `${note} — ${delivered ? appeal.decisionSent : appeal.decisionNotSent}`,
  });
}

// Fetching the member and sending a DM are two Discord round trips, which can
// outlast the ~3 s interaction budget. Deferring the *update* acknowledges the
// click and edits the entry afterwards — but only for staff, since after a
// defer the response is public and a refusal would overwrite the entry.
appealDecisions['appeal-grant'].deferred = (interaction) => mayModerate(interaction);
appealDecisions['appeal-deny'].deferred = (interaction) => mayModerate(interaction);

export const appealModals = {
  async 'appeal-submit'(interaction, [guildId, since]) {
    const member = actor(interaction);
    const text = modalValue(interaction, APPEAL_INPUT);
    if (!text) return ephemeralResponse(content.moderation.appeal.empty);

    const posted = await postModerationLog(
      getGatewayClient(),
      {
        type: LOG_APPEALED,
        guildId,
        userId: member.id,
        reason: text,
        // Shown in the entry so staff can see which enforcement pass is being
        // appealed without hunting through the log.
        since: incidentIso(since),
      },
      { components: decisionButtons(member.id, since ?? 0) },
    );

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
