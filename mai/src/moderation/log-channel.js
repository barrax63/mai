/**
 * Finding Mai somewhere to write, so the features that need one are not quietly
 * absent.
 *
 * `log-channel` is the only setting with no working default, and the cost of
 * leaving it unset is not that the moderation log is missing: it is that
 * reports refuse, appeals refuse, the appeal button is not attached to a warning
 * DM at all, and `LOG_DEGRADED` has nowhere to say that moderation is currently
 * passing everything through. A server that never got round to one decision is
 * missing four features and is told about none of them until somebody tries.
 *
 * So she looks for one herself when she joins, in two steps and in this order:
 *
 *   1. **Adopt** a channel the server already keeps for this. The patterns are
 *      deliberately narrow (`mod-log`, `moderation-log`, `mai-log`, and their
 *      plural and underscore spellings) rather than anything containing "log":
 *      adopting `#changelog` would start posting member ids and category slugs
 *      into a channel nobody meant for that, which is a privacy decision and not
 *      a convenience one. When in doubt she does not adopt.
 *   2. **Create** one, if she may. Denied to `@everyone` on creation, so the
 *      default is less exposure rather than more: admins see it inherently and
 *      the introduction message says to let the moderator role in. Creating a
 *      channel in somebody's server is a visible act, which is exactly why it is
 *      announced in the same breath rather than done quietly.
 *
 * Both steps are best effort and every failure ends in "no channel", which is
 * the state the server was already in.
 */
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { content } from '../content.js';
import { effectiveSettings, updateSettings } from '../db/settings.js';
import { logger } from '../logger.js';

/**
 * Names that mean "this is where moderation output goes" and nothing else.
 * Matched against the whole name, not a substring of it.
 */
const ADOPTABLE = /^(mod|moderation|mai)[-_]?logs?$/i;

/** What she must have in a channel for it to be usable as the log. */
const NEEDED = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
]);

/**
 * @param {import('discord.js').Guild} guild
 * @returns {import('discord.js').GuildTextBasedChannel | null}
 */
function adoptable(guild) {
  const me = guild.members?.me;

  for (const channel of guild.channels?.cache?.values() ?? []) {
    if (channel?.type !== ChannelType.GuildText) continue;
    if (!ADOPTABLE.test(channel.name ?? '')) continue;
    // A channel she cannot write in is not an answer, it is the same problem
    // one step further along. Written out rather than leaning on `?.` here: the
    // short-circuit would make an unreadable permission set read as "fine",
    // and this is the check that stops her adopting somewhere she is mute.
    if (me) {
      const gaps = channel.permissionsFor(me)?.missing(NEEDED);
      if (!gaps || gaps.length > 0) continue;
    }
    return channel;
  }
  return null;
}

/**
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').GuildTextBasedChannel | null>}
 */
async function create(guild) {
  const me = guild.members?.me;
  if (me && !me.permissions.has(PermissionFlagsBits.ManageChannels)) return null;

  try {
    return await guild.channels.create({
      name: content.moderation.log.channelName,
      type: ChannelType.GuildText,
      topic: content.moderation.log.channelTopic,
      permissionOverwrites: [
        // Everyone out by default. A moderation log names members and the
        // categories they were flagged for, and a server that has not chosen
        // who reads that has not consented to everyone reading it.
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...(me ? [{ id: me.id, allow: NEEDED }] : []),
      ],
    });
  } catch (error) {
    logger.warn({ guildId: guild.id, err: error }, 'Could not create a moderation log channel');
    return null;
  }
}

/**
 * Gives the guild a `log-channel` if it has none and one can be had.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{ channelId: string | null, created: boolean, adopted: boolean }>}
 */
export async function ensureLogChannel(guild) {
  const nothing = { channelId: null, created: false, adopted: false };
  // Never overrule a server that has chosen: this only fills an empty setting.
  if (effectiveSettings(guild.id).logChannelId) return nothing;

  const existing = adoptable(guild);
  if (existing) {
    updateSettings(guild.id, { 'log-channel': existing.id });
    logger.info(
      { guildId: guild.id, channelId: existing.id },
      'Adopted an existing channel as the moderation log',
    );
    return { channelId: existing.id, created: false, adopted: true };
  }

  const made = await create(guild);
  if (!made) return nothing;

  updateSettings(guild.id, { 'log-channel': made.id });
  logger.info({ guildId: guild.id, channelId: made.id }, 'Created a moderation log channel');
  return { channelId: made.id, created: true, adopted: false };
}
