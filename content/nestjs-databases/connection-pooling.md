---
title: Connection pooling
description: Sizing a pool inside a Nest application — one singleton pool per process, what replicas multiply, the serverless pool-explosion problem, and exposing pool counters as metrics and a health signal.
status: current
updated: 2026-09-11
---

The arithmetic of connection pooling is the same in Nest as anywhere else, and [Connection pooling](../databases/connection-pooling.md) does that arithmetic: why a pool of 100 is usually slower than a pool of 10, how exhaustion presents, and what a transaction-mode pooler breaks. What Nest adds is a place to *put* the pool — one singleton provider — and a container that makes it easy to accidentally create more than one.

## One pool per process, enforced by the container

A provider is a singleton by default: one instance for the whole application, built once. That is the correct cardinality for a pool, and it is the reason the DI approach beats a module-level global — not because it is tidier, but because the container is the only thing that knows how many exist.

Three ways to end up with more pools than you think:

**A second unnamed `forRoot`.** `TypeOrmModule.forRoot()` registered in two modules does not add a second connection — it replaces the first, and queries start going to the wrong database. A genuine second connection needs `name`.

**A `@Module` that lists the pool provider instead of importing its module.**

```ts vulnerable title="DO NOT COPY — two pools, silently"
@Module({
  // DatabaseModule already provides PG_POOL. Re-declaring the provider here
  // creates a SECOND instance, scoped to this module.
  providers: [pgPoolProvider, ReportsService],
})
export class ReportsModule {}
```

Nest resolves providers per module unless the module that owns them exports them and you import that module. Re-declaring `{ provide: PG_POOL, useFactory }` in a feature module runs the factory again. You now have two pools of ten, both open, and only one is closed if only one service implements `onModuleDestroy`. Import `DatabaseModule` instead.

**A request-scoped provider in the chain.** Marking anything request-scoped propagates upward through everything that injects it. If a pool provider becomes request-scoped, you build a pool per request:

```ts vulnerable title="DO NOT COPY — a pool per request"
{
  provide: PG_POOL,
  scope: Scope.REQUEST,
  useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }),
}
```

At 200 requests per second that is 200 pools per second, each opening TCP connections and TLS handshakes, none of them closed. `max_connections` is gone in seconds. Read [Injection scopes](../nestjs/injection-scopes.md) before making anything request-scoped.

The rule from [Connections and DI](connections-and-di.md) holds throughout this section: **the connection is a singleton; the unit of work is a parameter.**

## Where the size is set

Each integration has its own name for the same number.

| Stack | Option | Default |
| --- | --- | --- |
| `pg` 8.23.0 | `max` on `new Pool()` | 10 |
| `mysql2` 3.24.4 | `connectionLimit` on `createPool()` | 10 |
| `@nestjs/typeorm` 12.0.1 + `typeorm` 1.1.1 | `poolSize` in the module options, or driver `extra` | driver default |
| `@nestjs/mongoose` 12.0.0 + `mongoose` 9.10.0 | `maxPoolSize` / `minPoolSize` | 100 / 0 |
| `@prisma/client` 7.10.0 | driver-adapter options — `max` on `PrismaPg` | 10 |
| `ioredis` 6.0.0 | no pool; one multiplexed connection | — |
| `better-sqlite3` 13.0.3 | no pool; one handle | — |

Mongoose's default of **100** is the one that surprises people: four replicas of a Nest service is 400 connections before anything else connects. Set it explicitly.

```ts title="src/database/database.module.ts"
TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    type: 'postgres' as const,
    url: config.getOrThrow<string>('DATABASE_URL'),
    autoLoadEntities: true,
    synchronize: false,
    poolSize: config.get<number>('database.poolMax') ?? 10,
    extra: {
      // pg-specific options TypeORM passes through to the driver.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 5_000,
    },
  }),
})
```

Make the size configurable and validate it. A pool size that came from a tutorial and cannot be changed without a deploy is a pool size you cannot fix during an incident:

```ts title="src/config/env.schema.ts"
import { z } from 'zod'

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
})
```

The `max(50)` is deliberate. It is not a limit on what the database can do; it is a guard against someone setting `DB_POOL_MAX=500` to "fix" a slowness and taking the database down for every other service.

## The number that actually matters

What the database sees is not your pool size. It is:

```text
total connections = pool size
                  × processes per container   (clustering / PM2 instances)
                  × replicas
                  + background workers        (BullMQ, cron, consumers)
                  + migration jobs
                  + health-check pools
                  + everything else that shares the database
```

A Nest service at `DB_POOL_MAX=10`, two workers per pod via [clustering](../nestjs-production/clustering.md), eight pods, plus a BullMQ worker deployment of three pods at 10 each, is `10 × 2 × 8 + 30 = 190` connections. On a managed Postgres instance with `max_connections = 200` there is no headroom for a migration job, a psql session, or a monitoring agent — and the failure mode is that your *next deploy* cannot connect.

Two consequences for a Nest deployment specifically:

- **Clustering multiplies the pool.** Nest's clustering guidance runs one process per CPU. Each process has its own container and therefore its own pool. Divide the per-container budget by the worker count.
- **Workers need their own, smaller pool.** A BullMQ consumer with a concurrency of 5 does not need a pool of 10. Give the worker deployment its own `DB_POOL_MAX`, and set it to the concurrency plus a little.

## Exposing the pool counters

`pg` tracks three numbers, and they are the single most useful thing you can put on a metrics endpoint. `waitingCount > 0` means requests are queued for a connection, which is the difference between "the database is slow" and "the pool is too small" — a diagnosis that otherwise takes twenty minutes of guessing.

```ts title="src/database/pool-metrics.service.ts"
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common'
import { Pool } from 'pg'
import { PG_POOL } from './pg.tokens.js'

export interface PoolSnapshot {
  total: number
  idle: number
  waiting: number
  max: number
}

@Injectable()
export class PoolMetricsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PoolMetricsService.name)
  private readonly pool: Pool
  private timer: NodeJS.Timeout | undefined

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.pool = pool
  }

  snapshot(): PoolSnapshot {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      max: this.pool.options.max ?? 10,
    }
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      const s = this.snapshot()
      if (s.waiting > 0) {
        this.logger.warn(`pool saturated: ${s.total}/${s.max} open, ${s.waiting} waiting`)
      }
    }, 10_000)
    // Do not hold the process open just to emit metrics.
    this.timer.unref()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }
}
```

Two Nest-specific points in that snippet. `onApplicationBootstrap` runs after every module has initialised, which is the right moment to start a timer — `onModuleInit` can fire before the thing you are measuring exists. And `clearInterval` in `onModuleDestroy` is not optional: an un-cleared interval keeps the event loop alive and `app.close()` hangs, which looks like a shutdown bug rather than a forgotten timer.

Feed the snapshot into whatever exports metrics, and put it on the internal health page too — but not the public one, which should return a status word and nothing else. See [Health checks](health-checks.md) and [Observability](../nestjs-production/observability.md).

### Borrow latency is the leading indicator

Saturation shows up in `waitingCount` only while it is happening. Time the borrow itself and you get a distribution you can alert on before it becomes an outage:

```ts title="src/database/pg.service.ts"
async connectTimed() {
  const started = process.hrtime.bigint()
  const client = await this.pool.connect()
  const waitedMs = Number(process.hrtime.bigint() - started) / 1e6
  if (waitedMs > 50) this.logger.warn(`waited ${waitedMs.toFixed(1)}ms for a connection`)
  return client
}
```

A healthy pool returns a connection in microseconds. Anything in the tens of milliseconds means every request is now paying for queueing, and the cause is either an undersized pool or a leak.

## Leaks, and the Nest-shaped way to cause one

A leak is a connection checked out and never released. With `pool.query()` it cannot happen — the pool releases for you. It happens whenever you call `pool.connect()`, which is every transaction.

```ts vulnerable title="DO NOT COPY — one leaked connection per error"
async transfer(fromId: number, toId: number, cents: number) {
  const client = await this.db.connect()
  await client.query('BEGIN')
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [cents, fromId])
  await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [cents, toId])
  await client.query('COMMIT')
  client.release()
}
```

If the first `UPDATE` violates a constraint, the throw skips `release()`. The connection is checked out forever, holding an open transaction and its locks. Ten such errors and a pool of ten is dead — and the symptom is that *every* endpoint hangs, not just this one. The `finally` is what makes it correct:

```ts good title="src/database/pg.service.ts"
async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await this.pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection's state is unknown — destroy it rather than pool it.
      client.release(rollbackErr as Error)
      throw err
    }
    throw err
  } finally {
    // release() is idempotent in pg; a second call is a no-op.
    client.release()
  }
}
```

Write it once as a method on the database provider and never call `connect()` anywhere else. That is the Nest advantage: there is exactly one place that can leak, and it is fifteen lines you can review.

The other Nest-specific leak source is a **request-scoped provider that checks out a connection in its constructor**. Nest destroys request-scoped instances after the response, but it does not know your constructor borrowed a connection — nothing releases it.

## Serverless and pool explosion

The model a pool assumes — a long-lived process serving many requests — is exactly what a serverless platform does not provide.

Each concurrent invocation is its own process with its own pool. A hundred concurrent requests is a hundred pools, and if each has `max: 10` the database is asked for a thousand connections. Even at `max: 1` it is a hundred connections, each paying a fresh TCP and TLS handshake on a cold start.

Nest makes this worse in one specific way: a Nest application bootstraps the whole module graph, so a cold start constructs every provider including the pool. Caching the bootstrapped app across invocations is the standard mitigation and it is the correct one — but it only helps within one warm container, so the concurrency arithmetic above is unchanged.

What actually works, in order:

1. **Put a pooler in front.** PgBouncer, RDS Proxy, Supabase's pooler, Neon's pooled endpoint. The functions connect to the pooler; the pooler holds a small number of real connections. This is the answer.
2. **`max: 1` per instance** so the arithmetic is at least linear rather than multiplied.
3. **A short `idleTimeoutMillis`** so a container that is about to be frozen is not holding an idle connection.
4. **An HTTP data proxy** where the provider offers one, which removes connections from the picture entirely.
5. **Do not deploy this service to a per-request runtime.** A Nest application with a connection pool and shutdown hooks is designed for a long-lived process. That is usually the honest answer.

:::warning Transaction-mode pooling changes what works
A pooler in transaction mode hands you a different backend connection per transaction. Session state does not survive: `SET`, `LISTEN/NOTIFY`, advisory locks held outside a transaction, temporary tables, and — depending on the pooler version — server-side prepared statements. `pg` does not use prepared statements by default, but TypeORM and Prisma may, and `mysql2`'s `execute` always does.

Test against the pooler, not against the database directly. "It works locally" means nothing here. [Connection pooling](../databases/connection-pooling.md) has the full list of what breaks.
:::

## Security considerations

**An exhausted pool is a denial of service, and it is usually reachable without authentication.** Any endpoint that can hold a connection for a long time — an unbounded list, an export, a report, a search with no limit — is an amplification primitive: a handful of concurrent requests occupies the whole pool and every other endpoint, including the health check, starts timing out. Bound the work (`LIMIT`, `statement_timeout`) and rate-limit the expensive routes.

**Set `connectionTimeoutMillis` so saturation fails fast.** The `pg` default waits forever. A request that waits forever holds a socket, a Node handle and whatever the client is holding open, so an attacker gets to consume your memory as well as your connections. A 5-second timeout turns the same attack into visible 503s.

**Do not expose pool counters publicly.** `{"pool":{"total":10,"waiting":7}}` on a public endpoint tells an attacker exactly how close to the edge you are and when to push. Internal endpoint or operator credential only — [Health checks](health-checks.md).

**Give the health check its own connection, not the application pool.** Otherwise a saturated pool makes healthy instances report unready, they leave the load balancer, and their traffic lands on the remaining replicas — which saturates those too. That is a slow query turning into a total outage, and it is self-inflicted.

**Never derive pool credentials from a request.** One pool, one identity, chosen at boot. Per-tenant credentials in a connection string built at request time is both a pool-explosion bug and an authorization bypass — see [PostgreSQL](postgresql.md).

**Keep pool options out of logs.** The options object carries `connectionString` or `password`, and both Nest's bootstrap failures and driver errors like to print it. [Safe logging](../nestjs-security/safe-logging.md).

## Production considerations

- **Start at 10 per process and change it only with a measurement.** Bigger pools mostly move queueing from your process into the database, where it is harder to see.
- **Do the total-connections arithmetic before every capacity change.** Pool × processes × replicas, plus workers, plus migration jobs, plus headroom for an operator's `psql`.
- **Reserve headroom for migrations and operators.** A deploy that cannot open a connection to run its migration is an outage caused by capacity planning.
- **Set `connectionTimeoutMillis` and `idleTimeoutMillis` explicitly.** The defaults are "wait forever" and "keep forever" on some drivers.
- **Export `total`, `idle`, `waiting` and borrow latency.** `waiting > 0` is the single most informative database metric you have.
- **Alert on borrow latency, not just on errors.** It rises minutes before anything fails.
- **One `withTransaction` helper, on the database provider.** It is then the only code that can leak a connection.
- **Clear every interval in `onModuleDestroy`.** An un-cleared timer makes `app.close()` hang and the shutdown look broken.
- **Give workers their own pool size.** Concurrency plus a little, not the API's number.
- **Put a pooler in front for serverless or high-replica-count deployments**, and test through it.
- **Set `application_name` (Postgres) or a connection attribute (MySQL)** so `pg_stat_activity` tells you which deployment owns the connections.
- **Re-check the numbers after a scaling change.** Autoscaling from 4 to 40 replicas multiplies your connection count by ten without anyone editing a config file.

## Common mistakes

- **Re-declaring the pool provider in a feature module.** A second pool, and only one gets closed.
- **A second unnamed `TypeOrmModule.forRoot`.** It replaces the first instead of adding a connection.
- **A request-scoped connection provider.** A pool per request; the database is gone in seconds.
- **Leaving Mongoose at its default `maxPoolSize: 100`.** Four replicas is 400 connections.
- **Sizing the pool without counting replicas and workers.** The database sees the product, not your number.
- **Forgetting that clustering multiplies the pool per container.** Four workers at `max: 10` is 40 per pod.
- **`pool.connect()` without `finally { release() }`.** One leaked connection per error path.
- **Checking out a connection in a request-scoped provider's constructor.** Nothing releases it.
- **No `connectionTimeoutMillis`.** Exhaustion presents as hung requests instead of fast failures.
- **An un-cleared `setInterval` in a metrics provider.** `app.close()` never resolves.
- **Using the application pool for the readiness probe.** Saturation is misreported as unreadiness and the traffic shifts onto the other replicas.
- **Deploying a pooled Nest app to a per-request serverless runtime without a pooler.** Pool explosion.
- **Assuming session state survives a transaction-mode pooler.** `SET`, `LISTEN`, temp tables and prepared statements do not.

## Related topics

- [Connection pooling](../databases/connection-pooling.md) — the sizing arithmetic, exhaustion, leak detection and what a pooler breaks.
- [Connections and DI](connections-and-di.md) — why the pool is a singleton provider and how it is closed.
- [Injection scopes](../nestjs/injection-scopes.md) — how `Scope.REQUEST` propagates and what it costs.
- [PostgreSQL](postgresql.md) — `max`, `statement_timeout` and the pool counters on the `pg` provider.
- [MySQL](mysql.md) — `connectionLimit`, `queueLimit` and keepalive.
- [Transactions](transactions.md) — the one place a connection is checked out by hand.
- [Health checks](health-checks.md) — a probe with its own connection, and keeping the counters internal.
- [Clustering](../nestjs-production/clustering.md) — one process per CPU, and therefore one pool per CPU.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — draining the pool without cutting in-flight queries.
- [Observability](../nestjs-production/observability.md) — turning the snapshot into metrics with history.
