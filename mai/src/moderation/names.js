/**
 * The name a member wears, which no message rule can ever see.
 *
 * A nickname sits on every message its owner sends, in the member list and in
 * every mention of them, and none of that is a message: `checkMessage` never
 * looks at it, so a slur as a display name was simply invisible to Mai while
 * she deleted the same word out of that member's sentences.
 *
 * What she does about it is per guild (`/mod config set name-check`):
 *   - `off`   nothing, and no classification call;
 *   - `log`   an entry in the moderation log, for humans to act on;
 *   - `reset` the same entry, plus the guild nickname is removed.
 *
 * The ceiling is deliberate and lower than the message ladder's: Mai never
 * kicks or bans over a name, and she cannot touch a *global* username at all
 * (Discord does not allow it, and it is not this server's property). A reset
 * falls back to that global name, which may itself be the problem: then the
 * entry is all there is, and a human decides.
 *
 * The entry carries no copy of the name. It does not have to: `<@id>` renders
 * as the member's current display name for whoever reads it, so staff see the
 * offending name without Mai storing or republishing it, and they see the
 * *current* one if it changed again in the meantime.
 *
 * Fails **open**, like the message pipeline: an unreachable classifier means no
 * verdict, and no verdict must not become "reset this member's nickname".
 */
import { classify } from '../ai/moderation.js';
import { config, isGuildAllowed } from '../config.js';
import { content, fill } from '../content.js';
import { effectiveSettings, isGuildActive } from '../db/settings.js';
import { explainError } from '../errors.js';
import { logger } from '../logger.js';
import { createRateLimiter } from '../rate-limit.js';
import { LOG_NAME_FLAGGED, postModerationLog } from './log.js';

const CLEAN = Object.freeze({ flagged: false, categories: [] });

/**
 * Renaming is free and instant, so a member could otherwise turn every rename
 * into a classification call and a log entry. Per member and guild.
 */
const nameLimiter = createRateLimiter({ max: 3, windowMs: 10 * 60_000, name: 'name-check' });

/**
 * What Discord shows for this member here: the guild nickname if there is one,
 * otherwise the account's display name, otherwise the username.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {string}
 */
export const displayName = (member) =>
  String(member?.nickname ?? member?.user?.globalName ?? member?.user?.username ?? '').trim();

/**
 * @param {import('discord.js').GuildMember} member
 * @param {string} guildId
 * @param {string[]} categories
 * @param {'log' | 'reset'} mode
 * @returns {Promise<string>} The resolution line for the log entry.
 */
async function actOn(member, guildId, categories, mode) {
  const { names } = content.moderation;

  // A global username is not Mai's to change: there is nothing to reset, and
  // saying so is more useful to staff than a failed attempt.
  if (mode !== 'reset') return names.reportedOnly;
  if (!member.nickname) return names.globalName;

  try {
    await member.setNickname(
      null,
      fill(names.resetReason, { categories: categories.join(', ') || names.unknownCategory }),
    );
    logger.info({ guildId, userId: member.id, categories }, 'Reset a flagged nickname');
    return names.nicknameReset;
  } catch (error) {
    // Missing Manage Nicknames, or a member above Mai in the hierarchy. Same
    // treatment as a refused timeout: staff are told, in words, that the action
    // did not happen.
    logger.warn(
      { guildId, userId: member.id, err: error },
      'Could not reset a flagged nickname; check Manage Nicknames and the role hierarchy',
    );
    return `${names.resetFailed} ${explainError(error)}`;
  }
}

/**
 * Screens one member's display name and acts on the guild's setting.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<{ flagged: boolean, categories: string[] }>}
 */
export async function screenMemberName(member) {
  const guildId = member?.guild?.id;

  if (!config.moderation.enabled) return CLEAN;
  if (member?.user?.bot) return CLEAN;
  if (!guildId || !isGuildAllowed(guildId) || !isGuildActive(guildId)) return CLEAN;

  const settings = effectiveSettings(guildId);
  if (settings.nameCheck === 'off') return CLEAN;

  const name = displayName(member);
  if (!name) return CLEAN;

  if (!nameLimiter.consume(`${guildId}:${member.id}`)) return CLEAN;

  let verdict;
  try {
    verdict = await classify(name, [], {
      guildId,
      // The guild's own line, exactly as for messages: the provider's default
      // is tuned for English and a name is a very short piece of text.
      policy: { threshold: settings.threshold, categories: settings.categories },
    });
  } catch (error) {
    // Fails open. The alternative is stripping a member's nickname because the
    // API timed out.
    logger.error({ guildId, userId: member.id, err: error }, 'Could not classify a member name');
    return CLEAN;
  }

  if (!verdict.flagged) return CLEAN;

  const resolution = await actOn(member, guildId, verdict.categories, settings.nameCheck);

  // Metadata only: the ids and the category slugs. The name itself is in the
  // mention the entry renders, and in the container log at debug like every
  // other piece of content.
  logger.info({ guildId, userId: member.id, categories: verdict.categories }, 'Member name flagged');
  logger.debug({ guildId, userId: member.id, name }, 'Flagged member name');

  await postModerationLog(member.client, {
    type: LOG_NAME_FLAGGED,
    guildId,
    userId: member.id,
    categories: verdict.categories,
    resolution,
  });

  return { flagged: true, categories: verdict.categories };
}
