import { createApp } from './app.js'
import { knex, close, databaseFile, migrateToLatest } from './db.js'
import { seedIfEmpty } from './seed.js'

// Migrate then seed at boot so a clean checkout runs with `npm start` alone.
// In production these are a separate step: two instances starting at once would
// otherwise race to apply the same migration.
const { batch, applied } = await migrateToLatest()
const seeded = await seedIfEmpty()

const app = createApp()
const port = Number(process.env.PORT ?? 3025)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`orm-knex listening on http://localhost:${port}`)
  console.log(`  database:   ${databaseFile}`)
  console.log(`  migrations: batch ${batch}, ${applied.length} applied this run`)
  console.log(`  seed:       ${seeded.seeded ? 'inserted fixtures' : `already had ${seeded.users} users`}`)
})

async function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    // Destroying the pool is not optional: an open better-sqlite3 handle keeps
    // the WAL files around and the process alive.
    await close()
    process.exit(0)
  })
  server.closeIdleConnections?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

export { knex }
