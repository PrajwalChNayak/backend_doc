/**
 * knexfile.js — read by the `knex` CLI (`knex migrate:latest`, `knex seed:run`)
 * and imported by src/db.js so the server and the CLI can never disagree.
 *
 * Knex is a query builder, not an ORM: there are no models and no identity map.
 * What it gives you is a driver-independent way to build parameterised SQL, plus
 * migrations and seeds.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR ?? join(here, 'data')
mkdirSync(dataDir, { recursive: true })

export const databaseFile = process.env.DATABASE_FILE ?? join(dataDir, 'app.db')

const config = {
  // `better-sqlite3` is a first-class Knex client and ships prebuilt binaries,
  // so it needs no C++ toolchain. The older `sqlite3` client also works; it is
  // asynchronous and slower for the small queries an API actually makes.
  client: 'better-sqlite3',
  connection: { filename: databaseFile },
  // SQLite writes are serialised by the file lock, so a pool larger than one
  // just moves the contention. `useNullAsDefault` silences Knex's warning that
  // SQLite has no DEFAULT keyword for omitted insert columns.
  useNullAsDefault: true,
  pool: {
    min: 1,
    max: 1,
    // Foreign keys are per-connection in SQLite and off by default. This is the
    // only hook that runs on a freshly opened connection, so it is where the
    // pragma belongs.
    afterCreate(connection, done) {
      connection.pragma('foreign_keys = ON')
      connection.pragma('journal_mode = WAL')
      connection.pragma('busy_timeout = 5000')
      done(null, connection)
    },
  },
  migrations: { directory: join(here, 'migrations'), extension: 'js' },
  seeds: { directory: join(here, 'seeds') },
}

export default config
