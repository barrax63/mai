/**
 * `/mai pet`, and the bite at the end of it.
 *
 * Cats have a petting threshold: a few strokes are wonderful, a few more are
 * tolerated, and one past that is a bite out of nowhere. Mai keeps that
 * property. The first pets in a window get a happy answer, the next ones get a
 * warning, and the one after that bites and leaves her sulking with the person
 * who did it for a while: she stops answering them in chat and through
 * `/mai ask` until she is over it.
 *
 * The silence is the joke and it is why the shape matters. It is per member,
 * self-inflicted, always the member's own doing, and it never touches
 * moderation: a sulking cat still deletes what she would have deleted, still
 * counts strikes, and still answers everybody else. Nothing here is reachable
 * by anyone other than the person being sulked with.
 *
 * State is in memory, like the zoomies and the classifier health, and for the
 * same reason: a restart is a nap, and a bite that outlived one would be a
 * silence nobody could connect to anything they did.
 */
import { config } from '../config.js';

/** @type {Map<string, { pets: number, lastPetAt: number, sulkingUntil: number }>} */
const members = new Map();

/** How a pet went, which is also which set of lines answers it. */
export const HAPPY = 'happy';
export const ANNOYED = 'annoyed';
export const BITE = 'bite';
export const SULKING = 'sulking';

/**
 * Drops members she has forgotten about entirely, so a busy server does not
 * leave an entry per member behind forever. Called on every pet, which is the
 * only thing that grows the map.
 *
 * @param {number} now
 */
function forgetStale(now) {
  const { windowMs, biteMs } = config.petting;
  for (const [userId, state] of members) {
    const idle = now - state.lastPetAt;
    if (idle > windowMs && now >= state.sulkingUntil + biteMs) members.delete(userId);
  }
}

/**
 * Whether Mai is currently refusing to answer this member because they would
 * not stop petting her.
 *
 * @param {string} userId
 * @param {number} [now]
 * @returns {boolean}
 */
export function isSulking(userId, now = Date.now()) {
  return now < (members.get(userId)?.sulkingUntil ?? 0);
}

/**
 * One pet.
 *
 * @param {string} userId
 * @param {number} [now]
 * @returns {string} One of HAPPY / ANNOYED / BITE / SULKING.
 */
export function pet(userId, now = Date.now()) {
  const { windowMs, happyPets, patience } = config.petting;

  if (isSulking(userId, now)) return SULKING;

  forgetStale(now);

  const previous = members.get(userId);
  // The memory of being petted fades: somebody coming back an hour later is
  // starting over, not carrying on from four strokes ago.
  const stale = !previous || now - previous.lastPetAt > windowMs;
  const pets = (stale ? 0 : previous.pets) + 1;

  const state = {
    pets,
    lastPetAt: now,
    // Preserved rather than reset: a sulk that has run out is in the past, and
    // the next one is decided by this counter alone.
    sulkingUntil: previous?.sulkingUntil ?? 0,
  };
  members.set(userId, state);

  if (pets <= happyPets) return HAPPY;
  if (pets <= patience) return ANNOYED;

  // The bite: one past the last one she was willing to put up with. The
  // counter goes back to nothing, or every further pet would bite again and
  // the sulk would never end.
  state.pets = 0;
  state.sulkingUntil = now + config.petting.biteMs;
  return BITE;
}

/** Test seam, and the same one `resetClassifierHealth` is. */
export function resetPetting() {
  members.clear();
}
