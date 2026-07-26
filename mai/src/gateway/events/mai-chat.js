/**
 * Mai chat: users talk to the bot by mentioning it, replying to one of its
 * messages, or sending it a direct message.
 *
 * This module owns the Discord side (trigger detection, typing indicator,
 * posting the answer) and the guards in front of the model call; the reply
 * itself comes from chat/reply.js.
 */
import { generateChatReply, rememberExchange } from '../../chat/reply.js';
import { acquireSlot, consumeRateLimit, releaseSlot, runExclusive } from '../../chat/limits.js';
import { config, isGuildAllowed } from '../../config.js';
import { content } from '../../content.js';
import { logger } from '../../logger.js';

// Discord's typing indicator expires after ~10 s; refresh while the model call
// is still running.
const TYPING_REFRESH_MS = 8_000;

/**
 * Whether a direct-message author is allowed to talk to Mai: they must share at
 * least one whitelisted guild with the bot. A DM has no guildId, so the plain
 * allowlist cannot apply — this walks the whitelisted guilds and checks
 * membership. Empty allowlist = every guild allowed, so DMs are open too.
 *
 * A single-member fetch by ID uses the REST API and does NOT need the
 * privileged GuildMembers intent (bulk fetches would).
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>}
 */
export async function isDmAuthorInAllowedGuild(message) {
  const { guildIds } = config.discord;
  if (guildIds.size === 0) return true;

  const userId = message.author?.id;
  if (!userId) return false;

  for (const guildId of guildIds) {
    const guild = message.client.guilds.cache.get(guildId);
    if (!guild) continue; // bot is not in this whitelisted guild
    try {
      await guild.members.fetch(userId);
      return true;
    } catch {
      // Unknown Member (not in this guild) or a transient fetch error — try
      // the next whitelisted guild.
    }
  }
  return false;
}

/**
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} Whether this message is addressed to Mai.
 */
export async function isMaiChatTrigger(message) {
  if (!config.chat.enabled) return false;

  const botId = message.client.user?.id;
  if (!botId) return false;

  // A direct message is always addressed to Mai — no mention needed. Whether
  // the author may DM at all (shared whitelisted guild) is enforced by the
  // caller (onMessageCreate) before this runs.
  if (!message.guildId) return true;

  // Same guild allowlist as moderation.
  if (!isGuildAllowed(message.guildId)) return false;

  // Direct @mention (also covers replies with the mention toggle on).
  if (message.mentions.users?.has(botId)) return true;

  // Reply to one of Mai's messages with the mention toggle off.
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      return referenced?.author?.id === botId;
    } catch (error) {
      logger.debug(
        { messageId: message.id, err: error },
        'Could not fetch referenced message',
      );
      return false;
    }
  }

  return false;
}

/**
 * Reaction instead of an answer: Mai is rate-limited or at her concurrency cap.
 *
 * @param {import('discord.js').Message} message
 */
const reactBusy = (message) =>
  message.react(content.chat.busyEmoji).catch((error) => {
    logger.debug({ messageId: message.id, err: error }, 'Busy reaction failed');
  });

/**
 * @param {import('discord.js').Message} message
 */
export async function handleMaiChat(message) {
  const botId = message.client.user.id;

  // Strip the bot mention; an empty remainder is a bare poke, answered with a
  // greeting.
  const text = (message.content ?? '')
    .replaceAll(`<@${botId}>`, '')
    .replaceAll(`<@!${botId}>`, '')
    .trim();

  const input = {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    username: message.author.username,
    content: text,
  };

  if (!consumeRateLimit(input.userId)) {
    await reactBusy(message);
    return;
  }

  if (!acquireSlot()) {
    await reactBusy(message);
    return;
  }

  try {
    // Per-channel serialization keeps read-history -> reply -> store atomic when
    // several people talk to Mai in the same channel at once.
    await runExclusive(input.channelId, async () => {
      await message.channel.sendTyping().catch(() => {});
      const typing = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, TYPING_REFRESH_MS);

      let reply;
      try {
        reply = await generateChatReply(input);
      } finally {
        clearInterval(typing);
      }

      if (!reply) return;

      // parse: [] blocks @everyone/role/user pings inside the LLM reply; the
      // reply-ping to the author is allowed explicitly.
      await message.reply({
        content: reply,
        allowedMentions: { parse: [], repliedUser: true },
      });

      rememberExchange(input, reply);

      logger.info({ messageId: message.id, replyLength: reply.length }, 'Mai replied');
      logger.debug({ messageId: message.id, reply }, 'Mai reply content');
    });
  } finally {
    releaseSlot();
  }
}
