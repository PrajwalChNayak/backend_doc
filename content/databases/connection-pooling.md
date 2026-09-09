---
title: Connection pooling
description: What a database pool actually does, how to size it, how to spot exhaustion and leaks, and why serverless plus Postgres needs PgBouncer or RDS Proxy.
status: current
updated: 2026-09-08
---

A connection pool is a small set of pre-opened database connections that your request handlers borrow and return. It exists because opening a connection is expensive and because the database can only support a bounded number of them. Almost every "the database got slow" incident is really a pooling incident.

## Why it exists

Opening a PostgreSQL connection costs a TCP handshake, a TLS handshake, an authentication round trip, and — this is the expensive part — a **fork on the server**. Every PostgreSQL connection is a separate operating-system process with its own memory. MySQL uses a thread per connection, which is cheaper but not free.

Round-trip cost for a new connection on a local network is typically 5–30 ms, and 50–150 ms across an availability zone with TLS. A query that takes 0.4 ms should not be preceded by 30 ms of setup.

So you open a few connections once, keep them, and hand them out. That is the whole idea.

## What a pool actually is

A pool is three things:

1. **A list of idle connections** ready to be borrowed.
2. **A counter** of how many are currently checked out, capped at `max`.
3. **A queue** of callers waiting because all connections are busy.

Borrowing is: take an idle connection if one exists; otherwise open a new one if you are below `max`; otherwise **wait in the queue**.

That third branch is the one everybody forgets. When the pool is saturated, your code does not fail — it *waits*, silently, inside `await pool.query(...)`. The symptom is latency, not errors, and it appears in the application long before anything looks wrong on the database.

```js
// This one line contains a hidden queue wait.
const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [id])
```

## Sizing: more connections is usually slower

The intuition is that a bigger pool serves more concurrent requests. Past a certain point the opposite is true, and the point is lower than you expect.

A database server executes queries on a fixed number of CPU cores. Beyond roughly the number of cores, additional concurrent queries do not run in parallel — they time-share. Time-sharing adds context switches, cache-line thrashing, more lock contention, and (in Postgres) more memory for work areas. Throughput flattens and then falls, while every individual query gets slower.

The starting heuristic, from PostgreSQL's own sizing guidance:

```text
connections ≈ (core_count × 2) + effective_spindles
```

`effective_spindles` is how many concurrent I/O operations the storage can service. On SSD or cloud block storage, treat it as a small number — 1 or 2 — because the queries that block on I/O are the exception, not the rule.

For an 8-core database server on SSD, that is roughly **18 connections in total**, across your whole fleet.

Read that again: *in total*. Not per process.

| | Value |
| --- | --- |
| Database cores | 8 |
| Total connection budget | ~18 |
| Application replicas | 6 |
| Pool `max` per replica | **3** |
| Plus migrations, cron, admin sessions | +3 |

A pool of 3 per replica feels wrong to most people. Measure it. A pool of 3 against a database that can only really run 8 things at once will very often beat a pool of 20, because the queueing happens in your application — where it is cheap and observable — rather than inside the database, where it is expensive and invisible.

The other constraint is the server's own limit. PostgreSQL's `max_connections` defaults to 100, and a fair chunk is reserved for superuser connections and background workers. MySQL 8 defaults to 151.

```sql
-- Postgres: what you are allowed and what you are using
SHOW max_connections;
SELECT count(*) AS used, state FROM pg_stat_activity GROUP BY state;
```

```sql
-- MySQL: the same question
SHOW VARIABLES LIKE 'max_connections';
SHOW STATUS LIKE 'Threads_connected';
SHOW STATUS LIKE 'Max_used_connections';
```

Work backwards: server limit, minus headroom for migrations and human operators, divided by the maximum number of application instances you will ever run at once — including the extra set that exists during a rolling deploy.

:::warning Rolling deploys double your connection count
During a deploy, the old replicas are still serving while the new ones start. For a few minutes you have `2 × replicas × max` connections. Size for the peak, not the steady state.
:::

### When a bigger pool is right

Raise `max` when your queries are dominated by waiting rather than by CPU — a database that is mostly idle while your application blocks on network latency, or a workload with long transactions. If the database's CPU is at 30% and your `waitingCount` is high, you are pool-bound, not database-bound. That is the only signal that justifies increasing it.

## Pool exhaustion

Exhaustion means every connection is checked out and callers are queueing. The symptoms, in the order you notice them:

1. **`waitingCount` above zero.** The earliest and most direct signal.
2. **Request latency climbs, uniformly.** All endpoints get slower, including trivial ones, because they all queue behind the same pool.
3. **Latency is quantized.** Response times cluster around multiples of your slowest query's duration — the queue drains in waves.
4. **The database looks fine.** CPU is low, active queries are few. This is the tell that distinguishes exhaustion from a slow database.
5. **Timeouts.** `Connection terminated due to connection timeout` from `pg`, or an unbounded queue in `mysql2` that never fails at all.

Three causes, in order of frequency:

- **A slow query holds a connection.** One 8-second report against a pool of 10 means the other nine serve everything else. Fix with `statement_timeout` and an index.
- **A leak.** A checked-out client that is never released. The pool shrinks permanently until restart.
- **The pool is genuinely too small** for the concurrency and the query latency. Little's Law: `connections_needed ≈ throughput × average_query_seconds`. 200 queries per second averaging 5 ms needs about 1 connection. 200 per second averaging 200 ms needs 40 — which is your real problem, and the fix is the 200 ms, not the 40.

### Set the wait timeout

An unbounded queue converts a database slowdown into an unbounded pile of in-flight requests and eventual memory exhaustion. Bound it and fail fast.

```js title="pg"
export const pool = new pg.Pool({
  max: 5,
  connectionTimeoutMillis: 3_000, // includes time spent waiting for a free client
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
})
```

```js title="mysql2"
export const pool = mysql.createPool({
  connectionLimit: 5,
  waitForConnections: true,
  queueLimit: 25, // not 0 — reject rather than queue forever
})
```

Returning 503 in 3 seconds is a better outcome than returning 200 in 45 seconds, because the caller has usually given up by then anyway and the work is wasted.

## Leak detection

A leaked connection is one checked out with `pool.connect()` / `pool.getConnection()` and never released. The rule is mechanical:

```js
const client = await pool.connect()
try {
  // …
} finally {
  client.release()   // ← in finally. Always.
}
```

Better: do not write that block by hand. Wrap it once, and make the wrapper the only way to check out a connection.

```js title="src/db/with-client.js"
import { pool } from './pool.js'

export async function withClient(fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
```

Then code review has one rule: no raw `pool.connect()` outside `src/db/`.

Signs of a leak:

- `pool.totalCount` stays at `max` while `pool.idleCount` sits at 0 **and the service is idle**.
- The count is monotonic — it never recovers between traffic peaks.
- The service works after a restart and degrades over hours.

To find it, log a stack trace for connections held too long:

```js title="src/db/with-client.js"
export async function withClient(fn) {
  const client = await pool.connect()
  const start = Date.now()
  const where = new Error('checkout site').stack
  const warn = setTimeout(() => {
    logger.warn({ heldMs: Date.now() - start, where }, 'connection held over 5s')
  }, 5_000)

  try {
    return await fn(client)
  } finally {
    clearTimeout(warn)
    client.release()
  }
}
```

Capturing the stack at checkout is what makes this useful — by the time the timer fires, the call stack is gone.

The other frequent leak is a transaction that errors before `COMMIT` or `ROLLBACK`. The client is released but the connection is still inside an open transaction, holding locks. `idle_in_transaction_session_timeout` on Postgres kills those sessions; set it.

## Instrumenting the pool

`pg` exposes three counters. Export them on your metrics endpoint and graph them.

```js title="src/db/metrics.js"
import { pool } from './pool.js'

export function poolStats() {
  return {
    total: pool.totalCount,   // open connections (idle + in use)
    idle: pool.idleCount,     // available right now
    waiting: pool.waitingCount, // callers queued for a connection
  }
}
```

| Metric | Healthy | What a bad value means |
| --- | --- | --- |
| `waitingCount` | 0 almost always | Exhaustion. This is the alert. |
| `idleCount` | Usually > 0 | Persistently 0 under light load suggests a leak. |
| `totalCount` | Below `max` at low traffic | Pinned at `max` while idle is a leak. |

Alert on `waitingCount > 0` sustained for more than a few seconds. It is a leading indicator: it moves before request latency does, and well before the database shows anything.

`mysql2` does not expose equivalent public counters, but it emits events:

```js
let inUse = 0
let queued = 0

pool.on('acquire', () => { inUse += 1 })
pool.on('release', () => { inUse -= 1 })
pool.on('enqueue', () => { queued += 1 })
```

An `enqueue` event is `mysql2`'s equivalent of `waitingCount` incrementing. Count them; a non-zero rate is the same warning.

For MongoDB, the driver emits connection-pool monitoring events when the client is created with `monitorCommands`, and `maxPoolSize` plays the role of `max`.

## Serverless and pool explosion

This is where pooling breaks hardest.

Every warm Lambda, Cloud Run instance or edge worker is a separate Node process with its own pool. The platform scales instances with traffic and you do not control the count.

```text
200 concurrent function instances × pool max of 10 = 2000 connections
PostgreSQL max_connections = 100
```

The result is `53300 too_many_connections` — and once the database is saturated, even your migrations and your admin sessions cannot get in.

There is a second, subtler failure: a function instance is frozen between invocations. Its idle connections stay open from the database's point of view, so you hold connections you are not using, and TCP keepalives do not run while frozen.

The mitigations, in order:

**1. Put a connection pooler in front of the database.**

- **PgBouncer** in transaction mode multiplexes thousands of client connections onto a few dozen server connections. This is the standard answer for Postgres.
- **AWS RDS Proxy** does the same as a managed service for RDS and Aurora.
- Managed platforms increasingly ship a pooler endpoint — a separate connection string, often on a different port. Use it.

**2. Set `max: 1` in the function's own pool.** A single-threaded function handles one request at a time; a pool of 10 in a Lambda is 10 connections for one concurrent request.

**3. Hoist the pool outside the handler** so it is reused across invocations on a warm instance. A pool created inside the handler is a new pool per request.

```js title="src/handler.js"
import pg from 'pg'

// Module scope: survives between invocations on a warm instance.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // the pooler endpoint
  max: 1,
  idleTimeoutMillis: 10_000,
  allowExitOnIdle: true,
})

export async function handler(event) {
  const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [event.userId])
  return rows[0] ?? null
}
```

`allowExitOnIdle: true` lets the Node process exit when the pool is idle instead of being held open by the pool's socket — useful in short-lived environments.

**4. Consider an HTTP data proxy.** Several managed Postgres providers offer an HTTP or WebSocket query endpoint that removes persistent connections from the picture entirely. It costs you transactions and `LISTEN`, and it is the right trade for some edge workloads.

## Transaction-mode pooling breaks things

PgBouncer has three pool modes, and the one you want for scale is the one that changes semantics.

| Mode | A server connection is assigned for | Scales | Safe |
| --- | --- | --- | --- |
| `session` | The whole client connection | Barely | Everything works |
| `transaction` | One transaction | Very well | **Session state is not preserved** |
| `statement` | One statement | Extremely | No multi-statement transactions at all |

In **transaction mode**, consecutive statements from your client can land on *different* server connections. Anything that lives on a connection rather than in a transaction therefore breaks:

- **`LISTEN` / `NOTIFY`.** `LISTEN` registers on a server connection you will never see again. Silent failure: no error, no notifications. Run listeners on a direct connection that bypasses the pooler.
- **Prepared statements.** Your driver prepares on one server connection and executes on another, which does not have it. PgBouncer 1.21 added tracking of protocol-level prepared statements via `max_prepared_statements`, which fixes this for `pg` in many setups — but verify it against your pooler's version and configuration before assuming it.
- **Session-level `SET`.** `SET statement_timeout = …` outside a transaction may apply to a connection your next query does not use. Use `SET LOCAL` inside a transaction instead.
- **Advisory locks** taken with `pg_advisory_lock` (session-scoped). Use `pg_advisory_xact_lock`, which releases at commit.
- **`WITH HOLD` cursors** and **temporary tables**, which are session-scoped by definition.

RDS Proxy handles this by **pinning**: when it detects session state it dedicates a backend connection to your client for the duration, which silently removes the multiplexing benefit. Watch its pinning metrics — high pinning means you are paying for a proxy that is not proxying.

:::best-practice Two connection strings
Give the application two: `DATABASE_URL` pointing at the transaction-mode pooler for request traffic, and `DATABASE_DIRECT_URL` pointing at the database for migrations, `LISTEN` connections and admin tasks. Most migration tools support this explicitly because they need it.
:::

## Security considerations

**The connection string is a credential.** It carries a username and password. It belongs in a secret manager, not in a repository, a log line, an error message or a build argument. See [Secrets management](../security/secrets-management.md).

**Do not log the pool configuration at startup.** `logger.info({ config: poolConfig })` prints the password. Redact it explicitly.

**A pooler is a new trust boundary.** PgBouncer terminates your TLS and opens its own connection to the database. Both hops need TLS, and the pooler's own listener needs authentication and a private network. A pooler reachable from the internet is a database reachable from the internet.

**Pool the right identity.** A pooler multiplexes connections *per user and per database*. If you rely on per-user database roles or row-level security driven by `SET ROLE`, transaction-mode pooling will hand a connection with the wrong role to the wrong request. Use `SET LOCAL ROLE` inside the transaction, or do not use transaction-mode pooling for that workload.

**Exhaustion is a denial-of-service vector.** A single unauthenticated endpoint running an unindexed query can occupy every connection in the pool and take the whole service down. `statement_timeout` plus rate limiting on expensive endpoints is the defense. See [Rate limiting](../express-libraries/rate-limiting.md).

**Cap the queue.** An unbounded wait queue is unbounded memory. `queueLimit` and `connectionTimeoutMillis` are availability controls.

## Production considerations

- **One pool per process,** created at module load, closed in the `SIGTERM` handler with `await pool.end()`. See [Graceful shutdown](../production/graceful-shutdown.md).
- **Derive `max` from the server limit and the replica count,** including the doubling during a rolling deploy. Write the arithmetic in a comment next to the number.
- **Alert on `waitingCount`, not on latency.** It moves first.
- **Set every timeout.** `connectionTimeoutMillis` for acquisition, `statement_timeout` for execution, `idle_in_transaction_session_timeout` for abandoned transactions.
- **Never share a pool across a `cluster` fork boundary.** Each worker process gets its own pool, so `max` multiplies by the worker count. See [Clustering](../production/clustering.md).
- **Keep a separate, tiny pool for the health check** — or better, do not use the pool at all for liveness. A saturated pool must not make the process look dead and trigger a restart storm. See [Health checks](health-checks.md).
- **Migrations get their own connection**, direct rather than through a transaction-mode pooler, with a different credential.
- **Expect failover to invalidate every connection.** Handle pool `error` events, and retry idempotent operations. See [Retries and timeouts](retries-and-timeouts.md).
- **Reserve headroom for humans.** If the pool math consumes 100% of `max_connections`, nobody can connect to diagnose the incident. Postgres keeps `superuser_reserved_connections` back for exactly this reason; do not eat into it.

## Common mistakes

- **Setting `max` to 50 "to handle more traffic".** You have made every query slower and moved the queue into the database.
- **Creating a pool inside a request handler or a factory function.** N pools of size `max`, and the connection count climbs until the server refuses.
- **`queueLimit: 0` with no HTTP timeout.** Requests queue forever, memory grows, nothing errors.
- **Releasing outside `finally`.** The classic leak. Every error path drops a connection permanently.
- **Not handling the pool's `error` event.** An idle-connection error during failover crashes the process.
- **Ignoring the deploy overlap.** Sized for 6 replicas, briefly running 12, hitting `max_connections` during every deploy.
- **`LISTEN` through a transaction-mode pooler.** No error, no notifications, and it looks like your event system is just slow.
- **Serverless with default pool settings.** 100 warm instances at `max: 10` is 1000 connections.
- **Using the same pool for the readiness probe and for traffic.** The probe fails exactly when the pool is busiest, so the orchestrator restarts a healthy but loaded process.
- **Assuming a proxy fixes everything.** RDS Proxy pins on session state; PgBouncer transaction mode drops it. Both change semantics.

## Related topics

- [PostgreSQL with pg](postgresql-with-pg.md) — pool options, `pool.connect()` and the release rule.
- [MySQL with mysql2](mysql-with-mysql2.md) — `connectionLimit`, `queueLimit` and the pool events.
- [Transactions](transactions.md) — why a transaction holds a connection for its whole duration.
- [Health checks](health-checks.md) — probing without consuming the pool you are trying to protect.
- [Retries and timeouts](retries-and-timeouts.md) — bounding acquisition, execution and the request.
- [Clustering](../production/clustering.md) — each worker multiplies the pool.
- [Graceful shutdown](../production/graceful-shutdown.md) — draining connections on `SIGTERM`.
- [Secrets management](../security/secrets-management.md) — where the connection string lives.
- [Performance](../production/performance.md) — measuring before resizing.
