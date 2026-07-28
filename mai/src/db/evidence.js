/**
 * What an enforced message said, kept just long enough to decide an appeal
 * about it.
 *
 * The second deliberate exception to the no-content rule, and deliberately the
 * narrowest one. Everything else Mai stores about moderation is metadata, which
 * is enough to *act* and not enough to *review*: an appeal saying "das war ein
 * Zitat, kein Angriff" used to leave staff choosing between the member's word
 * and a category slug, with the message itself already deleted.
 *
 * The limits are the feature:
 *   - off unless the guild turned it on and the operator set a retention window
 *     (`MODERATION_EVIDENCE_HOURS` above 0, which also makes the key required);
 *   - only messages Mai actually enforced;
 *   - `content` is AES-256-GCM ciphertext (crypto.js), like `chat_history`;
 *   - pruned in hours by the same tick that prunes everything else;
 *   - read back ephemerally by one moderator, never posted into a channel.
 *
 * Undecryptable rows (a rotated key) are skipped rather than thrown, exactly
 * like chat history: a lost key must not break an appeal review.
 */
import { logger } from '../logger.js';
import { decrypt, encrypt } from './crypto.js';
import { getDb } from './index.js';

const parseCategories = (value) => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
};

/**
 * @param {{ messageId: string, guildId: string, userId: string, channelId: string,
 *   content: string, attachments?: number, categories?: string[], createdAt?: string }} entry
 */
export function recordEvidence(entry) {
  getDb()
    .prepare(
      `INSERT INTO evidence
         (message_id, guild_id, user_id, channel_id, content, attachments, categories, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
    )
    .run(
      entry.messageId,
      entry.guildId,
      entry.userId,
      entry.channelId,
      encrypt(entry.content ?? ''),
      entry.attachments ?? 0,
      JSON.stringify(entry.categories ?? []),
      entry.createdAt ?? new Date().toISOString(),
    );
}

/**
 * The messages one enforcement pass took from a member, for the appeal about
 * that pass.
 *
 * Scoped by guild *and* time for the same reason `overturnSince` is: an appeal
 * names one incident, and a moderator reviewing it has no business reading four
 * earlier ones that nobody is disputing.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} sinceIso Start of the enforcement pass.
 * @param {number} [limit]
 * @returns {{ messageId: string, channelId: string, content: string,
 *   attachments: number, categories: string[], createdAt: string }[]} Oldest first.
 */
export function evidenceFor(guildId, userId, sinceIso, limit = 10) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM evidence
       WHERE guild_id = ? AND user_id = ? AND created_at >= ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(guildId, userId, sinceIso, limit);

  const entries = [];
  for (const row of rows) {
    try {
      entries.push({
        messageId: row.message_id,
        channelId: row.channel_id,
        content: decrypt(row.content),
        attachments: row.attachments,
        categories: parseCategories(row.categories),
        createdAt: row.created_at,
      });
    } catch (error) {
      // The row id and the reason, never the row: it is ciphertext we could not
      // read, and logging the attempt must not become a second copy.
      logger.warn({ messageId: row.message_id, err: error }, 'Dropping undecryptable evidence row');
    }
  }
  return entries;
}

/**
 * Retention. Hours rather than days: this exists for the appeal window.
 *
 * @param {string} cutoffIso
 * @returns {number} Rows removed.
 */
export function pruneOlderThan(cutoffIso) {
  return getDb().prepare('DELETE FROM evidence WHERE created_at < ?').run(cutoffIso).changes;
}

/**
 * Drops what is kept about one member in one guild.
 *
 * Called when staff wipe that member's record (`/mod forgive … strikes:true`):
 * a pardon that leaves the quotes lying around is not a pardon. Deliberately
 * *not* wired to `/mai forget`, which is the member's own command: evidence is
 * what an appeal is reviewed against, and letting the person being reviewed
 * delete it would make the review worthless.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {number} Rows removed.
 */
export function clearForUser(guildId, userId) {
  return getDb()
    .prepare('DELETE FROM evidence WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId).changes;
}

/**
 * @param {string} [guildId] Omit for the process-wide total (operators only).
 * @returns {number}
 */
export function count(guildId) {
  const db = getDb();
  return guildId
    ? db.prepare('SELECT COUNT(*) AS count FROM evidence WHERE guild_id = ?').get(guildId).count
    : db.prepare('SELECT COUNT(*) AS count FROM evidence').get().count;
}
