/**
 * Deliberately tiny chat guards, plus a token budget small enough to blow
 * through, so the three limits in front of a model call can be exercised with a
 * handful of calls instead of hundreds.
 *
 * Must be imported **before** `./setup.js`: `config.js` freezes the environment
 * the first time it is loaded.
 */
process.env.CHAT_ENABLED = 'true';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.OPENAI_API_KEY = 'test-key';
process.env.CHAT_RATE_LIMIT_MAX = '2';
process.env.CHAT_RATE_LIMIT_WINDOW_MS = '1000';
process.env.CHAT_MAX_CONCURRENT = '2';
process.env.OPENAI_MONTHLY_TOKEN_BUDGET = '100';
