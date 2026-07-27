/**
 * Handler for deleted messages.
 *
 * The enforcer already noticed a self-deletion — but only at the deadline, so
 * an author who fixed their mistake in ten seconds still saw a live queue row,
 * a scold reply sitting under a message that no longer exists, and nothing in
 * the log for up to the whole grace period. Reacting to the event closes that
 * window: the row resolves the moment the author acts.
 *
 * `messageDelete` does not say *who* deleted the message, so deletions Mai
 * performs herself (enforcement, an approved report, cleaning up a scold reply)
 * are marked in `cleanup.js` beforehand and skipped here. Without that, her own
 * enforcement would be recorded as the author having fixed it — the opposite of
 * what happened, and a strike quietly downgraded.
 */
import { findRow } from '../../db/queue.js';
import { isGuildActive } from '../../db/settings.js';
import { isGuildAllowed } from '../../config.js';
import { logger } from '../../logger.js';
import { isOwnDeletion } from '../../moderation/cleanup.js';
import { recordSelfDeletion } from '../../moderation/check.js';

/**
 * @param {import('discord.js').Message} message Possibly a partial — for an
 *   uncached message Discord sends little more than the ids, which is all this
 *   needs: the queue is keyed by message id.
 */
export async function onMessageDelete(message) {
  const messageId = message?.id;
  if (!messageId) return;

  // Mai's own doing. Not logged: this fires for every enforced deletion and
  // every scold reply she cleans up, which is normal traffic, not an event.
  if (isOwnDeletion(messageId)) return;

  const row = findRow(messageId);
  if (!row) return;

  if (!isGuildAllowed(row.guildId)) return;

  // Paused (/mod off) is a pause, not an amnesty — the enforcer keeps the row
  // for later, so this must not resolve it either.
  if (!isGuildActive(row.guildId)) {
    logger.debug(
      { messageId, guildId: row.guildId },
      'Ignoring deletion of a queued message: Mai is paused in this guild',
    );
    return;
  }

  await recordSelfDeletion(message.client, row);
}
