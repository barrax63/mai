/**
 * Moderation on, with name screening switched on process-wide: that flag is
 * also what requests the privileged GuildMembers intent, so a test file about
 * names has to be the one that sets it.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
process.env.MODERATION_NAME_CHECK = 'log';
// Welcomes on as well: both features share the one member-events handler, and
// the interesting part is what happens when they meet (a member whose name is
// the violation must not be greeted by it).
process.env.DISCORD_WELCOME_ENABLED = 'true';
