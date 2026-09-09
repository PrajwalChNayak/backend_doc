/**
 * drizzle-kit reads this to diff src/schema.js against the migration history and
 * write a new .sql file into drizzle/. It never touches the database on its own:
 * `drizzle-kit generate` only writes SQL, and src/migrate.js is what applies it.
 *
 * The config is plain JavaScript. drizzle-kit accepts .ts as well, but a .js
 * config keeps this example free of any build or type-stripping step.
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.js',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_FILE ?? './data/app.db' },
})
