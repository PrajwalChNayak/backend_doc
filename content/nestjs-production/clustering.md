---
title: Clustering
description: node:cluster around a Nest bootstrap — when it helps, what the DI container silently duplicates, schedulers and throttlers that break across workers, and why Kubernetes wants one process per container.
status: current
updated: 2026-09-11
---

Nest has no clustering feature. A clustered Nest application is `node:cluster` with your `bootstrap()` in the worker branch, which means everything true of clustering a Node process is true here — and the Nest-specific part is what the DI container quietly duplicates when you fork. The mechanics, the `availableParallelism()` trap and the `worker_threads` alternative are in [Clustering](../production/clustering.md); this page is what changes when the process is a Nest application.

## The shape

```ts title="src/cluster.ts"
import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'
import process from 'node:process'
import { Logger } from '@nestjs/common'

const logger = new Logger('Cluster')

export async function runClustered(bootstrap: () => Promise<void>) {
  if (!cluster.isPrimary) {
    // Every worker runs the ordinary Nest bootstrap, unchanged.
    await bootstrap()
    return
  }

  // availableParallelism() respects cgroup CPU limits. os.cpus().length
  // reports the HOST's core count and will fork 64 workers on a 1-CPU pod.
  const count = Number(process.env.WEB_CONCURRENCY) || availableParallelism()
  logger.log(`primary ${process.pid} forking ${count} workers`)

  let shuttingDown = false
  for (let i = 0; i < count; i += 1) cluster.fork()

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`worker ${worker.process.pid} exited (${signal ?? code})`)
    if (!shuttingDown) cluster.fork()
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      shuttingDown = true
      // Each worker runs its own full Nest shutdown sequence.
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.process.kill(signal)
      }
    })
  }
}
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { runClustered } from './cluster.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true })
  app.enableShutdownHooks()
  await app.listen(process.env.PORT ?? 3000)
}

runClustered(bootstrap)
```

Workers are **separate operating-system processes**. They share no memory, no module state and no DI container. Each one builds the entire Nest module graph from scratch, instantiates every provider, opens its own pools, and registers its own schedulers.

That last sentence is the whole of this page.

## What the DI container duplicates

A `Scope.DEFAULT` provider is a singleton **per process**, not per application. Fork four workers and you have four of everything.

| Provider | What four workers actually give you | Fix |
| --- | --- | --- |
| A connection pool from a `useFactory` | `poolMax × 4` connections from one container | divide `poolMax` by the worker count |
| `@nestjs/cache-manager` with the default in-memory store | four independent caches, a quarter of the hit rate, inconsistent reads | a Redis-backed store |
| `@nestjs/throttler` with the default storage | each worker counts separately — your 100/minute limit is really 400/minute | `@nest-lab/throttler-storage-redis` 1.2.0 |
| `@nestjs/schedule` `@Cron` and `@Interval` | **the job runs four times**, concurrently | run schedulers in one process, or take a Redis lock |
| `@nestjs/event-emitter` | an event emitted on worker A is never seen on workers B, C, D | a broker, or accept the boundary knowingly |
| A WebSocket gateway | a broadcast on worker A never reaches sockets on worker B | the socket.io Redis adapter |
| An in-memory session store | logged in on one request, logged out on the next | a shared store |
| A microservice consumer | four consumers on one subscription | usually fine for a queue, wrong for a broadcast subject |
| An idempotency-key `Set` | duplicate requests land on different workers and both proceed | Redis with a TTL |

The scheduler row is the one that causes real damage, because it is silent and the failure is a *duplicate side effect* rather than an error.

```ts title="src/billing/invoice.scheduler.ts"
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InvoiceService } from './invoice.service.js'

@Injectable()
export class InvoiceScheduler {
  private readonly logger = new Logger(InvoiceScheduler.name)
  private readonly invoices: InvoiceService

  constructor(invoices: InvoiceService) {
    this.invoices = invoices
  }

  // With four workers this runs FOUR times at 02:00, in parallel, against
  // the same rows. Nothing errors. Customers are charged four times.
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async chargeOutstanding() {
    this.logger.log('charging outstanding invoices')
    await this.invoices.chargeAllOutstanding()
  }
}
```

There is no first-party lock in `@nestjs/schedule`. The three real options, in order of preference:

1. **Do not put the scheduler in the web process at all.** A separate single-replica deployment importing a `SchedulerModule` is unambiguous, independently scalable, and the same answer that works for replicas as well as workers.
2. **Enqueue instead of executing.** The cron enqueues one BullMQ job; the queue's own concurrency and deduplication decide what runs. N triggers collapse into one job if you give it a stable job id.
3. **Take a distributed lock** in Redis with a TTL shorter than the interval, and make the handler idempotent anyway.

The third is the weakest, because a lock that expires mid-job gives you two concurrent runs — which is the outcome you were preventing.

:::warning
The identical problem exists between **replicas**, and replicas are something you already have. Three pods with one process each is three executions of every cron, with no clustering involved. Solving it for workers and not for replicas fixes nothing; solving it once, properly, fixes both. See [Scheduling](../nestjs-libraries/schedule.md).
:::

## When clustering helps

**A CPU-bound Nest service on a machine you control.** Heavy serialization, template rendering, image work, synchronous transformation of large payloads. If a CPU profile shows your JavaScript executing rather than waiting, more processes means more throughput, close to linearly, up to the core count.

**A single VM or bare-metal host running one service.** You paid for sixteen cores and one process uses one.

## When it does not

**I/O-bound services, which is nearly every Nest API.** A handler validates a DTO, awaits a query, and serializes a response. During the `await` the thread is free — one process serves thousands of concurrent requests because it spends nearly all its time waiting. Adding processes adds memory and connection-pool pressure while the database, the actual bottleneck, gets no faster.

Measure before assuming. If event-loop delay at p99 under load is in single-digit milliseconds, you are I/O-bound and clustering will buy nothing. [Performance](performance.md) has the measurement and what to do instead.

**A container with a 1-CPU limit.** Multiple processes sharing one core's worth of quota means context switching plus multiplied memory for zero extra parallelism. It is strictly worse than one process.

**Anywhere the orchestrator already runs replicas.**

## In Kubernetes: one process per container

| | One process, scaled by replicas | Cluster inside the container |
| --- | --- | --- |
| Scaling unit | the pod; the HPA can act on it | fixed at fork time, invisible to the HPA |
| Failure blast radius | one pod, replaced by the scheduler | a silently degraded pod with dead workers |
| Readiness signal | honest | answered by whichever worker got the probe |
| Pool arithmetic | `poolMax × replicas` | `poolMax × workers × replicas` |
| Logs and metrics | one process, one identity | N processes on one stdout, all labelled with the same pod |
| Shutdown | the sequence in [Graceful shutdown](graceful-shutdown.md) | the primary must forward and then wait for every worker |
| Memory limits | map to actual usage | multiply the baseline by the worker count |

The orchestrator is already a process supervisor with health checking, restart policy, resource limits and scheduling. Running a second one inside it means two components have opinions about how many processes exist and neither can see the other.

The readiness row deserves emphasis in a Nest context. With clustering, a probe is answered by whichever worker the kernel handed it to. A pod can report `Ready` while half its workers have died and are being replaced in a loop — and because `@nestjs/terminus` is checking *that worker's* pool, the probe genuinely passes.

:::best-practice
In a container: **one Nest process, `resources.limits.cpu: "1"`, scale with `replicas`**. If a pod is CPU-starved, add replicas. If one *endpoint* is CPU-heavy, move that work into a `worker_threads` pool or a BullMQ consumer inside the single process, which keeps the event loop responsive without multiplying your pools, your schedulers and your memory.

Reach for `node:cluster` only on a VM you manage yourself.
:::

## Memory and startup cost

Each worker is a full V8 instance with its own heap, its own JIT-compiled code, and its own copy of the Nest module graph. There is no copy-on-write sharing of the heap after startup.

Nest amplifies the startup half. `NestFactory.create()` reads decorator metadata, resolves the dependency graph, and constructs every provider before anything listens — and every worker does all of it independently. On a large application that makes cold start N times more expensive in CPU terms, which matters most during a scale-up, when you needed capacity quickly.

Measure your own baseline rather than trusting a number:

```ts title="src/main.ts — measure the per-worker cost once"
await app.listen(port)
const { rss, heapUsed } = process.memoryUsage()
Logger.log(`ready rss=${Math.round(rss / 1e6)}MB heap=${Math.round(heapUsed / 1e6)}MB`, 'Bootstrap')
```

Then budget from it. Two consequences:

- **Divide the container memory limit by the worker count** when setting `--max-old-space-size`, not the whole limit.
- **Divide `DATABASE_POOL_MAX` by the worker count** — otherwise one container opens `poolMax × workers` connections and a modest replica count exhausts Postgres's default `max_connections` of 100. The arithmetic is in [Connection pooling](../nestjs-databases/connection-pooling.md).

## Shutting down a cluster

The primary must forward the signal and then wait; it must not exit while workers are still draining.

1. The primary receives `SIGTERM` and sets a flag so `cluster.on('exit')` stops replacing workers.
2. It forwards the signal to every worker.
3. Each worker runs the full Nest sequence — readiness off, drain delay, `app.close()` running `onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown`.
4. The primary waits for every worker to exit, with its own deadline, then exits.

The budget is the same as for a single process, but everything happens N times against one grace period. Size `terminationGracePeriodSeconds` against the **slowest** worker, not the average.

A worker that dies and is replaced during normal running is a restart with no drain at all: its in-flight requests are reset and its shutdown hooks never ran. That is the fault-isolation benefit and its cost in one sentence.

## Make each worker identifiable

N processes writing to one stdout is unreadable, and per-worker problems become invisible. Put the pid in the logger's base fields, and in any metric labels:

```ts title="src/logger/logger.config.ts"
import cluster from 'node:cluster'

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'api',
    pid: process.pid,
    // undefined in the primary and in an unclustered process.
    workerId: cluster.worker?.id,
    version: process.env.GIT_SHA ?? 'dev',
  },
}
```

Then alert on **worker restart rate**. A cluster that replaces workers as fast as they crash looks perfectly healthy from outside the pod.

## Common mistakes

- **Clustering an I/O-bound Nest API and expecting throughput.** The database was the bottleneck; now you have four times the connections to it.
- **`os.cpus().length` in a CPU-limited container.** It reports the host's cores and forks dozens of workers onto one core of quota.
- **Clustering inside a Kubernetes pod.** Two supervisors, an invisible scaling unit, multiplied memory, and degraded-but-`Ready` pods.
- **Forgetting that a `@Cron` runs once per worker.** No error, just N charges, N emails, N exports.
- **"Fixing" crons for workers but not for replicas.** Three pods is three executions regardless.
- **The default `@nestjs/throttler` storage behind multiple processes.** Your limit is silently multiplied by the process count.
- **The default in-memory cache store.** N caches, low hit rate, inconsistent reads that look like a caching bug in your code.
- **Assuming `@nestjs/event-emitter` crosses processes.** It is in-process only, by design.
- **A WebSocket gateway with no Redis adapter.** Broadcasts reach a quarter of your clients.
- **Not dividing `DATABASE_POOL_MAX` by the worker count.** One container exhausts `max_connections` on its own.
- **Reaching for sticky sessions.** It converts a shared-state problem into a routing problem and makes both worse — it breaks on every worker restart and behind every NAT.
- **A primary that exits before its workers finish draining.** Every in-flight request across every worker is reset.
- **No per-worker identity in logs.** N processes on one stdout, and a worker crash-loop that is invisible.
- **Treating PM2 cluster mode as different.** It is `node:cluster` with a supervisor around it — useful on a VM, redundant inside a container.

## Related topics

- [Clustering](../production/clustering.md) — `node:cluster` mechanics, `worker_threads`, and the memory arithmetic.
- [Performance](performance.md) — measuring event-loop delay before adding processes.
- [Scheduling](../nestjs-libraries/schedule.md) — running a cron exactly once across workers and replicas.
- [Rate limiting with Throttler](../nestjs-libraries/throttler.md) — the Redis storage that survives multiple processes.
- [Caching](../nestjs-libraries/cache-manager.md) — why the in-memory store stops being correct.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — pool size divided by workers, multiplied by replicas.
- [Graceful shutdown](graceful-shutdown.md) — the sequence each worker runs.
- [Health and readiness probes](health-and-readiness-probes.md) — why a clustered pod's readiness signal is weaker.
- [Docker](docker.md) — PID 1, signal forwarding and container CPU limits.
- [Observability](observability.md) — per-worker identity in logs and metrics.
- [WebSockets](../nestjs-advanced/websockets.md) — the adapter that makes broadcasts cross processes.
- [Deployment checklist](deployment-checklist.md) — the process-model items to verify before shipping.
