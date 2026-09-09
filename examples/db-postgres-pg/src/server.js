import { createApp } from './app.js'
import { pool, ping, connectionHelp } from './db.js'
import { migrate } from './migrate.js'

const port = Number(process.env.PORT ?? 3011)

/**
 * Shared with the app so /health can answer honestly before (or after) the
 * database probe finishes.
 */
const state = { dbReady: false }

const app = createApp(state)

// Bind the port first. The health endpoint then always answers — 503 while the
// database is unreachable, 200 once it is up — instead of the process hanging
// on a connection attempt with nothing listening.
const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`db-postgres-pg listening on http://localhost:${port}`)
})

try {
  await ping()
  await migrate()
  state.dbReady = true
  console.log('[pg] connected and migrated')
} catch (err) {
  console.error(connectionHelp(err))

  // Default: fail fast, because a booted API that cannot serve a single request
  // is worse than a process that exits with an explanation. Set DEGRADED_OK=1 to
  // keep serving (health returns 503) — useful when a supervisor restarts you.
  if (process.env.DEGRADED_OK === '1') {
    console.error('  DEGRADED_OK=1 — staying up; /health will report "degraded".\n')
  } else {
    server.close()
    await pool.end().catch(() => {})
    process.exit(1)
  }
}

async function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    // Drain the pool so in-flight queries finish before the process exits.
    await pool.end().catch(() => {})
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
