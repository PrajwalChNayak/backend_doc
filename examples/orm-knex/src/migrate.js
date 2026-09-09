/**
 * Applies every migration that has not run yet, then exits.
 *
 *   npm run migrate
 *
 * This is the same operation as `npx knex migrate:latest`; calling the API
 * directly keeps the script a plain `node` invocation, which works identically
 * on Windows and POSIX and does not depend on the CLI resolving an ESM
 * knexfile. Use whichever you prefer — the README shows the CLI form too.
 */
import { close, databaseFile, migrateToLatest } from './db.js'

const { batch, applied } = await migrateToLatest()

if (applied.length === 0) {
  console.log(`orm-knex: already up to date (${databaseFile})`)
} else {
  console.log(`orm-knex: batch ${batch} applied ${applied.length} migration(s): ${applied.join(', ')}`)
}

await close()
