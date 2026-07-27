/**
 * Dispatch for every interaction Discord sends to `POST /interactions`:
 * pings, slash commands, autocomplete, component clicks and modal submits.
 *
 * The caller passes a `send` callback that writes the HTTP response. It is
 * called exactly once, immediately: anything slower than Discord's ~3 s budget
 * answers with a deferred placeholder first and edits it afterwards, so handlers
 * never have to think about the deadline: they declare `deferred` and return
 * their final response whenever they are done.
 */
import { InteractionResponseType, InteractionType } from 'discord-interactions';
import { commandHandlers } from '../commands/index.js';
import { isGuildAllowed } from '../config.js';
import { content } from '../content.js';
import { isGuildActive } from '../db/settings.js';
import { logger } from '../logger.js';

/** The one command that still answers while a guild is paused. */
const STAFF_COMMAND = 'mod';
import { resolveSubcommand } from './options.js';
import { componentHandlers, modalHandlers, parseCustomId } from './registry.js';
import {
  autocompleteResponse,
  deferredResponse,
  deferredUpdateResponse,
  editOriginalResponse,
  ephemeralResponse,
} from './respond.js';

/** Resolve a `boolean | (interaction) => boolean` handler flag. */
const flag = (value, interaction) =>
  typeof value === 'function' ? Boolean(value(interaction)) : Boolean(value);

/** Snowflake of whoever triggered this, in a guild or in a DM. */
const actorId = (interaction) => interaction.member?.user?.id ?? interaction.user?.id;


/**
 * Runs a handler and delivers its response, deferring first when the handler
 * asks for it.
 *
 * @param {object} interaction
 * @param {(body: object, status?: number) => void} send
 * @param {{ handler: Function, args?: unknown[], deferred: boolean, ephemeral: boolean,
 *   isComponent?: boolean, logContext: object }} options
 */
async function dispatch(interaction, send, options) {
  const { handler, args = [], deferred, ephemeral, isComponent, logContext } = options;
  const startedAt = Date.now();

  if (!deferred) {
    // Fast path: the handler's response *is* the HTTP response.
    try {
      send(await handler(interaction, ...args));
      logger.info({ ...logContext, ms: Date.now() - startedAt }, 'Interaction handled');
    } catch (error) {
      logger.error({ ...logContext, err: error }, 'Interaction handler failed');
      send(ephemeralResponse(content.commands.error));
    }
    return;
  }

  send(isComponent ? deferredUpdateResponse() : deferredResponse(ephemeral));

  try {
    const response = await handler(interaction, ...args);
    await editOriginalResponse(interaction, response);
    logger.info(
      { ...logContext, deferred: true, ms: Date.now() - startedAt },
      'Interaction handled',
    );
  } catch (error) {
    logger.error({ ...logContext, deferred: true, err: error }, 'Interaction handler failed');
    await editOriginalResponse(interaction, ephemeralResponse(content.commands.error));
  }
}

/**
 * @param {object} interaction Raw, signature-verified interaction payload.
 * @param {(body: object, status?: number) => void} send
 */
export async function routeInteraction(interaction, send) {
  switch (interaction.type) {
    case InteractionType.PING:
      return send({ type: InteractionResponseType.PONG });

    case InteractionType.APPLICATION_COMMAND:
      return routeCommand(interaction, send);

    case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
      return routeAutocomplete(interaction, send);

    case InteractionType.MESSAGE_COMPONENT:
      return routeComponent(interaction, send);

    case InteractionType.MODAL_SUBMIT:
      return routeModal(interaction, send);

    default:
      logger.warn({ type: interaction.type }, 'Unhandled interaction type');
      return send({ error: 'unhandled interaction type' }, 400);
  }
}

/**
 * The two gates in front of every interaction, in order: the operator's guild
 * allowlist (DISCORD_GUILD_IDS), then the guild's own kill switch (`/mod off`).
 * Raw interactions use snake_case, and `guild_id` is absent for DM
 * interactions, which bypass both like DM chat does.
 *
 * Deciding is deliberately split from answering. Every interaction kind has to
 * pass these, but they cannot all be refused the same way: an autocomplete
 * response has to be a list of choices, and answering one with a message is a
 * protocol error, not a refusal the user ever sees.
 *
 * @param {object} interaction
 * @param {object} logContext
 * @param {{ allowMod?: boolean }} [options] `/mod` itself stays reachable while
 *   a guild is paused, otherwise the only way back on would be the database.
 * @returns {string | null} The refusal text, or null when it may proceed.
 */
function refusalReason(interaction, logContext, { allowMod = false } = {}) {
  if (!isGuildAllowed(interaction.guild_id)) {
    logger.debug(logContext, 'Refusing interaction: guild not in allowlist');
    return content.commands.notActive;
  }

  if (allowMod && interaction.data?.name === STAFF_COMMAND) return null;

  if (!isGuildActive(interaction.guild_id)) {
    logger.debug(logContext, 'Refusing interaction: Mai is paused in this guild');
    return content.commands.paused;
  }

  return null;
}

function routeCommand(interaction, send) {
  const name = interaction.data?.name;
  const { group, name: subcommand } = resolveSubcommand(interaction);
  const logContext = {
    command: name,
    subcommand: group ? `${group} ${subcommand}` : subcommand,
    guildId: interaction.guild_id,
    userId: actorId(interaction),
  };

  const refusal = refusalReason(interaction, logContext, { allowMod: true });
  if (refusal) return send(ephemeralResponse(refusal));

  const command = commandHandlers.get(name);
  if (!command) {
    logger.warn({ command: name }, 'Received unknown command');
    return send({ error: 'unknown command' }, 400);
  }

  return dispatch(interaction, send, {
    handler: command.execute,
    deferred: flag(command.deferred, interaction),
    ephemeral: flag(command.ephemeral, interaction),
    logContext,
  });
}

function routeAutocomplete(interaction, send) {
  const logContext = {
    autocomplete: interaction.data?.name,
    guildId: interaction.guild_id,
    userId: actorId(interaction),
  };

  // Same two gates as every other kind, answered in this one's protocol: an
  // un-listed or paused guild gets no suggestions rather than a message, which
  // Discord would reject outright. `allowMod` matches routeCommand: `/mod`
  // keeps working while a guild is paused, so its suggestions have to as well,
  // or the way back on is a command whose options will not complete.
  if (refusalReason(interaction, logContext, { allowMod: true })) {
    return send(autocompleteResponse([]));
  }

  const command = commandHandlers.get(interaction.data?.name);
  if (typeof command?.autocomplete !== 'function') {
    return send(autocompleteResponse([]));
  }

  return dispatch(interaction, send, {
    handler: async (payload) => autocompleteResponse(await command.autocomplete(payload)),
    deferred: false,
    ephemeral: false,
    logContext,
  });
}

function routeComponent(interaction, send) {
  const { name, args } = parseCustomId(interaction.data?.custom_id);
  const logContext = {
    component: name,
    guildId: interaction.guild_id,
    userId: actorId(interaction),
  };

  const refusal = refusalReason(interaction, logContext);
  if (refusal) return send(ephemeralResponse(refusal));

  const handler = componentHandlers.get(name);
  if (!handler) {
    // A button from an older deploy whose handler no longer exists.
    logger.warn(logContext, 'No handler for component');
    return send(ephemeralResponse(content.commands.expired));
  }

  return dispatch(interaction, send, {
    handler,
    args: [args],
    deferred: flag(handler.deferred, interaction),
    ephemeral: true,
    isComponent: true,
    logContext,
  });
}

function routeModal(interaction, send) {
  const { name, args } = parseCustomId(interaction.data?.custom_id);
  const logContext = { modal: name, guildId: interaction.guild_id, userId: actorId(interaction) };

  const refusal = refusalReason(interaction, logContext);
  if (refusal) return send(ephemeralResponse(refusal));

  const handler = modalHandlers.get(name);
  if (!handler) {
    logger.warn(logContext, 'No handler for modal');
    return send(ephemeralResponse(content.commands.expired));
  }

  return dispatch(interaction, send, {
    handler,
    args: [args],
    deferred: flag(handler.deferred, interaction),
    ephemeral: true,
    logContext,
  });
}
