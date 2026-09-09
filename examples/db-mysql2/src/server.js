import { createApp } from './app.js'
import { pool, ping, connectionHelp } from './db.js'
import { migrate } from './migrate.js'

const port = Number(process.env.PORT ?? 3012)
const state = { dbReady: false }
const app = createApp(state)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`db-mysql2 listening on http://localhost:${port}`)
})

try {
  await ping()
  await migrate()
  state.dbReady = true
  console.log('[mysql] connected and migrated')
} catch (err) {
  console.error(connectionHelp(err))
  if (process.env.DEGRADED_OK === '1') {
    console.error('  DEGRADED_OK=1 — staying up; /health will report "degraded".\n')
  } else {
    server.close()
    await pool.end().catch(() => {})
    process.exit(1)
  }
}

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    await pool.end().catch(() => {})
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
