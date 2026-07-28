/**
 * What staff know about a member that no counter records.
 *
 * "Already warned them in voice", "is fourteen", "the joke is between them and
 * their friend": a moderation team keeps this in its own heads or in a pinned
 * message, and loses it the week the person who knew it is away. The strike
 * record answers *what Mai did*; this answers *what we decided about them*, and
 * the two are not the same file.
 *
 * Deliberately plaintext, unlike `chat_history` and `evidence`. Those hold text
 * a member wrote, taken from them by the bot. A note is written by staff, for
 * staff, about their own server: the same class as a report reason, which is
 * already posted into a Discord channel in the clear. It is still pruned on the
 * strike-record window, so it does not become an unbounded file on a person.
 */
import { getDb } from './index.js';

/** Long enough for a sentence, short enough not to become a case file. */
export const MAX_NOTE_LENGTH = 500;

/**
 * @param {{ guildId: string, userId: string, authorId: string, note: string,
 *   createdAt?: string }} entry
 * @returns {number} The note's id.
 */
export function addNote(entry) {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO member_notes (guild_id, user_id, author_id, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.guildId,
        entry.userId,
        entry.authorId,
        String(entry.note ?? '').slice(0, MAX_NOTE_LENGTH),
        entry.createdAt ?? new Date().toISOString(),
      ).lastInsertRowid,
  );
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {number} [limit]
 * @returns {{ id: number, authorId: string, note: string, createdAt: string }[]} Newest first.
 */
export function notesFor(guildId, userId, limit = 5) {
  return getDb()
    .prepare(
      `SELECT id, author_id, note, created_at FROM member_notes
       WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(guildId, userId, limit)
    .map((row) => ({
      id: row.id,
      authorId: row.author_id,
      note: row.note,
      createdAt: row.created_at,
    }));
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {number} Notes removed.
 */
export function clearForUser(guildId, userId) {
  return getDb()
    .prepare('DELETE FROM member_notes WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId).changes;
}

/**
 * Retention, on the same window as the strike record.
 *
 * @param {string} cutoffIso
 * @returns {number} Notes removed.
 */
export function pruneOlderThan(cutoffIso) {
  return getDb().prepare('DELETE FROM member_notes WHERE created_at < ?').run(cutoffIso).changes;
}
