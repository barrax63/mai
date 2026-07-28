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
import { content } from './content.js';
import { effectiveSettings, resumeEscalation, suspendEscalation } from './db/settings.js';
import { getGatewayClient } from './gateway/client.js';
import { logger } from './logger.js';
import { LOG_CONFIG, postModerationLog } from './moderation/log.js';

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
  reconcileEscalation(guild, report);

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

/**
 * Stops handing out timeouts she cannot hand out, and starts again when she can.
 *
 * Every failed timeout is logged at `error`, which reaches the operator's alert
 * channel, and posts an entry in the guild's log. That is the right noise for an
 * incident and the wrong noise for a permanent state: a server that never
 * granted Moderate Members produces one every time anybody reaches the second
 * strike, forever, and an alert that fires forever is an alert nobody reads.
 *
 * Switching escalation off is not giving up on the ladder: strikes still
 * accumulate (that has always been what escalation-off means), so nothing is
 * lost and the moment the permission appears she picks up where she left off.
 * `escalation_suspended_at` is what makes the second half safe: she only
 * restores a suspension of her own, and any human touching `escalation` ends it.
 *
 * Reported once per transition rather than once per audit, in the guild's log
 * as well as the process log: staff are the ones who can grant the permission,
 * and a ladder that has quietly stopped is exactly the kind of silence this
 * whole file exists to break.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ guild: string[], known: boolean }} report
 */
function reconcileEscalation(guild, report) {
  // An unknown report is not evidence of anything: her own member object is
  // simply not cached, and acting on that would switch the ladder off on every
  // cold start.
  if (!report.known) return;

  // The audit itself is a read, and two of its three callers are the gateway's
  // ready sweep and the join handler: a failing write here would take those with
  // it. Reporting what is missing matters more than acting on it, so the acting
  // half can fail on its own.
  try {
    const settings = effectiveSettings(guild.id);
    const canTimeOut = !report.guild.includes('ModerateMembers');

    if (!canTimeOut && settings.escalationEnabled) {
      if (suspendEscalation(guild.id)) {
        logger.warn(
          { guildId: guild.id },
          'Escalation switched off: Moderate Members is missing, so every timeout would fail',
        );
        announce(guild.id, content.moderation.log.escalationSuspended);
      }
      return;
    }

    if (canTimeOut && settings.escalationSuspendedAt && resumeEscalation(guild.id)) {
      logger.info({ guildId: guild.id }, 'Escalation switched back on: Moderate Members is back');
      announce(guild.id, content.moderation.log.escalationResumed);
    }
  } catch (error) {
    logger.warn({ guildId: guild.id, err: error }, 'Could not reconcile escalation with permissions');
  }
}

/**
 * The guild's own log, best effort and detached: a permission audit must not
 * wait on two Discord round trips, and it runs on a path (`/mod status`) with a
 * three-second budget.
 *
 * @param {string} guildId
 * @param {string} changes
 */
function announce(guildId, changes) {
  void postModerationLog(getGatewayClient(), { type: LOG_CONFIG, guildId, changes });
}

/** Test seam: the once-per-process set is module state. */
export function resetPermissionAudit() {
  reported.clear();
}
