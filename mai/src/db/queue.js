/**
 * The moderation queue ("privacy queue"): metadata of flagged messages waiting
 * out their grace period. Never message content — the text of a deleted message
 * is read live from Discord at enforcement time and is not persisted.
 *
 * A present row also encodes "this user has an open, un-enforced violation",
 * which is what makes Mai's chat persona turn aggressive (see chat/reply.js).
 */
import { getDb } from './index.js';

const parseCategories = (value) => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
};

const toRow = (row) => ({
  messageId: row.message_id,
  guildId: row.guild_id,
  channelId: row.channel_id,
  userId: row.user_id,
  categories: parseCategories(row.categories),
  warnedAt: row.warned_at,
  dueAt: row.due_at,
  scoldMessageId: row.scold_message_id || null,
});

/**
 * Adds (or replaces) a queue entry. Replacing keeps re-classification of the
 * same message idempotent instead of piling up duplicate rows.
 *
 * @param {{ messageId: string, guildId: string, channelId: string, userId: string,
 *   categories: string[], warnedAt: string, dueAt: string, scoldMessageId?: string | null }} entry
 */
export function enqueue(entry) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO moderation_queue
         (message_id, guild_id, channel_id, user_id, categories, warned_at, due_at, scold_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.messageId,
      entry.guildId,
      entry.channelId,
      entry.userId,
      JSON.stringify(entry.categories ?? []),
      entry.warnedAt,
      entry.dueAt,
      entry.scoldMessageId ?? null,
    );
}

/**
 * Rows whose grace period has expired, oldest first.
 *
 * @param {string} nowIso
 */
export function dueRows(nowIso) {
  return getDb()
    .prepare('SELECT * FROM moderation_queue WHERE due_at <= ? ORDER BY due_at ASC')
    .all(nowIso)
    .map(toRow);
}

/**
 * @param {string} messageId
 * @returns {number} Rows removed.
 */
export function remove(messageId) {
  return getDb()
    .prepare('DELETE FROM moderation_queue WHERE message_id = ?')
    .run(messageId).changes;
}

/**
 * Open violations of a user across **all** guilds — Mai is one persona, so a
 * strike anywhere makes her mad at that user everywhere, DMs included.
 *
 * @param {string} userId
 * @param {number} [limit]
 * @returns {{ count: number, categories: string[] }}
 */
export function openViolations(userId, limit = 20) {
  const rows = getDb()
    .prepare('SELECT categories FROM moderation_queue WHERE user_id = ? ORDER BY warned_at DESC LIMIT ?')
    .all(userId, limit);

  const categories = [...new Set(rows.flatMap((row) => parseCategories(row.categories)))];
  return { count: rows.length, categories };
}

/**
 * Drops every open violation of a user (the `/mai forgive` command). Returns the
 * removed rows so their scold replies can be cleaned up.
 *
 * @param {string} userId
 * @returns {ReturnType<typeof toRow>[]}
 */
export function forgiveUser(userId) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM moderation_queue WHERE user_id = ?')
    .all(userId)
    .map(toRow);

  if (rows.length > 0) {
    db.prepare('DELETE FROM moderation_queue WHERE user_id = ?').run(userId);
  }
  return rows;
}

/**
 * @returns {number} Total open violations across all users.
 */
export function depth() {
  return getDb().prepare('SELECT COUNT(*) AS count FROM moderation_queue').get().count;
}
