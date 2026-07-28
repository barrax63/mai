/**
 * Whether Mai can actually do what a server has asked her to do.
 *
 * Every permission she needs is discovered at the worst possible moment
 * otherwise: Manage Messages when a deletion fails at the end of a grace
 * period, Moderate Members when somebody has just earned a timeout, Manage
 * Nicknames when a name is already up, Send Messages in the log channel when
 * there is finally something worth logging. Each of those is handled
 * gracefully, which is precisely the problem: they are handled so gracefully
 * that a server can run for weeks believing it is moderated.
 *
 * So she checks herself: once per process for every server she is in, again
 * whenever she joins one, and on demand in `/mod status`.
 *
 * Two scopes, because they fail differently. The guild-wide check reads her
 * role's permissions; the log-channel check reads the overrides on that one
 * channel, which is where "she has Send Messages, just not *there*" lives.
 * Permission names are Discord's own identifiers, like category slugs: the
 * sentence around them is in the content file, the names are not.
 */
import { PermissionFlagsBits } from 'discord.js';
import { effectiveSettings } from './db/settings.js';
import { logger } from './logger.js';

/** Needed everywhere, for the pipeline to work at all. */
const ALWAYS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  // The warning reaction on a flagged message.
  PermissionFlagsBits.AddReactions,
  // Deleting a flagged message once the grace period is over.
  PermissionFlagsBits.ManageMessages,
]);

/** What a log channel needs on top of ViewChannel and SendMessages. */
const LOG_CHANNEL = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
]);

/**
 * @param {import('discord.js').Guild} guild
 * @returns {{ guild: string[], logChannel: string[], known: boolean }}
 *   Missing permission names. `known: false` means her own member object is not
 *   cached, so nothing could be checked: reported as unknown rather than as
 *   "all fine", which would be a lie in exactly the situation this exists for.
 */
export function missingPermissions(guild) {
  const me = guild?.members?.me;
  if (!me) return { guild: [], logChannel: [], known: false };

  const settings = effectiveSettings(guild.id);
  const required = [...ALWAYS];
  // Only what this server has actually switched on: telling a guild with
  // escalation off that it is missing Moderate Members is noise.
  if (settings.escalationEnabled) required.push(PermissionFlagsBits.ModerateMembers);
  if (settings.nameCheck === 'reset') required.push(PermissionFlagsBits.ManageNicknames);

  return {
    guild: me.permissions.missing(required),
    logChannel: logChannelGaps(guild, me, settings.logChannelId),
    known: true,
  };
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} me
 * @param {string | null} logChannelId
 * @returns {string[]}
 */
function logChannelGaps(guild, me, logChannelId) {
  if (!logChannelId) return [];

  // Cache only: this runs inside `/mod status`, which has ~3 s and no business
  // making a REST call. An uncached channel simply reports nothing missing.
  const channel = guild.channels?.cache?.get(logChannelId);
  if (!channel?.permissionsFor) return [];

  return channel.permissionsFor(me)?.missing(LOG_CHANNEL) ?? [];
}

/**
 * @param {{ guild: string[], logChannel: string[], known: boolean }} report
 * @returns {boolean}
 */
export const permissionsComplete = (report) =>
  report.known && report.guild.length === 0 && report.logChannel.length === 0;

/** Guilds already reported this process, so a restart is one line, not a flood. */
const reported = new Set();

/**
 * Logs and (where possible) posts what is missing, once per guild per process.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ force?: boolean }} [options] `force` for the join path, which
 *   reports into its own introduction message rather than relying on this.
 * @returns {{ guild: string[], logChannel: string[], known: boolean }}
 */
export function auditPermissions(guild, { force = false } = {}) {
  const report = missingPermissions(guild);

  if (!force && reported.has(guild.id)) return report;
  reported.add(guild.id);

  if (permissionsComplete(report)) {
    logger.debug({ guildId: guild.id }, 'Permissions complete');
    return report;
  }

  if (!report.known) {
    logger.debug({ guildId: guild.id }, 'Could not check permissions: own member not cached');
    return report;
  }

  // `warn`, not `error`: a missing permission is a deployment fact somebody has
  // to fix, not an incident that should page the operator through the alert
  // hook every time a guild is a little under-configured.
  logger.warn(
    { guildId: guild.id, missing: report.guild, logChannelMissing: report.logChannel },
    'Mai is missing permissions she has been asked to use',
  );

  return report;
}

/** Test seam: the once-per-process set is module state. */
export function resetPermissionAudit() {
  reported.clear();
}
