/**
 * Central configuration. Reads and validates environment variables once at
 * startup so the rest of the app can rely on a well-formed config object.
 */

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

export const config = Object.freeze({
  discord: {
    botToken: required('DISCORD_BOT_TOKEN'),
    publicKey: required('DISCORD_PUBLIC_KEY'),
    // Only needed for command registration (npm run register).
    appId: optional('DISCORD_APP_ID'),
    // Comma-separated guild IDs whose messages are forwarded to n8n.
    // Empty = forward from every guild the bot is a member of.
    guildIds: new Set(
      (optional('DISCORD_GUILD_IDS', '') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    // Welcome messages need the privileged "Server Members Intent" — keep the
    // GuildMembers intent out of the login unless it is enabled in the
    // Developer Portal, otherwise the gateway connection is refused.
    welcomeEnabled: optional('DISCORD_WELCOME_ENABLED', 'false') === 'true',
  },
  http: {
    port: Number.parseInt(optional('PORT', '3000'), 10),
  },
  n8n: {
    webhookUrl: optional('N8N_WEBHOOK_URL'),
    // Mai chat workflow (mention/reply conversations). Unset = chat disabled.
    chatWebhookUrl: optional('N8N_CHAT_WEBHOOK_URL'),
    webhookSecret: optional('N8N_WEBHOOK_SECRET'),
    // Header carrying the shared secret (exact value match, no "Bearer"
    // prefix), as configured in n8n's header auth.
    webhookHeader: optional('N8N_WEBHOOK_HEADER', 'Authorization'),
    // The workflow responds via "Respond to Webhook" after processing, so
    // allow enough time for the full workflow run (e.g. LLM classification).
    webhookTimeoutMs: Number.parseInt(optional('N8N_WEBHOOK_TIMEOUT_MS', '30000'), 10),
  },
  presence: {
    // Hours between rotating custom statuses; 0 (or negative) = pick one
    // status at startup and never rotate.
    rotateHours: Number.parseFloat(optional('PRESENCE_ROTATE_HOURS', '3')),
  },
  logLevel: optional('LOG_LEVEL', 'info'),
});

/**
 * Whether Mai should act in a given guild. This is the single authority for the
 * DISCORD_GUILD_IDS allowlist — every entry point (message handler, chat,
 * moderation forward, welcome, slash commands) must go through here so an
 * un-whitelisted server gets no behavior at all, not merely no n8n forwarding.
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
