import { createApp } from './app.js'
import { dataSource, databaseFile } from './data-source.js'
import { seedIfEmpty } from './seed.js'

// `initialize()` connects, loads the entity metadata and — because
// `synchronize: true` — brings the schema in line with the entities. It must
// finish before the first request, so it is awaited at module top level.
await dataSource.initialize()
const seeded = await seedIfEmpty()

const app = createApp()
const port = Number(process.env.PORT ?? 3022)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`orm-typeorm listening on http://localhost:${port}`)
  console.log(`  database: ${databaseFile}`)
  console.log(`  seed:     ${seeded.seeded ? 'inserted fixtures' : `already had ${seeded.users} users`}`)
})

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    // destroy() closes the pool. Skipping it leaves the SQLite WAL files behind
    // and, on a real database, connections open until the server times them out.
    await dataSource.destroy()
    process.exit(0)
  })
  server.closeIdleConnections?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
