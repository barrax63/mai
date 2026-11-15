/**
 * `/mai`: the commands every member can use.
 *
 * `ask` runs a model call, so it declares `deferred`: the router answers Discord
 * with a placeholder first and edits it when the reply is ready. `forget` is the
 * self-service side of the privacy policy: it wipes what Mai remembers about the
 * caller, behind a confirmation button. `appeal` is the second door into the
 * appeals process, for members whose warning DM never arrived. `pet` is a cat
 * being a cat: costs nothing, calls nothing, and can end in a bite. `mood` is
 * the same price and says how she is doing, minus anything she must not say.
 * `laser` is a game anybody in the channel can play, carried entirely by its
 * own button.
 */
import { buildMessages, generateReply } from '../ai/chat.js';
import { acquireSlot, consumeRateLimit, releaseSlot, withinBudget } from '../chat/limits.js';
import { gifEmbeds } from '../chat/reply.js';
import { config } from '../config.js';
import { content, fill, pick } from '../content.js';
import { gotchaDay } from '../chat/gotcha.js';
import { laserId, moveDot, parseScore } from '../chat/laser.js';
import { describeMood } from '../chat/mood.js';
import { isSulking, pet } from '../chat/petting.js';
import { territoryFor } from '../chat/territory.js';
import { napping } from '../naps.js';
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
  // Asleep, which is the other half of the chat path: a command is not a
  // reason to wake a cat.
  if (napping()) return messageResponse(content.commands.ask.sleeping);
  // Still sulking with this member after biting them: she stops answering
  // them, and this is one of the two places answering happens.
  if (isSulking(user.id)) return messageResponse(pick(content.commands.pet.sulking));
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
    const client = getGatewayClient();
    const messages = buildMessages({
      history: [],
      username: user.username ?? '',
      content: question,
      // Same grudge as in chat: an open violation makes her hiss here too.
      violations: openViolations(user.id),
      guildId: interaction.guild_id ?? null,
      // Same claim as in chat. The parent arrives with the interaction's
      // channel when this is asked inside a thread.
      territory: territoryFor(client, interaction.guild_id, {
        channelId: interaction.channel_id ?? null,
        parentId: interaction.channel?.parent_id ?? null,
      }),
      // And the same anniversary.
      gotchaYears: gotchaDay(interaction.guild_id),
    });

    const reply = await generateReply(messages, {
      userId: user.id,
      guildId: interaction.guild_id ?? null,
      client,
    });
    logger.info(
      {
        userId: user.id,
        replyLength: reply.text.length,
        gif: Boolean(reply.gifUrl),
        model: config.openai.chatModel,
      },
      'Answered /mai ask',
    );
    logger.debug({ userId: user.id, question, reply: reply.text }, '/mai ask content');

    // Public answer, quoting the question so the thread of conversation is
    // visible to everyone; the question is the caller's own text. A GIF she
    // chose rides along as an embed, the same as in chat, so no address ends
    // up in the text.
    return messageResponse(
      fill(content.commands.ask.answer, { question, reply: reply.text }),
      { embeds: gifEmbeds(reply.gifUrl) },
    );
  } finally {
    releaseSlot();
  }
}

/**
 * `/mai pet`: stroke the cat.
 *
 * Synchronous and free: no model call, no database, no Discord round trip, just
 * a counter in memory and a line from the config. The answer is public, because
 * getting bitten in front of everybody is the joke.
 *
 * @param {object} interaction
 */
function petMai(interaction) {
  const user = actor(interaction);
  const outcome = pet(user.id);

  logger.info({ userId: user.id, outcome }, 'Mai was petted');

  return messageResponse(pick(content.commands.pet[outcome]));
}

/**
 * `/mai mood`: how she is doing.
 *
 * Synchronous and free like `/mai pet`, and public for the same reason: it is
 * a cat being asked how she is in front of everybody. What it may and may not
 * say is decided in chat/mood.js.
 *
 * @param {object} interaction
 */
function mood(interaction) {
  const user = actor(interaction);
  const answer = describeMood({
    userId: user.id,
    guildId: interaction.guild_id ?? null,
    channelId: interaction.channel_id ?? null,
    parentId: interaction.channel?.parent_id ?? null,
    client: getGatewayClient(),
  });

  logger.info({ userId: user.id, guildId: interaction.guild_id ?? null }, 'Asked Mai how she is');

  return messageResponse(answer);
}

/**
 * The one button under a laser game, carrying the score so far.
 *
 * @param {{ caught: number, tries: number }} score
 * @returns {object[]}
 */
const laserButton = (score) => [
  {
    type: ACTION_ROW,
    components: [
      {
        type: BUTTON,
        style: STYLE_SECONDARY,
        label: content.commands.laser.button,
        custom_id: laserId(score),
      },
    ],
  },
];

/**
 * `/mai laser`: puts the red dot down. Public, because a cat chasing a laser is
 * a spectator sport, and synchronous like `/mai pet`.
 *
 * @param {object} interaction
 */
function laser(interaction) {
  const user = actor(interaction);
  const lines = content.commands.laser;

  // Asleep, and a laser is not a reason to wake a cat: a nap with an exception
  // in it is not something anybody can predict.
  if (napping()) return messageResponse(lines.sleeping);
  if (isSulking(user.id)) return messageResponse(pick(content.commands.pet.sulking));

  logger.info({ userId: user.id, guildId: interaction.guild_id ?? null }, 'Mai spotted a laser dot');
  return messageResponse(pick(lines.start), {
    components: laserButton({ caught: 0, tries: 0 }),
  });
}

/**
 * The button under a laser game. Registered in interactions/registry.js.
 *
 * Anybody may move the dot: it is a game for the channel, not for whoever
 * started it. The score in the custom_id is checked for shape and cap (see
 * chat/laser.js) and trusted for nothing else.
 */
export const laserComponents = {
  laser(interaction, args) {
    const score = parseScore(args);
    if (!score) return ephemeralResponse(content.commands.expired);

    const user = actor(interaction);
    const lines = content.commands.laser;
    const tally = (value) => fill(lines.score, value);

    // She fell asleep in the middle of it: the game ends for everybody, with
    // the score it had.
    if (napping()) {
      return updateResponse(
        [lines.sleeping, ...(score.tries > 0 ? [tally(score)] : [])].join('\n'),
      );
    }
    // A member she is sulking with gets the sulk, privately, and the game
    // stays exactly where it was for everybody else.
    if (isSulking(user.id)) return ephemeralResponse(pick(content.commands.pet.sulking));

    const next = moveDot(score);
    const line = pick(next.hit ? lines.caught : lines.missed);

    if (next.over) {
      logger.info(
        {
          userId: user.id,
          guildId: interaction.guild_id ?? null,
          caught: next.caught,
          tries: next.tries,
        },
        'Mai lost interest in the laser',
      );
      // No components: the button goes, and so does any way to edit this again.
      return updateResponse(`${line}\n${fill(lines.done, next)}`);
    }

    return updateResponse(`${line}\n${tally(next)}`, { components: laserButton(next) });
  },
};

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
        name: 'pet',
        description: 'Streichle Mai (auf eigene Gefahr)',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'mood',
        description: 'Frag Mai, wie es ihr geht',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'laser',
        description: 'Lass Mai einen roten Punkt jagen',
        type: 1, // SUB_COMMAND
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

  // `ask` waits for the model; `pet`, `mood`, `laser`, `forget` and `appeal`
  // answer instantly, and `appeal` answers with a modal, which cannot be
  // deferred at all.
  deferred: (interaction) => resolveSubcommand(interaction).name === 'ask',
  ephemeral: false,

  /**
   * @param {object} interaction Raw interaction payload from Discord.
   * @returns {Promise<object> | object} Interaction response body.
   */
  execute(interaction) {
    const { name } = resolveSubcommand(interaction);
    if (name === 'pet') return petMai(interaction);
    if (name === 'mood') return mood(interaction);
    if (name === 'laser') return laser(interaction);
    if (name === 'forget') return forget(interaction);
    if (name === 'appeal') return appeal(interaction);
    return ask(interaction);
  },
};
