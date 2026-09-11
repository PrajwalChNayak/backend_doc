---
title: Health checks
description: Database health checks with @nestjs/terminus 12 — HealthCheckService, the TypeORM, Mongoose, memory and disk indicators, a custom indicator with HealthIndicatorService, and why liveness must never touch the database.
status: current
updated: 2026-09-11
---

`@nestjs/terminus` gives you a health controller that composes indicators and renders a consistent JSON result. What it does not give you is judgement about *which* checks belong in *which* probe — and getting that wrong is how a 60-second database failover becomes a 20-minute outage. [Health checks](../databases/health-checks.md) explains that failure mode in detail and is worth reading first; this page is the Nest implementation.

## Installing

```bash
npm install @nestjs/terminus@12.0.0
```

`@nestjs/terminus` 12 declares `engines.node: ^20.19.0 || ^22.12.0 || >=24.0.0` and peers on `@nestjs/common` and `@nestjs/core` 11 or 12. Its database indicators are optional peer dependencies: `TypeOrmHealthIndicator` needs `typeorm` and `@nestjs/typeorm` installed, `MongooseHealthIndicator` needs `mongoose` and `@nestjs/mongoose`, `PrismaHealthIndicator` needs `@prisma/client`. You install only the ones you use.

## The two probes

They answer different questions and the difference is not stylistic — it is determined by what the orchestrator *does* when each fails.

| | Liveness | Readiness |
| --- | --- | --- |
| Question | Is this process broken beyond repair? | Should it receive traffic right now? |
| On failure | **restart the container** | **remove from the load balancer** |
| Touches the database | **no** | yes |
| Touches Redis | no | only to report degraded |
| Path | `/livez` | `/readyz` |

The rule follows mechanically: **a liveness probe may only fail for conditions a restart would fix.** A restart does not fix an unreachable database, a saturated pool, or a provider outage — so none of those belong in liveness.

:::danger The most expensive Terminus mistake
```ts vulnerable title="DO NOT COPY — src/health/health.controller.ts"
@Get('livez')
@HealthCheck()
liveness() {
  return this.health.check([() => this.db.pingCheck('database')])
}
```

During a database failover every replica's liveness probe fails at once, Kubernetes restarts every pod simultaneously, and the database — already recovering — is hit by a reconnect storm from every cold replica. The new pods fail their probes too. `CrashLoopBackOff`.

The database recovers in 60 seconds. Your service does not recover for 20 minutes, because it destroyed itself.
:::

Had liveness ignored the database and readiness checked it, the outcome would have been: pods stay up, traffic drains, the database recovers, readiness passes, traffic returns. Total impact: 60 seconds, with warm pools.

## The health module

```ts title="src/health/health.module.ts"
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HealthController } from './health.controller.js'
import { RedisHealthIndicator } from './redis.health.js'

@Module({
  imports: [
    TerminusModule.forRoot({
      // 'pretty' is readable in a terminal; 'json' (the default) is what you
      // want anywhere logs are ingested by a collector.
      errorLogStyle: 'json',
      // How long the app waits, after readiness starts failing, before it
      // begins tearing down — the load balancer's grace window.
      gracefulShutdownTimeoutMs: 5_000,
    }),
  ],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
```

`TerminusModule.forRoot()` takes optional options; `imports: [TerminusModule]` on its own is equivalent to the defaults. It exports `HealthCheckService`, `HealthIndicatorService` and every built-in indicator, so the controller just injects what it needs.

## The controller

```ts title="src/health/health.controller.ts"
import { Controller, Get } from '@nestjs/common'
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus'
import { RedisHealthIndicator } from './redis.health.js'

@Controller()
export class HealthController {
  private readonly health: HealthCheckService
  private readonly db: TypeOrmHealthIndicator
  private readonly mongo: MongooseHealthIndicator
  private readonly memory: MemoryHealthIndicator
  private readonly disk: DiskHealthIndicator
  private readonly redis: RedisHealthIndicator

  constructor(
    health: HealthCheckService,
    db: TypeOrmHealthIndicator,
    mongo: MongooseHealthIndicator,
    memory: MemoryHealthIndicator,
    disk: DiskHealthIndicator,
    redis: RedisHealthIndicator,
  ) {
    this.health = health
    this.db = db
    this.mongo = mongo
    this.memory = memory
    this.disk = disk
    this.redis = redis
  }

  // Liveness: no I/O, no dependencies. If the event loop can run this, the
  // process is alive. Heap is included because a heap that will not come
  // down IS fixed by a restart.
  @Get('livez')
  @HealthCheck()
  liveness() {
    return this.health.check([() => this.memory.checkHeap('memory_heap', 1024 * 1024 * 1024)])
  }

  // Readiness: the hard dependencies, each hard-bounded and cached.
  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1_500).cacheFor(3_000),
      () => this.mongo.pingCheck('mongo').withTimeout(1_500).cacheFor(3_000),
      () => this.redis.isHealthy('cache'),
    ])
  }
}
```

`@HealthCheck()` sets `Cache-Control: no-cache, no-store, must-revalidate` on the response and, when `@nestjs/swagger` is installed, documents the endpoint. Both behaviours are opt-out: `@HealthCheck({ noCache: false })`, `@HealthCheck({ swaggerDocumentation: false })`.

`HealthCheckService.check()` runs every indicator, returns 200 when all are `up` or `degraded`, and 503 when any is `down`. The body is `{ status, info, error, details }` — `info` holds the `up` and `degraded` entries, `error` the `down` ones, `details` everything.

### withTimeout and cacheFor

Two builder methods on the attempt returned by every `pingCheck`, and both are load-bearing:

- **`withTimeout(ms)`** hard-bounds the check. `SELECT 1` is instant against a healthy database and can hang for the connection timeout against a sick one — and a probe that hangs for 30 seconds is indistinguishable from one that fails, except that it holds a connection while it does so.
- **`cacheFor(ms)`** caches the result per indicator key and collapses concurrent executions into one in-flight run. With a 5-second probe interval, eight replicas, and both a readiness and a startup probe, an uncached check is a query every few hundred milliseconds forever — and during an incident, when every check fails slowly, the probes *are* the load.

Cache for slightly less than the probe interval. Results served from the cache carry `cachedResponse: true` in the details, so you can tell.

:::note The `timeout` option is deprecated
`pingCheck('database', { timeout: 1500 })` still works and is marked deprecated in the 12.0.0 type declarations. Chain `.withTimeout(1500)` instead — same effect, and the builder also gives you `.cacheFor()`.
:::

## The built-in indicators

| Indicator | Call | Needs |
| --- | --- | --- |
| `TypeOrmHealthIndicator` | `pingCheck(key, { connection? })` | `typeorm`, `@nestjs/typeorm` |
| `MongooseHealthIndicator` | `pingCheck(key, { connection? })` | `mongoose`, `@nestjs/mongoose` |
| `PrismaHealthIndicator` | `pingCheck(key, prismaClient)` | `@prisma/client` |
| `SequelizeHealthIndicator`, `MikroOrmHealthIndicator` | `pingCheck(key, …)` | the respective packages |
| `MemoryHealthIndicator` | `checkHeap(key, bytes)`, `checkRSS(key, bytes)` | — |
| `DiskHealthIndicator` | `checkStorage(key, { path, threshold })` or `{ path, thresholdPercent }` | — |
| `HttpHealthIndicator` | `pingCheck(key, url)` | `@nestjs/axios` |
| `MicroserviceHealthIndicator`, `GrpcHealthIndicator` | transport checks | `@nestjs/microservices` |

The TypeORM and Mongoose indicators resolve the connection from the DI context when you do not pass one, which is why the controller above needs no `@InjectDataSource`. Pass `{ connection }` when you have more than one — a reporting replica, a second Mongo cluster.

`PrismaHealthIndicator` takes the client explicitly because Prisma's client is your own provider, not one Terminus registered.

**`DiskHealthIndicator` belongs in readiness, not liveness**, on anything that writes: a full disk stops the process serving but a restart does not empty it.

```ts
() => this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 })
```

`threshold` is in bytes of *used* space; `thresholdPercent` is a fraction (`0.9` means "fail above 90% used"). The two are mutually exclusive in the type.

**There is no built-in Redis indicator** in `@nestjs/terminus` 12.0.0 — the exported indicator list is HTTP, Mongoose, TypeORM, MikroORM, Sequelize, Prisma, microservice, gRPC, disk and memory. Redis gets a custom one, which is the next section.

## A custom indicator

`HealthIndicatorService` is the supported way to build one. `check(key)` returns a session; `.up()`, `.degraded()` and `.down()` produce a result; `.attempt(fn)` runs a function and maps throw-or-not onto down-or-up, returning the same builder with `.withTimeout()` and `.cacheFor()`.

```ts title="src/health/redis.health.ts"
import { Injectable } from '@nestjs/common'
import { HealthIndicatorService } from '@nestjs/terminus'
import { RedisService } from '../redis/redis.service.js'

@Injectable()
export class RedisHealthIndicator {
  private readonly indicator: HealthIndicatorService
  private readonly redis: RedisService

  constructor(indicator: HealthIndicatorService, redis: RedisService) {
    this.indicator = indicator
    this.redis = redis
  }

  async isHealthy(key: string) {
    const session = this.indicator.check(key)
    try {
      const started = Date.now()
      await this.redis.raw.ping()
      return session.up({ latencyMs: Date.now() - started })
    } catch (err) {
      // DEGRADED, not down: the cache being unavailable makes the service
      // slower, not incorrect, so it must not take the fleet out of rotation.
      return session.degraded({ message: (err as Error).message })
    }
  }
}
```

`degraded` is the piece of Terminus 12 worth knowing about. A degraded indicator does **not** fail the check: the overall `status` becomes `'degraded'` and the HTTP status stays 200. That is exactly right for an optional dependency — the operator sees the problem on the health page, and the load balancer keeps sending traffic to a process that is still able to serve.

Reserve `down` for dependencies without which the service cannot answer a single request correctly. For most applications that is the primary database and nothing else.

The `attempt` form is shorter when a throw is the only failure mode:

```ts title="src/health/search.health.ts"
isHealthy(key: string) {
  return this.indicator
    .check(key)
    .attempt(async ({ signal }) => {
      const res = await fetch(`${this.baseUrl}/_cluster/health`, { signal })
      if (!res.ok) throw new Error(`search cluster returned ${res.status}`)
      return { status: res.status }
    })
    .withTimeout(2_000)
    .cacheFor(5_000)
}
```

The callback receives an `AbortSignal` that fires when `withTimeout` elapses. Pass it to `fetch`, to the database driver, to whatever you are calling — otherwise the timeout abandons the work rather than cancelling it, and the connection stays busy.

## A dedicated health connection

A readiness probe that borrows from the application pool reports a *saturated* pool as *unready*. That instance then leaves the load balancer at the moment it is busiest, its traffic lands on the other replicas, and they saturate too. A slow query has become a full outage.

Give the probe its own pool of one:

```ts title="src/health/health-db.provider.ts"
import type { Provider } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool } from 'pg'

export const HEALTH_POOL = Symbol('HEALTH_POOL')

export const healthPoolProvider: Provider = {
  provide: HEALTH_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: 1,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 1_000,
      application_name: 'health',
    }),
}
```

```ts title="src/health/database.health.ts"
import { Inject, Injectable } from '@nestjs/common'
import { HealthIndicatorService } from '@nestjs/terminus'
import { Pool } from 'pg'
import { HEALTH_POOL } from './health-db.provider.js'

@Injectable()
export class DatabaseHealthIndicator {
  private readonly indicator: HealthIndicatorService
  private readonly pool: Pool

  constructor(indicator: HealthIndicatorService, @Inject(HEALTH_POOL) pool: Pool) {
    this.indicator = indicator
    this.pool = pool
  }

  isHealthy(key: string) {
    return this.indicator
      .check(key)
      // The cheapest statement the database offers. It is testing
      // connectivity, not correctness — never query a real table.
      .attempt(async () => {
        await this.pool.query('SELECT 1')
      })
      .withTimeout(1_000)
      .cacheFor(3_000)
  }
}
```

`SELECT count(*) FROM orders` as a health check is a sequential scan every few seconds on every replica, forever — a self-inflicted load generator that grows with your data. `SELECT 1` and nothing else.

`application_name: 'health'` means the probe's connections are identifiable in `pg_stat_activity`, which matters the first time you are wondering what is holding connections during an incident.

## Failing readiness during shutdown

The sequence that makes a rolling deploy lose zero requests: fail readiness **first**, wait for the load balancer to notice, *then* close the listener.

```ts title="src/health/shutdown.service.ts"
import { Injectable, OnApplicationShutdown } from '@nestjs/common'

@Injectable()
export class ShutdownStateService implements OnApplicationShutdown {
  private shuttingDown = false

  get isShuttingDown() {
    return this.shuttingDown
  }

  onApplicationShutdown() {
    this.shuttingDown = true
  }
}
```

```ts title="src/health/health.controller.ts"
@Get('readyz')
@HealthCheck()
readiness() {
  if (this.shutdown.isShuttingDown) {
    return this.health.check([() => this.indicator.check('shutdown').down('draining')])
  }
  return this.health.check([
    () => this.db.pingCheck('database').withTimeout(1_500).cacheFor(3_000),
    () => this.redis.isHealthy('cache'),
  ])
}
```

`TerminusModule.forRoot({ gracefulShutdownTimeoutMs })` covers the same ground at the framework level — it delays teardown so in-flight requests finish and the load balancer has time to react. Set it to at least the load balancer's health-check interval times its failure threshold, and see [Graceful shutdown](../nestjs-production/graceful-shutdown.md) for the rest of the sequence. None of it runs without `app.enableShutdownHooks()`.

## Security considerations

**A verbose health endpoint is reconnaissance.** Terminus's default body names every indicator key and, on failure, the driver's error message — which typically contains the database engine, an internal hostname, a username, and whether authentication is failing. All of that narrows an attacker's search.

Serve two endpoints. The public one returns a status word:

```ts title="src/health/health.controller.ts"
@Get('readyz')
@HealthCheck()
async readiness(@Res({ passthrough: true }) res: Response) {
  try {
    await this.health.check([() => this.db.pingCheck('database').withTimeout(1_500).cacheFor(3_000)])
    return { status: 'ok' }
  } catch {
    res.status(503)
    return { status: 'unavailable' }
  }
}
```

The detailed one goes behind a guard, or on a separate internal port:

```ts title="src/health/internal-health.controller.ts"
@Controller('internal')
@UseGuards(OperatorGuard)
export class InternalHealthController {
  @Get('health')
  @HealthCheck()
  detailed() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1_500),
      () => this.redis.isHealthy('cache'),
      () => this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 }),
      () => this.memory.checkRSS('memory_rss', 1.5 * 1024 * 1024 * 1024),
    ])
  }
}
```

**Never put pool counters, versions or commit SHAs on a public endpoint.** `{"pool":{"waiting":7,"max":10}}` tells an attacker exactly how close to the edge you are and when to push.

**Exclude the health endpoints from authentication, deliberately and narrowly.** A global `APP_GUARD` that requires a JWT will 401 the probes, and the usual fix — `@Public()` on the controller — is fine as long as the *detailed* controller is not also marked public. Check both.

**Rate-limit and cache the public probes.** An uncached `/readyz` is an unauthenticated endpoint that triggers a database query: a cheap amplification vector. `cacheFor()` already fixes this; keep it.

**Never let a health check write.** A probe that inserts a heartbeat row generates write and replication load on every replica forever, and hands an attacker a write primitive on an unauthenticated route.

**Do not include a dependency you would not act on.** A readiness check against a third-party API you call once an hour takes your whole fleet offline during someone else's outage.

## Production considerations

- **Liveness: no dependencies. Readiness: hard dependencies only.** This one rule prevents most health-check outages.
- **`withTimeout()` on every check**, at 1–2 seconds. A probe must return in well under the probe timeout.
- **`cacheFor()` just under the probe interval.** Concurrent probes then share a single round trip.
- **A dedicated `max: 1` pool for the database check**, so application saturation is not misreported as unreadiness.
- **`degraded` for optional dependencies, `down` only for hard ones.** A cache outage must not empty your load balancer.
- **`failureThreshold: 3` on liveness**, not 1 — one dropped packet should not restart a pod. Readiness can be more sensitive because the consequence is reversible.
- **Use a startup probe** for a slow boot. Otherwise liveness kills the process during a cold start and it never gets to serve.
- **Fail readiness on `SIGTERM` before closing the listener**, with a grace window, and set `gracefulShutdownTimeoutMs`.
- **`app.enableShutdownHooks()`**, or none of the shutdown behaviour runs.
- **Alert on readiness *flapping*,** not just failure. A replica cycling in and out of rotation is an undersized pool or an overloaded database.
- **Emit the same signals as metrics too.** The health page has no history; [Observability](../nestjs-production/observability.md) does.
- **Test the failure path.** Stop the database locally and confirm: readiness 503, liveness 200, process alive, and recovery with no restart when it returns.

## Common mistakes

- **A database ping in the liveness probe.** The cascading-restart failure at the top of this page.
- **No `withTimeout()`.** The probe hangs for the connection timeout and holds a connection while it does.
- **No `cacheFor()`.** Every probe from every replica hits the database; during an incident the probes are the load.
- **Using the application pool for the probe.** Saturation is reported as unreadiness and the traffic moves to the other replicas.
- **Querying a real table.** A growing sequential scan every few seconds, forever.
- **Failing readiness because Redis is down.** The whole fleet leaves rotation over a performance problem; use `degraded`.
- **Exposing the detailed Terminus body publicly.** Free reconnaissance, including the driver's error text.
- **A global auth guard that 401s the probes**, or the opposite: marking the detailed controller public along with the simple one.
- **`failureThreshold: 1` on liveness.** One blip restarts the pod.
- **No startup probe on a slow-booting service.** Liveness kills it before it is ready.
- **Not failing readiness during shutdown.** The deploy drops the requests routed to a closing process.
- **A writing health check.** Write load on every replica, plus an unauthenticated write path.
- **Passing `{ timeout }` to `pingCheck`.** Deprecated in 12.0.0; chain `.withTimeout()`.

## Related topics

- [Health checks](../databases/health-checks.md) — the cascading-restart failure in detail, caching, and safe dependency reporting.
- [Health and readiness probes](../production/health-and-readiness-probes.md) — probe configuration, thresholds and the orchestrator side.
- [Health checks with Terminus](../nestjs-libraries/terminus.md) — the rest of the Terminus surface, including HTTP and microservice indicators.
- [Health and readiness probes](../nestjs-production/health-and-readiness-probes.md) — wiring the probes into a Nest deployment.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — the drain sequence and `gracefulShutdownTimeoutMs`.
- [Connection pooling](connection-pooling.md) — why the probe needs its own connection, and what the counters mean.
- [Redis](redis.md) — why the cache is degraded rather than down.
- [Retries and timeouts](retries-and-timeouts.md) — `AbortSignal` and bounding every layer.
- [Observability](../nestjs-production/observability.md) — the metrics that make health checks unnecessary for diagnosis.
- [Safe logging](../nestjs-security/safe-logging.md) — keeping connection strings out of health-check error output.
