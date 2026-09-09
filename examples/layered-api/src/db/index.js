/**
 * The database handle.
 *
 * Primary driver is `better-sqlite3`. If its native binary is unavailable on the
 * host, this falls back to `node:sqlite`, which ships with Node 24 and needs no
 * build at all. Both expose `prepare().get()/.all()/.run()` and `exec()`, so the
 * repositories above cannot tell the difference — which is the point of having a
 * repository layer.
 *
 * Every statement in `src/repositories/` is parameterised with `?` placeholders,
 * the syntax both drivers accept.
 */
import fs from 'node:fs'
import path from 'node:path'
import config from '../config.js'
import logger from '../logger.js'

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS notes_user_id_created_at
    ON notes (user_id, created_at DESC);
`

async function openDriver(file) {
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(file)
    return { db, driver: 'better-sqlite3' }
  } catch (err) {
    logger.warn(
      { err: { message: err.message } },
      'better-sqlite3 unavailable, falling back to the built-in node:sqlite driver',
    )
    const { DatabaseSync } = await import('node:sqlite')
    return { db: new DatabaseSync(file), driver: 'node:sqlite' }
  }
}

let handle = null

export async function initDatabase(file = config.databaseFile) {
  if (handle) return handle

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const { db, driver } = await openDriver(file)
  db.exec(SCHEMA)

  handle = { db, driver, file }
  logger.info({ driver, file }, 'database ready')
  return handle
}

export function getDb() {
  if (!handle) throw new Error('initDatabase() must be awaited before getDb()')
  return handle.db
}

export function getDriverName() {
  return handle?.driver ?? 'not-initialised'
}

/** Closes the handle and removes the temp file. Called by graceful shutdown. */
export function closeDatabase() {
  if (!handle) return
  const { db, file } = handle
  handle = null
  try {
    db.close()
  } catch (err) {
    logger.warn({ err: { message: err.message } }, 'error closing database')
  }
  // Only clean up files we created under the OS temp directory.
  if (file !== config.databaseFile) return
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(file + suffix, { force: true })
    } catch {
      /* best effort */
    }
  }
}
