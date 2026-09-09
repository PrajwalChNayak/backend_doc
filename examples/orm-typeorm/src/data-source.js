/**
 * One DataSource for the process.
 *
 * A `DataSource` is TypeORM's connection pool plus its metadata registry. It is
 * created here, initialised once in server.js, and imported everywhere else —
 * calling `initialize()` twice throws, and building a second DataSource over the
 * same SQLite file gives you two writers fighting for one lock.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataSource } from 'typeorm'
import { User, Post } from './entities.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR ?? join(here, '..', 'data')
mkdirSync(dataDir, { recursive: true })

export const databaseFile = process.env.DATABASE_FILE ?? join(dataDir, 'app.db')

export const dataSource = new DataSource({
  // TypeORM 1.x dropped the callback-based `sqlite` (node-sqlite3) driver. The
  // SQLite drivers it ships now are `better-sqlite3` and `sqljs`.
  type: 'better-sqlite3',
  database: databaseFile,
  entities: [User, Post],

  // `synchronize` diffs the entities against the live schema and ALTERs to
  // match. It is a development convenience: it will happily drop a column it
  // does not recognise, so it must never be true against a database you care
  // about. The production path is `migrations` + `migrationsRun`.
  synchronize: true,

  // Set to true (or ['query', 'error']) to see every statement TypeORM builds.
  logging: false,

  // better-sqlite3 pragmas. Foreign keys are off per connection in SQLite, so
  // `onDelete: 'CASCADE'` in the entity is inert without this.
  prepareDatabase: (db) => {
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
  },
})

export const userRepository = () => dataSource.getRepository(User)
export const postRepository = () => dataSource.getRepository(Post)
