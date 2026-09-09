import { createApp } from './app.js'
import { client, ensureIndexes, ping, connectionHelp } from './db.js'

const port = Number(process.env.PORT ?? 3013)
const state = { dbReady: false }
const app = createApp(state)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`db-mongodb listening on http://localhost:${port}`)
})

/**
 * Connect at boot, but do NOT make the whole process depend on it.
 *
 * Exiting when Mongo is down turns a dependency outage into a total outage: the
 * port stops answering, so every request — including the ones that never touch
 * the database — fails at the socket instead of returning a diagnosable 503, and
 * nothing is left to health-check. The server stays up and every route answers
 * 503 with the `docker run` line (see the error handler in app.js).
 *
 * Set REQUIRE_DB=1 for the opposite policy — refuse to start without a database,
 * which is what you want from a container that an orchestrator will restart.
 */
try {
  await client.connect()
  await ping()
  await ensureIndexes()
  state.dbReady = true
  console.log('[mongodb] connected, indexes ensured')
} catch (err) {
  console.error(connectionHelp(err))
  if (process.env.REQUIRE_DB === '1') {
    console.error('  REQUIRE_DB=1 — refusing to start without a database.\n')
    server.close()
    await client.close().catch(() => {})
    process.exit(1)
  }
  // The driver closes its topology after a failed initial connect, so this
  // process will not pick Mongo up on its own — start Mongo, then restart this.
  console.error('  Staying up in degraded mode: every route answers 503.')
  console.error('  Start MongoDB and restart this process to leave degraded mode.\n')
}

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    await client.close().catch(() => {})
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
