/**
 * A `.env` carrying a variable that no longer does anything.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` reads the environment once, at import time.
 */
process.env.MODERATION_SHADOW = 'true';
