/**
 * Turns chat, moderation and the operator tier on for the security tests.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.MODERATION_ENABLED = 'true';
process.env.CHAT_ENABLED = 'true';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
process.env.OPENAI_MONTHLY_TOKEN_BUDGET = '1000000';
process.env.OPERATOR_USER_IDS = '900000000000000001';
