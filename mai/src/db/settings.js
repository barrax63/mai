/**
 * Per-guild settings, layered over the process defaults from `.env`.
 *
 * `effectiveSettings(guildId)` is the only thing callers need: it returns the
 * merged view plus, per key, whether the value is inherited — which is what
 * `/mod config view` shows.
 *
 * Reads are single-row primary-key lookups on SQLite, so they happen inline
 * (per flagged message, per queue row) without a cache.
 */
import { config, parseTimeoutLadder } from '../config.js';
import { getDb } from './index.js';

/**
 * Public setting names (as used by `/mod config`) mapped to their column and
 * how to parse/validate an incoming value. Adding a setting means adding an
 * entry here, a column in a migration, and an option to the command.
 */
export const SETTINGS = Object.freeze({
  'log-channel': {
    column: 'log_channel_id',
    parse: (value) => (value === null ? null : String(value)),
  },
  'welcome-channel': {
    column: 'welcome_channel_id',
    parse: (value) => (value === null ? null : String(value)),
  },
  grace: {
    column: 'grace_period_minutes',
    parse: (value) => {
      if (value === null) return null;
      const minutes = Number.parseInt(value, 10);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        throw new RangeError('grace must be between 1 and 1440 minutes');
      }
      return minutes;
    },
  },
  'timeout-ladder': {
    column: 'timeout_ladder',
    parse: (value) => {
      if (value === null) return null;
      // Validated here so a bad ladder is refused at the command, not at the
      // moment someone earns a timeout.
      return parseTimeoutLadder(value, 'timeout-ladder').join(',');
    },
  },
  'strike-window': {
    column: 'strike_window_days',
    parse: (value) => {
      if (value === null) return null;
      const days = Number.parseInt(value, 10);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new RangeError('strike-window must be between 1 and 365 days');
      }
      return days;
    },
  },
});

const COLUMNS = Object.values(SETTINGS).map((setting) => setting.column);

/**
 * @param {string} guildId
 * @returns {object | null} Raw row, or null when the guild never changed anything.
 */
export function rawSettings(guildId) {
  return getDb()
    .prepare('SELECT * FROM guild_settings WHERE guild_id = ?')
    .get(String(guildId)) ?? null;
}

/**
 * @param {string | null | undefined} guildId
 * @returns {{ logChannelId: string | null, welcomeChannelId: string | null,
 *   gracePeriodMinutes: number, inherited: Record<string, boolean> }}
 */
export function effectiveSettings(guildId) {
  const row = guildId ? rawSettings(guildId) : null;

  return {
    // No process-wide default: without an explicit channel there is no mod log.
    logChannelId: row?.log_channel_id ?? null,
    // Falls back to the guild's system channel in the welcome handler.
    welcomeChannelId: row?.welcome_channel_id ?? null,
    gracePeriodMinutes: row?.grace_period_minutes ?? config.moderation.gracePeriodMinutes,
    timeoutLadder: row?.timeout_ladder
      ? row.timeout_ladder.split(',').map(Number)
      : config.moderation.timeoutLadder,
    strikeWindowDays: row?.strike_window_days ?? config.moderation.strikeWindowDays,
    inherited: {
      'log-channel': !row?.log_channel_id,
      'welcome-channel': !row?.welcome_channel_id,
      grace: row?.grace_period_minutes === null || row?.grace_period_minutes === undefined,
      'timeout-ladder': !row?.timeout_ladder,
      'strike-window': row?.strike_window_days === null || row?.strike_window_days === undefined,
    },
  };
}

/**
 * Applies a patch of public setting names. A value of `null` clears the
 * override (back to inherited).
 *
 * @param {string} guildId
 * @param {Record<string, string | number | null>} patch
 * @param {string} [actorId] Who ran the command.
 * @returns {ReturnType<typeof effectiveSettings>}
 * @throws {RangeError} On an out-of-range value.
 */
export function updateSettings(guildId, patch, actorId) {
  const entries = Object.entries(patch).filter(([name]) => name in SETTINGS);
  if (entries.length === 0) return effectiveSettings(guildId);

  const columns = entries.map(([name]) => SETTINGS[name].column);
  const values = entries.map(([name, value]) => SETTINGS[name].parse(value));

  const db = getDb();
  // The row may not exist yet; INSERT … ON CONFLICT keeps this one statement.
  const assignments = columns.map((column) => `${column} = excluded.${column}`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  db.prepare(
    `INSERT INTO guild_settings (guild_id, ${columns.join(', ')}, updated_at, updated_by)
     VALUES (?, ${placeholders}, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       ${assignments}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(String(guildId), ...values, new Date().toISOString(), actorId ?? null);

  return effectiveSettings(guildId);
}

/**
 * Clears one override, or every override when `name` is omitted.
 *
 * @param {string} guildId
 * @param {string} [name] Public setting name.
 * @param {string} [actorId]
 */
export function resetSettings(guildId, name, actorId) {
  const columns = name ? [SETTINGS[name]?.column].filter(Boolean) : COLUMNS;
  if (columns.length === 0) throw new RangeError(`unknown setting: ${name}`);

  return updateSettings(
    guildId,
    Object.fromEntries(
      Object.entries(SETTINGS)
        .filter(([, setting]) => columns.includes(setting.column))
        .map(([key]) => [key, null]),
    ),
    actorId,
  );
}
