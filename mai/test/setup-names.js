/**
 * Moderation on, with member events available: that variable is what requests
 * the privileged GuildMembers intent, so a test file about names has to be the
 * one that sets it. The `name-check` mode itself is per guild.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
// Both features ride this one intent, and the interesting part is what happens
// when they meet (a member whose name is the violation must not be greeted by
// it). Which of them a guild wants is a per-guild setting the tests write.
process.env.DISCORD_MEMBER_EVENTS = 'true';
