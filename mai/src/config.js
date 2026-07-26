/**
 * Central configuration. Reads and validates environment variables once at
 * startup so the rest of the app can rely on a well-formed config object.
 *
 * Operational knobs only — everything Mai *says* (persona, prompts, scold
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

const int = (name, fallback, { min = 0 } = {}) => {
  const raw = optional(name, fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Environment variable ${name} must be an integer >= ${min}, got: ${raw}`);
  }
  return value;
};

const moderationEnabled = bool('MODERATION_ENABLED', 'true');
const chatEnabled = bool('CHAT_ENABLED', 'true');
const needsOpenAi = moderationEnabled || chatEnabled;

/**
 * The chat history encryption key: base64 of exactly 32 bytes (AES-256-GCM).
 * Generate with `openssl rand -base64 32`.
 */
const readHistoryKey = () => {
  if (!chatEnabled) return null;

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
    // Welcome messages need the privileged "Server Members Intent" — keep the
    // GuildMembers intent out of the login unless it is enabled in the
    // Developer Portal, otherwise the gateway connection is refused.
    welcomeEnabled: bool('DISCORD_WELCOME_ENABLED', 'false'),
  },
  http: {
    port: int('PORT', '3000', { min: 1 }),
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
  },
  moderation: {
    enabled: moderationEnabled,
    // Time the author has to delete a flagged message themselves.
    gracePeriodMinutes: int('MODERATION_GRACE_PERIOD_MINUTES', '10', { min: 1 }),
    // How often the enforcer looks for due rows (also prunes chat history).
    tickMs: int('MODERATION_TICK_MS', '60000', { min: 1000 }),
    // Also send image attachments to the moderation endpoint (multimodal).
    classifyImages: bool('MODERATION_CLASSIFY_IMAGES', 'false'),
  },
  chat: {
    enabled: chatEnabled,
    // Prior history rows handed to the model as context.
    historyTurns: int('CHAT_HISTORY_TURNS', '12', { min: 1 }),
    // Rows older than this are pruned on every enforcer tick.
    historyMaxAgeHours: int('CHAT_HISTORY_MAX_AGE_HOURS', '48', { min: 1 }),
    maxReplyChars: int('CHAT_MAX_REPLY_CHARS', '1800', { min: 1 }),
    historyKey: readHistoryKey(),
    // Per-user token bucket: at most `rateLimitMax` replies per window.
    rateLimitMax: int('CHAT_RATE_LIMIT_MAX', '5', { min: 1 }),
    rateLimitWindowMs: int('CHAT_RATE_LIMIT_WINDOW_MS', '60000', { min: 1000 }),
    // Hard cap on model calls in flight, across all channels.
    maxConcurrent: int('CHAT_MAX_CONCURRENT', '3', { min: 1 }),
  },
  db: {
    // Must be on a writable volume — the container rootfs is read-only.
    path: optional('DATABASE_PATH', '/data/mai.sqlite'),
  },
  content: {
    // Content/prompt YAML. Defaults to the copy baked into the image.
    path: optional('MAI_CONFIG_PATH', fileURLToPath(new URL('../config/mai.yaml', import.meta.url))),
  },
  presence: {
    // Hours between rotating custom statuses; 0 (or negative) = pick one
    // status at startup and never rotate.
    rotateHours: Number.parseFloat(optional('PRESENCE_ROTATE_HOURS', '3')),
  },
  timezone: optional('TZ', 'UTC'),
  logLevel: optional('LOG_LEVEL', 'info'),
});

/**
 * Whether Mai should act in a given guild. This is the single authority for the
 * DISCORD_GUILD_IDS allowlist — every entry point (message handler, chat,
 * moderation, welcome, slash commands) must go through here so an
 * un-whitelisted server gets no behavior at all.
 *
 * Empty allowlist = every guild is allowed (opt-out). A null/undefined guildId
 * is a direct message: this returns true (a DM has no guild to match), but DMs
 * carry their own membership gate — see `isDmAuthorInAllowedGuild` in
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
