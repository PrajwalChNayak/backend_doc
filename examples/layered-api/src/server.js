/**
 * src/server.js — process lifecycle: boot the database, listen, and shut down
 * without dropping requests.
 *
 * The shutdown sequence, in order, and why each step is there:
 *
 *   1. flip readiness to false      the balancer stops routing new work here
 *   2. server.close()               stop accepting NEW connections; the callback
 *                                   fires once every in-flight request finished
 *   3. closeIdleConnections()       Node 18.2+. Keep-alive sockets sitting idle
 *                                   would otherwise hold the server open for the
 *                                   full keep-alive timeout. Without this,
 *                                   server.close() looks like it hangs.
 *   4. wait, with a deadline        a request stuck on a slow query must not
 *                                   block the deploy forever
 *   5. close the database           flush WAL, release the file handle
 *   6. exit                         0 if we drained cleanly, 1 if we timed out
 */
import { createApp } from './app.js'
import config from './config.js'
import logger from './logger.js'
import { initDatabase, closeDatabase } from './db/index.js'
import { beginShutdown } from './readiness.js'

await initDatabase()

const app = createApp()

// Express 5: `app.listen()` hands a server 'error' to the callback rather than
// throwing it. Ignore the argument and EADDRINUSE becomes a silent hang.
const server = app.listen(config.port, (err) => {
  if (err) {
    logger.error({ err, port: config.port }, 'failed to bind port')
    process.exit(1)
  }
  logger.info({ port: config.port, env: config.nodeEnv }, 'layered-api listening')
})

// Slowloris defence: a client that opens a connection and dribbles headers holds
// a socket forever without these.
server.headersTimeout = 20_000
server.requestTimeout = 30_000
server.keepAliveTimeout = 15_000

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutdown requested')

  // 1. Readiness off first, and give the balancer a moment to notice before we
  //    start refusing connections. In Kubernetes this is what the
  //    preStop hook / terminationGracePeriod is really for.
  beginShutdown()

  const drained = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(
        { deadlineMs: config.shutdown.drainDeadlineMs },
        'drain deadline exceeded, forcing exit',
      )
      resolve(false)
    }, config.shutdown.drainDeadlineMs)
    timer.unref()

    // 2. Stop accepting new connections; callback fires when the last in-flight
    //    request has finished.
    server.close(() => {
      clearTimeout(timer)
      resolve(true)
    })

    // 3. Release idle keep-alive sockets so step 2 can actually complete.
    server.closeIdleConnections?.()
  })

  // 5. Only now is it safe to drop the database — an in-flight request may still
  //    have been querying it a moment ago.
  closeDatabase()

  logger.info({ drained }, 'shutdown complete')
  process.exit(drained ? 0 : 1)
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal)
  })
}

// A rejection nobody handled means the process is in an unknown state. Log it
// and go through the same orderly shutdown rather than staying up and lying.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection')
  shutdown('unhandledRejection')
})

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception')
  shutdown('uncaughtException')
})

export { server }
