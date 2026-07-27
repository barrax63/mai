/**
 * Chat *and* moderation on at once, which is the only configuration in which
 * `onMessageCreate` makes all of its decisions: the handler picks between a
 * scold and a reply, so a file that switches only one of them on cannot see the
 * choice being made.
 *
 * Must be imported **before** `./setup.js`: `config.js` freezes the environment
 * the first time it is loaded.
 */
process.env.CHAT_ENABLED = 'true';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
