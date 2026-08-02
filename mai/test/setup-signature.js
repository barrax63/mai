/**
 * A real Ed25519 key pair for the `/interactions` signature check.
 *
 * The rest of the suite calls `routeInteraction` directly, which is why the
 * gate in front of it was never exercised: every request in
 * `interactions-endpoint.test.js` stops at 413 or 429, so nothing reached
 * `verifyKeyMiddleware` and nothing proved that an unsigned request is refused
 * or that a signed one gets through.
 *
 * `DISCORD_PUBLIC_KEY` has to be the hex of a key we hold the private half of,
 * and it has to be set before `config.js` reads the environment, so this must be
 * imported **before** `./setup.js`.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// The raw 32-byte key is the tail of the SPKI encoding, and hex of that is what
// Discord shows in the Developer Portal.
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
process.env.DISCORD_PUBLIC_KEY = raw.toString('hex');

/**
 * Signs a request the way Discord does: over the timestamp followed by the raw
 * body, exactly as sent.
 *
 * @param {string} timestamp
 * @param {string} body
 * @returns {string} Hex signature for `X-Signature-Ed25519`.
 */
export const signRequest = (timestamp, body) =>
  sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
