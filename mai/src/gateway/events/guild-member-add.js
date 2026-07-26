/**
 * Welcomes new members in Mai's voice — in the channel configured with
 * `/mod config set welcome-channel`, or the guild's system channel.
 *
 * Requires the privileged "Server Members Intent" (Developer Portal -> Bot)
 * and DISCORD_WELCOME_ENABLED=true — the GuildMembers gateway intent is only
 * requested when the flag is set (see gateway/client.js).
 */
import { PermissionFlagsBits } from 'discord.js';
import { isGuildAllowed } from '../../config.js';
import { content, fill, pick } from '../../content.js';
import { effectiveSettings } from '../../db/settings.js';
import { logger } from '../../logger.js';

/**
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').GuildTextBasedChannel | null>}
 */
async function welcomeChannel(guild) {
  const { welcomeChannelId } = effectiveSettings(guild.id);
  if (!welcomeChannelId) return guild.systemChannel;

  try {
    const channel = await guild.channels.fetch(welcomeChannelId);
    if (channel?.isTextBased()) return channel;
    logger.warn(
      { guildId: guild.id, channelId: welcomeChannelId },
      'Configured welcome channel is not a text channel, falling back',
    );
  } catch (error) {
    logger.warn(
      { guildId: guild.id, channelId: welcomeChannelId, err: error },
      'Configured welcome channel is unreachable, falling back',
    );
  }
  return guild.systemChannel;
}

/**
 * @param {import('discord.js').GuildMember} member
 */
export async function onGuildMemberAdd(member) {
  if (member.user?.bot) return;

  // Same guild allowlist as the rest of the bot.
  if (!isGuildAllowed(member.guild.id)) return;

  const channel = await welcomeChannel(member.guild);
  if (!channel) {
    logger.debug(
      { guildId: member.guild.id },
      'No welcome channel and no system channel, skipping welcome',
    );
    return;
  }

  const me = member.guild.members.me;
  if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    logger.debug(
      { guildId: member.guild.id, channelId: channel.id },
      'Missing Send Messages permission in the welcome channel, skipping welcome',
    );
    return;
  }

  // {member} renders as a mention; it is the only ping a welcome may send.
  const line = fill(pick(content.welcome.lines), { member: `<@${member.id}>` });

  try {
    await channel.send({
      content: line,
      allowedMentions: { users: [member.id] },
    });
    logger.info(
      { guildId: member.guild.id, userId: member.id },
      'Welcomed new member',
    );
  } catch (error) {
    logger.warn(
      { guildId: member.guild.id, userId: member.id, err: error },
      'Failed to send welcome message',
    );
  }
}
