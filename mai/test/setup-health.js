/**
 * Moderation on, with a short degradation threshold so a test does not have to
 * fake an outage message by message.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
process.env.MODERATION_DEGRADED_AFTER = '2';
