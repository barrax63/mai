/**
 * The one operator switch on the zoomies, set to off.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.ZOOMIES_CHANCE = '0';
