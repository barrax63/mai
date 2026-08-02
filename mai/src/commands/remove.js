/**
 * "Löschen (Mai)": the staff message context-menu deletion.
 *
 * Right-click a message -> Apps -> the entry below -> the message is gone and
 * the strike is on the record. Mai could only ever act on her own verdict, so a
 * moderator who disagreed with her about a message had to delete it by hand,
 * which left the record saying nothing happened, the escalation ladder unaware,
 * and the log channel silent.
 *
 * The differences to the automatic path are deliberate:
 *   - **no grace period**: a human already looked at it, which is exactly what
 *     the grace period exists to substitute for;
 *   - **no timeout**: the strike counts towards the *next* automatic
 *     escalation, but a click here never hands one out. A moderator who wants a
 *     timeout has Discord's own, in front of them, with the duration visible;
 *   - **no appeal button**: an appeal is against Mai being wrong. This was a
 *     person, and the member can talk to them.
 *
 * Anything Mai deletes has to be registered first (`markOwnDeletion`), or the
 * messageDelete handler records the author as having removed it themselves and
 * silently downgrades the strike.
 */
import { PermissionFlagsBits } from 'discord.js';
import { content, fill } from '../content.js';
import { recordEvidence } from '../db/evidence.js';
import { findRow, remove } from '../db/queue.js';
import { effectiveSettings } from '../db/settings.js';
import { ACTION_DELETED, recordViolation } from '../db/violations.js';
import { getGatewayClient } from '../gateway/client.js';
import { targetMessage } from '../interactions/options.js';
import { ephemeralResponse } from '../interactions/respond.js';
import { logger } from '../logger.js';
import { deleteMessageById, markOwnDeletion } from '../moderation/cleanup.js';
import { LOG_MANUAL_DELETE, postModerationLog } from '../moderation/log.js';
import { mayModerate } from '../permissions.js';

const actor = (interaction) => interaction.member?.user ?? interaction.user ?? {};

/**
 * A message Mai had already flagged and was waiting to enforce: staff got there
 * first. The row has to go with it, or the next tick fetches a message that is
 * gone, reads that as the author having deleted it, and records a self-deletion
 * over the strike this click just wrote.
 *
 * @param {import('discord.js').Client} client
 * @param {string} messageId
 * @param {string} channelId
 */
async function dropPendingRow(client, messageId, channelId) {
  const row = findRow(messageId);
  if (!row) return;

  remove(messageId);
  await deleteMessageById(client, channelId, row.scoldMessageId);
  logger.info({ messageId }, 'Staff deleted a message Mai still had queued');
}

export const removeMessage = {
  definition: {
    // Context-menu entries carry no description and show their name verbatim.
    name: 'Löschen (Mai)',
    type: 3, // MESSAGE
    // Hides the entry from members without Manage Messages. The check is
    // repeated in code: this is a UI default a server admin can widen.
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
  },

  // Deleting is a Discord round trip, and the log post another: both together
  // outlast the ~3 s budget under a rate limit.
  //
  // Only for staff, though. A refusal is one line from memory, and answering it
  // through the deferral means a placeholder plus a webhook edit for somebody
  // who was never going to be allowed to do anything: the same reason
  // `report-approve` makes its deferral conditional.
  deferred: (interaction) => mayModerate(interaction),
  ephemeral: true,

  /**
   * @param {object} interaction
   * @returns {Promise<object>}
   */
  async execute(interaction) {
    if (!interaction.guild_id) return ephemeralResponse(content.commands.remove.guildOnly);
    if (!mayModerate(interaction)) return ephemeralResponse(content.commands.forbidden);

    const staff = actor(interaction);
    const channelId = interaction.channel_id;
    const messageId = interaction.data?.target_id;
    const target = targetMessage(interaction);
    const authorId = target?.author?.id ?? '';

    if (!messageId || !authorId) return ephemeralResponse(content.commands.error);
    // Deleting Mai's own message through this is pointless, and recording a
    // strike against the bot is worse than pointless.
    if (target?.author?.bot) return ephemeralResponse(content.commands.remove.botMessage);

    const client = getGatewayClient();
    const settings = effectiveSettings(interaction.guild_id);

    try {
      const channel = await client?.channels?.fetch(channelId);

      // No channel is a failed deletion, never a permitted one. `client` is null
      // until the gateway is ready (the HTTP server listens first), and
      // `channels.fetch` can answer null for a channel that is simply gone.
      // Optional chaining all the way to `delete` used to swallow both and fall
      // through to the success path, which wrote a strike towards an automatic
      // timeout, kept the text as appeal evidence and logged a removal, for a
      // message still on screen. `warn` rather than `error`: a gateway that is
      // not up yet is not an incident worth paging the operator about.
      if (!channel) {
        logger.warn(
          { channelId, messageId, guildId: interaction.guild_id, byUserId: staff.id },
          'Manual deletion could not resolve its target channel',
        );
        return ephemeralResponse(content.commands.remove.failed);
      }

      // The target id comes from Discord's own resolved payload rather than a
      // custom_id, but the fetch still goes through the bot's client, which
      // reaches every guild Mai is in: prove the channel is this guild's.
      if (channel.guildId !== interaction.guild_id) {
        logger.error(
          { channelId, messageId, guildId: interaction.guild_id, byUserId: staff.id },
          'Manual deletion targeted a channel outside the calling guild',
        );
        return ephemeralResponse(content.commands.remove.failed);
      }

      if (settings.evidenceEnabled) {
        keepEvidence(interaction.guild_id, authorId, channelId, messageId, target);
      }

      markOwnDeletion(messageId);
      // Unchained deliberately: a channel with no message manager (a category, a
      // voice channel) has to throw into the catch below rather than resolve as
      // a deletion, for the same reason.
      await channel.messages.delete(messageId);
    } catch (error) {
      logger.warn({ channelId, messageId, err: error }, 'Manual deletion failed');
      return ephemeralResponse(content.commands.remove.failed);
    }

    await dropPendingRow(client, messageId, channelId);

    recordViolation({
      guildId: interaction.guild_id,
      userId: authorId,
      messageId,
      // No classifier ran, so there is no category to name: a human decided.
      categories: [],
      action: ACTION_DELETED,
    });

    logger.info(
      { guildId: interaction.guild_id, channelId, messageId, userId: authorId, byUserId: staff.id },
      'Staff deleted a message through Mai',
    );

    await postModerationLog(client, {
      type: LOG_MANUAL_DELETE,
      guildId: interaction.guild_id,
      channelId,
      messageId,
      userId: authorId,
      actorId: staff.id,
    });

    return ephemeralResponse(fill(content.commands.remove.done, { userId: authorId }));
  },
};

/**
 * Same rule as the enforcer's: where the guild keeps evidence, this is the last
 * moment the text exists. Never allowed to stop the deletion.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} channelId
 * @param {string} messageId
 * @param {object} message The resolved message from the interaction payload.
 */
function keepEvidence(guildId, userId, channelId, messageId, message) {
  try {
    recordEvidence({
      messageId,
      guildId,
      userId,
      channelId,
      content: message?.content ?? '',
      attachments: message?.attachments?.length ?? 0,
      categories: [],
    });
  } catch (error) {
    logger.error({ messageId, err: error }, 'Could not keep evidence for a manual deletion');
  }
}
