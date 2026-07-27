/**
 * The moderation queue ("privacy queue"): metadata of flagged messages waiting
 * out their grace period. Never message content: the text of a deleted message
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
  attempts: row.attempts ?? 0,
});

/**
 * Adds (or updates) a queue entry, so re-classifying the same message stays
 * idempotent instead of piling up duplicate rows.
 *
 * An upsert rather than INSERT OR REPLACE, which is a delete followed by an
 * insert and therefore silently resets `attempts` to its column default. A row
 * that is failing to enforce would forget how many times it had already tried
 * and never reach the give-up threshold.
 *
 * @param {{ messageId: string, guildId: string, channelId: string, userId: string,
 *   categories: string[], warnedAt: string, dueAt: string, scoldMessageId?: string | null }} entry
 */
export function enqueue(entry) {
  getDb()
    .prepare(
      `INSERT INTO moderation_queue
         (message_id, guild_id, channel_id, user_id, categories, warned_at, due_at, scold_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         guild_id = excluded.guild_id,
         channel_id = excluded.channel_id,
         user_id = excluded.user_id,
         categories = excluded.categories,
         warned_at = excluded.warned_at,
         due_at = excluded.due_at,
         scold_message_id = excluded.scold_message_id`,
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
 * The pending row for one message, if it has one. Reading this is how the edit
 * re-check tells "newly flagged" from "already flagged and still is".
 *
 * @param {string} messageId
 * @returns {ReturnType<typeof toRow> | null}
 */
export function findRow(messageId) {
  const row = getDb()
    .prepare('SELECT * FROM moderation_queue WHERE message_id = ?')
    .get(messageId);
  return row ? toRow(row) : null;
}

/**
 * Re-classification of an already-queued message came back with different
 * categories. Only those are written: `warned_at` and `due_at` deliberately stay
 * where they are, so editing one violation into another cannot buy a fresh grace
 * period.
 *
 * @param {string} messageId
 * @param {string[]} categories
 * @returns {number} Rows changed.
 */
export function updateCategories(messageId, categories) {
  return getDb()
    .prepare('UPDATE moderation_queue SET categories = ? WHERE message_id = ?')
    .run(JSON.stringify(categories ?? []), messageId).changes;
}

/**
 * Builds the `guild_id NOT IN (…)` tail plus its parameters. Excluding in SQL
 * rather than skipping in the loop is what keeps a guild whose rows are never
 * resolvable (a paused one) from filling the tick's cap forever: see
 * `pausedGuildIds` in db/settings.js.
 *
 * @param {string[]} [guildIds]
 * @returns {{ sql: string, params: string[] }}
 */
function excludeGuilds(guildIds) {
  const excluded = [...new Set(guildIds ?? [])].filter(Boolean);
  if (excluded.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND guild_id NOT IN (${excluded.map(() => '?').join(', ')})`,
    params: excluded,
  };
}

/**
 * Rows whose grace period has expired, oldest first.
 *
 * @param {string} nowIso
 * @param {number} [limit] Most rows to return. Oldest-first ordering makes the
 *   remainder the *newest* overdue rows, so a capped tick still drains the
 *   backlog in the order it built up.
 * @param {string[]} [skipGuildIds] Guilds whose rows must not be returned at all.
 */
export function dueRows(nowIso, limit, skipGuildIds) {
  const skip = excludeGuilds(skipGuildIds);
  return getDb()
    .prepare(
      `SELECT * FROM moderation_queue WHERE due_at <= ?${skip.sql}
       ORDER BY due_at ASC${limit ? ' LIMIT ?' : ''}`,
    )
    .all(nowIso, ...skip.params, ...(limit ? [limit] : []))
    .map(toRow);
}

/**
 * @param {string} nowIso
 * @param {string[]} [skipGuildIds] Same exclusion as `dueRows`, so the "more
 *   overdue rows than one tick handles" warning counts only rows a tick would
 *   actually pick up. Without it a paused guild logs that warning every minute.
 * @returns {number} How many rows are overdue in total, capped tick or not.
 */
export function dueCount(nowIso, skipGuildIds) {
  const skip = excludeGuilds(skipGuildIds);
  return getDb()
    .prepare(`SELECT COUNT(*) AS count FROM moderation_queue WHERE due_at <= ?${skip.sql}`)
    .get(nowIso, ...skip.params).count;
}

/**
 * Counts one failed enforcement attempt (missing permission, transient error),
 * so a permanently stuck row can report itself instead of failing silently
 * every minute forever.
 *
 * @param {string} messageId
 * @returns {number} The new attempt count.
 */
export function bumpAttempts(messageId) {
  const db = getDb();
  db.prepare('UPDATE moderation_queue SET attempts = attempts + 1 WHERE message_id = ?').run(messageId);
  return db
    .prepare('SELECT attempts FROM moderation_queue WHERE message_id = ?')
    .get(messageId)?.attempts ?? 0;
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
 * Open violations of a user across **all** guilds: Mai is one persona, so a
 * strike anywhere makes her mad at that user everywhere, DMs included.
 *
 * @param {string} userId
 * @param {number} [limit]
 * @returns {{ count: number, categories: string[], nextDueAt: string | null }}
 *   `nextDueAt` is when the earliest of them gets enforced (the `get_my_violations`
 *   tool answers "wann ist das vorbei?" with it).
 */
export function openViolations(userId, limit = 20) {
  const rows = getDb()
    .prepare('SELECT categories, due_at FROM moderation_queue WHERE user_id = ? ORDER BY warned_at DESC LIMIT ?')
    .all(userId, limit);

  const categories = [...new Set(rows.flatMap((row) => parseCategories(row.categories)))];
  const dueDates = rows.map((row) => row.due_at).filter(Boolean).sort();

  return { count: rows.length, categories, nextDueAt: dueDates[0] ?? null };
}

/**
 * Drops a user's open violations **in one guild** (`/mod forgive`). Returns the
 * removed rows so their scold replies can be cleaned up.
 *
 * Scoped deliberately, unlike `openViolations`: reading a member's own record
 * across guilds is Mai having one memory, but *pardoning* is an exercise of
 * authority, and a moderator's authority stops at their own server. Without the
 * guild filter, staff in one guild could clear pending enforcement in another.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {ReturnType<typeof toRow>[]}
 */
export function forgiveUser(guildId, userId) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM moderation_queue WHERE guild_id = ? AND user_id = ?')
    .all(guildId, userId)
    .map(toRow);

  if (rows.length > 0) {
    db.prepare('DELETE FROM moderation_queue WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  }
  return rows;
}

/**
 * @param {string} [guildId] Omit for the process-wide total (operators only).
 * @returns {number} Open violations.
 */
export function depth(guildId) {
  const db = getDb();
  return guildId
    ? db.prepare('SELECT COUNT(*) AS count FROM moderation_queue WHERE guild_id = ?').get(guildId).count
    : db.prepare('SELECT COUNT(*) AS count FROM moderation_queue').get().count;
}

/**
 * The worst-off row in the queue, process-wide, for the operator metrics.
 * `depth` alone cannot show a row that keeps failing to enforce: the queue looks
 * the same whether a row is waiting out its grace period or has been retrying a
 * missing permission for an hour. A rising number here is the latter.
 *
 * @returns {number} Highest failed-attempt count on any pending row; 0 when the
 *   queue is empty.
 */
export function maxAttempts() {
  return getDb()
    .prepare('SELECT COALESCE(MAX(attempts), 0) AS count FROM moderation_queue')
    .get().count;
}
