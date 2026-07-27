/**
 * An absurd rotation interval, so the 32-bit clamp is the thing under test.
 *
 * A delay above 2^31-1 ms overflows to 1 ms in Node, which would turn "rotate
 * rarely" into a tight loop: the exact opposite of what the knob asks for.
 *
 * Must be imported **before** `./setup.js`: `config.js` freezes the environment
 * the first time it is loaded.
 */
process.env.PRESENCE_ROTATE_HOURS = '1000000';
