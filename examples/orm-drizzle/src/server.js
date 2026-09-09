import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createApp } from './app.js'
import { db, close, databaseFile, migrationsFolder } from './db.js'
import { seedIfEmpty } from './seed.js'

// Migrate at boot so the example runs from a clean checkout with nothing but
// `npm start`. In a real deployment migrations run as a separate step before the
// new version starts — two processes racing to apply the same migration is a
// genuine outage, not a theoretical one.
migrate(db, { migrationsFolder })
const seeded = seedIfEmpty()

const app = createApp()
const port = Number(process.env.PORT ?? 3021)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`orm-drizzle listening on http://localhost:${port}`)
  console.log(`  database: ${databaseFile}`)
  console.log(`  seed:     ${seeded.seeded ? 'inserted fixtures' : `already had ${seeded.users} users`}`)
})

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(() => {
    close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
