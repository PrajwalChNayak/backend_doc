---
title: Health checks
description: Database health probes that do not cause cascading restarts — liveness versus readiness, a cheap SELECT 1 with a hard timeout, cached results, and safe dependency reporting.
status: current
updated: 2026-09-08
---

A health check tells an orchestrator or a load balancer whether to send traffic to this process and whether to restart it. Done badly, the check itself becomes the outage: a database blip restarts every pod, and the restart storm keeps the database from recovering.

This page covers the database side. [Health and readiness probes](../production/health-and-readiness-probes.md) covers the HTTP and orchestration side.

## Liveness vs readiness

They answer different questions and must have different implementations.

| | Liveness | Readiness |
| --- | --- | --- |
| Question | Is this process broken beyond repair? | Should this process receive traffic right now? |
| Failure action | **Restart the container** | **Remove from the load balancer** |
| Should it touch the database | **No** | Yes |
| Should it touch Redis | No | Only to report degraded, not to fail |
| Typical path | `/livez` | `/readyz` |

The rule follows from the failure action: **a liveness probe must only fail for conditions a restart would fix.**

A restart does not fix an unreachable database. It does not fix a saturated connection pool. It does not fix a failing managed provider. So none of those belong in a liveness probe.

### Why a database call in a liveness probe causes cascading restarts

Trace what happens when the database has a 60-second failover:

1. Every replica's liveness probe queries the database. Every one fails.
2. Kubernetes restarts every pod, simultaneously.
3. Every pod comes up cold: new connections, new TLS handshakes, cold caches, JIT warmup.
4. The database, already recovering, is hit by a thundering herd of connection attempts from every replica at once.
5. Connections are refused or slow. The new pods fail their liveness probes.
6. Kubernetes restarts them again. `CrashLoopBackOff`.

The database recovers after 60 seconds. Your service does not recover for 20 minutes, because it destroyed itself.

Had liveness ignored the database and readiness checked it, the outcome would have been: pods stay up, traffic drains from all of them, the database recovers, readiness passes, traffic returns. Total outage: 60 seconds, and the connection pools were still warm.

:::danger The most expensive one-line mistake in this section
```js vulnerable title="DO NOT COPY — src/routes/health.js"
app.get('/livez', async (req, res) => {
  await pool.query('SELECT 1')
  res.status(200).json({ status: 'ok' })
})
```
Every transient database problem now restarts every instance of your service, at the exact moment the database can least afford a reconnect storm.
:::

Liveness should check that the event loop is running and this process is not wedged. That is all.

```js good title="src/routes/health.js"
import { Router } from 'express'

export const health = Router()

// Liveness: no I/O, no dependencies. If the event loop can run this, we are alive.
health.get('/livez', (req, res) => {
  res.status(200).json({ status: 'ok' })
})
```

If you want liveness to detect a genuinely wedged process, measure event-loop delay rather than calling out to anything:

```js title="src/health/loop-lag.js"
import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 20 })
histogram.enable()

/** Returns true when the event loop is responsive enough to serve traffic. */
export function eventLoopHealthy() {
  const p99Ms = histogram.percentile(99) / 1e6
  return p99Ms < 1_000
}
```

That is a condition a restart actually fixes.

## The readiness check

Readiness may touch the database, because failing it removes this instance from the load balancer rather than killing it. Three properties are mandatory: it must be **cheap**, **hard-bounded in time**, and **cached**.

### Cheap

Use the cheapest statement the database offers. It is testing connectivity, not correctness.

| Database | Statement |
| --- | --- |
| PostgreSQL | `SELECT 1` |
| MySQL | `SELECT 1` |
| SQLite | `PRAGMA quick_check` on the file, or a `SELECT 1` |
| MongoDB | `db.command({ ping: 1 })` |
| Redis | `PING` |

Never query a real table. A readiness check that does `SELECT count(*) FROM orders` runs a sequential scan every few seconds on every replica, forever — a self-inflicted load generator that grows with your data.

### Hard timeout

`SELECT 1` is instant against a healthy database. Against a sick one it can hang for the connection timeout, and a readiness probe that hangs for 30 seconds is indistinguishable from one that fails — except that it holds a connection while it does so.

`AbortSignal.timeout()` gives you a hard bound.

```js title="src/health/db.js"
import { pool } from '../db/pool.js'

const TIMEOUT_MS = 1_000

export async function checkDatabase() {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const client = await pool.connect()

  try {
    const query = client.query('SELECT 1')
    const aborted = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('db health check timed out')), {
        once: true,
      })
    })
    await Promise.race([query, aborted])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    // Release even on timeout — otherwise the probe leaks a connection every cycle.
    client.release()
  }
}
```

The `finally` is not optional. A probe that leaks one connection per failed check exhausts the pool during exactly the incident you are trying to observe.

You can also enforce the bound server-side, which is stronger because it stops the work rather than abandoning it:

```js
await client.query("SET LOCAL statement_timeout = '1s'")
```

### Cached

With a 5-second probe interval, 8 replicas, and both a readiness and a startup probe, that is a query every few hundred milliseconds forever. During an incident, when every check fails slowly, it is far worse — the probes themselves consume the connections the application needs.

Cache the result for slightly less than the probe interval, and collapse concurrent checks into one.

```js title="src/health/cache.js"
const TTL_MS = 3_000

let cached = { at: 0, value: null }
let inFlight = null

export function cachedCheck(fn) {
  return async function check() {
    const now = Date.now()
    if (cached.value && now - cached.at < TTL_MS) return cached.value

    // Single-flight: concurrent probes share one database round trip.
    if (inFlight) return inFlight

    inFlight = fn()
      .then((value) => {
        cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }
}
```

```js title="src/health/index.js"
import { cachedCheck } from './cache.js'
import { checkDatabase } from './db.js'

export const databaseHealth = cachedCheck(checkDatabase)
```

Now the database sees at most one health query every 3 seconds per process, regardless of how many probes and load balancers are asking.

:::tip Do not use the application pool
Better still, give the health check its own tiny pool (`max: 1`). Then a saturated application pool cannot make the process look unready — which would remove it from the load balancer at the exact moment it is busiest, sending its traffic to the other replicas and saturating them too. That is how a slow query becomes a full outage.
:::

## Wiring it up

```js title="src/routes/health.js"
import { Router } from 'express'
import { databaseHealth } from '../health/index.js'
import { redisHealth } from '../health/redis.js'
import { eventLoopHealthy } from '../health/loop-lag.js'

export const health = Router()

health.get('/livez', (req, res) => {
  if (!eventLoopHealthy()) return res.status(503).json({ status: 'unhealthy' })
  res.status(200).json({ status: 'ok' })
})

health.get('/readyz', async (req, res) => {
  const [db, cache] = await Promise.all([databaseHealth(), redisHealth()])

  // The database is required. The cache is not — degraded, but still serving.
  const ready = db.ok
  const status = ready ? (cache.ok ? 'ok' : 'degraded') : 'unavailable'

  res.status(ready ? 200 : 503).json({ status })
})
```

Two decisions encoded there:

- **Only hard dependencies fail readiness.** If the service cannot answer a single request without Postgres, Postgres is hard. Redis usually is not — see [Redis](redis.md). Failing readiness because a cache is down takes your whole fleet out of rotation over a performance problem.
- **The public response body is one word.** More on that below.

Also serve `/readyz` as **503 during shutdown**, before you stop accepting connections. That gives the load balancer time to stop routing to you before the process closes its listener, which is what makes a rolling deploy lose zero requests.

```js title="src/server.js"
let shuttingDown = false

health.get('/readyz', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' })
  // …
})

process.on('SIGTERM', async () => {
  shuttingDown = true
  await new Promise((r) => setTimeout(r, 5_000)) // let the load balancer notice
  server.close(() => pool.end())
})
```

See [Graceful shutdown](../production/graceful-shutdown.md).

## Dependency status reporting

Operators need detail; the internet does not. Serve both, on different routes with different access.

```js title="src/routes/health.js"
// Detailed. Bind to an internal port, or require an operator credential.
health.get('/internal/health', requireOperator, async (req, res) => {
  const [db, cache] = await Promise.all([databaseHealth(), redisHealth()])

  res.status(db.ok ? 200 : 503).json({
    status: db.ok ? (cache.ok ? 'ok' : 'degraded') : 'unavailable',
    version: process.env.GIT_SHA,
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database: { ok: db.ok, latencyMs: db.latencyMs, error: db.error },
      cache: { ok: cache.ok, latencyMs: cache.latencyMs, error: cache.error },
    },
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
  })
})
```

The pool counters are the single most valuable thing on that page. `waiting > 0` tells an operator, immediately, that the problem is pool exhaustion rather than a slow database — a diagnosis that otherwise takes twenty minutes. See [Connection pooling](connection-pooling.md).

Distinguish **degraded** from **unavailable**. A service running without its cache is slower but correct, and should keep serving. Reporting that as "unhealthy" prompts an operator to restart something that is working.

## Security considerations

**Do not expose the detailed check publicly.** A verbose health endpoint is reconnaissance: it typically leaks the database engine and version, internal hostnames, the deployed commit, dependency names, pool sizes and uptime. Every one of those narrows an attacker's search.

```js vulnerable title="DO NOT COPY — a public /health"
res.json({
  status: 'unavailable',
  database: {
    host: 'prod-pg-primary.internal.acme.net',
    error: 'password authentication failed for user "app_user"',
  },
  version: '2.14.3',
  commit: 'a91f0c2',
})
```

That single response hands over an internal hostname, a valid database username, the fact that authentication is failing, and the exact build to look up known vulnerabilities for.

**Public endpoints return a status word and nothing else.** `{"status":"ok"}` or a bare 200/503. No error strings, no hostnames, no versions, no stack traces.

**Never put credentials or connection strings in a health response**, including inside an error message. A driver error frequently contains the connection string.

**Rate-limit and cache the public endpoints.** An uncached `/readyz` is an unauthenticated endpoint that causes a database query — a cheap amplification vector. The caching above already fixes this; keep it.

**Bind the detailed endpoint to an internal interface or a separate port**, or require an operator credential. "It is not linked anywhere" is not access control.

**Health endpoints are logged and often unauthenticated.** Keep them out of your access-log noise, but ensure they cannot be used to enumerate internal structure.

**Do not let the health check write.** A probe that inserts a heartbeat row generates write traffic, WAL and replication load on every replica forever, and gives an attacker a write primitive on an unauthenticated route.

## Production considerations

- **Liveness: no dependencies. Readiness: hard dependencies only.** This one rule prevents most health-check outages.
- **Tune the probe timings against reality.** A `failureThreshold` of 1 restarts on a single blip. Three consecutive failures at a 5-second interval — roughly 15 seconds of sustained failure — is a reasonable liveness threshold. Readiness can be more sensitive because the consequence is reversible.
- **Use a startup probe** for slow boots. Otherwise the liveness probe kills the process during a long migration or a cold start, and it never gets to serve.
- **Give health checks their own connection.** A dedicated `max: 1` pool means application saturation cannot be misreported as unreadiness.
- **Cache the result** for just under the probe interval, and single-flight concurrent checks.
- **Hard-bound every check.** A probe must return in well under the probe timeout; 1 second is a good target.
- **Fail readiness on `SIGTERM` before closing the listener**, with a few seconds of grace so the load balancer's own health check notices. This is what makes a deploy lose zero requests.
- **Alert on readiness flapping**, not just on failure. A replica cycling in and out of rotation is a symptom of an undersized pool or an overloaded database.
- **Do not include a check for something you would not act on.** A readiness check on a third-party API you call once an hour will take you offline for someone else's outage.
- **Emit the pool counters as metrics too**, not only on the health page — you want the history. See [Observability](../production/observability.md).
- **Test the failure path.** Stop the database locally and confirm: readiness 503, liveness 200, process alive, and recovery without a restart when it comes back.

## Common mistakes

- **A database query in the liveness probe.** The cascading-restart failure at the top of this page.
- **An uncached check.** Every probe from every replica hits the database; during an incident the probes are the load.
- **No timeout.** The probe hangs for 30 seconds and holds a connection while it does.
- **Not releasing the client on the failure path.** The probe leaks a connection per cycle and exhausts the pool.
- **Using the application pool.** Saturation makes healthy instances look unready, shifting their traffic onto the others.
- **Querying a real table.** `SELECT count(*) FROM events` on every probe is a permanent, growing self-inflicted load.
- **Failing readiness because the cache is down.** The whole fleet leaves rotation over something that only makes it slower.
- **A verbose public `/health`.** Free reconnaissance.
- **`failureThreshold: 1` on liveness.** One dropped packet restarts the pod.
- **No startup probe** on a service with a slow boot. Liveness kills it before it is ready.
- **Not failing readiness during shutdown.** Requests are routed to a process that is closing its listener, and the deploy drops them.
- **A writing health check.** Write load on every replica, plus an unauthenticated write path.

## Related topics

- [Health and readiness probes](../production/health-and-readiness-probes.md) — the HTTP and orchestrator side, probe configuration and thresholds.
- [Connection pooling](connection-pooling.md) — why the probe needs its own connection, and what the counters mean.
- [Graceful shutdown](../production/graceful-shutdown.md) — draining traffic before the listener closes.
- [Retries and timeouts](retries-and-timeouts.md) — `AbortSignal.timeout()` and bounding every layer.
- [Redis](redis.md) — reporting a degraded cache instead of failing.
- [Observability](../production/observability.md) — the metrics that make health checks unnecessary for diagnosis.
- [PostgreSQL with pg](postgresql-with-pg.md) — pool counters and `statement_timeout`.
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — keeping connection strings out of error output.
