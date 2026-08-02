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
 * Ladders with names, because "0,5,15,30,60" is a sentence in a language nobody
 * speaks and every server was being asked to write one.
 *
 * Deliberately *not* a new setting. A `severity` knob that quietly rewrote the
 * ladder would be a second named-bundle mechanism sitting next to profiles,
 * which is the layer this project spent two changes removing. These are values
 * the existing option accepts, so `/mod config view` still shows the minutes
 * that are actually in force and `/mod config reset timeout-ladder` still means
 * one thing.
 *
 * The names describe the shape rather than a verdict on the member: each starts
 * at 0 (the deletion is the message on a first offence) and differs in how fast
 * it climbs and where it stops.
 */
export const NAMED_LADDERS = Object.freeze({
  // Barely a ladder: a nudge that never reaches an hour.
  gentle: '0,5,10,30',
  normal: '0,5,15,30,60',
  // Reaches a day, for a server that has already decided it needs one.
  firm: '0,15,60,360,1440',
});

/**
 * Parses a comma-separated escalation ladder ("0,5,15,30,60") into minutes per
 * strike, or one of the names above. Exported so `/mod config set timeout-ladder`
 * validates identically.
 *
 * @param {string} raw
 * @param {string} [label] Used in the error message.
 * @returns {number[]}
 */
export function parseTimeoutLadder(raw, label = 'timeout ladder') {
  // The value comes from a moderator or from a `.env`, so the lookup is
  // `Object.hasOwn`: a bare read also answers for everything on
  // `Object.prototype`, and `constructor` would arrive here as a ladder.
  const key = String(raw ?? '').trim().toLowerCase();
  const named = Object.hasOwn(NAMED_LADDERS, key) ? NAMED_LADDERS[key] : null;

  const steps = String(named ?? raw ?? '')
    .split(',')
    .map((step) => step.trim())
    .filter(Boolean)
    .map((step) => wholeNumber(step));

  if (steps.length === 0 || steps.some((step) => !Number.isInteger(step))) {
    throw new RangeError(
      `${label} must be comma-separated whole minutes (e.g. 0,5,15,30,60) or one of: `
        + `${Object.keys(NAMED_LADDERS).join(', ')}`,
    );
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

/**
 * Tuning that used to be configurable and is now simply correct.
 *
 * Every one of these had an environment variable, a line in `.env.example` and
 * a paragraph explaining a number nobody had a reason to change: the size of an
 * HTTP body Discord never sends, how many turns of context a model reads well,
 * how often a loop that processes a handful of rows should wake up. A knob that
 * is never turned is not flexibility, it is another line the operator has to
 * form an opinion about before the bot starts, and fifty of those is why this
 * file was hard to approach.
 *
 * The bar for keeping a variable is that somebody has a reason to set it: a
 * secret, something about the deployment (ports, paths, ids), or a policy that
 * differs per server. These are none of those, so they are values now.
 *
 * A second tier sits between this and the documented surface: the timings the
 * *test suite* varies (`OPENAI_MAX_RETRIES` and `OPENAI_TIMEOUT_MS` so a stubbed
 * failure does not sleep through its backoff, the four rate-limit knobs and
 * `MODERATION_MAX_ROWS_PER_TICK` / `MODERATION_DEGRADED_AFTER` so a test can
 * reach a limit in two steps instead of a hundred, `PRESENCE_ROTATE_HOURS` to
 * reach the interval clamp). Those keep reading the environment, because the
 * environment is already the seam the tests use and a test-only setter exported
 * from production code would be worse. They are gone from `.env.example` and the
 * README instead: reachable, not offered.
 */
const TICK_MS = 60_000;
const STUCK_RESTART_TICKS = 5;
const MAX_BODY_BYTES = 65_536;
const HISTORY_TURNS = 12;
const MAX_REPLY_CHARS = 1800;
const VISION_MAX_IMAGES = 2;
const SHADOW_DAYS = 7;
// GIF search. The timeout is short on purpose: this runs inside a chat turn
// that is already waiting on a model, and a GIF is the most optional thing in
// the reply, so it gives up long before the member does. Results are fetched a
// handful at a time and one is picked at random, or the same query would always
// produce the same GIF and she would look like a macro.
const GIF_SEARCH_TIMEOUT_MS = 4_000;
const GIF_SEARCH_RESULTS = 8;
// GIPHY's own content rating, their side of the filter.
// `g`, `pg`, `pg-13` and `r` exist.
const GIF_SEARCH_RATING = 'r';

// Reported at startup rather than ignored: the failure mode of silence is a
// deployment whose carefully chosen number stopped being read and cannot see it.
const retired = (name) =>
  deprecate(name, 'This is a fixed value now and the variable is ignored.');

retired('MODERATION_TICK_MS');
retired('MODERATION_STUCK_RESTART_TICKS');
retired('INTERACTIONS_MAX_BODY_BYTES');
retired('CHAT_HISTORY_TURNS');
retired('CHAT_MAX_REPLY_CHARS');
retired('CHAT_VISION_MAX_IMAGES');
retired('MODERATION_SHADOW_DAYS');

/**
 * The per-server policies that used to have a process-wide default here.
 *
 * A default for a setting that belongs to a server is only meaningful in a
 * deployment with one server. With several, it quietly decided things for
 * servers whose staff could not see the file it lived in, and it put a third
 * place to look between `/mod config view` and the answer to "why did Mai
 * delete that?". They live in `BASE_SETTINGS` (moderation/presets.js) now, at
 * the values these shipped with, under the guild's profile and its own
 * overrides. Nothing about an existing server's behaviour changes unless its
 * `.env` had one of these set to something other than the default.
 */
for (const name of [
  'MODERATION_GRACE_PERIOD_MINUTES',
  'MODERATION_ESCALATION_ENABLED',
  'MODERATION_TIMEOUT_LADDER',
  'MODERATION_STRIKE_WINDOW_DAYS',
  'MODERATION_THRESHOLD',
  'MODERATION_CATEGORIES',
  'MODERATION_INVITE_FILTER',
  'MODERATION_LINK_POLICY',
  'MODERATION_LINK_DOMAINS',
  'MODERATION_MENTION_CAP',
  'MODERATION_FLOOD',
]) {
  deprecate(
    name,
    'This is a per-server setting now: /mod setup for a whole profile, '
      + '/mod config set for one value. The variable is ignored.',
  );
}

// The parsers above are exported rather than used here: nothing in the
// environment is a per-server policy any more, so `/mod config set` and
// `BASE_SETTINGS` are their only callers (db/settings.js).

const moderationEnabled = bool('MODERATION_ENABLED', 'true');
const chatEnabled = bool('CHAT_ENABLED', 'true');
const needsOpenAi = moderationEnabled || chatEnabled;
// 0 = no appeal evidence anywhere, which is the default. Read before the key,
// because keeping evidence is the second thing that needs one.
const evidenceHours = hours('MODERATION_EVIDENCE_HOURS', '0');

/**
 * Whether the privileged "Server Members Intent" is switched on in the Discord
 * Developer Portal, which is the only thing this variable says.
 *
 * It used to be said twice and sideways: `DISCORD_WELCOME_ENABLED` and
 * `MODERATION_NAME_CHECK` were both *policies*, and requesting the intent was a
 * side effect of either being on. So a deployment could not greet members in
 * one server and not another, turning on a name check anywhere silently changed
 * what the gateway asked Discord for, and switching a policy off in the last
 * server that wanted it dropped the intent from under the other feature.
 *
 * One variable, one meaning, and it is a fact about the deployment rather than
 * a stance on moderation: exactly the test for whether something belongs here.
 * Both features are ordinary per-guild settings now (`welcome`, `name-check`),
 * folded against this in `effectiveSettings` so what a caller reads is what
 * actually happens, and stored even when it says no, so a server that
 * configured itself is already configured the moment the operator flips it.
 *
 * Getting it wrong is loud in one direction and quiet in the other: `true`
 * without the portal toggle makes the gateway login fail outright, which is why
 * it cannot default to on.
 */
const memberEventsEnabled = bool('DISCORD_MEMBER_EVENTS', 'false');

deprecate(
  'DISCORD_WELCOME_ENABLED',
  'Greeting new members is a per-server setting now (/mod config set welcome:true). '
    + 'Set DISCORD_MEMBER_EVENTS=true to make the intent available at all.',
);
deprecate(
  'MODERATION_NAME_CHECK',
  'Display-name screening is a per-server setting now (/mod config set name-check). '
    + 'Set DISCORD_MEMBER_EVENTS=true to make the intent available at all.',
);

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
    // Member events (joins, nickname changes) ride on the privileged
    // GuildMembers intent, which is requested once at login for the whole
    // process, so no guild setting can turn one on. Keep it out of the login
    // unless the Developer Portal toggle is on, or the gateway refuses the
    // connection outright.
    memberEventsEnabled,
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
    maxBodyBytes: MAX_BODY_BYTES,
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
    // How often the enforcer looks for due rows (also prunes chat history).
    tickMs: TICK_MS,
    // Most rows one tick will work through. Rows are processed one at a time
    // (several Discord calls each), so an unbounded backlog after an outage
    // could take longer than the interval and be skipped by the overlap guard
    // forever. The remainder is simply picked up by the next tick.
    maxRowsPerTick: int('MODERATION_MAX_ROWS_PER_TICK', '100', { min: 1 }),
    // Also send image attachments to the moderation endpoint (multimodal).
    // On by default, matching `.env.example`: with it off, a message carrying
    // only an image is not classified at all, so posting one is a way around
    // moderation entirely. A deployment that omits the variable should not get
    // the bypass, and an operator who wants the tokens back can still say so.
    classifyImages: bool('MODERATION_CLASSIFY_IMAGES', 'true'),
    // How long the strike record is kept at all.
    violationRetentionDays: int('VIOLATION_RETENTION_DAYS', '90', { min: 1 }),
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
    // How long `/mod setup observe` watches before switching itself back to
    // enforcing. A week, because that is what Mai's introduction promises, and
    // the promise is the feature: a flag somebody has to remember to turn off
    // is the shapeless version this replaced.
    shadowDays: SHADOW_DAYS,
    // Missed ticks before the process gives up on itself and exits, so the
    // container restarts it. A tick that hangs (a Discord call that never
    // settles) is skipped by the overlap guard forever after, which /healthz
    // reports and nothing acts on: Docker restart policies do not watch health.
    stuckRestartTicks: STUCK_RESTART_TICKS,
  },
  chat: {
    enabled: chatEnabled,
    // Prior history rows handed to the model as context.
    historyTurns: HISTORY_TURNS,
    // Rows older than this are pruned on every enforcer tick.
    historyMaxAgeHours: int('CHAT_HISTORY_MAX_AGE_HOURS', '48', { min: 1 }),
    maxReplyChars: MAX_REPLY_CHARS,
    historyKey: readHistoryKey(),
    // Let Mai look at image attachments in messages addressed to her.
    visionEnabled: bool('CHAT_VISION_ENABLED', 'true'),
    // Images cost tokens per call, so only the first few are sent.
    visionMaxImages: VISION_MAX_IMAGES,
    // Function calling: lets her look up her own moderation queue and server
    // facts instead of inventing them.
    toolsEnabled: bool('CHAT_TOOLS_ENABLED', 'true'),
    // Per-user token bucket: at most `rateLimitMax` replies per window.
    rateLimitMax: int('CHAT_RATE_LIMIT_MAX', '5', { min: 1 }),
    rateLimitWindowMs: int('CHAT_RATE_LIMIT_WINDOW_MS', '60000', { min: 1000 }),
    // Hard cap on model calls in flight, across all channels.
    maxConcurrent: int('CHAT_MAX_CONCURRENT', '3', { min: 1 }),
    // Live GIF search (GIPHY). A key is a secret and a deployment fact, so it
    // belongs here; whether a *server* wants searched GIFs is the per-guild
    // `gifs` setting. Without a key the tool does not exist and the catalog in
    // the content file is the only source, which is the safer default and
    // therefore the one that needs no configuration.
    //
    // GIPHY rather than Tenor: Google stopped accepting new Tenor API clients
    // in January 2026 and shut the API down entirely that June, so a Tenor
    // integration written today would never have worked at all.
    gifSearch: {
      apiKey: optional('GIPHY_API_KEY', ''),
      enabled: Boolean(optional('GIPHY_API_KEY', '')),
      timeoutMs: GIF_SEARCH_TIMEOUT_MS,
      results: GIF_SEARCH_RESULTS,
      rating: GIF_SEARCH_RATING,
    },
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
    rotateHours: hours('PRESENCE_ROTATE_HOURS', '5'),
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
