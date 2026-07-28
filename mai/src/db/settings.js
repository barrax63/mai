/**
 * Per-guild settings, layered over the process defaults from `.env`.
 *
 * `effectiveSettings(guildId)` is the only thing callers need: it returns the
 * merged view plus, per key, whether the value is inherited, which is what
 * `/mod config view` shows.
 *
 * Reads are single-row primary-key lookups on SQLite, so they happen inline
 * (per flagged message, per queue row) without a cache.
 */
import {
  config,
  parseCategoryList,
  parseDomainList,
  parseFloodRule,
  parseLinkPolicy,
  parseNameCheck,
  parseThreshold,
  parseTimeoutLadder,
  wholeNumber,
} from '../config.js';
import { getDb } from './index.js';

/** Discord snowflakes, as stored in the comma-separated channel columns. */
const SNOWFLAKE = /^\d{5,25}$/;

/**
 * @param {unknown} value Comma-separated channel ids.
 * @returns {string} Normalized, deduplicated, comma-separated.
 */
export function parseChannelList(value, label = 'exempt-channels') {
  const ids = String(value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const bad = ids.filter((id) => !SNOWFLAKE.test(id));
  if (bad.length > 0) throw new RangeError(`${label} must be channel ids, got: ${bad.join(', ')}`);
  if (ids.length > 50) throw new RangeError(`${label} accepts at most 50 channels`);

  return [...new Set(ids)].join(',');
}

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Public setting names (as used by `/mod config`) mapped to their column and
 * how to parse/validate an incoming value. Adding a setting means adding an
 * entry here, a column in a migration, and an option to the command.
 */
/**
 * SQLite has no boolean type, and node:sqlite refuses a JS boolean outright:
 * flags are stored as 1/0 with NULL meaning "inherit".
 *
 * @param {unknown} value
 * @param {string} name For the error message.
 * @returns {number}
 */
function toFlag(value, name) {
  if (value === true || value === 'true' || value === 1 || value === '1') return 1;
  if (value === false || value === 'false' || value === 0 || value === '0') return 0;
  throw new RangeError(`${name} must be true or false`);
}

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
      const minutes = wholeNumber(value);
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
  escalation: {
    column: 'escalation_enabled',
    parse: (value) => (value === null ? null : toFlag(value, 'escalation')),
  },
  enabled: {
    column: 'enabled',
    parse: (value) => (value === null ? null : toFlag(value, 'enabled')),
  },
  'exempt-channels': {
    column: 'exempt_channels',
    parse: (value) => (value === null ? null : parseChannelList(value)),
  },
  threshold: {
    column: 'moderation_threshold',
    parse: (value) => (value === null ? null : parseThreshold(value, 'threshold')),
  },
  categories: {
    column: 'moderation_categories',
    parse: (value) => (value === null ? null : parseCategoryList(value, 'categories').join(',')),
  },
  'strike-window': {
    column: 'strike_window_days',
    parse: (value) => {
      if (value === null) return null;
      const days = wholeNumber(value);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new RangeError('strike-window must be between 1 and 365 days');
      }
      return days;
    },
  },
  'invite-filter': {
    column: 'invite_filter',
    parse: (value) => (value === null ? null : toFlag(value, 'invite-filter')),
  },
  'link-policy': {
    column: 'link_policy',
    parse: (value) => (value === null ? null : parseLinkPolicy(value, 'link-policy')),
  },
  'link-domains': {
    // A list, but unlike `exempt-channels` a typeable one: these are host names
    // a moderator reads and writes, not snowflakes, so they stay a plain option
    // on `/mod config set` instead of getting add/remove subcommands.
    column: 'link_domains',
    parse: (value) => (value === null ? null : parseDomainList(value, 'link-domains').join(',')),
  },
  'mention-cap': {
    column: 'mention_cap',
    parse: (value) => {
      if (value === null) return null;
      const cap = wholeNumber(value);
      // 0 = off. The upper bound is Discord's own: a message cannot address
      // more than 100 users anyway, so anything above it is a typo.
      if (!Number.isInteger(cap) || cap < 0 || cap > 100) {
        throw new RangeError('mention-cap must be between 0 (off) and 100');
      }
      return cap;
    },
  },
  evidence: {
    // Whether an enforced message's text is kept (encrypted, for hours) so
    // staff can review an appeal about it. Off unless the operator set a
    // retention window too: `MODERATION_EVIDENCE_HOURS` is the availability
    // switch, this flag is the guild's own consent to it.
    column: 'evidence_enabled',
    parse: (value) => (value === null ? null : toFlag(value, 'evidence')),
  },
  'name-check': {
    column: 'name_check',
    parse: (value) => (value === null ? null : parseNameCheck(value, 'name-check')),
  },
  shadow: {
    // Classify and report, act on nothing. Not a pause: rows queued before
    // shadow was switched on are still enforced (`/mod off` is the pause).
    column: 'shadow_mode',
    parse: (value) => (value === null ? null : toFlag(value, 'shadow')),
  },
  flood: {
    column: 'flood_rule',
    parse: (value) => {
      if (value === null) return null;
      const rule = parseFloodRule(value, 'flood');
      // Empty string, not NULL: "off" is a decision this guild made, while NULL
      // means "inherit", and a guild switching the guard off must not silently
      // pick up the process default again. `/mod config reset flood` is how you
      // go back to inheriting.
      return rule ? `${rule.messages}/${rule.seconds}` : '';
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

  const flag = (column, fallback) => (row?.[column] == null ? fallback : row[column] === 1);

  return {
    // The kill switch: false means Mai does nothing in this guild at all.
    enabled: flag('enabled', true),
    escalationEnabled: flag('escalation_enabled', config.moderation.escalationEnabled),
    // No process-wide default: without an explicit channel there is no mod log.
    logChannelId: row?.log_channel_id ?? null,
    // Falls back to the guild's system channel in the welcome handler.
    welcomeChannelId: row?.welcome_channel_id ?? null,
    gracePeriodMinutes: row?.grace_period_minutes ?? config.moderation.gracePeriodMinutes,
    timeoutLadder: row?.timeout_ladder
      ? row.timeout_ladder.split(',').map(Number)
      : config.moderation.timeoutLadder,
    strikeWindowDays: row?.strike_window_days ?? config.moderation.strikeWindowDays,
    // Channels the delete/scold pipeline ignores entirely. Chat and reactions
    // are unaffected, this is about moderation only.
    exemptChannels: splitList(row?.exempt_channels),
    // How hard this guild judges. 0 = defer to the provider's own `flagged`.
    threshold: row?.moderation_threshold ?? config.moderation.threshold,
    categories: row?.moderation_categories
      ? splitList(row.moderation_categories)
      : config.moderation.categories,
    // The rules Mai applies herself, without a classifier (heuristics.js).
    inviteFilter: flag('invite_filter', config.moderation.inviteFilter),
    linkPolicy: row?.link_policy ?? config.moderation.linkPolicy,
    // `== null` and not a truthiness check: an empty string is a guild saying
    // "no domains at all", which under the allowlist policy is a real, much
    // stricter setting than inheriting the process list.
    linkDomains: row?.link_domains == null ? config.moderation.linkDomains : splitList(row.link_domains),
    mentionCap: row?.mention_cap ?? config.moderation.mentionCap,
    // Same here: '' is "flood guard off in this guild", NULL is "inherit".
    floodRule: row?.flood_rule == null
      ? config.moderation.floodRule
      : parseFloodRule(row.flood_rule, 'flood'),
    // Keeping a member's deleted words is a decision each guild makes for
    // itself, so this one inherits `false` rather than a process default: the
    // operator's knob (`MODERATION_EVIDENCE_HOURS`) decides whether it is
    // available at all, not whether it is on.
    evidenceEnabled: flag('evidence_enabled', false) && config.moderation.evidenceHours > 0,
    nameCheck: row?.name_check ?? config.moderation.nameCheck,
    // No process default: shadow mode is a server's decision about its own
    // moderation, and the only shapeless version of it (on everywhere, forever,
    // announced nowhere) was the one an environment flag could produce.
    shadowMode: flag('shadow_mode', false),
    // When an observation period ends by itself. NULL = shadow mode with no
    // end, which is what an explicit `/mod config set shadow:true` means.
    shadowUntil: row?.shadow_until ?? null,
    inherited: {
      enabled: row?.enabled == null,
      escalation: row?.escalation_enabled == null,
      'log-channel': !row?.log_channel_id,
      'welcome-channel': !row?.welcome_channel_id,
      grace: row?.grace_period_minutes === null || row?.grace_period_minutes === undefined,
      'timeout-ladder': !row?.timeout_ladder,
      'strike-window': row?.strike_window_days === null || row?.strike_window_days === undefined,
      'exempt-channels': !row?.exempt_channels,
      threshold: row?.moderation_threshold === null || row?.moderation_threshold === undefined,
      categories: !row?.moderation_categories,
      'invite-filter': row?.invite_filter == null,
      'link-policy': row?.link_policy == null,
      'link-domains': row?.link_domains == null,
      'mention-cap': row?.mention_cap == null,
      flood: row?.flood_rule == null,
      evidence: row?.evidence_enabled == null,
      'name-check': row?.name_check == null,
      shadow: row?.shadow_mode == null,
    },
  };
}

/**
 * The kill switch, as its own function because every entry point asks it.
 *
 * @param {string | null | undefined} guildId
 * @returns {boolean} False only for a guild that was explicitly paused.
 */
export function isGuildActive(guildId) {
  // A DM has no guild to pause.
  if (!guildId) return true;
  return effectiveSettings(guildId).enabled;
}

/**
 * Every guild that ran `/mod off`, as a list rather than one lookup at a time.
 *
 * The enforcer needs this to keep paused rows out of its due query entirely.
 * Skipping them per row is not enough: `dueRows` is ordered oldest-first and
 * capped at MODERATION_MAX_ROWS_PER_TICK, so rows that are kept but never
 * resolved stay the oldest forever and fill the cap on every tick, starving
 * every other guild. The list is short by construction (only guilds that
 * explicitly paused have a row at all).
 *
 * @returns {string[]}
 */
export function pausedGuildIds() {
  return getDb()
    .prepare('SELECT guild_id FROM guild_settings WHERE enabled = 0')
    .all()
    .map((row) => row.guild_id);
}

/**
 * How many guilds have changed at least one setting from the process default,
 * for the operator metrics: this is a count of configured servers, not of
 * servers Mai is in.
 *
 * Counts *settings*, not rows. A row also exists for a server that has only
 * been greeted (`onboarded_at`), and counting those would report every server
 * Mai has ever joined as configured. The condition is built from the SETTINGS
 * map so it stays true as columns are added.
 *
 * @returns {number}
 */
export function configuredGuildCount() {
  const anySetting = COLUMNS.map((column) => `${column} IS NOT NULL`).join(' OR ');
  return getDb()
    .prepare(`SELECT COUNT(*) AS count FROM guild_settings WHERE ${anySetting}`)
    .get().count;
}

/**
 * Starts an observation period: shadow mode with an end date.
 *
 * The difference to `/mod config set shadow:true` is the whole point. That is
 * an open-ended decision somebody made and will remember; this is a promise
 * Mai made in her introduction ("I watch, then you decide"), and a promise
 * nobody has to remember to collect on.
 *
 * @param {string} guildId
 * @param {number} days Fractions allowed, so a deployment can test the ending.
 * @param {Date} [now]
 */
export function startShadowWindow(guildId, days, now = new Date()) {
  const until = new Date(now.getTime() + days * 86_400_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, shadow_mode, shadow_until, shadow_hits, updated_at)
       VALUES (?, 1, ?, 0, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         shadow_mode = 1, shadow_until = excluded.shadow_until, shadow_hits = 0,
         updated_at = excluded.updated_at`,
    )
    .run(String(guildId), until, now.toISOString());

  return until;
}

/**
 * Ends any pending observation period without touching `shadow` itself.
 *
 * Called whenever somebody states their own intent about shadow mode (another
 * preset, `/mod config set shadow:…`): a leftover end date would otherwise fire
 * days later and announce the end of an observation that nobody was running.
 *
 * @param {string} guildId
 */
export function clearShadowWindow(guildId) {
  getDb()
    .prepare('UPDATE guild_settings SET shadow_until = NULL WHERE guild_id = ?')
    .run(String(guildId));
}

/**
 * Counts one verdict Mai would have acted on. A count per guild, never a row
 * per member: see the migration.
 *
 * @param {string} guildId
 */
export function countShadowHit(guildId) {
  getDb()
    .prepare('UPDATE guild_settings SET shadow_hits = shadow_hits + 1 WHERE guild_id = ?')
    .run(String(guildId));
}

/**
 * Observation periods that have run out, switched back to enforcing in the
 * same statement they are reported by.
 *
 * Read *and* write, deliberately: two ticks overlapping (or two processes
 * against one database) would otherwise both find the same expired window and
 * both announce it. The UPDATE returns only what it actually changed, so the
 * announcement happens once.
 *
 * @param {Date} [now]
 * @returns {{ guildId: string, hits: number }[]}
 */
export function expireShadowWindows(now = new Date()) {
  const db = getDb();
  const due = db
    .prepare('SELECT guild_id, shadow_hits FROM guild_settings WHERE shadow_until IS NOT NULL AND shadow_until <= ?')
    .all(now.toISOString());

  const ended = [];
  const finish = db.prepare(
    `UPDATE guild_settings SET shadow_mode = 0, shadow_until = NULL, shadow_hits = 0, updated_at = ?
     WHERE guild_id = ? AND shadow_until IS NOT NULL AND shadow_until <= ?`,
  );

  for (const row of due) {
    const { changes } = finish.run(now.toISOString(), row.guild_id, now.toISOString());
    if (changes > 0) ended.push({ guildId: row.guild_id, hits: row.shadow_hits });
  }

  return ended;
}

/**
 * Whether Mai has already introduced herself here.
 *
 * Persisted rather than kept in memory on purpose: the introduction is a
 * one-time event, and a restart (or a gateway reconnect that replays the join)
 * must not produce a second one.
 *
 * @param {string} guildId
 * @returns {boolean}
 */
export function wasOnboarded(guildId) {
  return Boolean(rawSettings(guildId)?.onboarded_at);
}

/**
 * @param {string} guildId
 * @param {Date} [now]
 */
export function markOnboarded(guildId, now = new Date()) {
  // Its own statement: this is bookkeeping, not a setting, so it deliberately
  // does not go through `updateSettings` and cannot be reached by
  // `/mod config set` or reset by `/mod config reset`.
  const at = now.toISOString();
  // `updated_by` stays NULL: nobody ran anything, Mai joined a server.
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, onboarded_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET onboarded_at = excluded.onboarded_at`,
    )
    .run(String(guildId), at, at);
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
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a patch key
  // of `constructor` would pass the filter and then contribute `undefined` as
  // a column name to the statement below.
  const entries = Object.entries(patch).filter(([name]) => Object.hasOwn(SETTINGS, name));
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
