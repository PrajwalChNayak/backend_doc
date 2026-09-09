import { createClient } from 'redis'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

const MAX_RECONNECTS = Number(process.env.REDIS_MAX_RECONNECTS ?? 5)

/**
 * A failed TCP connect arrives as an AggregateError whose own `message` is
 * empty; the useful text lives on `err.errors`. Logging `err.message` alone
 * produces the famously useless "[redis] client error:" with nothing after it.
 */
export function errorDetail(err) {
  return (
    err?.message ||
    (Array.isArray(err?.errors) ? err.errors.map((e) => e.message).join('; ') : '') ||
    String(err)
  )
}

/**
 * One client for ordinary commands, reused for the life of the process.
 *
 * node-redis pipelines everything over a single connection, so one client
 * handles high concurrency fine. You need a *second* connection only when the
 * first one cannot accept commands any more — see `subscriber()` below.
 */
export const redis = createClient({
  url: REDIS_URL,
  socket: {
    connectTimeout: 3_000,
    /**
     * Bounded reconnect. Returning a number means "retry in N ms"; returning an
     * Error stops retrying and rejects the pending connect. The default strategy
     * retries forever with backoff, which hides a permanently wrong REDIS_URL
     * behind an endless log spew.
     */
    reconnectStrategy(retries) {
      if (retries > MAX_RECONNECTS) {
        return new Error(`redis: giving up after ${MAX_RECONNECTS} reconnect attempts`)
      }
      return Math.min(50 * 2 ** retries, 2_000)
    },
  },
})

// A client that has lost its socket emits 'error'. Without a listener the event
// is unhandled and takes the process down. Collapse repeats so a reconnect storm
// is one line, not one line per attempt.
let lastClientError = null
redis.on('error', (err) => {
  const detail = errorDetail(err)
  if (detail === lastClientError) return
  lastClientError = detail
  console.error('[redis] client error:', detail)
})
redis.on('ready', () => {
  lastClientError = null
})

/**
 * Pub/sub needs its OWN connection.
 *
 * Once a connection issues SUBSCRIBE it enters subscriber mode and Redis will
 * only accept (P)SUBSCRIBE / (P)UNSUBSCRIBE / PING / QUIT on it — a GET on that
 * same connection is an error. node-redis enforces this for you: calling
 * `.subscribe()` on a client you also use for commands throws. `duplicate()`
 * clones the configuration onto a fresh socket, which is what you want.
 *
 * The same rule applies to blocking commands (BLPOP, BRPOP, XREAD BLOCK): they
 * occupy the connection for their whole timeout, so give them their own.
 */
export function subscriber() {
  return redis.duplicate()
}

export async function ping() {
  return (await redis.ping()) === 'PONG'
}

/** Close a client without caring whether it ever opened. */
export async function closeQuietly(client) {
  if (!client) return
  try {
    if (client.isOpen) await client.quit()
    else client.destroy?.()
  } catch {
    // Already closed, or never connected. Nothing to do.
  }
}

export function connectionHelp(err) {
  return [
    '',
    '  Cannot reach Redis.',
    '',
    `    REDIS_URL : ${REDIS_URL}`,
    `    error     : ${err?.code ? `${err.code} — ` : ''}${errorDetail(err)}`,
    '',
    '  Start one with Docker:',
    '',
    '    docker run --rm -p 6379:6379 redis:8',
    '',
    '  Then re-run, optionally pointing somewhere else:',
    '',
    '    REDIS_URL=redis://localhost:6379 npm start',
    '',
  ].join('\n')
}
