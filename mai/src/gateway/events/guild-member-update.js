/**
 * A member changed something about themselves. The only part Mai cares about is
 * the name they wear (see moderation/names.js).
 *
 * Discord fires MEMBER_UPDATE for roles, avatars, boosts, and for the timeouts
 * Mai hands out herself, so the name comparison is not an optimization: without
 * it every role change in the server would cost a classification call, and
 * timing someone out would immediately re-screen them.
 *
 * A rename she did not have to act on is also remembered for a moment, so the
 * member's next message earns one emoji look (see gateway/renames.js). That
 * half is pure persona: no classification call, nothing recorded, nothing it
 * can do to anybody.
 *
 * Rides on the same privileged GuildMembers intent as the welcome (requested
 * only when `DISCORD_MEMBER_EVENTS` is on: see gateway/client.js).
 */
import { isGuildAllowed } from '../../config.js';
import { isGuildActive } from '../../db/settings.js';
import { displayName, screenMemberName } from '../../moderation/names.js';
import { noteRename } from '../renames.js';
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
  const verdict = await screenMemberName(newMember);

  // Persona, and only where she would act at all: an un-allowlisted or paused
  // guild gets no behaviour of any kind, and a bot renaming itself is not
  // somebody she has opinions about. A name she just had to deal with properly
  // is left alone: the entry (and possibly the reset) is the answer to that
  // one, and a wink on top of it would be the wrong note.
  const guildId = newMember.guild?.id;
  if (verdict.flagged || newMember.user?.bot) return;
  if (!guildId || !isGuildAllowed(guildId) || !isGuildActive(guildId)) return;

  noteRename(guildId, newMember.id);
}
