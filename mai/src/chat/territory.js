/**
 * Territory: one channel per server that Mai has claimed for the day, the way
 * a cat occupies a box. In it her replies are smug about whose channel this
 * is; elsewhere in the server she may mention that it is hers.
 *
 * A **tone and never a restriction**. The claim adds one directive to the chat
 * prompt and nothing else: she answers everywhere exactly as before, nobody is
 * turned away from her channel or told to go there, and moderation neither
 * reads this nor is read by it.
 *
 * The channel is picked at random from the ones that qualify, and deliberately
 * not by activity: "the busiest channel" means counting messages per channel,
 * which is a per-channel activity record, the very thing `/metrics` is
 * forbidden from labelling. What qualifies is decided by what she is about to
 * say about it, since she names it in other channels:
 *
 * - a plain text channel (not a thread, a forum, voice or announcements),
 * - one **everybody** can see, so naming it elsewhere cannot point a member at
 *   a staff channel or tell them one exists,
 * - one she can read and write in,
 * - not age-restricted, not exempted from moderation (a vent channel is the
 *   last place for a smug cat), and not the moderation log.
 *
 * Picked lazily, on the first chat turn in a server that needs one, rather than
 * by a timer: a server nobody talks to her in costs nothing, and the enforcer
 * tick stays a moderation loop. The claim is checked again on every read, so a
 * channel that was deleted, made private or exempted in the meantime is given
 * up straight away rather than at the end of the day. In memory, like the
 * zoomies: a restart is a nap, and she wakes up somewhere new.
 */
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { effectiveSettings } from '../db/settings.js';
import { logger } from '../logger.js';
import { isExemptChannel } from '../moderation/check.js';

/** What she needs in a channel to sit in it and talk. */
const MINE = Object.freeze([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);

/** `guildId` -> { channelId: string | null, until: epoch ms }. Null = nothing qualified. */
const claims = new Map();

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildBasedChannel | undefined} channel
 * @returns {boolean}
 */
function qualifies(guild, channel) {
  if (channel?.type !== ChannelType.GuildText) return false;
  if (channel.nsfw) return false;

  // Unknowable without her own member object, and "unknown" is not "allowed".
  const me = guild.members?.me;
  const everyone = guild.roles?.everyone;
  if (!me || !everyone) return false;
  if (!channel.permissionsFor(me)?.has(MINE)) return false;
  if (!channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)) return false;

  if (channel.id === effectiveSettings(guild.id).logChannelId) return false;
  return !isExemptChannel(guild.id, channel.id, channel.parentId);
}

/**
 * Her claim in this server, and whether the conversation is happening in it.
 *
 * @param {import('discord.js').Client | null | undefined} client
 * @param {string | null | undefined} guildId Null in a DM, which has no territory.
 * @param {{ channelId?: string | null, parentId?: string | null }} [where] The channel
 *   being talked in, and its parent when that is a thread: a thread inside her
 *   channel is still her channel.
 * @param {number} [now]
 * @returns {{ channelId: string, here: boolean } | null}
 */
export function territoryFor(client, guildId, where = {}, now = Date.now()) {
  if (!guildId) return null;
  const guild = client?.guilds?.cache?.get(guildId);
  if (!guild) return null;

  let claimed;
  try {
    claimed = claimFor(guild, now);
  } catch (error) {
    // A smug line is the most optional thing in the prompt: a failure here
    // costs the claim, never the reply.
    logger.debug({ guildId, err: error }, 'Territory lookup failed');
    return null;
  }
  if (!claimed) return null;

  const here = Boolean(where.channelId)
    && (claimed === where.channelId || claimed === where.parentId);
  return { channelId: claimed, here };
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {number} now
 * @returns {string | null} The claimed channel's id.
 */
function claimFor(guild, now) {
  const current = claims.get(guild.id);
  if (current && current.until > now) {
    if (current.channelId === null) return null;
    if (qualifies(guild, guild.channels?.cache?.get(current.channelId))) return current.channelId;
    // Deleted, made private or exempted since: given up now, not at the end
    // of the day.
  }

  const candidates = [...(guild.channels?.cache?.values() ?? [])].filter((channel) =>
    qualifies(guild, channel),
  );

  if (candidates.length === 0) {
    claims.set(guild.id, { channelId: null, until: now + config.territory.retryMs });
    return null;
  }

  const channel = candidates[Math.floor(Math.random() * candidates.length)];
  claims.set(guild.id, { channelId: channel.id, until: now + config.territory.claimMs });
  logger.info({ guildId: guild.id, channelId: channel.id }, 'Mai claimed a channel');
  return channel.id;
}

/** Test seam: the claims are process-lifetime state. */
export function resetTerritory() {
  claims.clear();
}
