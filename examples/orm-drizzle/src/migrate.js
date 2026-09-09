/**
 * Applies every generated migration in ../drizzle, then exits.
 *
 *   npm run setup
 *
 * The split is deliberate and worth keeping in your own projects:
 *   `drizzle-kit generate`  diffs the schema and WRITES SQL (developer machine)
 *   `migrate()`             APPLIES that SQL (developer machine, CI, and prod)
 *
 * `drizzle-kit push` skips the file and mutates the database directly. It is fine
 * for a scratch database and wrong for anything you have to roll back or review.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db, close, databaseFile, migrationsFolder } from './db.js'

migrate(db, { migrationsFolder })

console.log(`orm-drizzle: migrations applied to ${databaseFile}`)
close()
