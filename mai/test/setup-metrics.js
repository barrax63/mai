/**
 * Configures a metrics token for the one file that exercises the auth path.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.METRICS_TOKEN = 'test-metrics-token';
