/**
 * Per-guild settings, resolved through three layers.
 *
 *   explicit override  >  the guild's profile  >  the built-in base
 *
 * `effectiveSettings(guildId)` is the only thing callers need: it returns the
 * merged view plus, per key, where the value came from, which is what
 * `/mod config view` shows.
 *
 * There is deliberately no environment layer under any of this any more. A
 * process-wide default for a per-server policy is only meaningful in a
 * deployment with one server; in a deployment with several it decided things
 * for servers whose staff could not see the file it lived in, and it meant
 * every "why did Mai do that?" started with working out which of three places
 * had won. `.env` still holds secrets, deployment facts and the switches that
 * are genuinely the operator's (whether a feature is available at all), and
 * nothing that a server's own staff should be answering.
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
import { BASE_SETTINGS, PRESETS, PROFILE_KEYS } from '../moderation/presets.js';
import { getDb } from './index.js';
import { clearScores } from './shadow-scores.js';

/** Discord snowflakes, as stored in the comma-separated channel columns. */
const SNOWFLAKE = /^\d{5,25}$/;

/**
 * @param {unknown} value Comma-separated channel ids.
 * @returns {string} Normalized, deduplicated, comma-separated.
 */
function parseChannelList(value, label = 'exempt-channels') {
  const ids = String(value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const bad = ids.filter((id) => !SNOWFLAKE.test(id));
  if (bad.length > 0) throw new RangeError(`${label} must be channel ids, got: ${bad.join(', ')}`);
  if (ids.length > 50) throw new RangeError(`${label} accepts at most 50 channels`);

  return [...new Set(ids)].join(',');
}

/**
 * One channel id. Separate from `parseChannelList` deliberately: that one
 * accepts up to fifty, and a `log-channel` holding two ids is a value nothing
 * downstream can use.
 *
 * Both singular channel settings arrive from a Discord `CHANNEL` option today,
 * so the value comes inside a signature-verified payload and can only be a
 * channel of the calling guild. The validation is here anyway because this is
 * not the only writer: `setProfile`'s `extra` and `ensureLogChannel` reach the
 * same columns through `updateSettings`, and a bad value becomes a `<#garbage>`
 * mention in `/mod config view` plus a `channels.fetch` that throws on every log
 * write. Validation belongs where every writer passes through.
 *
 * @param {unknown} value
 * @param {string} label For the error message.
 * @returns {string}
 */
function parseChannelId(value, label) {
  const id = String(value ?? '').trim();
  if (!SNOWFLAKE.test(id)) throw new RangeError(`${label} must be a channel id, got: ${id}`);
  return id;
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
    parse: (value) => (value === null ? null : parseChannelId(value, 'log-channel')),
  },
  'welcome-channel': {
    column: 'welcome_channel_id',
    parse: (value) => (value === null ? null : parseChannelId(value, 'welcome-channel')),
  },
  welcome: {
    // Greet new members here at all. Rides the same privileged intent as
    // `name-check`, so it is stored either way and `/mod config set` warns when
    // the operator has not switched `DISCORD_MEMBER_EVENTS` on.
    column: 'welcome_enabled',
    parse: (value) => (value === null ? null : toFlag(value, 'welcome')),
  },
  gifs: {
    // Whether Mai may search for a GIF and post it here. Rides on the
    // operator's `GIPHY_API_KEY` the way `evidence` rides on the retention
    // window, so `/mod config set` warns when there is nothing to search with.
    column: 'gifs_enabled',
    parse: (value) => (value === null ? null : toFlag(value, 'gifs')),
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
 * Turns a patch of public setting names into a partial row, keyed by column and
 * carrying exactly the values the database would have stored.
 *
 * Both layers under the overrides are written as things a moderator could type
 * (`'6/10'`, `true`, `'0,10,60,1440'`) and are put through the same `parse` as
 * a typed value, so a mistake in a bundle is refused at import time rather than
 * at the moment somebody earns a timeout for it. Compiled once at module load:
 * `effectiveSettings` runs per flagged message, and re-parsing a ladder on
 * every one of those would be work to produce a constant.
 *
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
const compile = (patch) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(patch).map(([name, value]) => [SETTINGS[name].column, SETTINGS[name].parse(value)]),
    ),
  );

const BASE_ROW = compile(BASE_SETTINGS);

const PROFILE_ROWS = Object.freeze(
  Object.fromEntries(Object.entries(PRESETS).map(([name, entry]) => [name, compile(entry.settings)])),
);

/**
 * The three-layer lookup, and the reason `??` is the right operator here.
 *
 * An empty string is a *value* at every layer: `flood: ''` is "the flood guard
 * is off here" and `link-domains: ''` under an allowlist policy is "no domain
 * is allowed at all", which is the strictest setting there is rather than an
 * absent one. Only NULL means "I did not decide, ask the layer below", so a
 * truthiness check would silently promote both of those to whatever the profile
 * or the base says.
 *
 * @param {object | null} row
 * @param {object | undefined} profileRow
 * @param {string} column
 */
const pick = (row, profileRow, column) => row?.[column] ?? profileRow?.[column] ?? BASE_ROW[column];

/**
 * A guild's profile row, or undefined. The name comes out of the database and
 * is looked up with `Object.hasOwn`, like every other externally-supplied key:
 * a bare property read also answers for everything on `Object.prototype`.
 *
 * @param {object | null} row
 */
const profileRowFor = (row) =>
  row?.profile && Object.hasOwn(PROFILE_ROWS, row.profile) ? PROFILE_ROWS[row.profile] : undefined;

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
  const fromProfile = profileRowFor(row);

  const value = (column) => pick(row, fromProfile, column);
  const flag = (column) => value(column) === 1;
  const list = (column) => splitList(value(column));

  // Where each setting's value came from, which is the whole point of the
  // layers: "inherited" was one bit when there was one thing to inherit from,
  // and a moderator looking at a mention cap of 6 now has three possible
  // answers to "who decided that?".
  const source = (name) => {
    const { column } = SETTINGS[name];
    if (row?.[column] != null) {
      // Escalation is the one setting Mai writes on her own behalf, when she
      // has lost the permission to carry it out. Without this it reads exactly
      // like a colleague having switched it off, which is the wrong thing for
      // the next moderator to believe: one of those is undone by granting a
      // permission and the other by having a conversation.
      return name === 'escalation' && row.escalation_suspended_at ? 'self' : 'set';
    }
    return fromProfile && column in fromProfile ? 'profile' : 'default';
  };

  return {
    // The kill switch: false means Mai does nothing in this guild at all. No
    // profile may contain it: applying one must not undo somebody's `/mod off`.
    enabled: row?.enabled == null ? true : row.enabled === 1,
    // The name of the bundle under the overrides, for `/mod config view`. Null
    // for a server that has never run `/mod setup`.
    profile: fromProfile ? row.profile : null,
    escalationEnabled: flag('escalation_enabled'),
    // No default anywhere: without an explicit channel there is no mod log.
    logChannelId: row?.log_channel_id ?? null,
    // Falls back to the guild's system channel in the welcome handler.
    welcomeChannelId: row?.welcome_channel_id ?? null,
    // Whether there is a greeting at all. Needs `DISCORD_MEMBER_EVENTS` too:
    // the intent it rides on is the operator's, decided once at login.
    welcomeEnabled: flag('welcome_enabled') && config.discord.memberEventsEnabled,
    // Whether she may search for a GIF here, folded like `evidence`: a server
    // can say yes long before there is a key to search with, so what this
    // returns is what actually happens rather than what was asked for.
    gifsEnabled: flag('gifs_enabled') && config.chat.gifSearch.enabled,
    gracePeriodMinutes: value('grace_period_minutes'),
    timeoutLadder: value('timeout_ladder').split(',').map(Number),
    strikeWindowDays: value('strike_window_days'),
    // Channels the delete/scold pipeline ignores entirely. Chat and reactions
    // are unaffected, this is about moderation only. Not in any profile: which
    // channels a server has is not a stance on moderation.
    exemptChannels: splitList(row?.exempt_channels),
    // How hard this guild judges. 0 = defer to the provider's own `flagged`.
    threshold: value('moderation_threshold'),
    categories: list('moderation_categories'),
    // The rules Mai applies herself, without a classifier (heuristics.js).
    inviteFilter: flag('invite_filter'),
    linkPolicy: value('link_policy'),
    linkDomains: list('link_domains'),
    mentionCap: value('mention_cap'),
    floodRule: parseFloodRule(value('flood_rule'), 'flood'),
    // Keeping a member's deleted words needs the guild's consent *and* the
    // operator's retention window: `MODERATION_EVIDENCE_HOURS` decides whether
    // the feature is available at all, this flag whether it is used. Folded in
    // here so every caller reads what actually happens.
    evidenceEnabled: flag('evidence_enabled') && config.moderation.evidenceHours > 0,
    // Screening a display name needs the same intent the greeting does, so it
    // is folded the same way: what this returns is what actually happens.
    nameCheck: config.discord.memberEventsEnabled ? value('name_check') : 'off',
    shadowMode: flag('shadow_mode'),
    // When an observation period ends by itself. NULL = shadow mode with no
    // end, which is what an explicit `/mod config set shadow:true` means.
    shadowUntil: row?.shadow_until ?? null,
    // Set only while *Mai* has escalation switched off, because she cannot
    // carry it out. Distinguishes her decision from staff's, so restoring the
    // permission restores the ladder without overruling anybody.
    escalationSuspendedAt: row?.escalation_suspended_at ?? null,
    // True when this guild has not explicitly set the key itself. Deliberately
    // still a plain "did somebody here type this?", so it keeps answering the
    // question `/mod config reset` is about; `source` is the finer view.
    inherited: {
      enabled: row?.enabled == null,
      escalation: row?.escalation_enabled == null,
      'log-channel': !row?.log_channel_id,
      'welcome-channel': !row?.welcome_channel_id,
      welcome: row?.welcome_enabled == null,
      gifs: row?.gifs_enabled == null,
      grace: row?.grace_period_minutes == null,
      'timeout-ladder': !row?.timeout_ladder,
      'strike-window': row?.strike_window_days == null,
      'exempt-channels': !row?.exempt_channels,
      threshold: row?.moderation_threshold == null,
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
    source: Object.fromEntries(Object.keys(SETTINGS).map((name) => [name, source(name)])),
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
 * map so it stays true as columns are added, plus `profile`: picking one is now
 * the ordinary way to configure a server, and the whole point of the layer is
 * that doing so writes no other column.
 *
 * @returns {number}
 */
export function configuredGuildCount() {
  const anySetting = [...COLUMNS, 'profile'].map((column) => `${column} IS NOT NULL`).join(' OR ');
  return getDb()
    .prepare(`SELECT COUNT(*) AS count FROM guild_settings WHERE ${anySetting}`)
    .get().count;
}

/**
 * Puts a guild on a profile, and hands back to it every setting the profiles
 * decide.
 *
 * The second half is what makes this different from `updateSettings`. A server
 * that ran `standard` before profiles existed carries six explicitly written
 * columns; switching it to `strict` without clearing them would leave it on
 * `standard`'s mention cap with `strict` printed at the top of
 * `/mod config view`. Clearing is also the honest reading of the command: a
 * profile is what you pick when you do *not* want to hold an opinion on the
 * individual knobs, so picking one withdraws the opinions you had.
 *
 * Keys no bundle mentions are untouched, deliberately: the log channel and the
 * exempt channels are facts about the server, not a stance on moderation, and
 * losing them to a `/mod setup` would take the moderation log with them.
 *
 * @param {string} guildId
 * @param {string} name A preset name, which may have come from a `custom_id`.
 * @param {string} [actorId]
 * @param {Record<string, string | number | null>} [extra] Applied in the same
 *   breath, for the optional `log-channel` on `/mod setup`.
 * @returns {ReturnType<typeof effectiveSettings> | null} Null for an unknown name.
 */
export function setProfile(guildId, name, actorId, extra = {}) {
  if (!Object.hasOwn(PROFILE_ROWS, String(name))) return null;

  updateSettings(
    guildId,
    { ...Object.fromEntries(PROFILE_KEYS.map((key) => [key, null])), ...extra },
    actorId,
  );

  getDb()
    .prepare('UPDATE guild_settings SET profile = ?, updated_at = ? WHERE guild_id = ?')
    .run(String(name), new Date().toISOString(), String(guildId));

  return effectiveSettings(guildId);
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
  // A period starts from nothing. The expiry path drops the histogram after
  // reading it, but a period that is *abandoned* (a different preset, an
  // explicit `shadow:false`) never reaches that path, and its leftovers would
  // otherwise be counted into the next one: a threshold learned from two
  // unrelated weeks, possibly months apart.
  clearScores(guildId);
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
  // Nothing will ever read this period's scores now, so they are not kept:
  // an abandoned observation is not a measurement of anything.
  clearScores(guildId);
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
 * Switches escalation off because Mai cannot carry it out, and records that it
 * was her doing.
 *
 * @param {string} guildId
 * @param {Date} [now]
 * @returns {boolean} False when it was already suspended, so the caller can
 *   announce it exactly once rather than on every audit.
 */
export function suspendEscalation(guildId, now = new Date()) {
  const at = now.toISOString();
  // One statement, and it only fires while the marker is absent: two overlapping
  // callers cannot both come away thinking they were the one who did it.
  const { changes } = getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, escalation_enabled, escalation_suspended_at, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         escalation_enabled = 0, escalation_suspended_at = excluded.escalation_suspended_at,
         updated_at = excluded.updated_at
       WHERE guild_settings.escalation_suspended_at IS NULL`,
    )
    .run(String(guildId), at, at);

  return changes > 0;
}

/**
 * Hands escalation back to whatever the guild's profile or the base says, but
 * only if the suspension was hers to lift.
 *
 * @param {string} guildId
 * @returns {boolean} False when there was nothing of hers to undo.
 */
export function resumeEscalation(guildId) {
  const { changes } = getDb()
    .prepare(
      `UPDATE guild_settings
       SET escalation_enabled = NULL, escalation_suspended_at = NULL, updated_at = ?
       WHERE guild_id = ? AND escalation_suspended_at IS NOT NULL`,
    )
    .run(new Date().toISOString(), String(guildId));

  return changes > 0;
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

  // A human saying anything about escalation ends Mai's suspension of it: from
  // here on the setting is theirs, and finding the permission restored must not
  // silently undo what they just typed. Keyed on `actorId` because that is
  // exactly the difference: `suspendEscalation` writes without one.
  if (actorId && Object.hasOwn(patch, 'escalation')) {
    db.prepare('UPDATE guild_settings SET escalation_suspended_at = NULL WHERE guild_id = ?')
      .run(String(guildId));
  }

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
