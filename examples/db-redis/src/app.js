import { randomUUID } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { redis, ping } from './redis.js'
import { findUser, updateUserName, stats, SLOW_MS_VALUE } from './slow-store.js'

const TTL_SECONDS = Number(process.env.CACHE_TTL ?? 30)
const KEY_PREFIX = 'example:user:'
const LOCK_PREFIX = 'example:lock:'

const IdParam = z.coerce.number().int().positive()
const RenameBody = z.object({ name: z.string().min(1).max(120) })
const LockBody = z.object({ ttl: z.coerce.number().int().min(1).max(300).default(30) })
const ScanQuery = z.object({
  match: z.string().max(120).default(`${KEY_PREFIX}*`),
  count: z.coerce.number().int().min(1).max(1000).default(100),
})

const userKey = (id) => `${KEY_PREFIX}${id}`

export function createApp(state) {
  const app = express()
  app.use(express.json())

  app.get('/health', async (_req, res) => {
    if (!state.redisReady) {
      return res.status(503).json({ status: 'degraded', redis: 'unreachable' })
    }
    try {
      const start = performance.now()
      await ping()
      res.json({ status: 'ok', redis: 'up', latencyMs: Math.round(performance.now() - start) })
    } catch (err) {
      res.status(503).json({ status: 'degraded', redis: 'unreachable', error: err.message })
    }
  })

  /**
   * CACHE-ASIDE (lazy loading).
   *
   *   1. read the cache
   *   2. on a miss, read the source of truth
   *   3. write the value back with a TTL
   *
   * The TTL is the important part. It is not a performance knob — it is the
   * bound on how stale the data can be, and the thing that stops a key you
   * forgot to invalidate from being wrong forever.
   *
   * Redis being down must not take the endpoint down: every cache call here is
   * wrapped so a Redis failure degrades to "always a miss".
   */
  app.get('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const key = userKey(id)
    const start = performance.now()

    let cached = null
    try {
      cached = await redis.get(key)
    } catch (err) {
      console.error('[cache] read failed, falling through to the store:', err.message)
    }

    if (cached) {
      return res.json({
        source: 'cache',
        ttl: await redis.ttl(key).catch(() => null),
        tookMs: Math.round(performance.now() - start),
        user: JSON.parse(cached),
      })
    }

    const user = await findUser(id)
    if (!user) return res.status(404).json({ error: 'user not found' })

    try {
      // Current node-redis option shape. The flat `{ EX: n }` form still works
      // but is deprecated in v6 in favour of the explicit `expiration` object.
      await redis.set(key, JSON.stringify(user), {
        expiration: { type: 'EX', value: TTL_SECONDS },
      })
    } catch (err) {
      console.error('[cache] write failed:', err.message)
    }

    res.json({
      source: 'store',
      ttl: TTL_SECONDS,
      tookMs: Math.round(performance.now() - start),
      user,
    })
  })

  /**
   * Write-through invalidation: change the source of truth, then DELETE the key.
   *
   * Delete, do not update. Writing the new value into the cache from here races
   * with any concurrent reader that is mid-repopulate and can leave the cache
   * holding an older value than the database. Deleting is idempotent and always
   * converges.
   */
  app.patch('/users/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id)
    const { name } = RenameBody.parse(req.body)

    const user = await updateUserName(id, name)
    if (!user) return res.status(404).json({ error: 'user not found' })

    const deleted = await redis.del(userKey(id)).catch(() => 0)
    res.json({ user, invalidatedKeys: deleted })
  })

  /**
   * SET key value NX EX ttl — the one-command distributed lock.
   *
   * NX makes the write conditional on the key not existing, so exactly one
   * caller wins; EX guarantees the lock evaporates if that caller crashes before
   * releasing it. Doing this as EXISTS-then-SET is a race with a hole in the
   * middle, and SETNX without an expiry deadlocks forever on a crash.
   *
   * The value is a random token so a holder can only release ITS OWN lock —
   * see DELETE below.
   */
  app.post('/locks/:name', async (req, res) => {
    const name = z.string().min(1).max(64).regex(/^[\w.:-]+$/).parse(req.params.name)
    const { ttl } = LockBody.parse(req.body ?? {})
    const token = randomUUID()

    const result = await redis.set(`${LOCK_PREFIX}${name}`, token, {
      expiration: { type: 'EX', value: ttl },
      condition: 'NX',
    })

    // SET with NX returns null when the key already existed.
    if (result === null) {
      const remaining = await redis.ttl(`${LOCK_PREFIX}${name}`)
      return res.status(409).json({ acquired: false, expiresInSeconds: remaining })
    }

    res.status(201).json({ acquired: true, token, expiresInSeconds: ttl })
  })

  /**
   * Releasing a lock safely needs a compare-and-delete, which is two operations
   * and therefore a race — unless it runs as one script on the server.
   * This Lua is a constant; the key and the token are passed as KEYS/ARGV, never
   * concatenated into the script text.
   */
  const RELEASE_LOCK_LUA = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `

  app.delete('/locks/:name', async (req, res) => {
    const name = z.string().min(1).max(64).regex(/^[\w.:-]+$/).parse(req.params.name)
    const token = z.string().min(1).max(200).parse(req.get('x-lock-token') ?? '')

    const released = await redis.eval(RELEASE_LOCK_LUA, {
      keys: [`${LOCK_PREFIX}${name}`],
      arguments: [token],
    })

    if (released === 0) {
      return res.status(409).json({ released: false, reason: 'not held, or held by someone else' })
    }
    res.json({ released: true })
  })

  /**
   * SCAN, never KEYS.
   *
   * KEYS walks the entire keyspace in one blocking pass. Redis is single
   * threaded, so on a few million keys that is hundreds of milliseconds during
   * which every other client waits. SCAN is a cursor: it returns a page, you
   * come back for more, and the server interleaves other work in between.
   *
   * The trade-off is SCAN's weaker guarantee — a key present for the whole
   * iteration is returned at least once, but keys added or removed during the
   * scan may or may not appear, and duplicates are possible. Deduplicate if it
   * matters.
   */
  app.get('/cache/keys', async (req, res) => {
    const { match, count } = ScanQuery.parse(req.query)
    const keys = new Set()
    let pages = 0

    // scanIterator yields ONE ARRAY OF KEYS PER PAGE in node-redis v5+.
    for await (const page of redis.scanIterator({ MATCH: match, COUNT: count })) {
      pages += 1
      for (const key of page) keys.add(key)
      if (keys.size >= 1000) break // bound the response
    }

    res.json({ match, pages, count: keys.size, keys: [...keys] })
  })

  app.delete('/cache/keys', async (req, res) => {
    const { match, count } = ScanQuery.parse(req.query)
    let deleted = 0
    for await (const page of redis.scanIterator({ MATCH: match, COUNT: count })) {
      if (page.length > 0) deleted += await redis.del(page)
    }
    res.json({ match, deleted })
  })

  app.get('/stats', (_req, res) => {
    res.json({
      backingStoreReads: stats.reads,
      simulatedStoreLatencyMs: SLOW_MS_VALUE,
      cacheTtlSeconds: TTL_SECONDS,
    })
  })

  app.use('/{*splat}', (_req, res) => res.status(404).json({ error: 'not found' }))

  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', issues: err.issues })
    }
    if (err.name === 'ClientClosedError' || err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'redis unreachable' })
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
