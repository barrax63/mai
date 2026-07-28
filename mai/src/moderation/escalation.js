/**
 * The escalation ladder: what happens to someone who keeps going.
 *
 * Deleting a message and forgetting about it treats the tenth offence like the
 * first. The ladder maps "how many enforced deletions in the strike window" to a
 * Discord timeout, per guild (`/mod config set timeout-ladder`), with the last
 * step repeating for everything above it.
 *
 * The ceiling is a timeout, deliberately. Mai never kicks or bans on her own:
 * an automated permanent action on a false positive is not recoverable, and
 * staff have `/mod history` plus the log to act on the ones that matter.
 */
import { PermissionFlagsBits } from 'discord.js';
import { content } from '../content.js';
import { effectiveSettings } from '../db/settings.js';
import { strikeCount } from '../db/violations.js';
import { explainError } from '../errors.js';
import { logger } from '../logger.js';

/**
 * @param {string} guildId
 * @returns {number[]} Minutes per strike, 1-based, last entry repeating.
 */
export const ladderFor = (guildId) => effectiveSettings(guildId).timeoutLadder;

/**
 * @param {string} guildId
 * @returns {string} ISO cutoff for counting strikes.
 */
export const strikeWindowStart = (guildId) => {
  const days = effectiveSettings(guildId).strikeWindowDays;
  return new Date(Date.now() - days * 86_400_000).toISOString();
};

/**
 * How long this member should be timed out for, given their record.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {{ strikes: number, minutes: number }} `minutes: 0` = no timeout.
 */
export function decideEscalation(guildId, userId) {
  const strikes = strikeCount(guildId, userId, strikeWindowStart(guildId));
  if (strikes === 0) return { strikes, minutes: 0 };

  // Switched off: strikes keep accumulating, they just cost nothing yet.
  if (!effectiveSettings(guildId).escalationEnabled) return { strikes, minutes: 0 };

  const ladder = ladderFor(guildId);
  const minutes = ladder[Math.min(strikes, ladder.length) - 1] ?? 0;
  return { strikes, minutes };
}

/**
 * Applies the timeout. Failure is expected and survivable: Mai may lack Moderate
 * Members, sit below the member in the role hierarchy, or the target may be an
 * admin or the owner: Discord refuses all of those.
 *
 * @param {import('discord.js').Client} client
 * @param {{ guildId: string, userId: string, minutes: number, reason: string }} request
 * @returns {Promise<{ applied: boolean, until: Date | null, error?: string }>}
 */
export async function applyTimeout(client, { guildId, userId, minutes, reason }) {
  if (minutes <= 0) return { applied: false, until: null };

  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);

    // Discord refuses a timeout on an administrator or the owner, always. That
    // is a permanent property of the target, not a fault in the deployment, so
    // it is reported without the `error` level that would page the operator
    // every single time such a member trips the ladder. The log-channel entry
    // still goes out: staff should know the ladder had no effect.
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator) || guild.ownerId === userId) {
      logger.info(
        { guildId, userId, minutes },
        'Not timing out an admin or the owner; Discord does not allow it',
      );
      return { applied: false, until: null, error: content.moderation.timeoutImmune };
    }

    await member.timeout(minutes * 60_000, reason);

    const until = new Date(Date.now() + minutes * 60_000);
    logger.info({ guildId, userId, minutes }, 'Timed out a repeat offender');
    return { applied: true, until };
  } catch (error) {
    // error level: this also reaches the alert channel, because a moderation
    // ladder that silently does nothing is worse than none.
    logger.error(
      { guildId, userId, minutes, err: error },
      'Could not time out a member; check Moderate Members and the role hierarchy',
    );
    // `error` here is shown in the guild's log channel, so staff get the code
    // in words, never the raw message: see errors.js. The full one is in the
    // line above, which the operator has and the guild does not.
    return { applied: false, until: null, error: explainError(error) };
  }
}
