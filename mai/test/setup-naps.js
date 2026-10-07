/**
 * Chat and moderation on, with Mai asleep for the whole test run.
 *
 * The nap window is derived from the clock rather than written down, because
 * `napping()` reads the real one: a fixed "23-6" would make this file's tests
 * pass or fail depending on what time somebody runs them. One hour starting
 * now is always a valid window (the two hours can never be equal, which
 * `config.js` refuses) and always contains the moment the tests run.
 *
 * Moderation is on because the property that matters most about a nap is the
 * one it must *not* have: a sleeping Mai still deletes.
 *
 * Must be imported **before** `./setup.js`: `config.js` reads and freezes the
 * environment the first time it is loaded.
 */
const hour = new Date().getHours();
process.env.NAP_HOURS = `${hour}-${(hour + 1) % 24}`;

process.env.CHAT_ENABLED = 'true';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
