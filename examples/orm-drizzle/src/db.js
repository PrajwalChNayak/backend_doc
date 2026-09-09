/**
 * One better-sqlite3 handle, wrapped once by Drizzle, exported for the process.
 *
 * Drizzle is a thin layer: `drizzle(sqlite, …)` does not open a pool or start a
 * background task, it wraps the handle you give it. That means every pragma you
 * want has to be set on the underlying `better-sqlite3` connection, exactly as
 * you would without an ORM.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { schema } from './schema.js'

const here = dirname(fileURLToPath(import.meta.url))

export const dataDir = process.env.DATA_DIR ?? join(here, '..', 'data')
export const databaseFile = process.env.DATABASE_FILE ?? join(dataDir, 'app.db')
export const migrationsFolder = join(here, '..', 'drizzle')

mkdirSync(dataDir, { recursive: true })

export const sqlite = new Database(databaseFile)

// Foreign keys are off by default in SQLite, per connection. Without this the
// `references(...)` in schema.js is documentation, not enforcement.
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('busy_timeout = 5000')

// `schema` must be passed here or `db.query.*` (the relational API) is empty.
export const db = drizzle(sqlite, { schema })

export function close() {
  sqlite.close()
}
