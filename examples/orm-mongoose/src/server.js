import { createApp } from './app.js'
import { connect, close, ping, connectionHelp, supportsTransactions, MONGODB_URL, DB_NAME } from './db.js'
import { seedIfEmpty } from './seed.js'

const port = Number(process.env.PORT ?? 3024)
const state = { dbReady: false }
const app = createApp(state)

// Listen first, then connect. The server can answer /health with 503 while the
// database is still coming up, which is what a readiness probe wants — a process
// that refuses connections looks dead rather than "not ready yet".
const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`orm-mongoose listening on http://localhost:${port}`)
})

try {
  await connect()
  await ping()
  state.dbReady = true
  const seeded = await seedIfEmpty()
  console.log(`[mongoose] connected to ${MONGODB_URL}/${DB_NAME}`)
  console.log(`  seed:         ${seeded.seeded ? 'inserted fixtures' : `already had ${seeded.users} users`}`)
  console.log(`  transactions: ${(await supportsTransactions()) ? 'available (replica set)' : 'unavailable (standalone server)'}`)
} catch (err) {
  // A stack trace here would tell the reader nothing they can act on. Print the
  // two commands that fix it instead.
  console.error(connectionHelp(err))
  if (process.env.DEGRADED_OK === '1') {
    console.error('  DEGRADED_OK=1 — staying up; /health reports "degraded" and every route answers 503.\n')
  } else {
    server.close()
    await close().catch(() => {})
    process.exit(1)
  }
}

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    await close().catch(() => {})
    process.exit(0)
  })
  server.closeIdleConnections?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
