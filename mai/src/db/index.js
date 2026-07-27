/**
 * SQLite connection and schema migrations.
 *
 * One process, one writer, a few hundred rows: the builtin `node:sqlite`
 * module covers it with zero dependencies. All SQL in the app lives behind this
 * directory (`queue.js`, `history.js`, `settings.js`, `violations.js`,
 * `usage.js`); nothing outside it prepares a statement or imports `node:sqlite`,
 * so swapping the engine stays a one-layer change. A reader that wants a number
 * the repositories do not expose yet gets a function here, not its own query:
 * `/metrics` had a private copy of "overdue" that drifted from the enforcer's.
 *
 * The database file must sit on a writable volume: the container rootfs is
 * read-only and /tmp is a tmpfs that does not survive a restart.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** @type {DatabaseSync | null} */
let db = null;

/**
 * Opens the database, applies pending migrations and returns the handle.
 * Failures here are fatal by design: a broken queue must not run silently.
 *
 * @returns {DatabaseSync}
 */
export function openDatabase() {
  if (db) return db;

  mkdirSync(dirname(config.db.path), { recursive: true });
  db = new DatabaseSync(config.db.path);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const applied = migrate(db);
  logger.info(
    { path: config.db.path, migrationsApplied: applied.length, schemaVersion: currentVersion(db) },
    'Database ready',
  );

  return db;
}

/**
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (!db) throw new Error('Database is not open; call openDatabase() first');
  return db;
}

export function closeDatabase() {
  if (!db) return;
  try {
    db.close();
  } catch (error) {
    logger.warn({ err: error }, 'Closing database failed');
  }
  db = null;
}

/**
 * Cheap liveness probe for /healthz.
 *
 * @returns {boolean}
 */
export function pingDatabase() {
  try {
    return getDb().prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch (error) {
    logger.error({ err: error }, 'Database ping failed');
    return false;
  }
}

const currentVersion = (handle) =>
  handle.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;

/**
 * Applies every `NNN_name.sql` file in ./migrations that has not run yet, each
 * in its own transaction, newest schema version last.
 *
 * @param {DatabaseSync} handle
 * @returns {number[]} Versions applied in this call.
 */
function migrate(handle) {
  handle.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.slice(0, name.indexOf('_')), 10);
      if (!Number.isInteger(version)) {
        throw new Error(`Migration file must start with a numeric version: ${name}`);
      }
      return { name, version };
    });

  const version = currentVersion(handle);
  const pending = files.filter((file) => file.version > version);
  const applied = [];

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file.name), 'utf8');
    handle.exec('BEGIN');
    try {
      handle.exec(sql);
      handle
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(file.version, new Date().toISOString());
      handle.exec('COMMIT');
    } catch (error) {
      handle.exec('ROLLBACK');
      throw new Error(`Migration ${file.name} failed: ${error.message}`, { cause: error });
    }
    logger.info({ migration: file.name }, 'Applied migration');
    applied.push(file.version);
  }

  return applied;
}
