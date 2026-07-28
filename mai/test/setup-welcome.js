/**
 * Member events available, which is not the default: the greeting itself is a
 * per-guild setting now (`welcome`), so the tests switch it on per guild and
 * this only says what the Developer Portal would say.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.DISCORD_MEMBER_EVENTS = 'true';
