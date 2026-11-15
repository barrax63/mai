/**
 * The laser pointer: a red dot she chases and, being a cat, mostly does not
 * catch. `/mai laser` posts it with one button, anybody in the channel can move
 * the dot, and every move is a pounce that lands or does not.
 *
 * There is no server-side game. The score travels in the button's custom_id
 * (`laser:<caught>:<tries>`), the same way every other component carries its
 * state, and that decides what the score is: a claim the button makes, not a
 * record. A client that forges one buys itself a fake score in a public message
 * and nothing else, because nothing reads it but the next click. What a forged
 * id must not buy is an endless game, so anything a real button could not have
 * carried is refused: not two whole numbers, more caught than tried, or a move
 * count already at the cap.
 *
 * The cap (`LASER_MAX_MOVES`) is what keeps one message from becoming an edit
 * storm: every click edits it, and after the last move the button is gone.
 *
 * Persona through and through: no database, no model, no Discord round trip of
 * its own, and nothing here reaches moderation.
 */
import { config } from '../config.js';
import { content } from '../content.js';

/** A move count or a catch count as a button writes it: digits, nothing else. */
const COUNT = /^\d{1,3}$/;

/**
 * @param {string[] | undefined} args The custom_id's arguments.
 * @returns {{ caught: number, tries: number } | null} Null for anything a
 *   button this module posted could not have carried.
 */
export function parseScore(args) {
  if (!Array.isArray(args) || args.length !== 2) return null;
  if (!args.every((value) => COUNT.test(String(value)))) return null;

  const [caught, tries] = args.map(Number);
  if (caught > tries || tries >= config.laser.maxMoves) return null;
  return { caught, tries };
}

/**
 * One move of the dot, and her pounce at it.
 *
 * @param {{ caught: number, tries: number }} score
 * @param {number} [roll] Takes the dice as an argument, like `pet` takes the clock.
 * @returns {{ caught: number, tries: number, hit: boolean, over: boolean }}
 */
export function moveDot(score, roll = Math.random()) {
  const hit = roll < content.commands.laser.chance;
  const caught = score.caught + (hit ? 1 : 0);
  const tries = score.tries + 1;
  return { caught, tries, hit, over: tries >= config.laser.maxMoves };
}

/**
 * @param {{ caught: number, tries: number }} score
 * @returns {string} The button's custom_id for this score.
 */
export const laserId = ({ caught, tries }) => `laser:${caught}:${tries}`;
