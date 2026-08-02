/**
 * Appeals: the button under Mai's warning DM.
 *
 * Click -> modal -> the member's statement lands in that guild's moderation log,
 * next to the entries about their deleted messages. This is the one place where
 * a member's text is deliberately forwarded to staff, and it happens only
 * because they typed it and pressed submit.
 *
 * The button only exists when the guild has a log channel, otherwise an appeal
 * would go nowhere.
 */
import { PermissionFlagsBits } from 'discord.js';
import { isGuildAllowed } from '../config.js';
import { content, fill } from '../content.js';
import { evidenceFor } from '../db/evidence.js';
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
import { sanitize } from './warning.js';
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
 *   to know *which* strikes it overturns: the record may hold older, correct
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
          // A DM has no guild context: carry it in the id.
          custom_id: `appeal:${guildId}:${since}`,
        },
      ],
    },
  ];
}

/** @param {string} since Epoch seconds from a custom_id. */
const incidentIso = (since) => new Date(Number(since || 0) * 1000).toISOString();

/**
 * An appeal is staff attention, so it is limited per member regardless of which
 * door it came through: the DM button or `/mai appeal`.
 *
 * @param {string} userId
 * @returns {boolean}
 */
export const mayOpenAppeal = (userId) => appealLimiter.consume(userId);

/**
 * The appeal form itself. Shared with `/mai appeal`, which exists because a
 * member with closed DMs never receives the button: the warning DM bounces, and
 * without a second route they are enforced with no way to answer for it.
 *
 * Opening a modal is the immediate response to an interaction and cannot be
 * deferred, so every caller must reach this with synchronous work only.
 *
 * @param {string} guildId
 * @param {string | number} since Epoch seconds of the enforcement pass.
 * @returns {object} Interaction response.
 */
export const appealModal = (guildId, since) =>
  modalResponse({
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

export const appealButtons = {
  appeal(interaction, [guildId, since]) {
    // The router's own allowlist check passes trivially here: this button is
    // clicked in a DM, so `interaction.guild_id` is absent and both gates read
    // it as "not a guild interaction". The guild being acted on is the one in
    // the `custom_id`, so it is the one that has to be checked. An id that only
    // ever came from a warning DM Mai sent herself is still an id for a server
    // the operator may have removed from DISCORD_GUILD_IDS since.
    if (!isGuildAllowed(guildId)) return ephemeralResponse(content.commands.notActive);

    const member = actor(interaction);
    if (!mayOpenAppeal(member.id)) {
      return ephemeralResponse(content.moderation.appeal.busy);
    }

    return appealModal(guildId, since);
  },
};

/**
 * Buttons under a fresh appeal, so staff can answer it where the rest of the
 * team can see the answer.
 *
 * The appealing member's id rides in the `custom_id`: the log entry lives in a
 * guild channel, and by the time somebody clicks, the DM that produced the
 * appeal is long gone.
 *
 * The evidence button is only attached where there is evidence to show, which
 * is a per-guild decision (`/mod config set evidence:true`) on top of the
 * operator's retention window. Never a promise Mai cannot keep: a button that
 * always says "nothing stored" would just be noise on every entry.
 *
 * @param {string} userId
 * @param {string | number} since
 * @param {string} guildId
 */
const decisionButtons = (userId, since, guildId) => [
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
      ...(effectiveSettings(guildId).evidenceEnabled
        ? [
            {
              type: BUTTON,
              style: STYLE_SECONDARY,
              label: content.moderation.appeal.evidenceButton,
              custom_id: `appeal-evidence:${userId}:${since}`,
            },
          ]
        : []),
    ],
  },
];

/**
 * Tells the member what staff decided. Best effort: closed DMs are normal, and
 * the decision is already recorded in the channel either way.
 *
 * Reached **through the deciding guild** rather than through `users.fetch`. The
 * member id arrives in a `custom_id`, which names a target and never authorizes
 * one, and the bot's client can DM any account it can see: `report-approve`,
 * `threshold-undo` and `appeal-evidence` all prove their target against
 * `interaction.guild_id` for the same reason, and the strike overturn beside
 * this call already did. Costs no extra round trip, since fetching the member
 * replaces fetching the user, and a target who is not in the guild simply throws
 * into the catch below and is reported as undelivered.
 *
 * @param {string | undefined} guildId The guild whose staff decided.
 * @param {string} userId
 * @param {string} body
 * @returns {Promise<boolean>}
 */
async function notifyMember(guildId, userId, body) {
  if (!guildId) return false;

  try {
    // Cache, not a fetch: every guild Mai is in is cached at ready, and this
    // runs on a click with a deadline.
    const guild = getGatewayClient()?.guilds?.cache?.get(guildId);
    const member = await guild?.members?.fetch(userId);
    if (!member) return false;
    await member.send({ content: body, allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    logger.info({ guildId, userId, err: error }, 'Could not deliver an appeal decision');
    return false;
  }
}

/**
 * Records the decision in the log entry itself: title, colour, a resolution
 * field, buttons removed, so every moderator sees it, not just the clicker.
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
 * Scoped to the incident the appeal names: the enforcement pass that produced
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

/** Discord's message limit, minus room for the header. */
const EVIDENCE_MAX_LENGTH = 1900;
const EVIDENCE_MAX_CHARS_PER_MESSAGE = 500;

/**
 * Shows the moderator deciding an appeal what the deleted messages said.
 *
 * The one read path of the evidence store, and its shape is the point:
 *
 *   - **ephemeral**, always. The whole reason a deleted message may be kept at
 *     all is that one moderator needs to read it once; posting it into the
 *     channel would put the text back in front of everyone with access, which
 *     is exactly what deleting it was for.
 *   - **staff only**, checked in code. The button sits on a message in a staff
 *     channel, but a channel is not an authorization boundary.
 *   - **this guild only**: `interaction.guild_id`, never the id in the
 *     `custom_id`. The clicker names a member and an incident; they do not get
 *     to name a server.
 *   - **that incident only**: the same `since` the decision buttons carry, so
 *     reviewing one appeal does not open the member's back catalogue.
 *
 * Not deferred: a SQLite read and a string, well inside Discord's window.
 */
export const appealEvidence = {
  'appeal-evidence'(interaction, [userId, since]) {
    if (!mayModerate(interaction)) return ephemeralResponse(content.commands.forbidden);
    if (!interaction.guild_id) return ephemeralResponse(content.commands.config.guildOnly);

    const { appeal } = content.moderation;
    const entries = evidenceFor(interaction.guild_id, userId, incidentIso(since));

    // Count only, never the text: it is stored deliberately and briefly, and
    // repeating it into the container log would be a second copy with a
    // different lifetime.
    logger.info(
      {
        guildId: interaction.guild_id,
        userId,
        entries: entries.length,
        byUserId: actor(interaction).id,
      },
      'Appeal evidence viewed',
    );

    if (entries.length === 0) return ephemeralResponse(appeal.evidenceEmpty);

    const lines = [];
    const header = appeal.evidenceHeader;
    for (const entry of entries) {
      const text = sanitize(entry.content).slice(0, EVIDENCE_MAX_CHARS_PER_MESSAGE);
      const line = fill(appeal.evidenceLine, {
        when: `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:f>`,
        categories: entry.categories.join(', ') || content.moderation.log.none,
        text: text || (entry.attachments > 0 ? appeal.evidenceAttachment : appeal.evidenceEmptyMessage),
      });

      if (`${header}\n${[...lines, line].join('\n')}`.length > EVIDENCE_MAX_LENGTH) break;
      lines.push(line);
    }

    return ephemeralResponse(`${header}\n${lines.join('\n')}`);
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

  // Deliberately not an early refusal for a missing `guild_id`: this handler is
  // deferred for staff, and after a defer the response replaces the log entry
  // itself. It falls through as a failed action instead, so the outcome lands
  // *in* the entry (nothing overturned, decision not sent), which is the same
  // shape `report-approve` uses for its own cross-guild check.
  const delivered = await notifyMember(
    interaction.guild_id,
    userId,
    granted ? appeal.grantedDm : appeal.deniedDm,
  );

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
      + `${note} ${delivered ? appeal.decisionSent : appeal.decisionNotSent}`,
  });
}

// Fetching the member and sending a DM are two Discord round trips, which can
// outlast the ~3 s interaction budget. Deferring the *update* acknowledges the
// click and edits the entry afterwards, but only for staff, since after a
// defer the response is public and a refusal would overwrite the entry.
appealDecisions['appeal-grant'].deferred = (interaction) => mayModerate(interaction);
appealDecisions['appeal-deny'].deferred = (interaction) => mayModerate(interaction);

export const appealModals = {
  async 'appeal-submit'(interaction, [guildId, since]) {
    // Checked again on submit, not only when the modal opened: the id in the
    // `custom_id` is what decides where this is posted, and the two are separate
    // interactions. The kill switch is deliberately *not* checked: `/mod off` is
    // a pause on Mai acting in a server, and a member answering for enforcement
    // that already happened is the one thing that should still get through.
    if (!isGuildAllowed(guildId)) return ephemeralResponse(content.commands.notActive);

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
      { components: decisionButtons(member.id, since ?? 0, guildId) },
    );

    // Metadata at info, the statement itself only at debug: same rule as
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

// Same reason as the report modal: posting the appeal is a channel lookup plus
// a send, and a member who loses their statement to a timed-out interaction has
// no way to get it back. The whole point of an appeal is that it reaches staff.
appealModals['appeal-submit'].deferred = true;
