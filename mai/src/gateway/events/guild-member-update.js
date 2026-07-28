/**
 * A member changed something about themselves. The only part Mai cares about is
 * the name they wear (see moderation/names.js).
 *
 * Discord fires MEMBER_UPDATE for roles, avatars, boosts, and for the timeouts
 * Mai hands out herself, so the name comparison is not an optimization: without
 * it every role change in the server would cost a classification call, and
 * timing someone out would immediately re-screen them.
 *
 * Rides on the same privileged GuildMembers intent as the welcome (requested
 * only when `DISCORD_MEMBER_EVENTS` is on: see gateway/client.js).
 */
import { displayName, screenMemberName } from '../../moderation/names.js';
import { logger } from '../../logger.js';

/**
 * @param {import('discord.js').GuildMember | import('discord.js').PartialGuildMember} oldMember
 * @param {import('discord.js').GuildMember} newMember
 */
export async function onGuildMemberUpdate(oldMember, newMember) {
  // An uncached "before" cannot be compared. Screening anyway is the safe
  // direction (the per-member limiter bounds it) and it only happens once per
  // member per restart.
  if (!oldMember?.partial && displayName(oldMember) === displayName(newMember)) return;

  logger.debug(
    { guildId: newMember.guild?.id, userId: newMember.id },
    'Member name changed, screening it',
  );
  await screenMemberName(newMember);
}
