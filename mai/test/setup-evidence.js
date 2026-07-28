/**
 * The enforcer, plus appeal evidence: a retention window above 0 and the key
 * that encrypts it. Chat stays off, so this also proves the key is required by
 * evidence alone rather than as a side effect of chat being on.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
process.env.MODERATION_EVIDENCE_HOURS = '48';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 9).toString('base64');
