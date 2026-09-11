---
title: Health and readiness probes
description: Wiring Terminus endpoints to Kubernetes probes — the startup probe a Nest app usually gets for free, probe cost arithmetic, keeping global pipes and guards off the probe path, and failing readiness during shutdown.
status: current
updated: 2026-09-11
---

Three probes, three different questions, and the difference between them is entirely about what the orchestrator *does* when each one fails. [Health checks](../nestjs-databases/health-checks.md) makes that argument and shows the controller; [Health checks with Terminus](../nestjs-libraries/terminus.md) documents the package, every indicator and the attempt builder. This page is the layer above both: the probe configuration, what it costs, the Nest-specific ways a probe endpoint stops working, and how readiness ties into shutdown.

## The three probes and the numbers behind them

| Probe | Question | Failure action | Checks dependencies |
| --- | --- | --- | --- |
| **Startup** | has it finished booting? | keep waiting, then restart if it never starts | no |
| **Liveness** | is this process broken beyond recovery? | **restart the container** | **never** |
| **Readiness** | should this instance receive traffic right now? | remove from the load balancer, leave it running | yes — only the ones it cannot serve without |

```yaml title="deployment.yaml"
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          startupProbe:
            httpGet: { path: /livez, port: 3000 }
            periodSeconds: 5
            failureThreshold: 60        # 5 minutes of boot budget
          livenessProbe:
            httpGet: { path: /livez, port: 3000 }
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3         # never 1 — one GC pause is not a wedge
          readinessProbe:
            httpGet: { path: /readyz, port: 3000 }
            periodSeconds: 2            # small, so the shutdown flag is noticed
            timeoutSeconds: 2
            failureThreshold: 2
```

Three arithmetic facts hide in that block:

- **`failureThreshold × periodSeconds` on the startup probe is your entire boot budget.** 60 × 5s = 5 minutes. While the startup probe is failing, liveness and readiness are suspended, which is what lets liveness stay aggressive afterwards.
- **`failureThreshold: 1` on liveness restarts a working container** the first time a GC pause or a noisy neighbor delays one response. Three is the floor.
- **`timeoutSeconds` must be below `periodSeconds`**, or checks overlap and pile up on each other.

## A Nest app gets most of a startup probe for free

This is the Nest-specific part, and it removes a whole endpoint from most services.

`NestFactory.create()` builds the entire module graph, instantiates every provider, and runs `onModuleInit` and `onApplicationBootstrap` on all of them. Only then does `app.listen()` bind the port. So for the whole of boot there is **no listener at all**, and a probe against it gets a connection refused — which the orchestrator counts as a failure, which is exactly the behavior a startup probe wants.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  // Nothing is listening until this resolves. Every provider is constructed,
  // every onModuleInit has run, every pool is open.
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true })

  app.enableShutdownHooks()
  await app.listen(3000)
}

bootstrap()
```

Point the startup probe at `/livez` and give it a generous `failureThreshold`. You do not need a separate `/startupz` endpoint and a `booted` flag — the absence of a listener is the signal.

You **do** need an explicit startup endpoint in two cases:

- **Warm-up work happens after `listen()`** — priming a cache, loading a model, JIT-warming a hot path. The port is open and the service is not useful yet.
- **You deliberately listen early** so that a long boot does not look like a crash, which some platforms without startup probes require.

In both cases the flag must flip to ready only when boot is genuinely complete. A probe that passes before the pool is open means the first requests fail.

## Liveness checks nothing external

The rule is mechanical, not stylistic: a liveness probe may only fail for a condition a **restart would fix**. A restart does not fix someone else's database.

:::danger
A `TypeOrmHealthIndicator.pingCheck()` in the liveness endpoint is the most expensive mistake in this section. During a database failover every replica's liveness probe fails at the same instant, Kubernetes restarts every pod simultaneously, and the recovering database is hit by a reconnect storm from every cold replica. The new pods fail the same check. `CrashLoopBackOff`, with exponential backoff on top.

The database recovers in 60 seconds. Your service does not recover for twenty minutes, because it destroyed itself. The detailed walkthrough is in [Health checks](../nestjs-databases/health-checks.md).
:::

The same reasoning excludes Redis, downstream HTTP services, message brokers, disk space and feature-flag providers from liveness. `MemoryHealthIndicator.checkHeap()` is the one legitimate exception — a heap that will not come down *is* fixed by a restart.

## Probes are a load test you run against yourself

Probe cost is arithmetic and it surprises people at scale:

```text
readiness periodSeconds   2
replicas                 40
indicators per check      3
                         ---
checks per second        60   ← 20 probe requests/s, each doing 3 round trips
```

Sixty database and cache round trips a second, forever, from an unauthenticated endpoint. Three things keep it harmless:

- **`cacheFor(ms)` on every expensive indicator.** Five seconds of caching turns a two-second probe into one real check every five, with no loss of signal at the timescale an orchestrator acts on. Concurrent probes share one in-flight run.
- **`withTimeout(ms)` on every network indicator.** Without it a hung database makes the probe hang, the orchestrator times out, and you have learned the same thing more slowly and while holding a connection.
- **Cheap checks only.** `SELECT 1` through the existing pool. Never a count, never an aggregate, never a migration-status query, and never a fresh connection per probe — that last one is a slow leak that surfaces as `too many clients` at the worst possible moment.

```ts
// One real check every five seconds per replica, bounded at 1.5s.
() => this.db.pingCheck('database').withTimeout(1_500).cacheFor(5_000)
```

:::warning
Be strict about what "required" means in readiness. Every dependency you mark required is a dependency whose outage becomes *your* outage, fleet-wide and simultaneously. If a request can be served — even degraded — without it, it is not required.

Terminus's `degraded()` status is built for exactly this: the indicator reports the problem, the overall status becomes `degraded`, and the endpoint still returns 200 so the load balancer keeps sending traffic. A cache being down should be `degraded`, not `down`.
:::

## Keeping the global pipeline off the probe path

This is where Nest breaks probes in ways plain Express does not. Everything you register globally applies to the health controller too, and each of these has taken a fleet down at least once somewhere.

| Global thing | What it does to a probe | Fix |
| --- | --- | --- |
| An authentication guard | every probe is 401 → orchestrator reads "unhealthy" → the deployment never becomes ready | `@Public()` (a metadata decorator your guard honors) on the health routes |
| `ThrottlerGuard` | a probe every second eventually trips the limiter; 429 is a failed probe → restarts under load | `@SkipThrottle()`, or `skipIf` on the probe paths |
| `app.setGlobalPrefix('api')` | the probes move to `/api/livez` while the manifest still says `/livez` | `exclude` the health paths, or update the manifest — but pick one |
| A global response-envelope interceptor | the Terminus body is wrapped; status codes still work, dashboards do not | exclude the controller, or accept the shape change knowingly |
| A global exception filter that normalizes everything to 200 | **a failing readiness check reports healthy** | never map a 503 to a 200; the platform reads the status code |
| An HTTP access logger | 86,400 identical lines per replica per day | exclude the probe paths from `autoLogging` |

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

export async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // The probes stay at the root; everything else moves under /api.
  app.setGlobalPrefix('api', { exclude: ['livez', 'readyz'] })

  await app.listen(3000)
}
```

```ts title="src/health/health.controller.ts"
import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, MemoryHealthIndicator, TypeOrmHealthIndicator } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import { Public } from '../auth/decorators/public.decorator.js'

@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  private readonly health: HealthCheckService
  private readonly memory: MemoryHealthIndicator
  private readonly db: TypeOrmHealthIndicator

  constructor(
    health: HealthCheckService,
    memory: MemoryHealthIndicator,
    db: TypeOrmHealthIndicator,
  ) {
    this.health = health
    this.memory = memory
    this.db = db
  }

  @Get('livez')
  @HealthCheck()
  liveness() {
    // No I/O. A heap that will not come down IS fixed by a restart.
    return this.health.check([
      () => this.memory.checkHeap('heap', 1024 * 1024 * 1024),
    ])
  }

  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1_500).cacheFor(5_000),
    ])
  }
}
```

:::warning
Versioning is the quiet one. If you enable URI versioning globally, `/livez` becomes `/v1/livez` and the probe 404s — which the orchestrator reads as unhealthy. `VERSION_NEUTRAL` on the health controller keeps it reachable at the unversioned path. See [Versioning](../nestjs-request-handling/versioning.md).
:::

## Readiness is the first step of shutdown

Readiness earns its place at deploy time more than at run time.

When `SIGTERM` arrives, the load balancer has **not** stopped routing to you yet — endpoint removal is asynchronous and takes a second or more to propagate through kube-proxy, the ingress controller and any cloud load balancer. If you close the socket immediately, every request that arrives in that window is a connection refused, which the proxy reports as a 502.

So the sequence is: readiness fails first, the process keeps serving normally for a few seconds, and only then does anything close.

With `@nestjs/terminus`, `gracefulShutdownTimeoutMs` implements exactly that window — readiness starts reporting `shutting_down` and the application waits before tearing down:

```ts title="src/health/health.module.ts"
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HealthController } from './health.controller.js'

@Module({
  imports: [
    TerminusModule.forRoot({
      errorLogStyle: 'json',
      gracefulShutdownTimeoutMs: 5_000,
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
```

It does nothing without `app.enableShutdownHooks()`, because nothing tells Terminus that shutdown has begun. Two configuration values have to agree with it:

- **`readinessProbe.periodSeconds` must be small** — 2 with `failureThreshold: 2` means the flip is observed in about four seconds. A period of 30 means the flag is noticed long after the socket closed.
- **`gracefulShutdownTimeoutMs` + your drain must fit inside `terminationGracePeriodSeconds`.** Too short and you drop requests; too long and `SIGKILL` arrives mid-drain anyway.

The full sequence is in [Graceful shutdown](graceful-shutdown.md).

### Shedding load with readiness

The flag has a second, riskier use: fail readiness while the instance is genuinely overloaded — event-loop delay through the roof, connection pool fully saturated — so the load balancer moves traffic to healthier replicas.

Use it carefully. If load is uniform across the fleet, every replica goes unready at the same moment and you have taken yourself down more thoroughly than the overload would have. It only helps when the imbalance is real.

## What the body may say

The status code is what the platform reads. The body is for a human with `curl`, and it is effectively public — the kubelet cannot authenticate, and anything reachable inside the cluster is reachable by everything inside the cluster.

```json title="GET /readyz — 503"
{
  "status": "error",
  "info": {},
  "error": { "database": { "status": "down" } },
  "details": { "database": { "status": "down" } }
}
```

`"status": "down"` is everything an operator needs to start looking. What must never appear: the driver's error string (it routinely contains a hostname and a username), a connection string, an internal hostname, a version number, or anything from `process.env`. Terminus's `errorLogStyle` controls the *log*, not the body — sanitize whatever you pass to `down()` yourself.

Two more rules that are easy to get wrong:

- **200 or 503, never 500 and never a 200 with a failing body.** The orchestrator reads the code.
- **Do not cache the response.** `@HealthCheck()` sets `Cache-Control: no-cache, no-store, must-revalidate` by default; leave it alone.

## Test the database-down case

The only way to know your liveness probe is honest is to break the database and watch.

```bash
# In staging: stop the database, then watch the pods.
kubectl scale statefulset postgres --replicas=0
kubectl get pods -w
```

The correct outcome is pods going **`Running` but not `Ready`**, staying up, and rejoining the pool the moment the database returns. If they enter `CrashLoopBackOff`, your liveness probe is checking a dependency and you have just found the bug before it found you.

Two more things worth watching in production:

- **Probe failure rate as a metric.** A pod that flaps between ready and not-ready is dropping requests at every transition, and it is invisible unless you count it.
- **Time from `SIGTERM` to process exit.** A creeping p99 predicts the deploy where the grace period starts being hit.

## Common mistakes

- **Any dependency check in liveness.** One database blip restarts every replica simultaneously and turns a 60-second problem into a 20-minute outage.
- **One endpoint wired to both probes.** They have opposite failure semantics; sharing them gives you the worse of both.
- **Marking a cache as a required readiness dependency.** Redis blips, every replica goes unready, you have an outage over something you could have degraded through.
- **Forgetting `@Public()` under a global auth guard.** Every probe is 401 and the deployment never becomes ready.
- **Leaving the probes inside the throttler.** 429 is a failed probe, and under load it restarts healthy pods.
- **`setGlobalPrefix` without excluding the health paths.** The probes move and the manifest does not.
- **URI versioning applied to the health controller.** `/livez` becomes `/v1/livez` and 404s.
- **A global filter or interceptor that turns a 503 into a 200.** The orchestrator believes you.
- **No `withTimeout` on a network indicator.** The probe hangs instead of failing fast.
- **No `cacheFor` on an expensive indicator.** Forty replicas probing every two seconds is a self-inflicted load test.
- **Opening a connection per probe instead of using the pool.** A steady leak that surfaces as connection exhaustion.
- **`failureThreshold: 1` on liveness.** One GC pause restarts a working container.
- **`readinessProbe.periodSeconds: 30`.** The shutdown flag is observed long after you needed it.
- **A startup probe with too small a budget.** A slow boot is killed and restarted forever, and it never starts.
- **Leaking the driver error into the body.** Hostnames and usernames on an unauthenticated endpoint.
- **Logging every probe request.** Your logs become 95% `GET /readyz 200`.
- **Never testing the database-down case.** You find out which probe checks what during the incident.

## Related topics

- [Health checks](../nestjs-databases/health-checks.md) — the probe-design argument and the controller, in depth.
- [Health checks with Terminus](../nestjs-libraries/terminus.md) — `TerminusModule` options, every indicator, and custom indicators.
- [Health and readiness probes](../production/health-and-readiness-probes.md) — the Node-level version, including the event-loop-aware liveness check.
- [Graceful shutdown](graceful-shutdown.md) — the sequence readiness starts, and `gracefulShutdownTimeoutMs`.
- [Rate limiting with Throttler](../nestjs-libraries/throttler.md) — `@SkipThrottle()` and `skipIf`.
- [Versioning](../nestjs-request-handling/versioning.md) — `VERSION_NEUTRAL` for the health controller.
- [Guards](../nestjs-request-handling/guards.md) — the global guard that needs a `@Public()` escape hatch.
- [Clustering](clustering.md) — why a clustered pod's readiness signal is weaker than it looks.
- [Observability](observability.md) — excluding probe paths from logs while keeping them in metrics.
- [Docker](docker.md) — the container `HEALTHCHECK`, and how it differs from a probe.
- [Deployment checklist](deployment-checklist.md) — the probe items to verify before shipping.
