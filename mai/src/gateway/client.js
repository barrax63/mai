/**
 * Discord gateway (WebSocket) client. Slash commands arrive over HTTP, but
 * message events only exist on the gateway, so both run side by side.
 *
 * Requires the "Message Content Intent" to be enabled for the application in
 * the Discord Developer Portal (Bot -> Privileged Gateway Intents). Welcome
 * messages additionally require the "Server Members Intent"; the GuildMembers
 * intent is only requested when DISCORD_WELCOME_ENABLED=true, because logging
 * in with a privileged intent that is not enabled in the portal fails.
 *
 * Direct messages arrive via the (non-privileged) DirectMessages intent plus
 * the Partials.Channel below — without the partial, discord.js drops events
 * for the uncached DM channel.
 */
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { startEnforcer } from '../moderation/enforcer.js';
import { onMessageCreate } from './events/message-create.js';
import { onMessageUpdate } from './events/message-update.js';
import { onMessageDelete } from './events/message-delete.js';
import { onGuildMemberAdd } from './events/guild-member-add.js';
import { startPresenceRotation } from './presence.js';

/** @type {import('discord.js').Client | null} */
let readyClient = null;

/** @type {{ stop: () => void } | null} */
let enforcer = null;

/**
 * The logged-in client, for code outside the gateway that needs Discord REST
 * access (the /mai slash commands arrive over HTTP, not over the gateway).
 *
 * @returns {import('discord.js').Client | null} null until the gateway is ready.
 */
export function getGatewayClient() {
  return readyClient;
}

/**
 * Set on ClientReady. Also the injection point for tests, which drive the
 * component and modal handlers without a gateway connection.
 *
 * @param {import('discord.js').Client | null} client
 */
export function setGatewayClient(client) {
  readyClient = client;
}

/** Stops the moderation tick loop (shutdown path). */
export function stopEnforcer() {
  enforcer?.stop();
  enforcer = null;
}

export function createGatewayClient() {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ];
  if (config.discord.welcomeEnabled) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  const client = new Client({
    intents,
    // Deliver events for uncached entities (e.g. messages in channels the
    // bot has not interacted with since startup).
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (ready) => {
    setGatewayClient(ready);
    logger.info(
      { user: ready.user.tag, guilds: ready.guilds.cache.size },
      'Gateway connected',
    );

    startPresenceRotation(ready);

    // The enforcer needs a logged-in client to delete messages and send DMs.
    if (config.moderation.enabled && !enforcer) {
      enforcer = startEnforcer(ready);
    }
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Gateway client error');
  });

  client.on(Events.Warn, (message) => {
    logger.warn({ message }, 'Gateway client warning');
  });

  client.on(Events.MessageCreate, (message) => {
    onMessageCreate(message).catch((error) => {
      logger.error({ err: error, messageId: message.id }, 'messageCreate handler failed');
    });
  });

  // Edits go through moderation too — the same intents cover MESSAGE_UPDATE, so
  // this needs no extra Developer Portal toggle.
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    onMessageUpdate(oldMessage, newMessage).catch((error) => {
      logger.error({ err: error, messageId: newMessage?.id }, 'messageUpdate handler failed');
    });
  });

  // So an author who deletes a flagged message sees it resolve at once, instead
  // of waiting out a grace period that no longer has anything to enforce.
  client.on(Events.MessageDelete, (message) => {
    onMessageDelete(message).catch((error) => {
      logger.error({ err: error, messageId: message?.id }, 'messageDelete handler failed');
    });
  });

  if (config.discord.welcomeEnabled) {
    client.on(Events.GuildMemberAdd, (member) => {
      onGuildMemberAdd(member).catch((error) => {
        logger.error(
          { err: error, guildId: member.guild?.id, userId: member.id },
          'guildMemberAdd handler failed',
        );
      });
    });
  }

  return client;
}

export async function startGateway() {
  const client = createGatewayClient();
  await client.login(config.discord.botToken);
  return client;
}
