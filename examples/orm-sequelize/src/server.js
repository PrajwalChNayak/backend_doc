import { createApp } from './app.js'
import { sequelize, initSchema, close, databaseFile } from './db.js'
import { seedIfEmpty } from './seed.js'

// `authenticate()` opens a connection and runs a trivial query. Doing it before
// `listen()` means a bad configuration fails at boot instead of on the first
// request that reaches a user.
await sequelize.authenticate()
await initSchema()
const seeded = await seedIfEmpty()

const app = createApp()
const port = Number(process.env.PORT ?? 3023)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`orm-sequelize listening on http://localhost:${port}`)
  console.log(`  database: ${databaseFile}`)
  console.log(`  seed:     ${seeded.seeded ? 'inserted fixtures' : `already had ${seeded.users} users`}`)
})

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    await close()
    process.exit(0)
  })
  server.closeIdleConnections?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
