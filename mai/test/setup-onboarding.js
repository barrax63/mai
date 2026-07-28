/**
 * Member events available, because two of the things this file checks are about
 * settings that ride the privileged GuildMembers intent: the permission report
 * (a `name-check` of `reset` is what makes ManageNicknames necessary) and the
 * `observe` preset (which sets `name-check` to `log`). Without the intent both
 * of those settings correctly report themselves as off, and the tests would be
 * asserting the operator's switch rather than what they are about.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, and `config.js` freezes the environment the first time it is loaded.
 */
process.env.DISCORD_MEMBER_EVENTS = 'true';
