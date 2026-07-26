/**
 * The strike record: what Mai actually enforced, per member and guild.
 *
 * The queue forgets a violation the moment it is enforced, which is what made a
 * repeat offender indistinguishable from a first-timer. This is the memory the
 * escalation ladder counts against — metadata only, and pruned after
 * VIOLATION_RETENTION_DAYS.
 */
import { getDb } from './index.js';

export const ACTION_DELETED = 'deleted';
export const ACTION_SELF_DELETED = 'self_deleted';

const parseCategories = (value) => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
};

/**
 * @param {{ guildId: string, userId: string, messageId: string, categories?: string[],
 *   action: string, createdAt?: string }} entry
 */
export function recordViolation(entry) {
  getDb()
    .prepare(
      `INSERT INTO violations (guild_id, user_id, message_id, categories, action, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.guildId,
      entry.userId,
      entry.messageId,
      JSON.stringify(entry.categories ?? []),
      entry.action,
      entry.createdAt ?? new Date().toISOString(),
    );
}

/**
 * Strikes that count towards escalation: enforced deletions in this guild since
 * the cutoff. A message the author removed during the grace period is on the
 * record but deliberately does not escalate — the grace period did its job.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} sinceIso
 * @returns {number}
 */
export function strikeCount(guildId, userId, sinceIso) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM violations
       WHERE guild_id = ? AND user_id = ? AND action = ? AND created_at >= ?`,
    )
    .get(guildId, userId, ACTION_DELETED, sinceIso).count;
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {number} [limit]
 * @returns {{ messageId: string, categories: string[], action: string, createdAt: string }[]}
 *   Newest first.
 */
export function historyFor(guildId, userId, limit = 10) {
  return getDb()
    .prepare(
      `SELECT message_id, categories, action, created_at FROM violations
       WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(guildId, userId, limit)
    .map((row) => ({
      messageId: row.message_id,
      categories: parseCategories(row.categories),
      action: row.action,
      createdAt: row.created_at,
    }));
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {{ total: number, deleted: number, selfDeleted: number }}
 */
export function totalsFor(guildId, userId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN action = ? THEN 1 ELSE 0 END) AS deleted,
              SUM(CASE WHEN action = ? THEN 1 ELSE 0 END) AS self_deleted
       FROM violations WHERE guild_id = ? AND user_id = ?`,
    )
    .get(ACTION_DELETED, ACTION_SELF_DELETED, guildId, userId);

  return {
    total: row.total ?? 0,
    deleted: row.deleted ?? 0,
    selfDeleted: row.self_deleted ?? 0,
  };
}

/**
 * Wipes a member's record in one guild (`/mod forgive … strikes:true`).
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {number} Rows removed.
 */
export function clearForUser(guildId, userId) {
  return getDb()
    .prepare('DELETE FROM violations WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId).changes;
}

/**
 * Retention.
 *
 * @param {string} cutoffIso
 * @returns {number} Rows removed.
 */
export function pruneOlderThan(cutoffIso) {
  return getDb().prepare('DELETE FROM violations WHERE created_at < ?').run(cutoffIso).changes;
}
