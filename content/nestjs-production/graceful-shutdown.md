---
title: Graceful shutdown
description: enableShutdownHooks, the three termination hooks and what each one may safely do, the drain delay that prevents deploy-time 502s, and the v12 hook-ordering change.
status: current
updated: 2026-09-11
---

Nest gives you three termination hooks and a single call that arms them. What it does not give you is the ordering discipline around them — and the two mistakes that actually drop requests, closing the database too early and closing the socket too early, are both ordering mistakes. The Node-level mechanics, the signal table and the `SIGKILL` reality are in [Graceful shutdown](../production/graceful-shutdown.md) and are unchanged here. This page is what Nest adds, plus the v12 change that can reorder your hooks.

## `enableShutdownHooks()` arms everything

Nothing on this page runs without it.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Otherwise app.close() can hang on an idle keep-alive socket until the
    // platform's grace period expires and SIGKILL arrives.
    forceCloseConnections: true,
  })

  const config = app.get(ConfigService)

  // Registers process signal listeners that call app.close(), which runs the
  // termination hooks on every provider. Off by default.
  app.enableShutdownHooks()

  const server = app.getHttpServer()
  // Must exceed the proxy's idle timeout, or you get 502s in steady state.
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  server.requestTimeout = 30_000

  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap()
```

`enableShutdownHooks()` is disabled by default because it starts signal listeners, which costs a little and matters when many application instances live in one process. In a deployed service you always want it.

`app.close()` is what the listeners call, and it is also what you call in a test or a script. Everything below describes what happens inside it.

## The three hooks, and what each may safely do

| Hook | Receives the signal | Runs | Safe to do here |
| --- | --- | --- | --- |
| `onModuleDestroy()` | no | first, on every provider | stop *producing* work — pause schedulers, stop consuming from queues |
| `beforeApplicationShutdown(signal?)` | **yes** | after every `onModuleDestroy` has settled | wait for work you already started; the HTTP server is **still listening** |
| `onApplicationShutdown(signal?)` | **yes** | after connections are closed and the server has stopped | close pools, Redis, external clients — nothing can issue a query now |

That sequence is the whole design, and the middle row is the part people miss. `beforeApplicationShutdown` runs *before* Nest closes the HTTP server; `onApplicationShutdown` runs *after*. So:

- **Draining belongs in `beforeApplicationShutdown`.** Requests can still be in flight, and that is exactly when you want to wait for them.
- **Resource teardown belongs in `onApplicationShutdown`.** By then nothing new can arrive.

```ts title="src/jobs/email.consumer.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { OnModuleDestroy, BeforeApplicationShutdown } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue, Worker } from 'bullmq'

@Injectable()
export class EmailConsumer implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(EmailConsumer.name)
  private readonly queue: Queue
  private worker?: Worker

  constructor(@InjectQueue('emails') queue: Queue) {
    this.queue = queue
  }

  // 1. Stop pulling new jobs. Nothing new starts from here on.
  async onModuleDestroy() {
    this.logger.log('pausing email worker')
    await this.worker?.pause(true)
  }

  // 2. Let the jobs already running finish. The HTTP server is still up,
  //    so a job that makes an internal call still works.
  async beforeApplicationShutdown(signal?: string) {
    this.logger.log(`draining email worker (${signal ?? 'no signal'})`)
    await this.worker?.close()
  }
}
```

```ts title="src/database/pool.provider.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import { Pool } from 'pg'

@Injectable()
export class DatabasePool implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabasePool.name)
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  query(text: string, values?: unknown[]) {
    return this.pool.query(text, values)
  }

  // 3. Nothing can check out a client any more. Now it is safe to end it.
  async onApplicationShutdown(signal?: string) {
    this.logger.log(`closing pg pool (${signal ?? 'no signal'})`)
    await this.pool.end()
  }
}
```

:::danger
Closing a connection pool in `onModuleDestroy` is the most damaging shutdown bug in a Nest application, and it looks tidy. `onModuleDestroy` runs while the HTTP server is still listening and requests are still executing, so `pool.end()` there turns requests that were about to succeed into 500s — on every single deploy.

`onApplicationShutdown` exists for exactly this. Resources close **last**.
:::

## The v12 hook-ordering change

In NestJS 12, lifecycle hooks run **by component hierarchy level** rather than in the previous traversal order. `onModuleInit`, `onApplicationBootstrap` and all three shutdown hooks can therefore fire in a different relative order than they did in v11 across providers that depend on one another.

This is not a bug and there is no flag to restore the old behavior. What it means in practice:

- **Any shutdown ordering you inferred from module import order is now unreliable.** If your queue consumer's `onApplicationShutdown` happened to run before the database provider's in v11, nothing guarantees that after the upgrade.
- **Express the dependency instead of assuming it.** If A must finish before B tears down, either put A's work in an earlier *hook* than B's — that ordering across the three hooks is guaranteed — or have B await something A owns.
- **Make every hook idempotent and defensive.** A hook that throws because the thing it needed was already closed will surface as a failed shutdown and a non-zero exit on every deploy.

```ts title="src/cache/cache.client.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import Redis from 'ioredis'

@Injectable()
export class CacheClient implements OnApplicationShutdown {
  private readonly logger = new Logger(CacheClient.name)
  private readonly redis: Redis
  private closed = false

  constructor(redis: Redis) {
    this.redis = redis
  }

  // Idempotent, and it never throws out of the hook — a failure to close the
  // cache must not stop the database pool from closing.
  async onApplicationShutdown() {
    if (this.closed) return
    this.closed = true
    try {
      // quit() waits for pending replies; disconnect() drops the socket.
      await this.redis.quit()
    } catch (error) {
      this.logger.warn(`redis close failed: ${(error as Error).message}`)
    }
  }
}
```

The three-hook ordering (`onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown`) is still guaranteed. It is the ordering *within* a single hook, across providers, that changed. Treat each hook as an unordered set and you are immune to the difference.

The rest of the upgrade is in [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md).

## The 502 race, and where the drain delay goes

`enableShutdownHooks()` calls `app.close()` the instant `SIGTERM` arrives. That is one step too fast, and it is why services with correct shutdown code still see 502s on every deploy.

Endpoint removal is asynchronous. Kubernetes sends `SIGTERM` and updates the EndpointSlice at the same moment; kube-proxy, your ingress controller and any cloud load balancer each pick that change up on their own schedule. For a second or more after `SIGTERM`, traffic is still being routed to you. If your socket is already closed, every one of those requests is a connection refused, which the proxy reports as a 502.

```text
t=0.00  SIGTERM. Readiness -> shutting_down. Socket STILL OPEN, still serving.
t=0.30  A new request arrives. Served normally. 200.
t=1.20  Load balancer has removed the endpoint. No new traffic.
t=5.00  Drain window elapsed. app.close() runs the three hooks.
t=5.40  Last in-flight request finishes; server closed.
t=5.45  Pools closed. Process exits 0.
```

The fix is to keep serving for a few seconds after readiness flips. With `@nestjs/terminus` that is one option:

```ts title="src/health/health.module.ts"
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HealthController } from './health.controller.js'

@Module({
  imports: [
    TerminusModule.forRoot({
      errorLogStyle: 'json',
      // On SIGTERM, readiness reports shutting_down and the app waits this
      // long before tearing down. This is the drain window.
      gracefulShutdownTimeoutMs: 5_000,
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
```

`gracefulShutdownTimeoutMs` does nothing without `enableShutdownHooks()`, because nothing tells Terminus that shutdown has begun. The two go together or neither works.

### `return503OnClosing` as a safety net

Nest has its own option for the same window, on `NestApplicationOptions`:

```ts
const app = await NestFactory.create(AppModule, {
  forceCloseConnections: true,
  // New requests arriving during shutdown get an explicit 503.
  // In-flight requests are still allowed to complete. Default: false.
  return503OnClosing: true,
})
```

It is worth turning on, and it is **not** a replacement for the drain delay. The difference is what a request that arrives at second zero gets:

| | Without a drain delay | With a drain delay |
| --- | --- | --- |
| `return503OnClosing: false` | connection refused → the proxy reports **502** | served normally → **200** |
| `return503OnClosing: true` | an explicit **503** | served normally → **200** |

A 503 is a better failure than a connection reset — it is unambiguous in your logs, and some proxies and service meshes will retry an idempotent request on it. It is still a failed request for any client behind a proxy that does not retry.

So use both: the drain delay is what makes those requests succeed, and `return503OnClosing` is what makes the ones that slip through legible instead of a mystery 502.

If you are not using Terminus, own the signal yourself instead of calling `enableShutdownHooks()`:

```ts title="src/shutdown.ts"
import type { INestApplication } from '@nestjs/common'
import { Logger } from '@nestjs/common'
import { setTimeout as delay } from 'node:timers/promises'

export function installDrainThenClose(
  app: INestApplication,
  setNotReady: () => void,
  drainDelayMs: number,
) {
  const logger = new Logger('Shutdown')
  let shuttingDown = false

  const handle = async (signal: NodeJS.Signals) => {
    // Impatient operators press Ctrl-C twice; some orchestrators re-send.
    if (shuttingDown) return
    shuttingDown = true
    logger.log(`${signal} received`)

    // 1. Readiness off FIRST, while the socket is still open and serving.
    setNotReady()
    await delay(drainDelayMs)

    // 2. Now run the hooks: destroy -> before -> close server -> after.
    await app.close()
    logger.log('shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', (signal) => { void handle(signal) })
  process.on('SIGINT', (signal) => { void handle(signal) })
}
```

Call it instead of `enableShutdownHooks()` — not as well as, or both paths race to call `app.close()`.

:::warning
Your whole shutdown budget must fit inside the platform's grace period, or `SIGKILL` arrives mid-drain and you lose the requests you were trying to save.

```text
drain delay (5s) + in-flight drain (10s) + resource close (~2s) = 17s
terminationGracePeriodSeconds: 30      ← comfortably larger
```

Kubernetes defaults `terminationGracePeriodSeconds` to **30**. If your requests can legitimately run for 60 seconds, you need a grace period above 60 and you need to raise it deliberately — the default will kill them.
:::

```yaml title="deployment.yaml — the fields that interact"
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          env:
            - name: SHUTDOWN_DRAIN_DELAY_MS
              value: "5000"
          readinessProbe:
            httpGet: { path: /readyz, port: 3000 }
            # A 30-second period makes the readiness flip useless — the proxy
            # would not re-check until long after you needed it to.
            periodSeconds: 2
            failureThreshold: 2
```

## Keep-alive sockets and `forceCloseConnections`

The second thing that goes wrong is subtler. `app.close()` waits for the HTTP server to finish, and an HTTP/1.1 keep-alive socket with no request in progress keeps that server open indefinitely. Every proxy and every modern client uses keep-alive, so without intervention `app.close()` never resolves, the process sits until the grace period, and `SIGKILL` ends it — with a non-zero exit on every deploy and no log line explaining why.

`forceCloseConnections: true` on `NestFactory.create()` is the option that stops it: open connections are closed rather than waited on.

It does not distinguish an idle socket from one mid-response, which is precisely why the **drain delay comes first**. By the time `app.close()` runs, the load balancer has stopped sending you traffic and there is very little left to interrupt. Without the delay, `forceCloseConnections` turns a hang into truncated responses, which is a different bug rather than a fix.

### `keepAliveTimeout` must exceed the proxy's idle timeout

Separately from shutdown, the same mechanism causes intermittent 502s during **normal** operation. Node's default `keepAliveTimeout` is 5 seconds; if your proxy's idle timeout is 60, the proxy still believes an idle socket is usable and sends a request onto one Node is closing at that exact moment.

Reach the underlying server through the adapter and set them at bootstrap:

```ts
const server = app.getHttpServer()
server.keepAliveTimeout = 65_000   // longer than the proxy's idle timeout
server.headersTimeout = 66_000     // must be above keepAliveTimeout
server.requestTimeout = 30_000     // bound how long one client can hold a socket
```

The proxy-by-proxy numbers are in [Graceful shutdown](../production/graceful-shutdown.md).

## Testing it

Almost every broken shutdown path is broken because nobody ran it. Three checks, all cheap:

```bash
# 1. A slow request survives SIGTERM.
node dist/main.js &
curl -s localhost:3000/slow &   # an endpoint that sleeps ~8s
sleep 1 && kill -TERM %1
# Expect: the curl returns 200, the process exits 0, hooks logged in order.

# 2. The container gets the signal at all.
docker run -d --name t api:test
docker stop t          # ~10s means SIGTERM never reached node
docker logs t | tail

# 3. Hooks run in a test, without any signals.
```

```ts title="test/shutdown.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module.js'

describe('shutdown', () => {
  it('runs the termination hooks without throwing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    const app = moduleRef.createNestApplication()
    app.enableShutdownHooks()
    await app.init()

    // Exercises onModuleDestroy -> beforeApplicationShutdown -> onApplicationShutdown.
    await app.close()
  })
})
```

That last test is worth more than it looks. A hook that throws — because it closed something twice, or awaited a client that was already gone — fails here in CI rather than as a non-zero exit on every production deploy.

## Common mistakes

- **Never calling `enableShutdownHooks()`.** Every hook you wrote is dead code, `gracefulShutdownTimeoutMs` is never armed, and `SIGTERM` kills the process instantly.
- **Closing a pool or a Redis client in `onModuleDestroy`.** The server is still listening; in-flight requests turn into 500s on every deploy.
- **Calling `app.close()` immediately on `SIGTERM`.** The load balancer has not deregistered you yet. This is the classic deploy-time 502.
- **Both `enableShutdownHooks()` and a custom signal handler.** Two paths race to call `app.close()`.
- **Relying on hook ordering across providers.** v12 runs them by hierarchy level; only the ordering *between* the three hooks is guaranteed.
- **A hook that throws.** One failed close aborts the rest of the shutdown and exits non-zero. Catch, log, continue.
- **A hook that is not idempotent.** `pool.end()` twice throws, and after the v12 ordering change "twice" is easier to reach.
- **Omitting `forceCloseConnections`.** `app.close()` waits on idle keep-alive sockets forever and every deploy hits the grace period.
- **Treating `return503OnClosing` as the fix for deploy-time errors.** It makes the failure legible; only the drain delay makes those requests succeed.
- **`forceCloseConnections` with no drain delay.** You trade a hang for truncated responses.
- **`keepAliveTimeout` left at Node's 5-second default behind a 60-second proxy.** Random-looking 502s in steady state.
- **A shutdown budget larger than `terminationGracePeriodSeconds`.** Your timeout never runs; `SIGKILL` does.
- **`readinessProbe.periodSeconds: 30`.** The shutdown flag is noticed long after it mattered.
- **`nest start` or `npm run start:prod` as the container command.** `SIGTERM` goes to the wrapper and never reaches Nest. See [Docker](docker.md).
- **Exiting without flushing the logger.** The lines describing the shutdown are exactly the ones you lose. See [Observability](observability.md).
- **Never testing it.** A slow request plus `kill -TERM` takes thirty seconds and finds most of the bugs on this page.

## Related topics

- [Graceful shutdown](../production/graceful-shutdown.md) — the signal table, the deregistration race and the Node-level sequence.
- [Health and readiness probes](health-and-readiness-probes.md) — the readiness flag this sequence flips first.
- [Health checks with Terminus](../nestjs-libraries/terminus.md) — `gracefulShutdownTimeoutMs` and the probe endpoints.
- [Docker](docker.md) — PID 1, and why `SIGTERM` may never reach your process.
- [Clustering](clustering.md) — shutting down a primary and its workers in the right order.
- [Environment configuration](configuration.md) — where the drain and timeout values come from.
- [Observability](observability.md) — logging the shutdown and flushing the logger before exit.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — what `pool.end()` actually waits for.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — draining a worker without losing or duplicating jobs.
- [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md) — the hook-ordering change in context.
- [Deployment checklist](deployment-checklist.md) — the shutdown items to verify before shipping.
