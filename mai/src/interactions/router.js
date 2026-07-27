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
 * Guild allowlist (DISCORD_GUILD_IDS). Raw interactions use snake_case;
 * `guild_id` is absent for DM interactions, which bypass the allowlist like DM
 * chat does. An un-listed guild gets an ephemeral refusal.
 */
function refuseForeignGuild(interaction, send, logContext) {
  if (isGuildAllowed(interaction.guild_id)) return false;
  logger.debug(logContext, 'Refusing interaction: guild not in allowlist');
  send(ephemeralResponse(content.commands.notActive));
  return true;
}

/**
 * The kill switch (`/mod off`). `/mod` itself stays reachable, otherwise the
 * only way back on would be editing the database.
 *
 * @returns {boolean} Whether the interaction was refused.
 */
function refusePausedGuild(interaction, send, logContext, { allowMod = false } = {}) {
  if (allowMod && interaction.data?.name === STAFF_COMMAND) return false;
  if (isGuildActive(interaction.guild_id)) return false;

  logger.debug(logContext, 'Refusing interaction: Mai is paused in this guild');
  send(ephemeralResponse(content.commands.paused));
  return true;
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

  if (refuseForeignGuild(interaction, send, logContext)) return undefined;
  if (refusePausedGuild(interaction, send, logContext, { allowMod: true })) return undefined;

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
  const command = commandHandlers.get(interaction.data?.name);
  if (typeof command?.autocomplete !== 'function') {
    return send(autocompleteResponse([]));
  }

  return dispatch(interaction, send, {
    handler: async (payload) => autocompleteResponse(await command.autocomplete(payload)),
    deferred: false,
    ephemeral: false,
    logContext: { autocomplete: interaction.data?.name, userId: actorId(interaction) },
  });
}

function routeComponent(interaction, send) {
  const { name, args } = parseCustomId(interaction.data?.custom_id);
  const logContext = {
    component: name,
    guildId: interaction.guild_id,
    userId: actorId(interaction),
  };

  if (refuseForeignGuild(interaction, send, logContext)) return undefined;
  if (refusePausedGuild(interaction, send, logContext)) return undefined;

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

  if (refuseForeignGuild(interaction, send, logContext)) return undefined;
  if (refusePausedGuild(interaction, send, logContext)) return undefined;

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
