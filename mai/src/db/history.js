/**
 * Mai's short-term chat memory, keyed by channel (a DM channel is stable per
 * user, so DMs work without a guild id).
 *
 * This is the only place message content is persisted — a deliberate exception
 * to the no-content rule, limited to messages deliberately addressed to Mai.
 * `username` and `content` are encrypted (db/crypto.js) and every row is pruned
 * after CHAT_HISTORY_MAX_AGE_HOURS.
 */
import { logger } from '../logger.js';
import { decrypt, encrypt } from './crypto.js';
import { getDb } from './index.js';

/**
 * Appends turns in the given order. Timestamps are spaced by 1 ms so the user
 * turn always sorts before Mai's answer.
 *
 * @param {{ channelId: string, guildId?: string | null, userId?: string | null,
 *   username?: string | null, role: 'user' | 'assistant', content: string }[]} turns
 * @param {Date} [now]
 */
export function appendTurns(turns, now = new Date()) {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO chat_history (channel_id, guild_id, user_id, username, role, content, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    turns.forEach((turn, index) => {
      insert.run(
        turn.channelId,
        turn.guildId ?? null,
        turn.userId ?? null,
        encrypt(turn.username ?? ''),
        turn.role,
        encrypt(turn.content),
        new Date(now.getTime() + index).toISOString(),
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The latest `limit` turns of a channel, oldest first (prompt order).
 * Rows that cannot be decrypted (key rotation, tampering) are skipped.
 *
 * @param {string} channelId
 * @param {number} limit
 * @returns {{ role: string, username: string, content: string, sentAt: string }[]}
 */
export function recentTurns(channelId, limit) {
  const rows = getDb()
    .prepare('SELECT * FROM chat_history WHERE channel_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?')
    .all(channelId, limit);

  const turns = [];
  for (const row of rows.reverse()) {
    try {
      turns.push({
        role: row.role,
        username: decrypt(row.username ?? ''),
        content: decrypt(row.content),
        sentAt: row.sent_at,
      });
    } catch (error) {
      // No content in the log line — just the row id and the reason.
      logger.warn({ rowId: row.id, err: error }, 'Dropping undecryptable history row');
    }
  }
  return turns;
}

/**
 * Retention: drops everything older than the cutoff.
 *
 * @param {string} cutoffIso
 * @returns {number} Rows removed.
 */
export function pruneOlderThan(cutoffIso) {
  return getDb().prepare('DELETE FROM chat_history WHERE sent_at < ?').run(cutoffIso).changes;
}

/**
 * @returns {{ rows: number, channels: number }}
 */
export function stats() {
  // `rows` is a SQLite keyword — alias around it.
  const row = getDb()
    .prepare('SELECT COUNT(*) AS row_count, COUNT(DISTINCT channel_id) AS channel_count FROM chat_history')
    .get();
  return { rows: row.row_count, channels: row.channel_count };
}
