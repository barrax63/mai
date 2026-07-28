/**
 * Welcome messages on, which is not the default: the handler now runs for name
 * screening too, so greeting somebody is gated on the flag inside it rather
 * than on whether the event is wired up at all.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.DISCORD_WELCOME_ENABLED = 'true';
