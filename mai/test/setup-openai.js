/**
 * The OpenAI client with retries actually switched on.
 *
 * Every other test file sets `OPENAI_MAX_RETRIES` to 0 or 1 so a failing stub
 * fails fast; here the retry loop is the thing under test, so it gets two extra
 * attempts. The stubs answer with a tiny `Retry-After`, which the client honors,
 * so the backoff costs milliseconds instead of seconds.
 *
 * Must be imported **before** `./setup.js`: `config.js` freezes the environment
 * the first time it is loaded.
 */
process.env.CHAT_ENABLED = 'true';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '2';
process.env.OPENAI_TIMEOUT_MS = '1000';
process.env.OPENAI_CHAT_MODEL = 'test-chat-model';
process.env.OPENAI_MODERATION_MODEL = 'test-moderation-model';
