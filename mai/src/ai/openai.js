/**
 * Minimal client for the two OpenAI-compatible endpoints Mai needs:
 * `POST /chat/completions` (her replies) and `POST /moderations`
 * (classification). Chat completions is the most widely implemented shape, so
 * OPENAI_BASE_URL can point at any compatible provider.
 *
 * Retries are safe here: an API call has no side effects of its own, and every
 * Discord action happens in our own code after the call returned. So 429/5xx and
 * network errors *and* timeouts are retried with exponential backoff.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE_BACKOFF_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenAiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, cause?: unknown }} [details]
   */
  constructor(message, { status, code, cause } = {}) {
    super(message, { cause });
    this.name = 'OpenAiError';
    this.status = status;
    this.code = code;
  }
}

const isRetryableStatus = (status) => status === 408 || status === 409 || status === 429 || status >= 500;

/**
 * Honors a numeric `Retry-After` (seconds) when the provider sends one.
 *
 * @param {Response} response
 * @param {number} attempt
 */
const backoffMs = (response, attempt) => {
  const header = Number.parseFloat(response?.headers?.get('retry-after') ?? '');
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
};

/**
 * @param {string} path Endpoint path, e.g. '/chat/completions'.
 * @param {object} body
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {OpenAiError}
 */
async function postJson(path, body) {
  const url = `${config.openai.baseUrl}${path}`;
  const attempts = config.openai.maxRetries + 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.openai.timeoutMs),
      });

      if (response.ok) {
        const result = await response.json();
        logger.debug(
          { path, model: body.model, ms: Date.now() - startedAt, usage: result.usage },
          'OpenAI call succeeded',
        );
        return result;
      }

      const text = await response.text().catch(() => '');
      const retryable = isRetryableStatus(response.status);
      logger.warn(
        { path, status: response.status, attempt, retryable },
        'OpenAI call failed',
      );

      if (!retryable || attempt === attempts - 1) {
        throw new OpenAiError(`OpenAI ${path} failed: ${response.status}`, {
          status: response.status,
          // Error bodies carry provider diagnostics, not user content, but keep
          // them out of the message and at debug level anyway.
          code: 'http_error',
        });
      }
      logger.debug({ path, body: text }, 'OpenAI error body');
      await sleep(backoffMs(response, attempt));
    } catch (error) {
      if (error instanceof OpenAiError) throw error;

      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      logger.warn(
        { path, attempt, timeoutMs: timedOut ? config.openai.timeoutMs : undefined, err: error },
        timedOut ? 'OpenAI call timed out' : 'OpenAI request error',
      );

      if (attempt === attempts - 1) {
        throw new OpenAiError(`OpenAI ${path} unreachable: ${error.message}`, {
          code: timedOut ? 'timeout' : 'network_error',
          cause: error,
        });
      }
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new OpenAiError(`OpenAI ${path} failed`);
}

/**
 * @param {{ messages: object[], tools?: object[] }} request Full message array,
 *   including the system message; `tools` enables function calling for this call.
 * @returns {Promise<{ message: object, usage?: object }>} The assistant message
 *   verbatim — it may carry `tool_calls` instead of `content`, and it has to go
 *   back into the next request unchanged.
 */
export async function createChatCompletion({ messages, tools }) {
  const result = await postJson('/chat/completions', {
    model: config.openai.chatModel,
    messages,
    ...(tools?.length ? { tools } : {}),
  });

  return {
    message: result?.choices?.[0]?.message ?? {},
    usage: result?.usage,
  };
}

/**
 * @param {string | Array<object>} input Text, or a multimodal content array.
 * @returns {Promise<{ flagged: boolean, categories: Record<string, boolean> }>}
 */
export async function createModeration(input) {
  const result = await postJson('/moderations', {
    model: config.openai.moderationModel,
    input,
  });

  const first = result?.results?.[0];
  if (!first) {
    throw new OpenAiError('Moderation response contained no result', { code: 'bad_response' });
  }
  return { flagged: Boolean(first.flagged), categories: first.categories ?? {} };
}
