/**
 * The schema layer: migrations are applied once, recorded, and never re-run.
 *
 * Two rules from the project's constraints are checked here rather than in a
 * review: a migration file is numbered and an applied one is never edited. The
 * second cannot be proven from inside the process, but its consequence can be:
 * opening the database again must apply nothing and must not change the schema
 * version.
 */
import './setup.js';
import { openTestDatabase } from './setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { closeDatabase, getDb, openDatabase, pingDatabase } from '../src/db/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

await openTestDatabase();

const version = () =>
  getDb().prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;

const tables = () =>
  getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);

const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));

test('every migration file is numbered, and the numbers are unique and gapless', () => {
  const versions = files.map((name) => {
    assert.match(name, /^\d{3}_[a-z0-9_]+\.sql$/, name);
    return Number.parseInt(name.slice(0, name.indexOf('_')), 10);
  });
  const sorted = [...versions].sort((a, b) => a - b);

  assert.equal(new Set(versions).size, versions.length, 'two migrations with the same number');
  assert.deepEqual(sorted, Array.from({ length: versions.length }, (_, index) => index + 1));
  // Lexical order (how they are read) has to match numeric order (how they
  // build on each other), which is what the zero padding is for.
  assert.deepEqual([...files].sort(), files.map((name) => name).sort());
});

test('opening the database applies every migration', () => {
  assert.equal(version(), files.length);
});

test('the tables the rest of the app talks to exist', () => {
  const present = tables();

  for (const name of [
    'schema_migrations',
    'moderation_queue',
    'chat_history',
    'guild_settings',
    'usage_daily',
    'violations',
  ]) {
    assert.ok(present.includes(name), `missing table: ${name}`);
  }
});

test('the queue carries metadata only: no column may hold message content', () => {
  const columns = getDb()
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('moderation_queue')
    .map((row) => row.name);

  assert.deepEqual(columns.sort(), [
    'attempts',
    'categories',
    'channel_id',
    'due_at',
    'guild_id',
    'message_id',
    'scold_message_id',
    'user_id',
    'warned_at',
  ]);
});

test('reopening applies nothing: an applied migration is never re-run', () => {
  const before = version();
  const schemaBefore = tables();

  closeDatabase();
  openDatabase();

  assert.equal(version(), before);
  assert.deepEqual(tables(), schemaBefore);
});

test('the ping is the probe /healthz relies on', () => {
  assert.equal(pingDatabase(), true);

  closeDatabase();
  assert.equal(pingDatabase(), false, 'a closed database is not reachable');

  openDatabase();
  assert.equal(pingDatabase(), true);
});

test('using the database before it is open is an error, not a silent no-op', () => {
  closeDatabase();
  assert.throws(() => getDb(), /not open/);
  openDatabase();
});

test('closing twice is harmless', () => {
  closeDatabase();
  assert.doesNotThrow(() => closeDatabase());
  openDatabase();
});

test('a migration only ever adds to the schema', () => {
  // ALTER TABLE ... DROP COLUMN or a DROP TABLE on a live table would take data
  // with it on deploy, and there is no down-migration to put it back.
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');

    assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/i, name);
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+tmp)/i, name);
  }
});
