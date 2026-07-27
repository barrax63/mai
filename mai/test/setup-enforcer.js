/**
 * Two allowed guilds and a deliberately tiny per-tick cap, so the enforcer's
 * capped-and-ordered due query can be exercised with a handful of rows.
 *
 * Must be imported **before** `./setup.js`, like setup-moderation.js: the ids
 * are spelled out because importing the constants from setup.js would run its
 * body (and therefore its defaults) first.
 */
process.env.MODERATION_ENABLED = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '0';
// TEST_GUILD, OTHER_GUILD from setup.js.
process.env.DISCORD_GUILD_IDS = '111111111111111111,222222222222222222';
process.env.MODERATION_MAX_ROWS_PER_TICK = '2';
