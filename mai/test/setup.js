/**
 * Test bootstrap. Import this **first** in every test file: `config.js` reads
 * and validates the environment at import time, so the variables have to exist
 * before any module under test is loaded.
 *
 * Chat and moderation are disabled here, which keeps the OpenAI key optional and
 * guarantees no test can reach the network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only guild the test bot is allowed to act in. */
export const TEST_GUILD = '111111111111111111';
export const OTHER_GUILD = '222222222222222222';
export const TEST_USER = '333333333333333333';

const set = (name, value) => {
  if (!process.env[name]) process.env[name] = value;
};

set('DISCORD_BOT_TOKEN', 'test-token');
set('DISCORD_PUBLIC_KEY', '0'.repeat(64));
set('DISCORD_GUILD_IDS', TEST_GUILD);
set('MODERATION_ENABLED', 'false');
set('CHAT_ENABLED', 'false');
set('LOG_LEVEL', 'silent');
set('DATABASE_PATH', join(mkdtempSync(join(tmpdir(), 'mai-test-')), 'test.sqlite'));
set('MAI_CONFIG_PATH', fileURLToPath(new URL('../config/mai.yaml', import.meta.url)));

/**
 * Opens the throwaway database and applies migrations.
 *
 * @returns {Promise<typeof import('../src/db/index.js')>}
 */
export async function openTestDatabase() {
  const db = await import('../src/db/index.js');
  db.openDatabase();
  return db;
}

/**
 * Replaces global fetch for the duration of a test.
 *
 * @param {(url: string, options: object) => Promise<Response> | Response} handler
 * @returns {() => void} Restores the original fetch.
 */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(String(url), options ?? {});
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Minimal interaction payload.
 *
 * @param {object} overrides
 */
export const interaction = (overrides = {}) => ({
  id: 'interaction-1',
  application_id: 'app-1',
  token: 'interaction-token',
  guild_id: TEST_GUILD,
  member: { user: { id: TEST_USER, username: 'tester' }, permissions: '0' },
  ...overrides,
});
