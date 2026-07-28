/**
 * Someone joined. Two things happen here, in this order:
 *
 *   1. the name they arrived with is screened (moderation/names.js), if the
 *      guild asked for that;
 *   2. they are welcomed in Mai's voice, in the channel configured with
 *      `/mod config set welcome-channel` or the guild's system channel.
 *
 * The order is the point: a welcome mentions the new member, so greeting
 * someone whose display name is the violation would put that name in front of
 * the whole server in Mai's own words. A flagged name gets the log entry and no
 * greeting.
 *
 * Both need the privileged "Server Members Intent" (Developer Portal -> Bot).
 * The GuildMembers gateway intent is only requested when DISCORD_WELCOME_ENABLED
 * or MODERATION_NAME_CHECK is on (see gateway/client.js), so this handler runs
 * for either feature and each half checks its own flag.
 */
import { PermissionFlagsBits } from 'discord.js';
import { config, isGuildAllowed } from '../../config.js';
import { content, fill, pick } from '../../content.js';
import { effectiveSettings, isGuildActive } from '../../db/settings.js';
import { logger } from '../../logger.js';
import { screenMemberName } from '../../moderation/names.js';

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

  // Same guild allowlist as the rest of the bot, plus the kill switch.
  if (!isGuildAllowed(member.guild.id)) return;
  if (!isGuildActive(member.guild.id)) return;

  // A no-op unless this guild has name checking on.
  const { flagged } = await screenMemberName(member);
  if (flagged) {
    logger.info(
      { guildId: member.guild.id, userId: member.id },
      'Not welcoming a member whose name was flagged',
    );
    return;
  }

  if (!config.discord.welcomeEnabled) return;

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
