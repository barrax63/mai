/**
 * Authenticated encryption for the chat history columns.
 *
 * The `chat_history` table is the one place Mai stores message content, so it
 * is encrypted at rest with AES-256-GCM (key: CHAT_HISTORY_KEY, 32 bytes
 * base64). `channel_id` and the timestamps stay plaintext: they are the lookup
 * and pruning keys, and are metadata under the project's logging/privacy rule.
 *
 * Stored format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`, a fresh random IV per
 * value. Key rotation is a hard cut: old rows fail to decrypt, are dropped from
 * prompts, and expire with the normal retention window.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const key = () => {
  const value = config.chat.historyKey;
  if (!value) throw new Error('CHAT_HISTORY_KEY is not configured (chat is disabled)');
  return value;
};

/**
 * @param {string} plain
 * @returns {string} `v1:iv:tag:ciphertext`, all parts base64.
 */
export function encrypt(plain) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * @param {string} value Stored column value.
 * @returns {string} Plaintext.
 * @throws If the value is malformed, from another key, or tampered with.
 */
export function decrypt(value) {
  const parts = String(value ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unsupported ciphertext format');
  }

  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
