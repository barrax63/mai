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
/** The author edited the violation out of a flagged message during the grace period. */
export const ACTION_EDITED = 'edited';
/** Staff granted an appeal: Mai was wrong, so this stops counting as a strike. */
export const ACTION_OVERTURNED = 'overturned';

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
 * @returns {{ total: number, byAction: Record<string, number>, deleted: number,
 *   selfDeleted: number }}
 *   `byAction` is grouped rather than a fixed set of columns: hard-coding the
 *   buckets meant every new outcome (`edited`, then `overturned`) landed in the
 *   total but in none of them, so `/mod history` printed a breakdown that did
 *   not add up to its own total.
 */
export function totalsFor(guildId, userId) {
  const rows = getDb()
    .prepare(
      `SELECT action, COUNT(*) AS count FROM violations
       WHERE guild_id = ? AND user_id = ? GROUP BY action`,
    )
    .all(guildId, userId);

  const byAction = Object.fromEntries(rows.map((row) => [row.action, row.count]));

  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    byAction,
    // Kept as named fields: these two are the ones other callers ask about.
    deleted: byAction[ACTION_DELETED] ?? 0,
    selfDeleted: byAction[ACTION_SELF_DELETED] ?? 0,
  };
}

/**
 * Marks the enforced deletions of one incident as overturned, because staff
 * granted an appeal against it.
 *
 * The rows are **kept, not deleted**: a record that quietly loses entries is
 * worse than one showing that Mai was wrong and it was corrected. Since
 * `strikeCount` only counts `ACTION_DELETED`, changing the action is what makes
 * the escalation ladder forget it — no separate flag to keep in sync.
 *
 * Scoped by time because that is what an appeal actually names: the warning DM
 * covers one enforcement pass, so `sinceIso` is that pass's start. Appealing one
 * incident must not clear four earlier, correct strikes.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} sinceIso
 * @returns {number} Strikes overturned.
 */
export function overturnSince(guildId, userId, sinceIso) {
  return getDb()
    .prepare(
      `UPDATE violations SET action = ?
       WHERE guild_id = ? AND user_id = ? AND action = ? AND created_at >= ?`,
    )
    .run(ACTION_OVERTURNED, guildId, userId, ACTION_DELETED, sinceIso).changes;
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
