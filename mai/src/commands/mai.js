/**
 * `/mai`: the commands every member can use.
 *
 * `ask` runs a model call, so it declares `deferred`: the router answers Discord
 * with a placeholder first and edits it when the reply is ready. `forget` is the
 * self-service side of the privacy policy: it wipes what Mai remembers about the
 * caller, behind a confirmation button. `appeal` is the second door into the
 * appeals process, for members whose warning DM never arrived.
 */
import { buildMessages, generateReply } from '../ai/chat.js';
import { acquireSlot, consumeRateLimit, releaseSlot, withinBudget } from '../chat/limits.js';
import { config } from '../config.js';
import { content, fill } from '../content.js';
import { deleteForUser } from '../db/history.js';
import { openViolations } from '../db/queue.js';
import { effectiveSettings } from '../db/settings.js';
import { lastEnforcementPass } from '../db/violations.js';
import { getGatewayClient } from '../gateway/client.js';
import { logger } from '../logger.js';
import { appealModal, mayOpenAppeal } from '../moderation/appeal.js';
import { strikeWindowStart } from '../moderation/escalation.js';
import { screenInput } from '../moderation/screen.js';
import { ephemeralResponse, messageResponse, updateResponse } from '../interactions/respond.js';
import { optionValue, resolveSubcommand } from '../interactions/options.js';

const BUTTON = 2;
const ACTION_ROW = 1;
const STYLE_DANGER = 4;
const STYLE_SECONDARY = 2;

const actor = (interaction) => interaction.member?.user ?? interaction.user ?? {};

/**
 * @param {object} interaction
 * @returns {string}
 */
const askedQuestion = (interaction) =>
  String(optionValue(resolveSubcommand(interaction).options, 'frage') ?? '').trim();

/**
 * A public question to Mai. Unlike a mention this is stateless: no channel
 * history goes into the prompt and the exchange is not written to her memory:
 * one question, one answer.
 *
 * @param {object} interaction
 */
async function ask(interaction) {
  const user = actor(interaction);
  const question = askedQuestion(interaction);

  // This subcommand is deferred, and a deferred response cannot turn ephemeral
  // afterwards (the edit ignores `flags`), so every refusal below is a public,
  // in-character message rather than a private notice.
  if (!config.chat.enabled) return messageResponse(content.commands.ask.disabled);
  if (!question) return messageResponse(content.commands.ask.empty);
  if (!withinBudget()) return messageResponse(content.commands.ask.busy);
  if (!consumeRateLimit(user.id)) return messageResponse(content.commands.ask.busy);

  // The answer quotes the question back into the channel, so this command makes
  // Mai republish a member's text under her own name: the one path where a
  // slash command posts publicly without the message pipeline ever seeing it.
  // Screened before the model call so a refusal costs no tokens, and screened
  // fail-closed (see moderation/screen.js).
  const screened = await screenInput(question, { guildId: interaction.guild_id });
  if (!screened.ok) {
    logger.info(
      { userId: user.id, guildId: interaction.guild_id, categories: screened.categories },
      'Refused /mai ask: flagged question',
    );
    return messageResponse(content.commands.ask.refused);
  }

  if (!acquireSlot()) return messageResponse(content.commands.ask.busy);

  try {
    const messages = buildMessages({
      history: [],
      username: user.username ?? '',
      content: question,
      // Same grudge as in chat: an open violation makes her hiss here too.
      violations: openViolations(user.id),
    });

    const reply = await generateReply(messages, {
      userId: user.id,
      guildId: interaction.guild_id ?? null,
      client: getGatewayClient(),
    });
    logger.info(
      { userId: user.id, replyLength: reply.length, model: config.openai.chatModel },
      'Answered /mai ask',
    );
    logger.debug({ userId: user.id, question, reply }, '/mai ask content');

    // Public answer, quoting the question so the thread of conversation is
    // visible to everyone; the question is the caller's own text.
    return messageResponse(fill(content.commands.ask.answer, { question, reply }));
  } finally {
    releaseSlot();
  }
}

/**
 * `/mai appeal`: the way in for a member whose warning DM never arrived.
 *
 * The normal route is the button under that DM. A member with DMs closed for
 * the server gets none of it: their messages are deleted, they may be timed
 * out, and the message explaining why (with the button on it) bounces. This
 * command reconstructs the same appeal from the strike record, so the incident
 * a granted appeal overturns is still exactly the one being appealed, not the
 * member's whole file.
 *
 * Synchronous throughout: the answer is a modal, and Discord opens a modal as
 * the immediate response to the interaction, so nothing here may be deferred.
 *
 * @param {object} interaction
 */
function appeal(interaction) {
  const user = actor(interaction);
  const lines = content.commands.appeal;

  // The appeal names a guild's decision, and a DM has no guild.
  if (!interaction.guild_id) return ephemeralResponse(lines.guildOnly);
  // Same rule as reports: never open a form whose answer has nowhere to land.
  if (!effectiveSettings(interaction.guild_id).logChannelId) {
    return ephemeralResponse(lines.unavailable);
  }

  // Only strikes that still count: one that has aged out of the window has
  // nothing left for a granted appeal to overturn.
  const pass = lastEnforcementPass(
    interaction.guild_id,
    user.id,
    strikeWindowStart(interaction.guild_id),
  );
  if (!pass) return ephemeralResponse(lines.nothing);

  if (!mayOpenAppeal(user.id)) return ephemeralResponse(content.moderation.appeal.busy);

  logger.info(
    { guildId: interaction.guild_id, userId: user.id, strikes: pass.strikes },
    'Opened an appeal through /mai appeal',
  );

  // Seconds, like the button's custom_id: the id budget is 100 characters.
  return appealModal(interaction.guild_id, Math.floor(new Date(pass.sinceIso).getTime() / 1000));
}

/**
 * Step one of the memory wipe: ask for confirmation. The user id is carried in
 * the button's custom_id, so the click can be checked against its owner.
 *
 * @param {object} interaction
 */
function forget(interaction) {
  const user = actor(interaction);
  return ephemeralResponse(content.commands.forget.confirm, {
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: BUTTON,
            style: STYLE_DANGER,
            label: content.commands.forget.confirmButton,
            custom_id: `forget:${user.id}`,
          },
          {
            type: BUTTON,
            style: STYLE_SECONDARY,
            label: content.commands.forget.cancelButton,
            custom_id: `forget-cancel:${user.id}`,
          },
        ],
      },
    ],
  });
}

/**
 * Button handlers for the wipe. Registered in interactions/registry.js.
 *
 * The ephemeral message is only visible to its owner, but the custom_id is
 * checked anyway: never trust a client-supplied id to name someone else.
 */
export const forgetComponents = {
  forget(interaction, [ownerId]) {
    const user = actor(interaction);
    if (ownerId !== user.id) return ephemeralResponse(content.commands.forbidden);

    const removed = deleteForUser(user.id);
    logger.info({ userId: user.id, rowsRemoved: removed }, 'Wiped chat memory on request');

    return updateResponse(fill(content.commands.forget.done, { count: removed }));
  },

  'forget-cancel'(interaction, [ownerId]) {
    const user = actor(interaction);
    if (ownerId !== user.id) return ephemeralResponse(content.commands.forbidden);
    return updateResponse(content.commands.forget.cancelled);
  },
};

export const mai = {
  definition: {
    name: 'mai',
    description: 'Mit Mai reden',
    type: 1, // CHAT_INPUT
    options: [
      {
        name: 'ask',
        description: 'Stell Mai eine Frage',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'frage',
            description: 'Was willst du wissen?',
            type: 3, // STRING
            required: true,
            max_length: 400,
          },
        ],
      },
      {
        name: 'forget',
        description: 'Lösche, was Mai sich von dir gemerkt hat',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'appeal',
        description: 'Einspruch gegen deine letzte Verwarnung einlegen',
        type: 1, // SUB_COMMAND
      },
    ],
  },

  // `ask` waits for the model; `forget` and `appeal` answer instantly, and
  // `appeal` answers with a modal, which cannot be deferred at all.
  deferred: (interaction) => resolveSubcommand(interaction).name === 'ask',
  ephemeral: false,

  /**
   * @param {object} interaction Raw interaction payload from Discord.
   * @returns {Promise<object> | object} Interaction response body.
   */
  execute(interaction) {
    const { name } = resolveSubcommand(interaction);
    if (name === 'forget') return forget(interaction);
    if (name === 'appeal') return appeal(interaction);
    return ask(interaction);
  },
};
