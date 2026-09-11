/**
 * One place that describes the database, shared by the Nest module and the seed
 * script so they cannot disagree.
 *
 * SQLite on purpose: the example must run unattended with no server. Point
 * `type`/`host`/`username` at Postgres and nothing above this file changes —
 * that is the whole argument for an ORM.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DataSourceOptions } from 'typeorm'
import { User } from './users/user.entity.js'
import { Post } from './posts/post.entity.js'

const projectRoot = join(__dirname, '..')

export const databaseFile =
  process.env.DATABASE_FILE ?? join(projectRoot, 'data', 'nest-typeorm.sqlite')

mkdirSync(dirname(databaseFile), { recursive: true })

export const dataSourceOptions: DataSourceOptions = {
  // TypeORM 1.x dropped the callback-based `sqlite` (node-sqlite3) driver.
  // The SQLite drivers it ships now are `better-sqlite3` and `sqljs`.
  type: 'better-sqlite3',
  database: databaseFile,
  entities: [User, Post],

  // Fine for a teaching example and for a throwaway dev database. In production
  // you generate migrations and run `migration:run` — `synchronize` will happily
  // drop a column to make the schema match the classes.
  synchronize: true,

  logging: process.env.TYPEORM_LOG === 'query' ? ['query', 'error'] : ['error'],

  // Foreign keys are OFF per connection in SQLite. Without this the
  // `onDelete: 'CASCADE'` on Post.author is decorative.
  prepareDatabase: (db: { pragma: (statement: string) => unknown }) => {
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
  },
}
