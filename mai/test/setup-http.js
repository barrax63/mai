/**
 * A tiny interactions rate limit, so the gate in front of the signature check
 * can be exercised with three requests instead of a hundred and twenty.
 *
 * Must be imported **before** `./setup.js`: `config.js` freezes the environment
 * the first time it is loaded.
 */
process.env.INTERACTIONS_RATE_LIMIT_MAX = '2';
process.env.INTERACTIONS_RATE_LIMIT_WINDOW_MS = '60000';
