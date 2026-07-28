/**
 * The moderation log: an embed per action in a staff channel, so what Mai does
 * is visible without reading container logs.
 *
 * **Metadata only.** No message content ever goes here: a Discord channel is
 * permanent storage readable by everyone with access, which would undo the
 * project's no-content rule. The log carries ids, category slugs, timestamps
 * and (while the message still exists) a jump link; the offender's own warning
 * DM remains the only place their text is quoted back.
 *
 * The target channel is per guild (`/mod config set log-channel`). Without one,
 * logging is off for that guild and every call here is a no-op.
 */
import { effectiveSettings } from '../db/settings.js';
import { content } from '../content.js';
import { logger } from '../logger.js';

/** Event kinds, matching the title keys in the content config. */
export const LOG_FLAGGED = 'flagged';
export const LOG_DELETED = 'deleted';
export const LOG_SELF_DELETED = 'selfDeleted';
/** The author edited the violation out of a flagged message. */
export const LOG_CLEARED = 'cleared';
export const LOG_FORGIVEN = 'forgiven';
export const LOG_REPORTED = 'reported';
export const LOG_APPEALED = 'appealed';
export const LOG_STUCK = 'stuck';
export const LOG_ABANDONED = 'abandoned';
export const LOG_TIMEOUT = 'timeout';
export const LOG_TIMEOUT_FAILED = 'timeoutFailed';
/** A `/mod config` or `/mod exempt` run: staff changing the rules on each other. */
export const LOG_CONFIG = 'config';
export const LOG_APPEAL_GRANTED = 'appealGranted';
export const LOG_APPEAL_DENIED = 'appealDenied';
/** The warning DM bounced (closed DMs), so the member was never told. */
export const LOG_WARNING_UNDELIVERED = 'warningUndelivered';
/** Classification keeps failing: moderation is passing everything through. */
export const LOG_DEGRADED = 'degraded';
export const LOG_RECOVERED = 'recovered';
/** A member's display name is the violation, which no message rule can see. */
export const LOG_NAME_FLAGGED = 'nameFlagged';
/** Shadow mode: what Mai *would* have done, with the score that decided it. */
export const LOG_SHADOW = 'shadow';
/** Staff acted through Mai themselves: a manual deletion or warning. */
export const LOG_MANUAL_DELETE = 'manualDelete';
export const LOG_WARNED = 'warned';

const COLORS = {
  [LOG_FLAGGED]: 0xf1c40f,
  [LOG_DELETED]: 0xe74c3c,
  [LOG_SELF_DELETED]: 0x2ecc71,
  [LOG_CLEARED]: 0x1abc9c,
  [LOG_FORGIVEN]: 0x3498db,
  [LOG_REPORTED]: 0x5865f2,
  [LOG_APPEALED]: 0x9b59b6,
  [LOG_STUCK]: 0xe67e22,
  [LOG_ABANDONED]: 0x7f8c8d,
  [LOG_TIMEOUT]: 0xc0392b,
  [LOG_TIMEOUT_FAILED]: 0xe67e22,
  [LOG_CONFIG]: 0x34495e,
  [LOG_APPEAL_GRANTED]: 0x27ae60,
  [LOG_APPEAL_DENIED]: 0x2c3e50,
  [LOG_WARNING_UNDELIVERED]: 0xe67e22,
  [LOG_DEGRADED]: 0xe67e22,
  [LOG_RECOVERED]: 0x2ecc71,
  [LOG_NAME_FLAGGED]: 0xd35400,
  [LOG_SHADOW]: 0x95a5a6,
  [LOG_MANUAL_DELETE]: 0xc0392b,
  [LOG_WARNED]: 0xf39c12,
};

const unixSeconds = (value) => Math.floor(new Date(value).getTime() / 1000);

/** Kinds where the message still exists, so a jump link resolves. */
const MESSAGE_ALIVE = new Set([LOG_FLAGGED, LOG_REPORTED, LOG_CLEARED, LOG_STUCK, LOG_SHADOW]);

/**
 * Every entry about a message renders it the same way, in the same position:
 * the id in a code span: copyable, and the only thing that still works once the
 * message is gone: plus a jump link while there is something to jump to.
 *
 * Consistency is the point. Following one incident across
 * *markiert → gelöscht → Einspruch* should not mean hunting for the id in a
 * different field each time, or finding it missing.
 *
 * @param {object} event
 * @returns {object|null}
 */
function messageField(event) {
  if (!event.messageId) return null;

  const id = `\`${event.messageId}\``;
  const link = `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
  // The link goes on its own line: an id is nearly as wide as the column, so
  // side by side the link wraps mid-phrase.
  const value = MESSAGE_ALIVE.has(event.type)
    ? `${id}\n[${content.moderation.log.jump}](${link})`
    : id;

  return { name: content.moderation.log.fields.message, value, inline: true };
}

/**
 * @param {object} event
 * @returns {object[]} Embed fields for this event kind.
 */
function fieldsFor(event) {
  const labels = content.moderation.log.fields;
  const none = content.moderation.log.none;
  const categories = event.categories?.length ? event.categories.join(', ') : none;

  // The same head on every entry, in the same order: who, where, which message.
  // Whatever the event does not carry is simply left out.
  const head = [
    event.userId
      ? { name: labels.user, value: `<@${event.userId}> \`${event.userId}\``, inline: true }
      : null,
    event.channelId ? { name: labels.channel, value: `<#${event.channelId}>`, inline: true } : null,
    messageField(event),
  ].filter(Boolean);

  const categoryField = { name: labels.categories, value: categories, inline: true };
  const reason = event.reason
    ? [{ name: labels.reason, value: event.reason, inline: false }]
    : [];
  const resolution = event.resolution
    ? [{ name: labels.resolution, value: event.resolution, inline: false }]
    : [];
  // Which enforcement pass an appeal is about, so its entries line up with the
  // deletions they follow.
  const incident = event.since
    ? [{ name: labels.incident, value: `<t:${unixSeconds(event.since)}:f>`, inline: true }]
    : [];

  switch (event.type) {
    case LOG_FLAGGED:
      return [
        ...head,
        categoryField,
        { name: labels.due, value: `<t:${unixSeconds(event.dueAt)}:R>`, inline: true },
      ];

    // All three are the same shape: the message id stays useful for correlating
    // with Discord's audit log even once the message itself is gone.
    case LOG_DELETED:
    case LOG_SELF_DELETED:
    case LOG_CLEARED:
      return [...head, categoryField];

    case LOG_FORGIVEN:
      return [
        ...head,
        { name: labels.actor, value: `<@${event.actorId}>`, inline: true },
        { name: labels.count, value: String(event.count ?? 0), inline: true },
      ];

    case LOG_REPORTED:
      return [
        ...head,
        { name: labels.reporter, value: `<@${event.reporterId}>`, inline: true },
        // The reporter's own words, deliberately handed to staff. Optional.
        ...reason,
        ...resolution,
      ];

    case LOG_APPEALED:
      return [
        ...head,
        ...incident,
        { name: labels.appeal, value: event.reason ?? none, inline: false },
      ];

    case LOG_APPEAL_GRANTED:
    case LOG_APPEAL_DENIED:
      return [
        ...head,
        ...incident,
        { name: labels.actor, value: `<@${event.actorId}>`, inline: true },
        ...resolution,
      ];

    case LOG_CONFIG:
      // Setting names and their new values: all of them ids, numbers, booleans
      // and category slugs, so this stays inside the metadata-only rule.
      return [
        { name: labels.actor, value: `<@${event.actorId}>`, inline: true },
        { name: labels.changes, value: event.changes || none, inline: false },
      ];

    case LOG_TIMEOUT:
    case LOG_TIMEOUT_FAILED:
      return [
        ...head,
        { name: labels.strikes, value: String(event.strikes ?? 0), inline: true },
        { name: labels.duration, value: `${event.minutes} min`, inline: true },
        ...(event.until
          ? [{ name: labels.until, value: `<t:${unixSeconds(event.until)}:f>`, inline: true }]
          : []),
        categoryField,
        ...reason,
      ];

    case LOG_STUCK:
    case LOG_ABANDONED:
      return [
        ...head,
        { name: labels.attempts, value: String(event.attempts ?? 0), inline: true },
        { name: labels.reason, value: event.reason ?? none, inline: false },
      ];

    // The member was enforced but never told, so nobody has answered for the
    // deletion and the appeal button never reached them. Staff are the only
    // remaining route: `count` is how many messages the DM would have listed.
    case LOG_WARNING_UNDELIVERED:
      return [
        ...head,
        { name: labels.count, value: String(event.count ?? 0), inline: true },
        categoryField,
        ...reason,
      ];

    // The member's *name*. No copy of it here and none needed: the mention in
    // the head renders as their current display name for whoever reads this,
    // which is both the evidence and always up to date.
    case LOG_NAME_FLAGGED:
      return [...head, categoryField, ...resolution];

    // Shadow mode: nothing happened, and the score that would have made it
    // happen is the whole point of the entry. Only the highest one, like the
    // debug log: a full vector is a profile of the message.
    case LOG_SHADOW:
      return [
        ...head,
        categoryField,
        {
          name: labels.score,
          value: event.topScore ? event.topScore.toFixed(2) : none,
          inline: true,
        },
      ];

    // Staff acting through Mai: who did it, and (for a warning) why.
    case LOG_MANUAL_DELETE:
    case LOG_WARNED:
      return [
        ...head,
        { name: labels.actor, value: `<@${event.actorId}>`, inline: true },
        ...reason,
        ...resolution,
      ];

    // Moderation is failing open in this guild: `attempts` is the streak of
    // consecutive failures, `reason` the error in words (never its message).
    case LOG_DEGRADED:
      return [
        { name: labels.attempts, value: String(event.attempts ?? 0), inline: true },
        { name: labels.reason, value: event.reason ?? none, inline: false },
      ];

    default:
      return head;
  }
}

/**
 * @param {{ type: string, guildId: string, userId: string, channelId?: string,
 *   messageId?: string, categories?: string[], dueAt?: string, actorId?: string,
 *   count?: number }} event
 * @returns {object} Discord embed.
 */
export function buildLogEmbed(event) {
  return {
    title: content.moderation.log.titles[event.type] ?? event.type,
    color: COLORS[event.type] ?? 0x95a5a6,
    fields: fieldsFor(event).filter(Boolean),
    // No footer. The "metadata only" disclaimer was on every single entry and
    // told staff nothing they act on: the rule it described is enforced in
    // code, not by saying so. The timestamp stays: when something happened is
    // the one thing a log entry always needs.
    timestamp: new Date().toISOString(),
  };
}

/**
 * Best effort: a missing channel or a missing permission must never break the
 * moderation pipeline.
 *
 * @param {import('discord.js').Client} client
 * @param {object} event
 * @param {{ components?: object[] }} [options] Buttons on the entry (reports).
 * @returns {Promise<boolean>} Whether the entry was posted.
 */
export async function postModerationLog(client, event, { components } = {}) {
  // Everything is inside the try: callers fire this detached (`void`), so a
  // throw here would surface as an unhandled rejection instead of a log line.
  let logChannelId;
  try {
    ({ logChannelId } = effectiveSettings(event.guildId));
    if (!logChannelId || !client) return false;

    const channel = await client.channels.fetch(logChannelId);
    if (!channel?.isTextBased?.()) {
      logger.warn(
        { guildId: event.guildId, channelId: logChannelId },
        'Configured moderation log channel is not a text channel',
      );
      return false;
    }

    // The id comes out of that guild's own settings, and `/mod config set`
    // takes it from a channel picker that only offers channels of the guild it
    // was run in. But the fetch goes through the bot's client, which reaches
    // every guild Mai is in, so a stored id that names a channel elsewhere
    // would quietly publish one guild's moderation into another's. Proven
    // rather than assumed, the same rule `report-approve` follows.
    if (channel.guildId && event.guildId && channel.guildId !== event.guildId) {
      logger.error(
        { guildId: event.guildId, channelId: logChannelId, channelGuildId: channel.guildId },
        'Configured moderation log channel belongs to a different guild, refusing to post',
      );
      return false;
    }

    await channel.send({
      embeds: [buildLogEmbed(event)],
      ...(components ? { components } : {}),
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    logger.warn(
      { guildId: event.guildId, channelId: logChannelId, type: event.type, err: error },
      'Could not write to the moderation log channel',
    );
    return false;
  }
}
