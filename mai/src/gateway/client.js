/**
 * Discord gateway (WebSocket) client. Slash commands arrive over HTTP, but
 * message events only exist on the gateway, so both run side by side.
 *
 * Requires the "Message Content Intent" to be enabled for the application in
 * the Discord Developer Portal (Bot -> Privileged Gateway Intents). Welcome
 * messages additionally require the "Server Members Intent"; the GuildMembers
 * intent is only requested when DISCORD_WELCOME_ENABLED=true, because logging
 * in with a privileged intent that is not enabled in the portal fails.
 */
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { onMessageCreate } from './events/message-create.js';
import { onGuildMemberAdd } from './events/guild-member-add.js';
import { startPresenceRotation } from './presence.js';

export function createGatewayClient() {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
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

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { user: readyClient.user.tag, guilds: readyClient.guilds.cache.size },
      'Gateway connected',
    );

    startPresenceRotation(readyClient);
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
