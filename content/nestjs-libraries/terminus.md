---
title: Health checks with Terminus
description: The @nestjs/terminus 12.0.0 package itself — TerminusModule options, HealthCheckService, the complete indicator list, custom indicators with HealthIndicatorService, and separate liveness and readiness endpoints.
status: current
updated: 2026-09-11
---

`@nestjs/terminus` is **12.0.0**. It gives you a `HealthCheckService` that runs a list of indicator functions concurrently and renders a consistent JSON result, a set of built-in indicators, and a `HealthIndicatorService` for writing your own. This page is the package. Which checks belong in which probe — the judgement call that decides whether a 60-second database failover becomes a 20-minute outage — is [Health checks](../nestjs-databases/health-checks.md), and it is the one to read first.

## Installing

```bash
npm install @nestjs/terminus@12.0.0
```

Engines are `^20.19.0 || ^22.12.0 || >=24.0.0`, and it peers on `@nestjs/common` and `@nestjs/core` 11 or 12. The database indicators are **optional** peers: `TypeOrmHealthIndicator` needs `typeorm` and `@nestjs/typeorm`, `PrismaHealthIndicator` needs `@prisma/client`, `MongooseHealthIndicator` needs `mongoose` and `@nestjs/mongoose`. You install only the ones you use.

## Registering the module

```ts title="src/health/health.module.ts"
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HttpModule } from '@nestjs/axios'
import { HealthController } from './health.controller.js'
import { QueueHealthIndicator } from './queue.health.js'

@Module({
  imports: [
    TerminusModule.forRoot({
      errorLogStyle: 'json',
      gracefulShutdownTimeoutMs: 5000,
    }),
    HttpModule,
  ],
  controllers: [HealthController],
  providers: [QueueHealthIndicator],
})
export class HealthModule {}
```

`TerminusModuleOptions` has exactly three fields in 12.0.0:

| Option | Default | Effect |
| --- | --- | --- |
| `errorLogStyle` | `'json'` | `'json'` or `'pretty'` — how a failed check is written to the log |
| `logger` | the Nest logger | a `LoggerService` class, or `false` to silence it |
| `gracefulShutdownTimeoutMs` | `0` | how long readiness keeps reporting `shutting_down` before the app stops |

`TerminusModule` with no `forRoot()` works and takes the defaults. Use `forRootAsync()` when the logger or the timeout comes from configuration; note that the async form takes a resolved `LoggerService` **instance** or a boolean, not a class.

`HttpModule` from `@nestjs/axios` is only needed if you use `HttpHealthIndicator` — the indicator resolves the HTTP service at call time and throws a clear error if the module is missing.

## The controller

```ts title="src/health/health.controller.ts"
import { Controller, Get } from '@nestjs/common'
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  HttpHealthIndicator,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus'
import { Public } from '../auth/decorators/public.decorator.js'

@Controller()
export class HealthController {
  private readonly health: HealthCheckService
  private readonly db: TypeOrmHealthIndicator
  private readonly http: HttpHealthIndicator
  private readonly memory: MemoryHealthIndicator
  private readonly disk: DiskHealthIndicator

  constructor(
    health: HealthCheckService,
    db: TypeOrmHealthIndicator,
    http: HttpHealthIndicator,
    memory: MemoryHealthIndicator,
    disk: DiskHealthIndicator,
  ) {
    this.health = health
    this.db = db
    this.http = http
    this.memory = memory
    this.disk = disk
  }

  // Liveness: only conditions a restart would fix.
  @Public()
  @Get('livez')
  @HealthCheck()
  liveness() {
    return this.health.check([
      () => this.memory.checkHeap('heap', 512 * 1024 * 1024),
    ])
  }

  // Readiness: everything this instance needs in order to serve a request.
  @Public()
  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1500),
      () => this.http.pingCheck('payments', 'https://payments.example.com/status', { timeout: 800 }),
      () => this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 }),
    ])
  }
}
```

`HealthCheckService.check()` takes an array of thunks, runs them concurrently, and aggregates. The array order does not imply execution order, and one slow indicator delays the whole response — which is why every network check needs a timeout.

`@HealthCheck()` does two things and takes two options:

| Option | Default | Effect |
| --- | --- | --- |
| `noCache` | `true` | sets `Cache-Control: no-cache, no-store, must-revalidate` |
| `swaggerDocumentation` | `true` | documents the endpoint when `@nestjs/swagger` is installed |

A cached health response is a health response that tells you about the past, so leave `noCache` alone unless you have a proxy that demands otherwise.

### The response shape

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" } },
  "error": {},
  "details": { "database": { "status": "up" } }
}
```

`status` is `'ok' | 'error' | 'degraded' | 'shutting_down'`. `info` holds every indicator that is `up` or `degraded`, `error` holds every `down`, and `details` holds all of them. A failing check returns **503 Service Unavailable**; `ok` and `degraded` both return 200.

`degraded` is the useful middle state: an indicator marks itself degraded when it is impaired but still serving, the overall status becomes `degraded`, and the endpoint still returns 200 — so the load balancer keeps sending traffic while your monitoring sees that something is wrong.

## The built-in indicators

Read from the package's own `dist/health-indicator/index.d.ts`, this is the complete exported set in 12.0.0:

| Indicator | Method | Needs |
| --- | --- | --- |
| `HttpHealthIndicator` | `pingCheck(key, url, options)`, `responseCheck(key, url, predicate, options)` | `@nestjs/axios` |
| `TypeOrmHealthIndicator` | `pingCheck(key, options)` | `typeorm`, `@nestjs/typeorm` |
| `MongooseHealthIndicator` | `pingCheck(key, options)` | `mongoose`, `@nestjs/mongoose` |
| `SequelizeHealthIndicator` | `pingCheck(key, options)` | `sequelize` |
| `MikroOrmHealthIndicator` | `pingCheck(key, options)` | `@mikro-orm/core` |
| `PrismaHealthIndicator` | `pingCheck(key, client)` | `@prisma/client` |
| `MicroserviceHealthIndicator` | `pingCheck(key, options)` | `@nestjs/microservices` |
| `GRPCHealthIndicator` | `checkService(key, service, options)` | `@grpc/grpc-js` |
| `MemoryHealthIndicator` | `checkHeap(key, bytes)`, `checkRSS(key, bytes)` | — |
| `DiskHealthIndicator` | `checkStorage(key, options)` | — |
| `HealthIndicatorService` | `check(key)` | — (for custom indicators) |

:::warning There is no Redis indicator
Terminus 12.0.0 ships **no** Redis, Valkey or Memcached health indicator. "redis" appears in the package's npm `keywords` array — which is search metadata, not an export — and that is enough to make plausible-looking `RedisHealthIndicator` examples circulate. Importing one produces a module-resolution error at build time, which is at least loud.

Check a cache or a rate-limit store with a custom indicator, which is the next section.
:::

`DiskHealthIndicator.checkStorage` takes **either** `threshold` (bytes) or `thresholdPercent` (a fraction, so `0.9` is 90%) alongside `path` — the type is an exclusive union, so passing both is a compile error. `MemoryHealthIndicator` thresholds are in bytes.

### The attempt builder

`TypeOrmHealthIndicator.pingCheck()` returns a `HealthCheckAttempt` rather than a promise, and the builder is where timeouts and caching live:

```ts
() => this.db.pingCheck('database').withTimeout(1500).cacheFor(5000)
```

| Method | Effect |
| --- | --- |
| `withTimeout(ms)` | mark the indicator `down` if it has not resolved; an `AbortSignal` is passed to the callback so the work can be cancelled |
| `cacheFor(ttlMs)` | reuse a fresh result instead of re-running; concurrent executions share one in-flight run, and a served result is tagged `cachedResponse: true` |

`cacheFor` is how you stop a probe every second from becoming a query every second. The `timeout` field on `TypeOrmPingCheckSettings` still exists but is **deprecated in 12.0.0** in favour of `withTimeout(ms)`.

## Writing a custom indicator

`HealthIndicatorService` is the supported way. `check(key)` returns a session with `up()`, `down()`, `degraded()` and `attempt()`.

```ts title="src/health/queue.health.ts"
import { Injectable } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { HealthIndicatorService } from '@nestjs/terminus'
import type { HealthIndicatorResult } from '@nestjs/terminus'
import { Queue } from 'bullmq'

const BACKLOG_WARN = 1_000
const BACKLOG_FAIL = 20_000

@Injectable()
export class QueueHealthIndicator {
  private readonly indicator: HealthIndicatorService
  private readonly queue: Queue

  constructor(indicator: HealthIndicatorService, @InjectQueue('emails') queue: Queue) {
    this.indicator = indicator
    this.queue = queue
  }

  async check(key = 'emailQueue'): Promise<HealthIndicatorResult> {
    const session = this.indicator.check(key)
    try {
      const waiting = await this.queue.getWaitingCount()
      if (waiting > BACKLOG_FAIL) return session.down({ waiting })
      if (waiting > BACKLOG_WARN) return session.degraded({ waiting })
      return session.up({ waiting })
    } catch (error) {
      return session.down({ message: (error as Error).message })
    }
  }
}
```

The `status` key is reserved — the types refuse it in the data object, because the session sets it.

For a check that is simply "does this call throw", `attempt()` is shorter and gives you the timeout and cache for free:

```ts title="src/health/cache.health.ts"
import { Inject, Injectable } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { HealthIndicatorService } from '@nestjs/terminus'
import type { Cache } from '@nestjs/cache-manager'

@Injectable()
export class CacheHealthIndicator {
  private readonly indicator: HealthIndicatorService
  private readonly cache: Cache

  constructor(indicator: HealthIndicatorService, @Inject(CACHE_MANAGER) cache: Cache) {
    this.indicator = indicator
    this.cache = cache
  }

  check(key = 'cache') {
    return this.indicator
      .check(key)
      .attempt(async () => {
        await this.cache.set('health:probe', Date.now(), 5_000)
        const value = await this.cache.get<number>('health:probe')
        if (value === undefined) throw new Error('cache round trip failed')
      })
      .withTimeout(500)
      .cacheFor(5_000)
  }
}
```

That is also the answer to the missing Redis indicator: probe the client you already have, through the abstraction you already use, with a timeout you chose.

:::best-practice
A custom indicator should exercise the dependency the way the application does. A TCP connect proves a socket opens; a `SET` followed by a `GET` proves the thing actually works. Keep it to one cheap round trip — a health check that is expensive is a health check that causes outages under load.
:::

## Liveness, readiness, and shutdown

The split is not stylistic. It is determined by what the orchestrator *does* on failure: liveness failing **restarts the container**, readiness failing **removes it from the load balancer**. So the rule follows mechanically — a liveness probe may only fail for conditions a restart would fix, and an unreachable database is not one of them.

`gracefulShutdownTimeoutMs` is Terminus's contribution to the shutdown sequence. With shutdown hooks enabled, a `SIGTERM` flips readiness to `shutting_down` — so the load balancer stops sending new requests — and the process then waits that long before tearing down, giving in-flight requests time to finish.

```ts title="src/main.ts"
const app = await NestFactory.create(AppModule)
app.enableShutdownHooks()
```

Without `enableShutdownHooks()` the timeout does nothing, because nothing tells Terminus that shutdown has begun. [Graceful shutdown](../nestjs-production/graceful-shutdown.md) covers the rest of the sequence, and [Health and readiness probes](../nestjs-production/health-and-readiness-probes.md) covers the orchestrator side.

## Security considerations

**A health endpoint is unauthenticated by necessity** — the kubelet has no token. That makes whatever it returns public to anything that can reach the port.

**Do not leak topology in the response.** A failing indicator's message can carry a hostname, a port, a connection string, or a driver error naming your schema. `errorLogStyle` controls the *log*, not the body, so sanitize the data you put in `down()` yourself.

**Do not expose the detailed probe on a public interface.** The usual shape is a bare liveness endpoint on the public listener and the detailed readiness endpoint on an internal port or network policy. Failing that, `@Public()` it but keep the detail minimal.

**Exempt the probes from rate limiting.** A probe every second against a burst limiter eventually reports your healthy service as unhealthy, and then the orchestrator restarts it. `skipIf`, or `@SkipThrottle` naming every throttler — see [Rate limiting with Throttler](throttler.md).

**Exclude the probes from access logs.** A one-second probe is 86,400 identical lines per instance per day, which you pay to ingest and which buries the lines you need.

**A health check is a request amplifier.** An endpoint that opens a database connection per call, reachable by anyone, is a denial-of-service primitive. `cacheFor` closes that, and a cheap indicator closes it further.

**`DiskHealthIndicator` reads a real filesystem path.** Make sure the path is one the process is meant to see; do not make it configurable from anything a caller controls.

## Production considerations

**Give every network indicator a timeout.** `check()` waits for the slowest thunk; one indicator with no timeout means the probe can hang until the orchestrator's own timeout fires, which it will read as a failure.

**Set the probe timeouts and the orchestrator's timeouts consistently.** An indicator with a 1.5-second timeout behind a probe with a 1-second timeout will never report anything but a timeout.

**`cacheFor` on the expensive indicators.** Five seconds of caching turns a one-second probe into one real check every five, with no loss of signal at the timescales an orchestrator acts on.

**Use `degraded` rather than `down` for impaired-but-serving dependencies.** A cache that is unreachable should not pull the instance out of the load balancer if the application still answers from the database. `degraded` keeps the 200 and still shows up in monitoring.

**Set `gracefulShutdownTimeoutMs` to slightly more than your longest in-flight request**, and make sure it is less than the orchestrator's termination grace period. Too short drops requests; too long and the platform kills the process mid-flight anyway.

**Probe the dependencies this instance needs, not the whole system.** A readiness check that fails because a downstream service you call once an hour is down removes a perfectly serviceable instance from rotation.

**Alert on the probe's own result, not just on restarts.** By the time the orchestrator restarts a container, the `degraded` window that preceded it has already told you what happened — if you were recording it.

## Common mistakes

- **Putting a database check in liveness.** A database failover then restarts every replica, all of which come back and fail the same check. This is the most expensive mistake on the page.
- **Importing a `RedisHealthIndicator`.** There is no such export in 12.0.0. Write a custom indicator.
- **No timeout on an HTTP or database indicator.** The probe hangs and the orchestrator calls it a failure.
- **Both `threshold` and `thresholdPercent` on `checkStorage`.** They are an exclusive union.
- **Treating `thresholdPercent: 90` as ninety percent.** It is a fraction: `0.9`.
- **Forgetting `@Public()` on the probes** under a global authentication guard. Every probe returns 401, the orchestrator reads that as unhealthy, and the deployment never becomes ready.
- **Forgetting `enableShutdownHooks()`** while relying on `gracefulShutdownTimeoutMs`. The timeout is never armed.
- **Leaving the probes in the rate limiter.** Self-inflicted restarts under load.
- **Logging every probe.** Tens of thousands of identical lines per instance per day.
- **Returning the raw driver error in `down()`.** Hostnames and connection strings, published on an unauthenticated endpoint.
- **Using `TerminusModule` without `HttpModule` while calling `HttpHealthIndicator`.** It fails at call time, not at boot.
- **One endpoint serving both probes.** The two have opposite failure semantics; sharing them means you get the worse of both.

## Related topics

- [Health checks](../nestjs-databases/health-checks.md) — probe design, the database connection to use, and failing readiness during shutdown, in depth.
- [Health and readiness probes](../nestjs-production/health-and-readiness-probes.md) — the orchestrator side: periods, thresholds and grace periods.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — what `gracefulShutdownTimeoutMs` fits into.
- [Rate limiting with Throttler](throttler.md) — exempting the probe routes.
- [Caching](cache-manager.md) — the `CACHE_MANAGER` token the custom cache indicator injects.
- [Background jobs with BullMQ](bullmq.md) — the queue the backlog indicator inspects.
- [Logging](logging.md) — keeping probe traffic out of the log platform.
- [Observability with @nestjs/observe](observe.md) — health checks are one signal among three.
- [Health checks](../databases/health-checks.md) — the framework-independent version of the probe argument.
