/**
 * One Knex instance for the process.
 *
 * `knex(config)` creates a connection pool. Creating one per request leaks
 * pools, and creating one per module means several pools fighting over the same
 * SQLite file — so it is created exactly once, here, and imported everywhere.
 */
import knexFactory from 'knex'
import config, { databaseFile } from '../knexfile.js'

export const knex = knexFactory(config)
export { databaseFile }

/** Applies any migration that has not run yet. Idempotent. */
export async function migrateToLatest() {
  const [batch, applied] = await knex.migrate.latest()
  return { batch, applied }
}

export async function close() {
  await knex.destroy()
}

/**
 * Columns a client may sort by. Knex quotes identifiers it is *given*, but
 * `orderBy('name; DROP TABLE users')` still puts that string in the statement —
 * quoting is not validation. The Set is the control.
 */
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])
