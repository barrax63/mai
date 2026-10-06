/**
 * Mai has an opinion about your new name, and she keeps it to herself.
 *
 * A rename is not a message, so there is nothing for her to react *to* at the
 * moment it happens, and the alternatives were both worse: posting a line into
 * a channel on every rename is noise nobody asked for, and announcing it in the
 * log channel would turn a joke into a record. So a rename is remembered, and
 * the member's next ordinary message gets a single emoji look. One reaction,
 * once, and the matter is closed.
 *
 * What this deliberately is not: the name is never read, never classified,
 * never quoted and never logged, and nothing here can act on a member. The
 * display-name *screen* is a different feature in a different place
 * (`moderation/names.js`, gated by `name-check`, with a nickname reset as its
 * ceiling); this costs no classification call and has no ceiling to reach,
 * because it does nothing. A flagged name is therefore also not looked at: she
 * has already dealt with that one properly, and a wink on top of it would be
 * the wrong note entirely.
 *
 * Rides the privileged `GuildMembers` intent, like the welcome and the name
 * screen, which is to say it simply never happens where
 * `DISCORD_MEMBER_EVENTS` is off: the map stays empty and the reaction path
 * finds nothing. Per member and guild, in memory, bounded by being *consumed*:
 * a rename storm refreshes one mark rather than queueing ten looks.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

/** `guildId:userId` -> epoch ms the look expires at. */
const pending = new Map();

const keyFor = (guildId, userId) => `${guildId}:${userId}`;

/**
 * Drops looks nobody came back to collect, so a server full of people renaming
 * themselves and going quiet does not leave an entry each. Called on every
 * rename, which is the only thing that grows the map.
 *
 * @param {number} now
 */
function forgetStale(now) {
  for (const [key, expiresAt] of pending) {
    if (now >= expiresAt) pending.delete(key);
  }
}

/**
 * Remembers that this member just renamed themselves.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} [now]
 */
export function noteRename(guildId, userId, now = Date.now()) {
  if (!guildId || !userId) return;

  forgetStale(now);
  pending.set(keyFor(guildId, userId), now + config.renames.lookMs);
  logger.debug({ guildId, userId }, 'Rename noted, she will have a look');
}

/**
 * Whether this member has a look coming, which this call also spends.
 *
 * Read *and* consumed in one step on purpose: the look is a reaction to the
 * rename and not to the message, so it happens once. Two messages in quick
 * succession must not both earn one, and nothing else in the pipeline needs to
 * know about it afterwards.
 *
 * @param {string | null | undefined} guildId
 * @param {string | null | undefined} userId
 * @param {number} [now]
 * @returns {boolean}
 */
export function takeRenameLook(guildId, userId, now = Date.now()) {
  if (!guildId || !userId) return false;

  const key = keyFor(guildId, userId);
  const expiresAt = pending.get(key);
  if (expiresAt === undefined) return false;

  // Spent either way: an expired look is not owed to anybody later.
  pending.delete(key);
  // She has forgotten about it by now. Somebody who renames themselves and
  // says nothing for half an hour gets no comment on it.
  return now < expiresAt;
}

/** Test seam, the same one `resetPetting` is. */
export function resetRenames() {
  pending.clear();
}
