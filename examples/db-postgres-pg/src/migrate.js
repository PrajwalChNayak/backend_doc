/**
 * The smallest honest migration: idempotent DDL, run at boot and by `npm run migrate`.
 * A real project uses a migration tool with ordered, versioned files — see
 * `examples/orm-knex/migrations` for that shape. This exists so the example can
 * create its own tables.
 */
import { pathToFileURL } from 'node:url'
import { pool, connectionHelp } from './db.js'

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
     id         BIGSERIAL PRIMARY KEY,
     email      TEXT        NOT NULL UNIQUE,
     name       TEXT        NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS posts (
     id         BIGSERIAL PRIMARY KEY,
     user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title      TEXT        NOT NULL,
     body       TEXT        NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS posts_user_id_idx ON posts (user_id)',
]

export async function migrate() {
  for (const statement of STATEMENTS) {
    await pool.query(statement)
  }
}

const runDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (runDirectly) {
  try {
    await migrate()
    console.log('migrated')
  } catch (err) {
    console.error(connectionHelp(err))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
