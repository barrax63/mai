/**
 * Central configuration. Reads and validates environment variables once at
 * startup so the rest of the app can rely on a well-formed config object.
 *
 * Operational knobs only: everything Mai *says* (persona, prompts, scold
 * lines, welcome messages, reaction triggers) lives in the YAML content file
 * loaded by `content.js`.
 */
import { fileURLToPath } from 'node:url';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optional = (name, fallback = undefined) => {
  const value = process.env[name]?.trim();
  return value || fallback;
};

const bool = (name, fallback) => {
  const value = optional(name, fallback);
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Environment variable ${name} must be "true" or "false", got: ${value}`);
  }
  return value === 'true';
};

/**
 * A whole number, or NaN when the value is not spelled as one.
 *
 * `Number.parseInt` stops at the first character it cannot use, so "1O" (with
 * the letter) parses as 1 and "10min" as 10: a typo turns into a plausible
 * value instead of a refusal, and every message below promises whole numbers.
 * The shape is checked first so that promise holds. A sign is allowed through
 * to the range check, which has something useful to say about a negative.
 *
 * Exported because `/mod config set` has to refuse exactly what the environment
 * refuses: the same knob, typed by a moderator instead of the operator.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function wholeNumber(raw) {
  const text = String(raw ?? '').trim();
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
}

/**
 * The same for a value that may carry decimals (a ratio, a number of hours).
 * `Number.parseFloat` truncates just as quietly as its integer sibling.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function decimalNumber(raw) {
  const text = String(raw ?? '').trim();
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number.parseFloat(text) : Number.NaN;
}

const int = (name, fallback, { min = 0 } = {}) => {
  const raw = optional(name, fallback);
  const value = wholeNumber(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Environment variable ${name} must be an integer >= ${min}, got: ${raw}`);
  }
  return value;
};

/** Discord refuses a timeout longer than 28 days. */
export const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

/**
 * Parses a comma-separated escalation ladder ("0,10,60,1440") into minutes per
 * strike. Exported so `/mod config set timeout-ladder` validates identically.
 *
 * @param {string} raw
 * @param {string} [label] Used in the error message.
 * @returns {number[]}
 */
export function parseTimeoutLadder(raw, label = 'timeout ladder') {
  const steps = String(raw ?? '')
    .split(',')
    .map((step) => step.trim())
    .filter(Boolean)
    .map((step) => wholeNumber(step));

  if (steps.length === 0 || steps.some((step) => !Number.isInteger(step))) {
    throw new RangeError(`${label} must be comma-separated whole minutes, e.g. 0,10,60,1440`);
  }
  if (steps.some((step) => step < 0 || step > MAX_TIMEOUT_MINUTES)) {
    throw new RangeError(`${label} steps must be between 0 and ${MAX_TIMEOUT_MINUTES} minutes`);
  }
  return steps;
}

/**
 * Parses a comma-separated category allowlist. Exported so
 * `/mod config set categories` validates identically.
 *
 * Slugs are checked for *shape* only, not against a fixed list: the categories
 * come from whatever `OPENAI_BASE_URL` points at, and hard-coding OpenAI's set
 * would reject a valid one from another provider. The cost is that a typo
 * silently never matches, which `/mod config view` makes visible.
 *
 * @param {string} raw
 * @param {string} [label] Used in the error message.
 * @returns {string[]} Empty = every category counts.
 */
export function parseCategoryList(raw, label = 'categories') {
  const slugs = String(raw ?? '')
    .split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);

  const bad = slugs.filter((slug) => !/^[a-z0-9][a-z0-9/_-]*$/.test(slug));
  if (bad.length > 0) {
    throw new RangeError(`${label} contains invalid category slugs: ${bad.join(', ')}`);
  }
  if (slugs.length > 30) {
    throw new RangeError(`${label} accepts at most 30 categories`);
  }
  return [...new Set(slugs)];
}

/**
 * Parses a 0-1 score threshold. Exported so `/mod config set threshold`
 * validates identically.
 *
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {number} 0 = fall back to the provider's own `flagged` boolean.
 */
export function parseThreshold(raw, label = 'threshold') {
  const value = decimalNumber(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a number between 0 and 1`);
  }
  return value;
}

/** What the link guard does with a URL that is not on the allowlist. */
export const LINK_POLICIES = Object.freeze(['off', 'allowlist']);

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {'off' | 'allowlist'}
 */
export function parseLinkPolicy(raw, label = 'link policy') {
  const value = String(raw ?? '').trim().toLowerCase() || 'off';
  if (!LINK_POLICIES.includes(value)) {
    throw new RangeError(`${label} must be one of: ${LINK_POLICIES.join(', ')}`);
  }
  return value;
}

/**
 * Parses a comma-separated host list for the link allowlist. Exported so
 * `/mod config set link-domains` validates identically.
 *
 * A leading `www.` is dropped and the comparison is done on the registrable
 * host plus its subdomains (see `hostAllowed` in moderation/heuristics.js), so
 * `example.com` covers `www.example.com` and `cdn.example.com`. Anything that
 * is not a bare host name is refused: a moderator typing a full URL would
 * otherwise create an entry that can never match.
 *
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {string[]}
 */
export function parseDomainList(raw, label = 'link domains') {
  const hosts = String(raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, ''))
    .filter(Boolean);

  const bad = hosts.filter(
    (host) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host),
  );
  if (bad.length > 0) {
    throw new RangeError(`${label} must be bare host names, got: ${bad.join(', ')}`);
  }
  if (hosts.length > 50) throw new RangeError(`${label} accepts at most 50 domains`);

  return [...new Set(hosts)];
}

/** What Mai does about a display name that is itself the violation. */
export const NAME_CHECKS = Object.freeze(['off', 'log', 'reset']);

/**
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {'off' | 'log' | 'reset'}
 */
export function parseNameCheck(raw, label = 'name check') {
  const value = String(raw ?? '').trim().toLowerCase() || 'off';
  if (!NAME_CHECKS.includes(value)) {
    throw new RangeError(`${label} must be one of: ${NAME_CHECKS.join(', ')}`);
  }
  return value;
}

/** Bounds for the flood rule, so a typo cannot arm a guard nobody survives. */
const FLOOD_MIN_MESSAGES = 2;
const FLOOD_MAX_MESSAGES = 50;
const FLOOD_MAX_SECONDS = 3600;

/**
 * Parses a flood rule written as `count/seconds` ("6/10" = more than six
 * messages in ten seconds). Exported so `/mod config set flood` validates
 * identically.
 *
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {{ messages: number, seconds: number } | null} null = off.
 */
export function parseFloodRule(raw, label = 'flood rule') {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text || text === 'off' || text === '0') return null;

  const [count, window, ...rest] = text.split('/');
  const messages = wholeNumber(count);
  const seconds = wholeNumber(window);

  if (rest.length > 0 || !Number.isInteger(messages) || !Number.isInteger(seconds)) {
    throw new RangeError(`${label} must be written as count/seconds, e.g. 6/10 (or "off")`);
  }
  if (messages < FLOOD_MIN_MESSAGES || messages > FLOOD_MAX_MESSAGES) {
    throw new RangeError(
      `${label} count must be between ${FLOOD_MIN_MESSAGES} and ${FLOOD_MAX_MESSAGES}`,
    );
  }
  if (seconds < 1 || seconds > FLOOD_MAX_SECONDS) {
    throw new RangeError(`${label} window must be between 1 and ${FLOOD_MAX_SECONDS} seconds`);
  }

  return { messages, seconds };
}

const ratio = (name, fallback) => {
  try {
    return parseThreshold(optional(name, fallback), name);
  } catch (error) {
    throw new Error(`Environment variable ${error.message}`);
  }
};

/** A non-negative number, fractional allowed. 0 = disabled. */
const amount = (name, fallback, unit) => {
  const raw = optional(name, fallback);
  const value = decimalNumber(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Environment variable ${name} must be a non-negative number of ${unit}, got: ${raw}`,
    );
  }
  return value;
};

const hours = (name, fallback) => amount(name, fallback, 'hours');
const days = (name, fallback) => amount(name, fallback, 'days');

/**
 * Environment variables that used to do something and no longer do.
 *
 * Reported at startup by index.js rather than thrown on: refusing to boot over
 * a stale line in someone's `.env` is worse than telling them. But it has to be
 * *said*, because the failure mode of silence here is a deployment that starts
 * behaving differently after an update and cannot see why.
 *
 * config.js deliberately does not import the logger (the logger imports this),
 * so the list is collected here and logged there.
 *
 * @type {{ name: string, message: string }[]}
 */
export const deprecatedEnv = [];

const deprecate = (name, message) => {
  if (process.env[name]?.trim()) deprecatedEnv.push({ name, message });
};

// Shadow mode became a per-guild decision with a shape: an observation window
// that ends by itself and says so. A process-wide flag could only ever produce
// the shapeless version, on everywhere and forever, so it is gone rather than
// left to mean something subtly different from the setting of the same name.
deprecate(
  'MODERATION_SHADOW',
  'Shadow mode is per server now: /mod setup observe (a window that ends by itself) '
    + 'or /mod config set shadow:true (open-ended). This variable is ignored.',
);

const ladder = (name, fallback) => {
  try {
    return parseTimeoutLadder(optional(name, fallback), name);
  } catch (error) {
    throw new Error(`Environment variable ${error.message}`);
  }
};

/**
 * Runs one of the exported parsers over an environment variable, so the process
 * default is refused exactly like the same value typed into `/mod config set`.
 *
 * @param {(raw: unknown, label: string) => unknown} parse
 */
const parsed = (parse) => (name, fallback) => {
  try {
    return parse(optional(name, fallback) ?? '', name);
  } catch (error) {
    throw new Error(`Environment variable ${error.message}`);
  }
};

const linkPolicy = parsed(parseLinkPolicy);
const domains = parsed(parseDomainList);
const flood = parsed(parseFloodRule);
const nameCheck = parsed(parseNameCheck);

const moderationEnabled = bool('MODERATION_ENABLED', 'true');
const chatEnabled = bool('CHAT_ENABLED', 'true');
const needsOpenAi = moderationEnabled || chatEnabled;
// 0 = no appeal evidence anywhere, which is the default. Read before the key,
// because keeping evidence is the second thing that needs one.
const evidenceHours = hours('MODERATION_EVIDENCE_HOURS', '0');

// Both of these decide whether the privileged GuildMembers intent is requested,
// so they are read here rather than inside the config object: `discord` is built
// before `moderation` and cannot look forward into it.
const welcomeEnabled = bool('DISCORD_WELCOME_ENABLED', 'false');
const nameCheckMode = nameCheck('MODERATION_NAME_CHECK', 'off');

/**
 * The database content key: base64 of exactly 32 bytes (AES-256-GCM).
 * Generate with `openssl rand -base64 32`.
 *
 * Named for the chat history because that was the only encrypted table when it
 * was introduced; appeal evidence uses the same key, so either feature makes it
 * required. Renaming the variable would break every existing deployment for no
 * gain, so the name stays and this comment carries the truth.
 */
const readHistoryKey = () => {
  if (!chatEnabled && evidenceHours === 0) return null;

  const raw = required('CHAT_HISTORY_KEY');
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(
      `CHAT_HISTORY_KEY must be base64 of 32 bytes (got ${key.byteLength}); generate one with: openssl rand -base64 32`,
    );
  }
  return key;
};

export const config = Object.freeze({
  discord: {
    botToken: required('DISCORD_BOT_TOKEN'),
    publicKey: required('DISCORD_PUBLIC_KEY'),
    // Only needed for command registration (npm run register).
    appId: optional('DISCORD_APP_ID'),
    // Comma-separated guild IDs Mai is allowed to act in.
    // Empty = every guild the bot is a member of.
    guildIds: new Set(
      (optional('DISCORD_GUILD_IDS', '') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    // Welcome messages need the privileged "Server Members Intent": keep the
    // GuildMembers intent out of the login unless it is enabled in the
    // Developer Portal, otherwise the gateway connection is refused.
    welcomeEnabled,
    // Member events (joins, nickname changes) all ride on that one intent, and
    // two features want them now. A guild setting cannot turn an intent on:
    // intents are decided once, at login, for the whole process, so this is the
    // operator's switch and `/mod config set name-check` says so when it is off.
    memberEventsEnabled: welcomeEnabled || nameCheckMode !== 'off',
    // Whoever runs the bot itself, as opposed to whoever moderates a server
    // that uses it. Only these ids see process-wide numbers in `/mod status`
    // and `/mod spend`; everyone else sees their own guild. Empty = nobody, so
    // the cross-guild view is off unless it is deliberately switched on.
    operatorIds: new Set(
      (optional('OPERATOR_USER_IDS', '') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  },
  http: {
    port: int('PORT', '3000', { min: 1 }),
    // `/interactions` is reachable from the public internet through the tunnel,
    // and every request costs an Ed25519 verification before anything can
    // reject it. These two caps sit in front of that work. Real traffic is a
    // handful of interactions a minute, so the defaults are far above normal
    // use and only bite on a flood.
    rateLimitMax: int('INTERACTIONS_RATE_LIMIT_MAX', '120', { min: 1 }),
    rateLimitWindowMs: int('INTERACTIONS_RATE_LIMIT_WINDOW_MS', '60000', { min: 1000 }),
    // Discord's own payloads are a few KB; this only stops someone streaming
    // megabytes at the signature check.
    maxBodyBytes: int('INTERACTIONS_MAX_BODY_BYTES', '65536', { min: 1024 }),
    // Bearer token for GET /metrics. The whole server is public through the
    // tunnel and the metrics are process-wide, so an empty token disables the
    // endpoint entirely rather than exposing every guild's counts.
    metricsToken: optional('METRICS_TOKEN', ''),
  },
  openai: {
    // Required as soon as moderation or chat is on; both call the API.
    apiKey: needsOpenAi ? required('OPENAI_API_KEY') : optional('OPENAI_API_KEY'),
    // Any OpenAI-compatible endpoint works: only /chat/completions and
    // /moderations are used.
    baseUrl: (optional('OPENAI_BASE_URL', 'https://api.openai.com/v1') ?? '').replace(/\/+$/, ''),
    moderationModel: optional('OPENAI_MODERATION_MODEL', 'omni-moderation-latest'),
    chatModel: optional('OPENAI_CHAT_MODEL', 'gpt-5.4-mini'),
    timeoutMs: int('OPENAI_TIMEOUT_MS', '30000', { min: 1000 }),
    // Retries are safe here: an API call has no side effects of its own.
    maxRetries: int('OPENAI_MAX_RETRIES', '2'),
    // Tokens per calendar month (UTC) before chat degrades to reactions.
    // 0 = no limit. Moderation is never gated: safety is not a budget item.
    monthlyTokenBudget: int('OPENAI_MONTHLY_TOKEN_BUDGET', '0'),
  },
  moderation: {
    enabled: moderationEnabled,
    // Time the author has to delete a flagged message themselves.
    gracePeriodMinutes: int('MODERATION_GRACE_PERIOD_MINUTES', '10', { min: 1 }),
    // How often the enforcer looks for due rows (also prunes chat history).
    tickMs: int('MODERATION_TICK_MS', '60000', { min: 1000 }),
    // Most rows one tick will work through. Rows are processed one at a time
    // (several Discord calls each), so an unbounded backlog after an outage
    // could take longer than the interval and be skipped by the overlap guard
    // forever. The remainder is simply picked up by the next tick.
    maxRowsPerTick: int('MODERATION_MAX_ROWS_PER_TICK', '100', { min: 1 }),
    // Also send image attachments to the moderation endpoint (multimodal).
    classifyImages: bool('MODERATION_CLASSIFY_IMAGES', 'false'),
    // Hand out timeouts at all. Off still records strikes, so the record stays
    // complete and switching it back on picks up where it left off.
    escalationEnabled: bool('MODERATION_ESCALATION_ENABLED', 'true'),
    // Timeout in minutes per strike, 1-based; the last entry repeats. 0 = no
    // timeout for that strike, so the default lets a first offence pass with
    // just the deletion. Discord caps a timeout at 28 days (40320 minutes).
    timeoutLadder: ladder('MODERATION_TIMEOUT_LADDER', '0,10,60,1440'),
    // How far back strikes count towards escalation.
    strikeWindowDays: int('MODERATION_STRIKE_WINDOW_DAYS', '30', { min: 1 }),
    // Minimum category score (0-1) that counts as a violation. 0 = trust the
    // provider's own `flagged` boolean. Worth raising off 0 for non-English
    // servers: the same insult scores far lower in German than in English, so
    // the provider's own line lets most of it through.
    threshold: ratio('MODERATION_THRESHOLD', '0'),
    // Comma-separated category slugs that count at all. Empty = all of them.
    categories: parseCategoryList(optional('MODERATION_CATEGORIES', '') ?? '', 'MODERATION_CATEGORIES'),
    // How long the strike record is kept at all.
    violationRetentionDays: int('VIOLATION_RETENTION_DAYS', '90', { min: 1 }),
    // Rules Mai applies herself, before any classifier call: they cost no
    // tokens, catch what a semantic score cannot (an ad, a raid, a mass ping)
    // and keep working while the provider is down. All four default to off:
    // they are a server's own house rules, not a safety floor.
    inviteFilter: bool('MODERATION_INVITE_FILTER', 'false'),
    linkPolicy: linkPolicy('MODERATION_LINK_POLICY', 'off'),
    linkDomains: domains('MODERATION_LINK_DOMAINS', ''),
    // Mentions (users, roles, @everyone, @here) one message may carry. 0 = off.
    mentionCap: int('MODERATION_MENTION_CAP', '0'),
    // Messages per member per window, as `count/seconds`. Empty = off.
    floodRule: flood('MODERATION_FLOOD', ''),
    // Consecutive failed classifications in one guild before its staff are told
    // in the log channel that Mai is currently letting everything through.
    // Moderation fails open, which is deliberate but invisible from Discord.
    degradedAfter: int('MODERATION_DEGRADED_AFTER', '3', { min: 1 }),
    // How long an enforced message's text is kept, encrypted, so staff can
    // review an appeal against it. 0 = never, and the whole feature is off:
    // this is the operator's switch, and each guild still has to opt in
    // (`/mod config set evidence:true`). Hours, not days: it exists for the
    // appeal window, not as an archive.
    evidenceHours,
    // What to do about a member whose *name* is the violation: 'off', 'log',
    // or 'reset' (also removes the guild nickname). Needs the GuildMembers
    // intent, which is why anything but 'off' requests it (see `discord` above).
    nameCheck: nameCheckMode,
    // How long `/mod setup observe` watches before switching itself back to
    // enforcing. Days, fractions allowed so a deployment can test the ending
    // without waiting a week. 0 = no automatic end, which turns the preset
    // back into an open-ended flag somebody has to remember.
    shadowDays: days('MODERATION_SHADOW_DAYS', '7'),
    // Missed ticks before the process gives up on itself and exits, so the
    // container restarts it. A tick that hangs (a Discord call that never
    // settles) is skipped by the overlap guard forever after, which /healthz
    // reports and nothing acts on: Docker restart policies do not watch health.
    // 0 = never exit, for anyone who would rather have a wedged bot than a
    // restarting one.
    stuckRestartTicks: int('MODERATION_STUCK_RESTART_TICKS', '5'),
  },
  chat: {
    enabled: chatEnabled,
    // Prior history rows handed to the model as context.
    historyTurns: int('CHAT_HISTORY_TURNS', '12', { min: 1 }),
    // Rows older than this are pruned on every enforcer tick.
    historyMaxAgeHours: int('CHAT_HISTORY_MAX_AGE_HOURS', '48', { min: 1 }),
    maxReplyChars: int('CHAT_MAX_REPLY_CHARS', '1800', { min: 1 }),
    historyKey: readHistoryKey(),
    // Let Mai look at image attachments in messages addressed to her.
    visionEnabled: bool('CHAT_VISION_ENABLED', 'true'),
    // Images cost tokens per call, so only the first few are sent.
    visionMaxImages: int('CHAT_VISION_MAX_IMAGES', '2', { min: 1 }),
    // Function calling: lets her look up her own moderation queue and server
    // facts instead of inventing them.
    toolsEnabled: bool('CHAT_TOOLS_ENABLED', 'true'),
    // Per-user token bucket: at most `rateLimitMax` replies per window.
    rateLimitMax: int('CHAT_RATE_LIMIT_MAX', '5', { min: 1 }),
    rateLimitWindowMs: int('CHAT_RATE_LIMIT_WINDOW_MS', '60000', { min: 1000 }),
    // Hard cap on model calls in flight, across all channels.
    maxConcurrent: int('CHAT_MAX_CONCURRENT', '3', { min: 1 }),
  },
  db: {
    // Must be on a writable volume: the container rootfs is read-only.
    path: optional('DATABASE_PATH', '/data/mai.sqlite'),
  },
  alerts: {
    // Channel for error/fatal log lines. Empty = no alerting. This is an
    // operator channel, not a per-guild setting: most failures are process-wide.
    channelId: optional('ALERT_CHANNEL_ID', ''),
  },
  content: {
    // Content/prompt YAML. Defaults to the copy baked into the image.
    path: optional('MAI_CONFIG_PATH', fileURLToPath(new URL('../config/mai.yaml', import.meta.url))),
  },
  presence: {
    // Hours between rotating custom statuses; 0 = pick one status at startup
    // and never rotate. Validated like every other knob: a typo used to become
    // NaN and silently disable rotation instead of failing at startup.
    rotateHours: hours('PRESENCE_ROTATE_HOURS', '3'),
  },
  timezone: optional('TZ', 'UTC'),
  logLevel: optional('LOG_LEVEL', 'info'),
});

/**
 * Whether Mai should act in a given guild. This is the single authority for the
 * DISCORD_GUILD_IDS allowlist: every entry point (message handler, chat,
 * moderation, welcome, slash commands) must go through here so an
 * un-whitelisted server gets no behavior at all.
 *
 * Empty allowlist = every guild is allowed (opt-out). A null/undefined guildId
 * is a direct message: this returns true (a DM has no guild to match), but DMs
 * carry their own membership gate: see `isDmAuthorInAllowedGuild` in
 * gateway/events/mai-chat.js, which requires the DM author to share a
 * whitelisted guild before Mai answers.
 *
 * @param {string|null|undefined} guildId
 * @returns {boolean}
 */
export function isGuildAllowed(guildId) {
  const { guildIds } = config.discord;
  if (guildIds.size === 0) return true;
  if (!guildId) return true;
  return guildIds.has(guildId);
}

/**
 * Whether this user operates the bot itself (`OPERATOR_USER_IDS`).
 *
 * Distinct from Manage Messages, which makes someone staff *in one guild*.
 * Mai serves several servers from one process, so the process-wide figures
 * (total queue depth, total chat memory, the whole month's token spend) are
 * other servers' data as far as a guild moderator is concerned. Only an
 * operator sees them.
 *
 * @param {string|null|undefined} userId
 * @returns {boolean}
 */
export function isOperator(userId) {
  if (!userId) return false;
  return config.discord.operatorIds.has(userId);
}
