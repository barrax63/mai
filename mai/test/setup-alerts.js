/**
 * Enables error alerting for a single test file.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment on first load.
 *
 * `LOG_LEVEL` matters here: alerts are raised from a pino hook, and pino
 * replaces the method of a disabled level with a no-op, hook included. So a
 * process configured above `error` sends no alerts at all. The default setup
 * uses `silent`, which would make every assertion in that file vacuous.
 */
process.env.ALERT_CHANNEL_ID = '950000000000000001';
process.env.LOG_LEVEL = 'error';
