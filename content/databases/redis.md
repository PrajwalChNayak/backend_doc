---
title: Redis
description: Using node-redis 6.2.1 or ioredis 6.0.0 for caching, rate limiting and pub/sub, with TTLs, stampede protection, SCAN instead of KEYS, and an honest account of durability.
status: current
updated: 2026-09-08
---

Redis is an in-memory data-structure server. It is excellent as a cache, a counter store, a lock, a pub/sub bus and the backbone of a job queue. It is not a system of record, and the default configuration will lose recently acknowledged writes if the process dies.

This page covers the two Node clients, the cache-aside pattern with real TTLs and stampede protection, and the operational rules that keep Redis from becoming your outage.

## Which client

| | `redis` (node-redis) 6.2.1 | `ioredis` 6.0.0 |
| --- | --- | --- |
| Maintained by | Redis, officially | Community (widely used, very stable API) |
| API style | Promise-based, one method per command | Promise-based, variadic arguments mirroring the CLI |
| Cluster / Sentinel | Supported | Supported, long track record |
| Lua scripting | `SCRIPT LOAD` / `EVALSHA` | `defineCommand` creates a typed method |
| Ecosystem | `connect-redis` 10.0.0, `rate-limit-redis` 6.0.1 | BullMQ 6.3.4 requires it |

Pick **node-redis** for a new service with no constraint — it is the official client and the API is explicit.

Pick **ioredis** if you already run BullMQ (which depends on it), if you need its Sentinel/Cluster behavior, or if you prefer command arguments that read like `redis-cli`. Running both in one process is legal but pointless; standardize on one.

:::tabs
@tab npm
```bash
npm install redis@^6.2.1
```
@tab pnpm
```bash
pnpm add redis@^6.2.1
```
@tab yarn
```bash
yarn add redis@^6.2.1
```
:::

## Connecting

Full runnable version: [`examples/db-redis`](../../examples/db-redis/README.md) — cache-aside
with a real TTL, `SET … EX … NX`, `SCAN` instead of `KEYS`, and a separate connection for
pub/sub.

Redis clients are long-lived and multiplex commands over a single connection. There is no pool to size — create one client per process at startup.

```js title="src/redis.js"
import { createClient } from 'redis'

export const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 5_000,
    // Exponential backoff with a ceiling. Returning a number = retry after N ms.
    reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 5_000),
  },
})

// Without an 'error' listener, a connection error is an unhandled 'error' event
// on an EventEmitter, which terminates the process.
redis.on('error', (err) => logger.error({ err }, 'redis error'))

await redis.connect()
```

With `ioredis`:

```js title="src/redis.js"
import Redis from 'ioredis'

export const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 5_000,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
})

redis.on('error', (err) => logger.error({ err }, 'redis error'))
```

Two `ioredis` options deserve attention:

- **`enableOfflineQueue: false`.** By default, commands issued while disconnected are queued in memory and flushed on reconnect. For a cache that is wrong: you want a fast failure so the request falls through to the database, not a command that resolves 30 seconds later. The queue also grows without bound during an outage.
- **`maxRetriesPerRequest`.** Bound it so a request cannot hang across a long reconnect.

:::warning BullMQ is different
BullMQ requires `maxRetriesPerRequest: null` on its connection, because a blocking worker command must survive reconnects. Give BullMQ its own client with its own options rather than sharing your cache client.
:::

### Redis must be optional

The single most valuable design rule on this page: **your application must work when Redis is down**, slower but correct.

```js title="src/cache.js"
export async function cacheGet(key) {
  try {
    return await redis.get(key)
  } catch (err) {
    logger.warn({ err, key }, 'cache read failed, falling through')
    return null // treat an error exactly like a miss
  }
}
```

A cache read that throws and propagates turns a Redis blip into a full outage. A cache read that returns `null` on error turns it into elevated database load. Wrap every cache call.

This does not apply to Redis used as a rate-limit store or a lock, where failing open is a security decision — see below.

## SET with an expiry and a condition

The workhorse command. One round trip, atomic, and it covers both caching and locking.

```text
SET session:abc123 "<value>" EX 900 NX
```

- `EX 900` — expire in 900 seconds. `PX` for milliseconds.
- `NX` — only set if the key does **not** exist. `XX` — only if it does.

The combination is what makes it a lock primitive: `SET … NX` succeeds for exactly one caller.

```js title="node-redis"
const stored = await redis.set(`session:${sessionId}`, payload, { EX: 900, NX: true })
// stored === 'OK' when it was set, null when NX prevented it
```

```js title="ioredis"
const stored = await redis.set(`session:${sessionId}`, payload, 'EX', 900, 'NX')
```

:::best-practice Every key gets a TTL
A cache key without an expiry is a memory leak with a slow fuse. Set the TTL in the same command that writes the value — never `SET` then `EXPIRE`, because a crash between the two leaves an immortal key.

Audit it: `redis-cli --scan --pattern 'cache:*' | head -100` then `TTL` each one. A `-1` result means no expiry.
:::

## Cache-aside with stampede protection

The standard read path: look in the cache, fall through to the database on a miss, write the result back with a TTL.

```js title="src/users.cache.js"
import { pool } from './db.js'
import { redis } from './redis.js'

const TTL_SECONDS = 300
const LOCK_TTL_SECONDS = 10

export async function getUser(id) {
  const key = `user:${id}`

  const hit = await cacheGet(key)
  if (hit !== null) return JSON.parse(hit)

  // Stampede guard: only one caller is allowed to do the expensive work.
  const lockKey = `lock:${key}`
  const gotLock = await redis.set(lockKey, '1', { EX: LOCK_TTL_SECONDS, NX: true })

  if (!gotLock) {
    // Someone else is refilling. Wait briefly, then re-check once.
    await new Promise((r) => setTimeout(r, 50))
    const second = await cacheGet(key)
    if (second !== null) return JSON.parse(second)
    // Still cold — fall through and query. Slower, never wrong.
  }

  try {
    const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [id])
    const user = rows[0] ?? null
    if (user) {
      // Jitter the TTL so a batch of keys written together does not expire together.
      const ttl = TTL_SECONDS + Math.floor(Math.random() * 60)
      await redis.set(key, JSON.stringify(user), { EX: ttl })
    }
    return user
  } finally {
    if (gotLock) await redis.del(lockKey)
  }
}
```

Why each piece is there:

- **A real TTL.** Five minutes, not an hour, and not forever. The TTL is your correctness bound: it is the maximum time a stale value can be served after a write you failed to invalidate.
- **TTL jitter.** Without it, a thousand keys warmed during a deploy expire in the same second and a thousand requests hit the database simultaneously. Adding 0–60 random seconds spreads them.
- **The lock.** On a cold key under load, every concurrent request misses and every one queries the database. That is a *cache stampede*, and it is how a cache flush becomes a database outage. `SET NX` elects one refiller.
- **The lock has a TTL.** If the holder crashes, the lock expires. A lock without a TTL is a permanent outage.
- **Falling through is allowed.** The guard is an optimization, not a correctness mechanism. When it fails, you get the un-cached behavior, which is slow but right.

On invalidation: delete the key on write (`await redis.del(key)`), and rely on the TTL as the backstop for the deletes you miss. Do not try to build perfect invalidation — build a short TTL you can live with.

:::note Not a distributed lock
`SET NX` with a TTL is a *good-enough* guard for cache refills, where the worst case is duplicated work. It is not a correct distributed lock for mutual exclusion of side effects — clock skew, network partitions and process pauses can result in two holders. If two callers doing the thing would be a real problem, enforce it in the database with a transaction or a unique constraint. See [Transactions](transactions.md).
:::

## SCAN, never KEYS

`KEYS pattern` walks the entire keyspace and returns every match in one reply. Redis executes commands on a single thread, so for the whole duration of that walk **the server serves nothing else**.

On a database with 10 million keys, `KEYS *` blocks for seconds. Every client times out. Your health checks fail. Your orchestrator restarts the pods. This is a well-known way to take a production system down with one command.

`SCAN` is a cursor. It returns a small batch and a cursor to continue with, so other commands interleave.

```js title="src/cache-invalidate.js"
// node-redis exposes an async iterator over SCAN.
export async function deleteByPrefix(prefix) {
  let deleted = 0
  for await (const key of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 500 })) {
    await redis.unlink(key)
    deleted += 1
  }
  return deleted
}
```

```js title="ioredis"
export async function deleteByPrefix(prefix) {
  const stream = redis.scanStream({ match: `${prefix}:*`, count: 500 })
  for await (const keys of stream) {
    if (keys.length) await redis.unlink(...keys)
  }
}
```

Two more notes:

- **`UNLINK` rather than `DEL`** for bulk deletion. `DEL` frees memory synchronously; `UNLINK` hands it to a background thread. On large values the difference is a visible latency spike.
- **`SCAN` gives weak guarantees.** Keys present for the whole iteration are returned at least once; keys added or removed during it may or may not appear. That is the right trade for invalidation.

The same rule applies to `FLUSHALL`, `SMEMBERS` on a huge set, and `HGETALL` on a huge hash. Prefer the `SSCAN` / `HSCAN` variants.

## Pub/sub needs its own connection

A Redis connection in subscriber mode may only issue subscription commands. If you call `SUBSCRIBE` on the client you use for `GET` and `SET`, everything else on that connection fails.

Duplicate the client instead:

```js title="src/events.js"
import { redis } from './redis.js'

export async function subscribeToInvalidations(onKey) {
  const subscriber = redis.duplicate()
  subscriber.on('error', (err) => logger.error({ err }, 'subscriber error'))
  await subscriber.connect()

  await subscriber.subscribe('cache:invalidate', (message) => {
    onKey(message)
  })

  return async () => {
    await subscriber.unsubscribe('cache:invalidate')
    await subscriber.quit()
  }
}
```

`duplicate()` clones the configuration, giving you a second connection to the same server. `ioredis` has the same method.

:::warning Pub/sub is fire-and-forget
A message is delivered to whoever is subscribed *at that moment*. There is no persistence, no acknowledgement and no replay. A subscriber that is reconnecting misses everything sent in the gap, and it will not know.

That is acceptable for cache invalidation, where the TTL is the backstop. It is not acceptable for work that must happen. For that, use Redis Streams (`XADD` / `XREADGROUP`, which have consumer groups and acknowledgements) or a real queue such as BullMQ.
:::

You must also re-subscribe after a reconnect. Both clients can do this automatically, but verify it in a test that kills the connection — a silently unsubscribed listener is a process that looks healthy and does nothing.

## Redis as a rate-limit store

An in-memory rate limiter counts per process. With four replicas behind a load balancer, a limit of 100 requests per minute is actually 400. A shared Redis store fixes that.

```js title="src/rate-limit.js"
import rateLimit from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { redis } from './redis.js'

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
  }),
})
```

The counter increment must be atomic — that is why the store issues `INCR` plus `EXPIRE` (or a Lua script) rather than a read-modify-write from Node. A `GET`, add one, `SET` sequence loses increments under concurrency, and a rate limiter that undercounts is not a rate limiter.

**Decide the failure mode deliberately.** If Redis is unavailable, does the limiter allow the request (fail open) or reject it (fail closed)? Fail open keeps the site up and removes the protection; fail closed protects the backend and causes an outage. For abuse protection on a login endpoint, fail closed. For general API throttling, fail open and alert. This is the one place where the "treat cache errors as a miss" rule above does not apply automatically — see [Rate limiting](../express-libraries/rate-limiting.md) and [Rate limiting and abuse](../security/rate-limiting-and-abuse.md).

## Redis is not durable by default

Say it plainly: **Redis can lose acknowledged writes.**

| Mode | Default | What you lose on a hard failure |
| --- | --- | --- |
| RDB snapshots | On | Everything since the last snapshot — minutes |
| AOF (`appendonly`) | **Off** in Redis OSS | Nothing, if enabled |
| AOF with `appendfsync everysec` | The AOF default when enabled | Up to ~1 second of writes |
| AOF with `appendfsync always` | — | Nothing, at a large throughput cost |

A `SET` that returns `OK` has been applied in memory. It has not necessarily been written to disk, and in a replicated setup it has not necessarily reached a replica — Redis replication is asynchronous, so a failover can lose writes the primary had already acknowledged.

Then there is eviction. With `maxmemory` set and `maxmemory-policy allkeys-lru`, Redis **deletes your data** when it runs out of room. That is exactly right for a cache and catastrophic for anything else.

The practical rules:

- **Anything you cannot recompute belongs in a real database.** Redis holds derived state: cache entries, counters, sessions you can afford to end, queue jobs you have designed to be re-runnable.
- **Sessions are a judgment call.** Losing them logs everyone out. That is usually acceptable; know that you have accepted it. See [Cookies](../express-libraries/cookies.md).
- **Job queues need care.** BullMQ stores jobs in Redis, so Redis durability *is* your job durability. Enable AOF on the queue instance, and make jobs idempotent so a redelivery is harmless.
- **Use separate instances (or at least separate databases) for cache and queue**, because the eviction policy you want for each is opposite.

## Security considerations

**Never expose Redis to the internet.** Historically it shipped with no authentication and no encryption. Bind it to a private network or a Unix socket, and require a password with `requirepass` or a Redis 6+ ACL user. Unauthenticated Redis instances are scanned for and compromised within hours.

**Use ACLs, not a shared password.** Redis 6 introduced per-user ACLs. Give the application a user that can run the commands it needs on the key prefixes it owns, and nothing else.

```text
ACL SETUSER app on >REDACTED ~cache:* ~session:* +@read +@write -@dangerous
```

**Disable or rename the dangerous commands** on any instance an application can reach: `FLUSHALL`, `FLUSHDB`, `CONFIG`, `DEBUG`, `SHUTDOWN`, `KEYS`. The `-@dangerous` ACL category covers most of them.

**Namespace keys and validate the interpolated part.** A key built as `session:${req.params.id}` where the id is unvalidated lets a caller reach `session:*`-shaped keys they should not, and in a multi-tenant system it is a cross-tenant read. Validate the identifier, and include the tenant in the key.

```js
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw new BadRequest('bad session id')
const key = `t:${tenantId}:session:${sessionId}`
```

**Never store secrets in plain form.** Redis has no encryption at rest by default and `MONITOR` streams every command with its arguments to any connected client. A session token in a value is fine; a password or a private key is not.

**Do not cache authorization decisions across users.** A cache key that omits the tenant or the user id will eventually serve one user's data to another. Include every dimension of the authorization decision in the key.

**Enable TLS** to a managed Redis (`rediss://`), and verify the certificate.

**Bound what you cache from user input.** An endpoint that caches per arbitrary query string lets an attacker fill your memory with millions of one-hit keys and evict everything useful. Cache on a normalized, allow-listed key.

## Production considerations

- **One client per process, plus one duplicate per subscriber.** Connect at startup, `await redis.quit()` on `SIGTERM`.
- **Always attach an `error` listener.** Without it, a reconnect error is an unhandled EventEmitter `'error'` and the process exits.
- **Set `maxmemory` and an explicit `maxmemory-policy`.** The default (`noeviction`) makes writes fail with an error once memory is full — which for a cache is worse than eviction. Choose `allkeys-lru` for a pure cache; choose `noeviction` for a queue instance and alert on memory instead.
- **Watch `evicted_keys`, `keyspace_hits` / `keyspace_misses`, `used_memory`, `connected_clients` and `blocked_clients`** from `INFO`. A rising eviction rate with a falling hit rate means the cache is too small to be useful.
- **A hit rate below ~80% usually means the cache is not paying for itself.** Measure it before adding more caching.
- **Never run `KEYS`, `FLUSHALL` or `MONITOR` against production.** `MONITOR` in particular degrades throughput substantially and leaks every argument.
- **Wrap cache reads and writes so failures degrade to a miss.** Then test it by stopping Redis locally and confirming the app still serves traffic.
- **Cap latency.** Redis calls are fast until they are not; a call inside a request path still needs a timeout so a network partition does not hold your connections open. See [Retries and timeouts](retries-and-timeouts.md).
- **Do not put Redis in the liveness probe.** A cache outage should not restart every application pod. See [Health checks](health-checks.md).
- **Big keys are latency bombs.** A 50 MB value or a million-element list blocks the single-threaded server while it is serialized. Find them with `redis-cli --bigkeys` and split them.

## Common mistakes

- **`KEYS` in application code.** It blocks the server for the length of the scan. Use `SCAN`.
- **No TTL.** Memory grows until eviction starts silently deleting things you needed.
- **`SET` then `EXPIRE` as two commands.** A crash in between leaves a key that never expires.
- **No `error` listener on the client.** A transient network error becomes a process crash.
- **Letting a cache failure fail the request.** Treat an error as a miss; the database is still there.
- **Using the main client for `SUBSCRIBE`.** The connection enters subscriber mode and every other command on it fails.
- **Relying on pub/sub for work that must happen.** No persistence, no acknowledgement, no replay across a reconnect.
- **Read-modify-write counters from Node.** Use `INCR`, `INCRBY` or a Lua script; anything else loses increments.
- **Uniform TTLs.** Keys written together expire together and stampede the database. Add jitter.
- **Treating Redis as a database.** RDB snapshots and asynchronous replication mean acknowledged writes can vanish.
- **Sharing one instance between a cache with `allkeys-lru` and a job queue.** Eviction will delete jobs.
- **Forgetting the tenant in a cache key.** One cross-tenant hit is a data breach.

## Related topics

- [Choosing a database](choosing-a-database.md) — why Redis sits beside a real database, not instead of one.
- [Connection pooling](connection-pooling.md) — why Redis needs no pool and Postgres does.
- [Rate limiting](../express-libraries/rate-limiting.md) — `express-rate-limit` with `rate-limit-redis`.
- [Rate limiting and abuse](../security/rate-limiting-and-abuse.md) — choosing fail-open or fail-closed.
- [Cookies](../express-libraries/cookies.md) — session storage and what losing it costs.
- [Health checks](health-checks.md) — reporting a degraded cache without restarting the process.
- [Retries and timeouts](retries-and-timeouts.md) — bounding cache calls in the request path.
- [Performance](../production/performance.md) — measuring whether the cache actually helps.
