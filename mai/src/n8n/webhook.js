/**
 * Forwards Discord messages to the n8n webhooks (moderation + Mai chat).
 *
 * The n8n workflows respond via their "Respond to Webhook" node, i.e. the HTTP
 * response arrives only after the workflow branch has finished and carries a
 * branch-specific JSON body. That body is returned to the caller for further
 * use; failures are logged and retried a limited number of times, but never
 * crash the gateway handler. If the corresponding URL env var is unset, that
 * forwarding target is disabled entirely.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Field names of a workflow response, for info-level logging without exposing
// values (the chat { reply } and any text in a verdict are user content).
const responseFields = (body) =>
  body && typeof body === 'object' ? Object.keys(body) : [];

export const isForwardingEnabled = () => Boolean(config.n8n.webhookUrl);
export const isChatEnabled = () => Boolean(config.n8n.chatWebhookUrl);

/**
 * @param {import('discord.js').Message} message
 * @returns {Promise<object | null>} Parsed workflow response body, or null if
 *   forwarding is disabled or ultimately failed.
 */
export async function forwardMessageToN8n(message) {
  if (!isForwardingEnabled()) return null;

  // Nothing to classify without text (e.g. attachment-only messages).
  if (!message.content?.trim()) {
    logger.debug({ messageId: message.id }, 'Skipping forward: empty content');
    return null;
  }

  // Guild allowlist (DISCORD_GUILD_IDS). Empty set = all guilds. DMs have no
  // guildId and are only forwarded when no allowlist is configured.
  const { guildIds } = config.discord;
  if (guildIds.size > 0 && !guildIds.has(message.guildId)) {
    logger.debug(
      { messageId: message.id, guildId: message.guildId },
      'Skipping forward: guild not in allowlist',
    );
    return null;
  }

  const payload = {
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    userId: message.author.id,
    username: message.author.username,
    content: message.content,
    attachments: message.attachments.map((attachment) => ({
      url: attachment.url,
      contentType: attachment.contentType,
    })),
    createdAt: message.createdAt.toISOString(),
  };

  return postToN8n(config.n8n.webhookUrl, payload, {
    messageId: message.id,
    target: 'moderation',
  });
}

/**
 * Sends a chat turn to the Mai chat workflow. The payload is built by the
 * gateway handler (mention already stripped from content).
 *
 * @param {object} payload Chat request body ({ messageId, guildId, channelId,
 *   userId, username, content, createdAt }).
 * @returns {Promise<object | null>} Workflow response ({ reply }) or null.
 */
export async function sendChatMessageToN8n(payload) {
  if (!isChatEnabled()) return null;

  return postToN8n(config.n8n.chatWebhookUrl, payload, {
    messageId: payload.messageId,
    target: 'chat',
  });
}

/**
 * POST with retry/backoff shared by all n8n targets. Retries only 5xx and
 * connection errors; 4xx and timeouts give up immediately (a timed-out
 * workflow already ran — retrying would process the same message twice).
 */
async function postToN8n(url, payload, logContext) {
  // n8n header auth compares the exact header value (no auth scheme prefix).
  const headers = { 'Content-Type': 'application/json' };
  if (config.n8n.webhookSecret) {
    headers[config.n8n.webhookHeader] = config.n8n.webhookSecret;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.n8n.webhookTimeoutMs),
      });

      if (response.ok) {
        const result = await parseResponseBody(response);
        // Metadata only at info: the response body carries content (the chat
        // { reply }, plus any text echoed in a moderation verdict). Log the
        // decision and the field names; the full body stays at debug.
        logger.info(
          { ...logContext, action: result?.action, fields: responseFields(result) },
          'n8n workflow responded',
        );
        logger.debug({ ...logContext, result }, 'n8n workflow response body');
        return result;
      }

      // 4xx will not succeed on retry (bad auth, wrong path) — give up early.
      if (response.status < 500) {
        logger.error(
          { ...logContext, status: response.status },
          'n8n webhook rejected message, not retrying',
        );
        return null;
      }

      logger.warn(
        { ...logContext, status: response.status, attempt },
        'n8n webhook returned server error',
      );
    } catch (error) {
      // A timeout means the workflow was (most likely) triggered but slow to
      // respond — retrying would execute it a second time for the same
      // message, so give up instead.
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        logger.error(
          { ...logContext, timeoutMs: config.n8n.webhookTimeoutMs },
          'n8n workflow did not respond in time, not retrying',
        );
        return null;
      }

      logger.warn(
        { ...logContext, attempt, err: error },
        'n8n webhook request failed',
      );
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
  }

  logger.error(
    { ...logContext, attempts: MAX_ATTEMPTS },
    'Giving up forwarding message to n8n',
  );
  return null;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
