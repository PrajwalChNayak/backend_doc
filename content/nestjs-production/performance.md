---
title: Performance
description: Measuring a Nest service before tuning it — where DI costs nothing and where REQUEST scope costs a lot, serialization, the Fastify adapter, caching, and the database that dominates all of it.
status: current
updated: 2026-09-11
---

Almost every Nest performance discussion starts in the wrong place: whether the framework is "slower than Express", whether to switch to Fastify, whether decorators cost something. The measurable answer in a real service is that framework overhead is under one percent of a request and the database is sixty to ninety percent of it. There is exactly one Nest-specific construct that genuinely costs real money at request time, and it is not the one people argue about. The Node-level material — profiling tools, synchronous APIs, connection reuse, realistic numbers — is in [Performance](../production/performance.md) and applies unchanged.

## Measure first

You cannot reason your way to a bottleneck. Three tools, three questions.

```bash
# Latency distribution for one endpoint. -c connections, -d seconds.
npx autocannon -c 100 -d 30 http://localhost:3000/orders

# Where the CPU actually went. Apply load, then SIGINT, then open the
# .cpuprofile in Chrome DevTools or VS Code and read it bottom-up by self time.
node --cpu-prof --cpu-prof-dir=./profiles dist/main.js
```

Two rules that decide whether the numbers mean anything:

- **Profile the built output, never `nest start --watch`.** The watch server has a file watcher, an incompatible module resolution, and often `--no-type-check`. You would be profiling the dev harness.
- **Profile against a realistic dataset.** A benchmark against an empty table on a laptop measures your JSON serializer. Production has ten million rows, a network hop, TLS, cold caches and a pool shared with forty replicas.

A wide, flat profile full of libuv and V8 internals means you are I/O-bound and there is no CPU problem to solve. That is the normal result for an API, and it is the single most useful thing a profile can tell you.

## The event loop is the bottleneck

Nest runs on one thread like anything else in Node. Every millisecond spent executing JavaScript is a millisecond no other request is served.

**Event-loop delay is the one number that says whether you have a CPU problem at all.** Expose it as a provider so it is available to metrics and to a probe:

```ts title="src/metrics/event-loop.service.ts"
import { Injectable } from '@nestjs/common'
import type { OnModuleInit, OnApplicationShutdown } from '@nestjs/common'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { IntervalHistogram } from 'node:perf_hooks'

@Injectable()
export class EventLoopService implements OnModuleInit, OnApplicationShutdown {
  private readonly histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 })

  onModuleInit() {
    this.histogram.enable()
  }

  onApplicationShutdown() {
    this.histogram.disable()
  }

  /** Values from the histogram are nanoseconds. */
  snapshot() {
    return {
      meanMs: this.histogram.mean / 1e6,
      p50Ms: this.histogram.percentile(50) / 1e6,
      p99Ms: this.histogram.percentile(99) / 1e6,
      maxMs: this.histogram.max / 1e6,
    }
  }

  /** Call after each metrics scrape so percentiles reflect the current window. */
  reset() {
    this.histogram.reset()
  }
}
```

| p99 delay under load | Diagnosis | What to do |
| --- | --- | --- |
| under ~10 ms | I/O bound — the thread is idle, waiting | look at the database and downstream calls; more CPU will not help |
| 10–50 ms | something synchronous is on the request path | profile and find the blocking call |
| over 100 ms | users feel it directly | fix this before anything else; more replicas will not help |

This is also the honest answer to "should we cluster?" — near-zero delay under load means more processes buy you nothing. See [Clustering](clustering.md).

## Where Nest's DI costs nothing

Dependency injection resolution happens **at bootstrap**, not per request. `NestFactory.create()` reads the decorator metadata, builds the dependency graph, and constructs every `Scope.DEFAULT` provider exactly once. After that a controller holds a plain reference to a service, and calling it is an ordinary method call.

So the cost of the container is paid in **boot time**, which grows with the size of the module graph — and boot time matters for cold starts, scale-ups and rolling deploys, not for p99 latency.

What is *not* free per request, in rough order of cost:

| Per-request work | Typical cost | Notes |
| --- | --- | --- |
| Route matching (path-to-regexp 8) | microseconds | the same code Express 5 runs |
| Guards, interceptors, pipes, filters | microseconds each | the pipeline itself is cheap; what you put in it may not be |
| `ValidationPipe` with `transform: true` | microseconds to milliseconds | scales with payload size and DTO depth |
| `ClassSerializerInterceptor` | **milliseconds on large arrays** | `plainToInstance` walks every object and every property |
| An RxJS operator chain in an interceptor | microseconds | negligible unless you added a `delay` |
| **A `REQUEST`-scoped provider** | **a whole subtree instantiated per request** | see below |

The first four are noise next to one database query. The last one is not.

## `REQUEST` scope is the real cost

This is the Nest-specific performance trap, and it is a design decision rather than a tuning knob.

A `Scope.REQUEST` provider is constructed fresh for every request — and **scope bubbles up**. Every provider that injects a request-scoped provider becomes request-scoped itself, and so does the controller that injects *that*. One innocuous provider deep in a service can silently convert an entire branch of your module graph into per-request instantiation.

```ts title="Don't: scope bubbles to everything above it"
import { Injectable, Scope, Inject } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import type { Request } from 'express'

@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  private readonly tenantId: string

  constructor(@Inject(REQUEST) request: Request) {
    this.tenantId = String(request.headers['x-tenant-id'] ?? 'public')
  }

  get id() {
    return this.tenantId
  }
}
```

Inject that into `OrdersService`, and `OrdersService` is now request-scoped. Inject `OrdersService` into `OrdersController`, and the controller is request-scoped too — so on every request Nest constructs a controller, a service, and everything else in that subtree. Nest also cannot cache the resolved handler for a request-scoped route, so there is per-request container work on top of the allocations.

The fix is almost always `AsyncLocalStorage`, which carries per-request state through the async call chain without touching the DI graph at all:

```ts good title="src/context/request-context.service.ts"
import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestStore {
  requestId: string
  tenantId: string
  userId?: string
}

// A plain singleton. Nothing in the graph becomes request-scoped.
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestStore>()

  run<T>(store: RequestStore, callback: () => T): T {
    return this.storage.run(store, callback)
  }

  get(): RequestStore | undefined {
    return this.storage.getStore()
  }

  get tenantId(): string {
    return this.storage.getStore()?.tenantId ?? 'public'
  }
}
```

Open the store once in middleware, and every singleton below can read it. Same capability, no scope propagation, no per-request construction. The full comparison — including the cases where `REQUEST` scope genuinely is the right answer, such as a per-tenant database connection — is in [Injection scopes](../nestjs/injection-scopes.md).

:::warning
`Scope.TRANSIENT` has the same bubbling behavior for a different reason: each consumer gets its own instance. It is cheaper than `REQUEST` because instances are not rebuilt per request, but it still multiplies object count and it still surprises people who expected a singleton.

Audit for both before a load test. `grep -r "Scope.REQUEST" src/` takes a second and is frequently the highest-value line of performance work available in a Nest codebase.
:::

## Serialization

`ClassSerializerInterceptor` is the Nest-specific cost that shows up in a CPU profile. It runs `class-transformer`'s `instanceToPlain` over the returned value, which walks every object and every property, applies `@Exclude`/`@Expose` metadata, and allocates a new object graph. On a single record that is microseconds. On a 2,000-item list with nested relations it is tens of milliseconds — of blocked event loop, per request.

The fix is almost never a faster serializer. It is **returning less**:

- **Paginate, with a server-enforced maximum.** An endpoint that can return an unbounded list is a denial-of-service vector as well as a performance problem — never trust the client's `limit`.
- **Select the columns you need.** `SELECT *` on a table with a `text` column pays for that column three times: off disk, over the network, and through the serializer.
- **Do not embed every relation.** A list endpoint that inlines everything is how a 2 KB response becomes 2 MB. Return ids and let the client fetch what it needs.
- **Apply the interceptor per-controller, not globally**, if only a few endpoints need `@Exclude` semantics. A global interceptor pays the walk on every response including ones with nothing to hide.

A Standard Schema (Zod 4) response schema is a reasonable alternative when the transform is simple: it validates and strips in one pass without building a class instance. `StandardSchemaSerializerInterceptor` is the v12 equivalent — see [Serialization](../nestjs-validation/serialization.md).

The same reasoning applies on the way in. `ValidationPipe` with `transform: true` runs `plainToInstance` on every request body; that is correct and worth it, and it is also proportional to body size. Cap the body size at the parser and the cost is bounded.

## The Fastify adapter

`@nestjs/platform-fastify` 12.0.1 is a supported alternative to `@nestjs/platform-express` 12.0.1. Fastify's HTTP layer and its schema-based serializer are genuinely faster than Express plus `JSON.stringify` on a synthetic benchmark.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  )
  app.enableShutdownHooks()
  // Fastify binds to localhost by default; in a container you need 0.0.0.0.
  await app.listen(3000, '0.0.0.0')
}

bootstrap()
```

Be honest about what that buys you. A benchmark comparing empty handlers is measuring the one to two percent of a real request that is framework overhead. If your handler does one indexed query, switching adapters moves your p99 by an amount you will struggle to distinguish from noise.

What it costs is real and immediate:

| Cost | Detail |
| --- | --- |
| Express middleware stops working | anything typed against Express `Request`/`Response`, and any `app.use()` of an Express-shaped middleware |
| `@Res()` handlers change | the underlying object is a Fastify reply, not an Express response |
| The ecosystem differs | Fastify plugins instead of Express middleware for CORS, helmet, static files, multipart |
| File uploads differ | `@nestjs/platform-express` bundles multer 2.2.0; Fastify needs its own multipart plugin |
| Every example you find assumes Express | including most of this handbook's Nest pages |

:::best-practice
Choose Fastify for a **new** service where you want its ecosystem, or where you have measured framework overhead as a genuine constraint — a very high request rate with very cheap handlers, such as a proxy or an edge service.

Do not migrate an existing Express-adapter application for performance. You would be paying a migration across every middleware, every `@Res()` handler and every upload endpoint to reclaim under one percent of a request, while the database keeps sixty. Details in [The Fastify adapter](../nestjs-advanced/fastify-adapter.md).
:::

## The database dominates

In a typical Nest API the request-time budget looks roughly like:

| Component | Typical share |
| --- | --- |
| Database queries, including time waiting for a pool connection | 60–90% |
| Downstream HTTP calls | 5–25% |
| Your JavaScript — pipeline, validation, serialization | 1–10% |
| Framework overhead | under 1% |

One index that takes a query from 200 ms to 5 ms beats every other optimization on this page combined. Where the time actually goes:

- **N+1 queries.** The most common ORM performance bug and the one Nest's tidy service layer hides best: a `for` loop over entities, each triggering a lazy relation load. It looks fine on ten rows and collapses on a thousand. See [Avoiding N+1](../nestjs-orms/avoiding-n-plus-one.md).
- **Missing indexes.** `EXPLAIN ANALYZE` the slow query. A sequential scan on a large table is the single most common production performance bug.
- **Pool wait.** Time queued for a connection is not in your query-duration metric — the query was fast; getting permission to run it was not.
- **Transactions held across an HTTP call.** A lock held for a network round trip serializes everything behind it. See [Transactions](../nestjs-databases/transactions.md).
- **Chatty repositories.** Log the SQL your ORM actually emits under a realistic workload. The count is usually surprising.

Turn on your database's slow-query log. It is the highest-value five minutes of performance work available.

### Connection pool sizing

Bigger is not faster. A pool larger than the database can usefully serve just moves the queue from your process to the database, where each connection costs memory and, in Postgres, a backend process.

```text
DATABASE_POOL_MAX per process   10
processes per container          1
replicas                         8
                                ---
connections to the database     80

Postgres default max_connections: 100
```

Add a second service or scale to 16 replicas and you exhaust it. The symptom is `sorry, too many clients already` under load — an outage caused by a number in a config file.

- **Start small.** 5–10 per process is plenty for most services. Raise it only when the pool's waiting count is consistently above zero *and* the database is not saturated.
- **Count across every replica and every service**, then compare against `max_connections`.
- **Set an acquire timeout.** Failing fast when the pool is exhausted beats an unbounded queue that becomes a total stall.
- **Clustering multiplies it again.** Divide the per-process pool by the worker count.

The arithmetic and the proxy options are in [Connection pooling](../nestjs-databases/connection-pooling.md).

## Caching

Caching is the highest-leverage optimization available and the one with the most ways to be subtly wrong.

`@nestjs/cache-manager` 12.0.0 gives you a `CACHE_MANAGER` provider and a `CacheInterceptor` that caches `GET` responses by URL. The interceptor is convenient and it is also the part to be careful with:

:::danger
`CacheInterceptor` registered globally keys on the request URL. Two different users hitting `GET /me` have the same URL — so the second one is served the first one's response. That is not a performance bug, it is a data leak.

Register it per-controller on endpoints whose response depends on nothing but the URL, or provide a key that includes the identity. Never cache a personalized response in a shared cache.
:::

Before adding a cache, ask what the hit rate will be. A cache with a 20% hit rate buys a 20% improvement on one query in exchange for a new dependency, a consistency problem and an invalidation bug.

Two rules that prevent the worst outcomes: **set a TTL on everything**, so a stale entry is temporary rather than permanent; and **decide the failure mode explicitly** — if Redis is down, does the request fail or fall through to the database? Falling through is usually right, but a cold cache falling through under full load is a stampede that can take the database out.

The in-memory store is per process, so N replicas means N caches and N versions of the truth. That is acceptable for reference data with a short TTL and wrong for anything that must be consistent. See [Caching](../nestjs-libraries/cache-manager.md).

## Keeping CPU work off the request path

The usual offenders are the same as in any Node service — `readFileSync`, `gzipSync`, `crypto.pbkdf2Sync`, `JSON.parse` on a huge body — and `await` does not help: `await gzipSync(buf)` blocks for exactly as long as `gzipSync(buf)`.

Two Nest-flavored notes:

- **`argon2` 0.45.1 and `bcrypt` 6.0.0 hash on libuv's threadpool** when you use the async API, so the event loop stays free. The threadpool is **4 threads by default** and `fs`, DNS and `zlib` share it — four concurrent logins at ~100 ms each saturate it and the fifth queues. Rate-limit the login endpoint rather than weakening the hash parameters.
- **Long work belongs in a queue.** A user waiting for a PDF, an export or a bulk import should get a `202` and a job id, not a held connection and a stalled event loop for everyone else. `@nestjs/bullmq` 12.0.0 is the first-party path — see [Background jobs with BullMQ](../nestjs-libraries/bullmq.md).

## Common mistakes

- **Optimizing without profiling.** A week on serialization while a sequential scan runs underneath.
- **Profiling `nest start --watch`.** You are measuring the dev harness.
- **Benchmarking against an empty database.** The result predicts nothing about production.
- **A `Scope.REQUEST` provider injected into a widely-used service.** Scope bubbles up and an entire subtree is rebuilt per request.
- **Reaching for `REQUEST` scope to carry a tenant or correlation id.** `AsyncLocalStorage` does it with no graph cost.
- **A global `ClassSerializerInterceptor` on endpoints that return large arrays.** Tens of milliseconds of blocked event loop per request.
- **Unbounded list endpoints.** A performance problem and a denial-of-service vector at once.
- **`CacheInterceptor` on a personalized endpoint.** One user's response served to another.
- **Caching before measuring the hit rate.** A dependency and an invalidation bug for a marginal gain.
- **Switching to the Fastify adapter for a benchmark number.** You pay a full migration to reclaim under 1% of a request.
- **Ignoring N+1 because the service layer looks clean.** Log the SQL your ORM emits.
- **Enlarging the connection pool to fix latency.** It moves the queue to the database and eventually exhausts `max_connections`.
- **Sizing the pool per process and forgetting replicas and workers.** Multiply, then compare against `max_connections`.
- **No statement timeout and no acquire timeout.** One slow query becomes a total stall.
- **A `*Sync` call in a handler.** One 20 ms block costs the hundredth concurrent request two seconds.
- **Weakening argon2 parameters for login latency.** Rate-limit the endpoint instead.
- **Not measuring event-loop delay.** Without it you cannot tell "the process is CPU-bound" from "the database is slow", and the fixes are opposite.

## Related topics

- [Performance](../production/performance.md) — profiling tools, synchronous APIs, connection reuse and realistic numbers.
- [Injection scopes](../nestjs/injection-scopes.md) — what `REQUEST` and `TRANSIENT` scope actually do, and when they are right.
- [Serialization](../nestjs-validation/serialization.md) — `ClassSerializerInterceptor` and the Standard Schema alternative.
- [The Fastify adapter](../nestjs-advanced/fastify-adapter.md) — the migration cost in full.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — sizing, acquire timeouts and proxies.
- [Avoiding N+1](../nestjs-orms/avoiding-n-plus-one.md) — the query pattern that dominates real latency.
- [Caching](../nestjs-libraries/cache-manager.md) — stores, TTLs and the interceptor's key.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — moving long work off the request path.
- [Clustering](clustering.md) — when more processes help, and when they do not.
- [Observability](observability.md) — event-loop delay and pool saturation in production.
- [Docker](docker.md) — heap sizing under a container memory limit.
- [Deployment checklist](deployment-checklist.md) — the performance items to verify before shipping.
