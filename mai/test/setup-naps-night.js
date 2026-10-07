/**
 * A nap window that crosses midnight, which is the branch worth testing on its
 * own: the hours in it are the ones at or after the start *or* before the end,
 * and reading that as "between" leaves her awake all night and asleep all day.
 *
 * Fixed hours, unlike `setup-naps.js`, because this file only asks `napping()`
 * about dates it hands in itself.
 *
 * Must be imported **before** `./setup.js`.
 */
process.env.NAP_HOURS = '23-6';
