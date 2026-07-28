/**
 * Mai joined a server. This is the only chance to be useful before somebody
 * reads the documentation, and until now she took it by saying nothing.
 *
 * What a fresh server actually looked like: no log channel, so no moderation
 * log, no reports and no appeals; every local rule off, because "off" is the
 * only honest default for a house rule; and seventeen `/mod config set` options
 * standing between an admin and a working setup. She moderated, invisibly, at
 * whatever the process defaults happened to be.
 *
 * So she introduces herself once per server, in the best channel she can write
 * to, with the three setup presets as buttons: one click is a whole
 * configuration (see moderation/presets.js). The same message names what is
 * missing for her to work at all, because a permission she has not got is the
 * other thing a new server never finds out about until it matters.
 *
 * Once per server, ever: `onboarded_at` in `guild_settings`, so a reconnect, a
 * restart or a re-join cannot produce a second one.
 */
import { PermissionFlagsBits } from 'discord.js';
import { isGuildAllowed } from '../../config.js';
import { content, fill } from '../../content.js';
import { markOnboarded, wasOnboarded } from '../../db/settings.js';
import { logger } from '../../logger.js';
import { auditPermissions, permissionsComplete } from '../../permissions.js';
import { PRESET_NAMES } from '../../moderation/presets.js';

const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_PRIMARY = 1;
const STYLE_SECONDARY = 2;

/**
 * Somewhere an admin will actually see it: the server's own system channel
 * first, then the first channel Mai may write in. Silence is the last resort
 * and is not an error: a server can legitimately have no channel for this.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {import('discord.js').GuildTextBasedChannel | null}
 */
function introductionChannel(guild) {
  const me = guild.members?.me;
  const writable = (channel) =>
    channel?.isTextBased?.()
    && !channel.isThread?.()
    && (!me || channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages));

  if (writable(guild.systemChannel)) return guild.systemChannel;

  for (const channel of guild.channels?.cache?.values() ?? []) {
    if (writable(channel)) return channel;
  }
  return null;
}

/**
 * One button per preset. The name rides in the `custom_id`, and the handler
 * checks the clicker's permissions rather than trusting the click.
 *
 * @returns {object[]}
 */
const presetButtons = () => [
  {
    type: ACTION_ROW,
    components: PRESET_NAMES.map((name, index) => ({
      type: BUTTON,
      // The recommended first step leads, and is the only highlighted one.
      style: index === 0 ? STYLE_PRIMARY : STYLE_SECONDARY,
      label: content.commands.setup.presets[name].button,
      custom_id: `setup:${name}`,
    })),
  },
];

/**
 * @param {import('discord.js').Guild} guild
 * @returns {string} The permission paragraph, or an empty string when there is
 *   nothing to say.
 */
function permissionNotice(guild) {
  const report = auditPermissions(guild, { force: true });
  if (permissionsComplete(report) || !report.known) return '';

  return `\n\n${fill(content.commands.setup.missingPermissions, {
    permissions: report.guild.join(', ') || content.moderation.log.none,
  })}`;
}

/**
 * @param {import('discord.js').Guild} guild
 */
export async function onGuildCreate(guild) {
  // An un-allowlisted server gets no behaviour at all, and that includes being
  // talked to: Mai is in it, but she is not *in* it.
  if (!isGuildAllowed(guild.id)) {
    logger.info({ guildId: guild.id }, 'Joined a guild outside the allowlist, staying quiet');
    return;
  }

  if (wasOnboarded(guild.id)) {
    logger.debug({ guildId: guild.id }, 'Already introduced here');
    return;
  }

  // Marked before the send, not after: a failure here must not queue up a
  // second attempt on the next reconnect. Saying hello twice is worse than not
  // saying it at all, and `/mod setup` is the same thing on demand.
  markOnboarded(guild.id);

  const channel = introductionChannel(guild);
  if (!channel) {
    logger.info({ guildId: guild.id }, 'Joined a guild with nowhere to introduce myself');
    return;
  }

  const body = `${content.commands.setup.introduction}${permissionNotice(guild)}`;

  try {
    await channel.send({
      content: body,
      components: presetButtons(),
      allowedMentions: { parse: [] },
    });
    logger.info(
      { guildId: guild.id, channelId: channel.id, members: guild.memberCount },
      'Introduced myself to a new guild',
    );
  } catch (error) {
    logger.warn({ guildId: guild.id, channelId: channel.id, err: error }, 'Introduction failed');
  }
}
