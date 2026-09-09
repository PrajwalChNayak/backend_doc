import { createApp } from './app.js'
import { redis, subscriber, ping, connectionHelp, closeQuietly } from './redis.js'

const port = Number(process.env.PORT ?? 3014)
const state = { redisReady: false }
const app = createApp(state)

const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`db-redis listening on http://localhost:${port}`)
})

/** A second connection, because a subscribed client cannot run other commands. */
let sub = null

try {
  await redis.connect()
  await ping()

  sub = subscriber()
  sub.on('error', (err) => console.error('[redis:sub] error:', err.message))
  await sub.connect()
  await sub.subscribe('example:events', (message, channel) => {
    console.log(`[redis:sub] ${channel}: ${message}`)
  })

  state.redisReady = true
  console.log('[redis] connected; subscriber listening on "example:events"')
} catch (err) {
  console.error(connectionHelp(err))
  if (process.env.DEGRADED_OK === '1') {
    console.error('  DEGRADED_OK=1 — staying up; /health will report "degraded".\n')
  } else {
    server.close()
    await closeQuietly(redis)
    await closeQuietly(sub)
    process.exit(1)
  }
}

function shutdown(signal) {
  console.log(`\n${signal} received, closing`)
  server.close(async () => {
    // quit() finishes in-flight commands; destroy() would drop them.
    await closeQuietly(redis)
    await closeQuietly(sub)
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
