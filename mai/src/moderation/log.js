/**
 * The moderation log: an embed per action in a staff channel, so what Mai does
 * is visible without reading container logs.
 *
 * **Metadata only.** No message content ever goes here — a Discord channel is
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
export const LOG_FORGIVEN = 'forgiven';

const COLORS = {
  [LOG_FLAGGED]: 0xf1c40f,
  [LOG_DELETED]: 0xe74c3c,
  [LOG_SELF_DELETED]: 0x2ecc71,
  [LOG_FORGIVEN]: 0x3498db,
};

const unixSeconds = (value) => Math.floor(new Date(value).getTime() / 1000);

const jumpLink = ({ guildId, channelId, messageId }) =>
  `[${content.moderation.log.jump}](https://discord.com/channels/${guildId}/${channelId}/${messageId})`;

/**
 * @param {object} event
 * @returns {object[]} Embed fields for this event kind.
 */
function fieldsFor(event) {
  const labels = content.moderation.log.fields;
  const none = content.moderation.log.none;
  const categories = event.categories?.length ? event.categories.join(', ') : none;

  const user = { name: labels.user, value: `<@${event.userId}> \`${event.userId}\``, inline: true };
  const channel = event.channelId
    ? { name: labels.channel, value: `<#${event.channelId}>`, inline: true }
    : null;

  switch (event.type) {
    case LOG_FLAGGED:
      return [
        user,
        channel,
        { name: labels.categories, value: categories, inline: true },
        { name: labels.due, value: `<t:${unixSeconds(event.dueAt)}:R>`, inline: true },
        { name: labels.message, value: jumpLink(event), inline: true },
      ];

    case LOG_DELETED:
      return [
        user,
        channel,
        { name: labels.categories, value: categories, inline: true },
        // The message is gone, so a jump link would 404 — the id stays useful
        // for correlating with the audit log.
        { name: labels.message, value: `\`${event.messageId}\``, inline: true },
      ];

    case LOG_SELF_DELETED:
      return [user, channel, { name: labels.categories, value: categories, inline: true }];

    case LOG_FORGIVEN:
      return [
        user,
        { name: labels.actor, value: `<@${event.actorId}>`, inline: true },
        { name: labels.count, value: String(event.count ?? 0), inline: true },
      ];

    default:
      return [user];
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
    footer: { text: content.moderation.log.footer },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Best effort: a missing channel or a missing permission must never break the
 * moderation pipeline.
 *
 * @param {import('discord.js').Client} client
 * @param {object} event
 * @returns {Promise<boolean>} Whether the entry was posted.
 */
export async function postModerationLog(client, event) {
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

    await channel.send({ embeds: [buildLogEmbed(event)], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    logger.warn(
      { guildId: event.guildId, channelId: logChannelId, type: event.type, err: error },
      'Could not write to the moderation log channel',
    );
    return false;
  }
}
