---
title: Clustering
description: Using node:cluster to spread work across CPU cores, when it actually helps, and why one process per container is usually right in Kubernetes.
status: current
updated: 2026-09-08
---

A Node process runs your JavaScript on one thread. On a machine with sixteen cores that means fifteen of them sit idle unless you do something about it. `node:cluster` is the built-in answer: fork one process per core and let the operating system share a listening socket between them. Whether you should is a different question, and the honest answer for most containerised deployments is no.

## How it works

`cluster.fork()` spawns a child process running the same script. The primary creates the listening socket; workers inherit it. On Linux, Node uses `SO_REUSEPORT`-style round-robin distribution by default, so the primary hands accepted connections to workers rather than letting the kernel decide — which avoids the pathological imbalance the kernel's own accept queue produces.

Workers are **separate operating-system processes**. They share no memory, no variables, no module state. Each one has its own V8 heap, its own JIT-compiled code, its own connection pool. Communication is message passing over an IPC channel, which is JSON serialization — never a substitute for shared state.

## Basic example

```js title="src/cluster.js"
import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'
import process from 'node:process'

if (cluster.isPrimary) {
  const workers = Number(process.env.WEB_CONCURRENCY) || availableParallelism()
  console.log(`primary ${process.pid} forking ${workers} workers`)

  let shuttingDown = false

  for (let i = 0; i < workers; i += 1) cluster.fork()

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} exited (${signal ?? code})`)
    // Do not replace a worker while the primary is shutting down.
    if (!shuttingDown) cluster.fork()
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      shuttingDown = true
      // Forward to workers; each runs its own graceful shutdown.
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker.process.kill(signal)
      }
    })
  }
} else {
  // Every worker runs the ordinary server, unchanged.
  await import('./server.js')
}
```

`availableParallelism()` is the right function to call. It is not `os.cpus().length`.

:::warning
`os.cpus().length` reports the **host's** core count, not what your container is allowed to use. A container with `--cpus=1` on a 64-core node still sees 64 entries in `os.cpus()`, so `os.cpus().length` forks 64 workers that fight over a single core's worth of CPU quota. Throughput drops, latency rises, and memory goes up 64-fold.

`availableParallelism()` (Node 18.14+) respects CPU affinity and cgroup limits where the platform exposes them. Use it, and still allow an explicit `WEB_CONCURRENCY` override, because no API detects every platform's quota correctly.
:::

## When clustering helps

**A CPU-bound workload on a multi-core machine you control.** Template rendering, image processing, JSON serialization of large payloads, cryptography that is not on a threadpool, data transformation. If a CPU profile shows your JavaScript actually executing rather than waiting, more processes means more throughput, close to linearly, up to the core count.

**A single VM or bare-metal host running one service.** You paid for sixteen cores; one process uses one. Here clustering is the whole point, and a supervisor like PM2 exists to do it for you.

**Fault isolation on a long-running process.** A worker that hits an uncaught exception dies and is replaced while its siblings keep serving. That is a real availability benefit — but so is an orchestrator restarting a container, and the orchestrator's version is easier to reason about.

## When it does not help

**I/O-bound workloads — which is most APIs.** A typical handler validates a body, awaits a database query, and serializes a response. During the `await` the thread is free. One process handles thousands of concurrent requests because it spends nearly all its time waiting. Adding processes there does not add capacity; it adds memory and connection-pool pressure while the database — the actual bottleneck — gets no faster. Measure before you assume: if [Performance](performance.md) shows event-loop delay near zero under load, you are I/O-bound and clustering will not help.

**A container with a 1-CPU limit.** Multiple processes on one core's worth of quota means context switching plus multiplied memory, for zero extra parallelism. It is strictly worse than one process.

**Anywhere the orchestrator already runs replicas.** Kubernetes, ECS and Nomad already run N copies of your process. Clustering inside each one gives you N × M processes managed by two different supervisors that do not know about each other.

## In Kubernetes, run one process per container

This is the recommendation, and it is not a stylistic preference.

| | One process per container, scaled by replicas | Cluster inside the container |
| --- | --- | --- |
| Scaling unit | The pod. HPA scales on CPU or custom metrics. | Fixed at fork time, invisible to the HPA. |
| Failure blast radius | One pod. The scheduler replaces it. | The whole pod, or a silently degraded pod with dead workers. |
| Resource requests | Meaningful — one process, one limit. | You must reason about N processes inside one limit. |
| Metrics and logs | One process, one identity. | N processes, all writing to the same stdout, all reporting the same pod name. |
| Signal handling | Straightforward. | The primary must forward and then wait for every worker. |
| Rolling updates | Pod-level, one healthy pod at a time. | Pod-level anyway — clustering adds nothing. |
| Memory | `requests`/`limits` map to actual usage. | Multiply the baseline by the worker count. |

The orchestrator is already a process supervisor with health checking, restart policy, resource limits and scheduling. Running a second one inside it means two components have opinions about how many processes exist and neither can see the other. When a worker dies, the pod is degraded but still "ready" — the readiness probe is answered by whichever worker is alive.

:::best-practice
In a container: **one process, `resources.limits.cpu: "1"`, scale with `replicas`**. If a pod is CPU-starved, add replicas. If a single request is CPU-heavy, move that work to a `worker_threads` pool inside the one process. Reach for `node:cluster` only on a VM you manage yourself.
:::

## Sticky sessions and in-memory state

Clustering breaks any assumption that consecutive requests hit the same process. Requests are distributed round-robin, so request 1 goes to worker A and request 2 to worker B, with nothing shared between them.

Everything below silently stops working:

| In-memory thing | What breaks | Fix |
| --- | --- | --- |
| `express-session` MemoryStore | User is logged in on one worker, logged out on the next request | A shared store — `connect-redis` |
| `express-rate-limit` default store | Each worker counts separately, so the effective limit is N × your limit | `rate-limit-redis` |
| An in-process cache (`Map`, `lru-cache`) | N independent caches, low hit rate, inconsistent reads | Redis, or accept the inconsistency knowingly |
| WebSocket rooms and broadcasts | A message published on worker A never reaches sockets on worker B | A Redis pub/sub backplane |
| A `setInterval` cron | Runs N times, once per worker | A single scheduler, or a lock in Redis |
| An idempotency-key set | Duplicate requests land on different workers and both proceed | Redis with a TTL |
| In-flight request counters, feature-flag caches | Wrong numbers, inconsistent behaviour | Shared store, or per-worker metric labels |

The "solution" people reach for is **sticky sessions** — hashing the client IP at the load balancer so a client always reaches the same worker. Do not. It concentrates load unevenly, it breaks entirely when a worker restarts (that client's session vanishes), it fails behind NAT and mobile carrier gateways where thousands of users share an IP, and it stops you scaling in without disconnecting people. It converts a state problem into a routing problem and makes both worse.

:::best-practice
Make every process stateless. Session data, rate-limit counters, locks, caches and pub/sub go to Redis. Then it does not matter whether you run one process or a hundred, on one machine or twenty, and clustering versus replicas becomes a pure capacity question instead of a correctness question.
:::

The same rule is what makes replicas work, which is why "make it stateless" is worth doing even if you never cluster.

## Memory cost

Each worker is a full V8 instance. On a small Express API that is roughly 40–80 MB of resident memory before your application allocates anything, and it does not shrink with worker count — there is no copy-on-write sharing of the heap after startup.

The consequences to budget for:

- **Memory scales linearly with workers.** Eight workers on a 512 MB container will OOM.
- **Connection pools multiply.** `poolMax: 10` with eight workers is 80 connections from one container. With six replicas that is 480 connections, against a Postgres `max_connections` that defaults to 100. See [Connection pooling](../databases/connection-pooling.md).
- **File descriptors, DNS caches and TLS session caches multiply too.**
- **Startup cost multiplies.** Each worker parses and JIT-compiles your code independently, so a heavy dependency tree makes cold start N times more expensive in CPU terms.

Set `--max-old-space-size` per worker with the container limit divided by worker count in mind, not the whole limit.

## `worker_threads` is usually the better answer for CPU work

If the problem is "one endpoint blocks the event loop", the targeted fix is a worker thread, not a second copy of your entire application.

| | `node:cluster` | `node:worker_threads` |
| --- | --- | --- |
| Unit | An OS process | A thread inside one process |
| Memory | Full V8 heap each (~40–80 MB) | Smaller; shares the process |
| Shares the listening socket | Yes — that is its purpose | No |
| Shares memory | No | Yes, via `SharedArrayBuffer` and transferable objects |
| Startup cost | High | Lower |
| Use it for | Scaling a whole HTTP server across cores | Moving one CPU-heavy task off the event loop |

The pattern: keep one HTTP process, and push the expensive operation — a large CSV parse, a PDF render, an image transform, a synchronous compression — onto a small pool of worker threads. The event loop stays responsive for every other request, and you have not multiplied your memory or your pool sizes.

```js title="src/heavy.js"
import { Worker } from 'node:worker_threads'

export function runInWorker(scriptUrl, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(scriptUrl, { workerData: payload })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with ${code}`))
    })
  })
}
```

Spawn a **pool** in real code rather than a worker per request — thread creation is not free, and an unbounded number of them is just a different way to exhaust the CPU. `piscina` is the well-known pool implementation; a fixed array of workers with a queue is not hard to write yourself.

Note that some CPU-heavy work is already off-thread. `argon2`, `bcrypt`, `crypto.pbkdf2` (the async form), `zlib`'s async APIs and `fs` all use libuv's threadpool. Their **synchronous** variants do not — `crypto.pbkdf2Sync` and `zlib.gzipSync` block the event loop for every concurrent request. See [Performance](performance.md).

## Shutting down a cluster

The primary must forward the signal and wait; it must not exit while workers are still draining.

1. The primary receives `SIGTERM` and sets a flag so `cluster.on('exit')` stops replacing workers.
2. It forwards the signal to every worker.
3. Each worker runs the full sequence from [Graceful shutdown](graceful-shutdown.md) — readiness off, drain delay, `server.close()`, `closeIdleConnections()`, wait for in-flight, close pools.
4. The primary waits for every worker to exit, with its own deadline, then exits.

The budget is the same as for a single process, but everything happens N times against the same deadline. Make sure the platform's grace period covers the slowest worker, not the average.

A worker that exits and gets replaced during normal running is a restart with no drain — it happens on an uncaught exception, and the connections it held are reset. That is the fault-isolation benefit and its cost in the same sentence.

## Production considerations

- **Measure before you cluster.** If event-loop delay under load is low, you are I/O-bound and clustering buys nothing. `perf_hooks.monitorEventLoopDelay` gives you the number — see [Observability](observability.md).
- **Never use `os.cpus().length` in a container.** `availableParallelism()`, with a `WEB_CONCURRENCY` override.
- **Divide pool sizes by the worker count**, or you multiply your database connection count silently.
- **Divide the memory limit by the worker count** when setting `--max-old-space-size`.
- **Give each worker an identity in logs and metrics.** Without a `pid` or worker-id field, N processes writing to one stdout is unreadable, and per-worker problems become invisible.
- **Watch for a slow leak of workers.** A crash loop that replaces workers as fast as they die looks healthy from outside; alert on worker restart rate.
- **Health probes report one worker's view.** With clustering, a "ready" pod may have half its workers dead. This is a real argument against clustering behind an orchestrator.
- **PM2 in cluster mode is `node:cluster` with a supervisor around it.** Useful on a VM; redundant inside a container that already has one.

## Common mistakes

- **Clustering an I/O-bound API and expecting a throughput win.** The database was the bottleneck; now you have more connections to it.
- **`os.cpus().length` in a CPU-limited container.** Dozens of workers on one core of quota.
- **Clustering inside a Kubernetes pod.** Two supervisors, invisible scaling unit, multiplied memory, degraded-but-ready pods.
- **Keeping sessions in `MemoryStore`.** Users appear logged out at random. The default store is documented as development-only for exactly this reason.
- **Rate limiting with the default in-memory store.** Your 100/minute limit becomes N × 100/minute.
- **Reaching for sticky sessions.** It papers over shared-state problems and breaks on every worker restart and behind every NAT.
- **A `setInterval` job in the worker file.** It runs once per worker. Put schedulers in the primary, or behind a Redis lock.
- **Assuming workers share memory.** They are separate processes. `global.cache` is N caches.
- **Using IPC as a data channel.** Messages are serialized; it is fine for coordination and wrong for throughput.
- **A primary that exits before its workers finish draining.** Every in-flight request across every worker is reset.
- **Forking a worker per request with `worker_threads`.** Use a bounded pool.
- **Forgetting that sync crypto and sync zlib block regardless.** Clustering hides it at low load and it reappears under traffic.

## Related topics

- [Graceful shutdown](graceful-shutdown.md) — the sequence each worker runs, and how the primary coordinates it.
- [Performance](performance.md) — measuring whether you are CPU-bound before adding processes.
- [Observability](observability.md) — event-loop delay, and giving each worker an identity.
- [Health and readiness probes](health-and-readiness-probes.md) — why a clustered pod's readiness signal is weaker.
- [Dockerfile](dockerfile.md) — PID 1, signal forwarding, and container CPU limits.
- [Connection pooling](../databases/connection-pooling.md) — pool size divided by workers, multiplied by replicas.
- [Redis](../databases/redis.md) — the shared store that makes processes interchangeable.
- [Rate limiting](../express-libraries/rate-limiting.md) — why the default store breaks across processes.
- [Runtime and the event loop](../node/runtime-and-event-loop.md) — why one thread is usually enough.
- [Process management](../express-libraries/process-management-and-graceful-shutdown.md) — PM2 and supervisors on a VM.
