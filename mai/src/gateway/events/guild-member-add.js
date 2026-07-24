/**
 * Welcomes new members in the guild's system channel, in Mai's voice.
 *
 * Requires the privileged "Server Members Intent" (Developer Portal -> Bot)
 * and DISCORD_WELCOME_ENABLED=true — the GuildMembers gateway intent is only
 * requested when the flag is set (see gateway/client.js).
 */
import { PermissionFlagsBits } from 'discord.js';
import { isGuildAllowed } from '../../config.js';
import { logger } from '../../logger.js';

const WELCOME_LINES = [
  (member) =>
    `*streckt sich, gähnt und tapst heran* Miau, ${member}! Willkommen - die besten Sonnenplätze sind leider schon besetzt. Von mir. 🐾`,
  (member) =>
    `Ein neuer Mensch! Willkommen, ${member}! *reibt den Kopf an deinem Bein* 😺`,
  (member) =>
    `*späht hinter dem Kratzbaum hervor* Oh, ${member} ist da! Willkommen. Mitgebrachte Leckerlis bitte direkt bei mir abgeben. 🐟`,
  (member) =>
    `${member}! *springt aufs Sofa* Willkommen! Ich bin Mai, die Moderatorin hier. Kraulen erlaubt, aber nur am Kopf. 🐱`,
];

/**
 * @param {import('discord.js').GuildMember} member
 */
export async function onGuildMemberAdd(member) {
  if (member.user?.bot) return;

  // Same guild allowlist as the rest of the bot.
  if (!isGuildAllowed(member.guild.id)) return;

  const channel = member.guild.systemChannel;
  if (!channel) {
    logger.debug(
      { guildId: member.guild.id },
      'No system channel, skipping welcome',
    );
    return;
  }

  const me = member.guild.members.me;
  if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    logger.debug(
      { guildId: member.guild.id, channelId: channel.id },
      'Missing Send Messages permission in system channel, skipping welcome',
    );
    return;
  }

  const line = WELCOME_LINES[Math.floor(Math.random() * WELCOME_LINES.length)];

  try {
    await channel.send({
      content: line(member),
      allowedMentions: { users: [member.id] },
    });
    logger.info(
      { guildId: member.guild.id, userId: member.id },
      'Welcomed new member',
    );
  } catch (error) {
    logger.warn(
      { guildId: member.guild.id, userId: member.id, err: error },
      'Failed to send welcome message',
    );
  }
}
