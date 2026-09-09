---
title: Graceful shutdown
description: The exact ordering that lets a Node process stop without dropping requests, and the load-balancer and keep-alive races that cause 502s even when your code is correct.
status: current
updated: 2026-09-08
---

Every deploy kills your process. A rolling update on Kubernetes, an ECS task replacement, a `systemctl restart`, an autoscaler scaling in — all of them send `SIGTERM` and then wait a fixed number of seconds before sending `SIGKILL`. What happens in those seconds decides whether your users see 502s on every deploy or nothing at all.

This page is about the **operational sequencing**: what order the steps go in, why each one is where it is, and the two races that produce dropped requests even when the shutdown code is perfect. [Process management](../express-libraries/process-management-and-graceful-shutdown.md) covers the surrounding topic — supervisors, restart policies, and the process lifecycle.

## Why it exists

By default, `process.on('SIGTERM')` has no handler and Node exits immediately. Immediately means:

- Every in-flight request dies mid-response. The client sees a connection reset, not a status code.
- Database transactions that were open are rolled back by the server, eventually, after a timeout.
- A job pulled off a queue but not yet acknowledged is either lost or redelivered, depending on the broker.
- Connections in your pool are closed by the OS rather than by a protocol-level goodbye, so the database logs a burst of unexpected disconnects.

Multiply that by the number of pods times the number of deploys per day. A team deploying ten times a day with fifty pods drops a few thousand requests a week for want of about sixty lines of code.

## The sequence, and why the order matters

There are seven steps and the order is not negotiable. Each one exists to close a window the previous one opened.

| # | Step | Why it must be here |
| --- | --- | --- |
| 1 | Flip readiness to `false` | Load balancers stop sending **new** connections. This has to be first, and it has to happen well before the socket closes, because deregistration is not instant. |
| 2 | `server.close()` | Stop accepting new connections and stop reusing idle keep-alive ones. Existing in-flight requests keep running. |
| 3 | `server.closeIdleConnections()` | Keep-alive sockets with no active request survive `server.close()` forever. This closes them so the callback can actually fire. |
| 4 | Wait for in-flight requests, with a hard deadline | The whole point. The deadline exists because one stuck handler must not hold the process past `SIGKILL`. |
| 5 | Drain queues and workers | A job handler is an in-flight request that HTTP does not know about. Stop consuming, finish or return what is held. |
| 6 | Close DB pools and Redis | **After** step 4 and 5, never before — closing the pool while a request is mid-query turns a graceful shutdown into 500s. |
| 7 | `process.exit(0)` | Explicit, so a lingering handle cannot keep the process alive past the deadline. `exit(1)` if the deadline was hit. |

The two orderings people get wrong:

**Closing the database first.** It feels like "release resources", but every request still running now fails. You converted requests that would have succeeded into 500s.

**Calling `server.close()` before flipping readiness.** The load balancer has not noticed yet, so it keeps sending connections to a socket that is no longer accepting. Each one is a connection refused, which the proxy reports as a 502. This is the single most common cause of "we get 502s on every deploy".

## A complete module

Copy this file. It is complete, has no dependencies beyond your own modules, and handles the cases below.

```js title="src/shutdown.js"
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Wires SIGTERM/SIGINT handling onto an http.Server.
 *
 * @param {import('node:http').Server} server
 * @param {object} deps
 * @param {() => void} deps.setNotReady        flip the readiness flag to false
 * @param {Array<{ name: string, close: () => Promise<void> }>} deps.resources
 *        drained in array order, AFTER in-flight requests finish
 * @param {number} [deps.timeoutMs]            hard deadline for the whole sequence
 * @param {{ info: Function, warn: Function, error: Function }} [deps.logger]
 */
export function installShutdownHandlers(server, {
  setNotReady,
  resources = [],
  timeoutMs = 15_000,
  logger = console,
}) {
  // Track live requests so we know when the last one finishes.
  let inFlight = 0
  let onIdle = null

  server.on('request', (req, res) => {
    inFlight += 1
    res.on('close', () => {
      inFlight -= 1
      if (inFlight === 0 && onIdle) onIdle()
    })
  })

  const waitForInFlight = () =>
    inFlight === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          onIdle = resolve
        })

  let shuttingDown = false

  async function shutdown(signal) {
    if (shuttingDown) {
      logger.warn({ signal }, 'shutdown already in progress, ignoring signal')
      return
    }
    shuttingDown = true
    const startedAt = Date.now()
    logger.info({ signal, inFlight }, 'shutdown started')

    // Hard deadline. Never let a stuck handler outlive SIGKILL silently.
    const killer = delay(timeoutMs, 'timeout').then(() => 'timeout')

    const graceful = (async () => {
      // 1. Readiness off first, so the load balancer stops choosing us.
      setNotReady()

      // Give the proxy time to observe it before the socket goes away.
      await delay(Number(process.env.DRAIN_DELAY_MS ?? 5000))

      // 2. Stop accepting new connections. Resolves when all sockets are gone.
      const closed = new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })

      // 3. Idle keep-alive sockets would otherwise hold that callback open.
      server.closeIdleConnections()

      // 4. Wait for handlers that are still running.
      await waitForInFlight()
      await closed

      logger.info({ ms: Date.now() - startedAt }, 'http server closed')

      // 5 + 6. Queues, workers, then pools — in the order given.
      for (const resource of resources) {
        try {
          await resource.close()
          logger.info({ resource: resource.name }, 'resource closed')
        } catch (err) {
          logger.error({ resource: resource.name, err }, 'resource close failed')
        }
      }
      return 'graceful'
    })()

    const outcome = await Promise.race([graceful, killer])

    if (outcome === 'timeout') {
      logger.error(
        { inFlight, timeoutMs },
        'shutdown deadline exceeded, forcing exit',
      )
      // 7. Non-zero: the orchestrator should record this as an unclean stop.
      process.exit(1)
    }

    logger.info({ ms: Date.now() - startedAt }, 'shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })

  // A crash is not a graceful shutdown. Log, then leave — the process is
  // in an unknown state and the supervisor should replace it.
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception')
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection')
    process.exit(1)
  })
}
```

### Wiring it up

```js title="src/server.js"
import { app, setNotReady } from './app.js'
import { config } from './config.js'
import { pool } from './db.js'
import { redis } from './redis.js'
import { jobWorker } from './jobs.js'
import { installShutdownHandlers } from './shutdown.js'
import { logger } from './logger.js'

const server = app.listen(config.port, (err) => {
  if (err) throw err
  logger.info({ port: config.port }, 'listening')
})

// Must exceed the proxy's idle timeout. See below.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
server.requestTimeout = 30_000

installShutdownHandlers(server, {
  setNotReady,
  timeoutMs: config.shutdownTimeoutMs,
  resources: [
    // Order matters: workers can still enqueue, so they go first.
    { name: 'jobs', close: () => jobWorker.close() },
    { name: 'redis', close: () => redis.quit() },
    { name: 'postgres', close: () => pool.end() },
  ],
  logger,
})
```

`setNotReady` is the readiness flag from [Health and readiness probes](health-and-readiness-probes.md). It is one boolean, and it is the most important line in the whole sequence.

## Signals

| Signal | Sent by | Catchable | What you should do |
| --- | --- | --- | --- |
| `SIGTERM` | Orchestrators, `docker stop`, `systemctl stop`, `kill` | Yes | Run the sequence above. This is the one that matters. |
| `SIGINT` | Ctrl-C in a terminal | Yes | Same sequence, so development matches production. |
| `SIGHUP` | Terminal closed; some tools use it for "reload config" | Yes | Ignore, or reload. Do not shut down — a detached process gets this for reasons unrelated to stopping. |
| `SIGKILL` | The orchestrator after the grace period; `kill -9`; the OOM killer | **No** | Nothing. It cannot be caught, blocked or handled. |

:::danger
**`SIGKILL` cannot be handled.** There is no handler, no cleanup, no `finally`, no flush. The kernel destroys the process. Everything in your shutdown path must therefore finish *before* the grace period expires, and your deadline must be shorter than the platform's.

The same is true of an out-of-memory kill and of a hardware failure. Design so that a hard kill is survivable: acknowledge queue messages only after the work is committed, make handlers idempotent, and never keep state that exists only in this process's memory.
:::

Two ordering details in the handler above:

- **Ignore repeat signals.** Impatient operators press Ctrl-C twice; some orchestrators re-send `SIGTERM`. Without the `shuttingDown` guard, the second signal restarts the sequence and you get two concurrent teardowns.
- **`uncaughtException` is not a shutdown.** After one, your application state is undefined — a mutex may be half-released, a transaction half-written. Log it and exit; do not try to drain gracefully from an unknown state. See [Error handling](../node/error-handling.md).

## The 502 race nobody tells you about

Your shutdown code can be perfect and you will still see 502s, because of this:

```text
t=0.00  Orchestrator sends SIGTERM to the pod
t=0.00  Orchestrator sends "remove this endpoint" to the load balancer
t=0.01  Your process calls server.close()
t=0.30  Load balancer routes a NEW request to your pod  ← connection refused
t=1.20  Load balancer finally applies the endpoint removal
```

Endpoint removal is **asynchronous and eventually consistent**. On Kubernetes, the kubelet sends `SIGTERM` and the endpoints controller updates the EndpointSlice at the same time; kube-proxy, your ingress controller and any cloud load balancer then each pick that change up on their own schedule. Nothing sequences them. The same is true of ALB target deregistration and of most service meshes.

So between `SIGTERM` arriving and the last proxy noticing, traffic still arrives. If your socket is already closed, every one of those is a 502.

**The fix is to wait before closing the socket.** That is the `DRAIN_DELAY_MS` sleep in the module above: readiness flips to `false`, then the process keeps serving normally for a few seconds while the proxies converge, and only then does the socket close.

```text
t=0.00  SIGTERM. Readiness -> false. Socket STILL OPEN, still serving.
t=0.30  A new request arrives. Served normally. 200.
t=1.20  Load balancer has removed the endpoint. No new traffic.
t=5.00  Drain delay elapsed. server.close() + closeIdleConnections().
t=5.40  Last in-flight request finishes.
t=5.45  Pools closed. exit(0).
```

Five seconds is a reasonable default; measure your own convergence time and set it from that. It costs nothing except a slightly longer deploy.

:::warning
Your total shutdown budget must fit inside the platform's grace period, or `SIGKILL` arrives mid-drain and you lose the requests you were trying to save.

On Kubernetes, `terminationGracePeriodSeconds` defaults to **30**. Budget it:

```text
DRAIN_DELAY_MS (5s) + in-flight deadline (15s) + resource close (~2s) = 22s
terminationGracePeriodSeconds: 30   ← comfortably larger
```

If your requests can legitimately run for 60 seconds, you need a grace period above 60, and you need to raise it deliberately — the default will kill them.
:::

```yaml title="deployment.yaml — the fields that matter"
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          env:
            - name: DRAIN_DELAY_MS
              value: "5000"
            - name: SHUTDOWN_TIMEOUT_MS
              value: "15000"
          readinessProbe:
            httpGet: { path: /readyz, port: 3000 }
            periodSeconds: 2
            failureThreshold: 2
```

A readiness probe with `periodSeconds: 30` makes the flag useless — the proxy will not re-check for half a minute. Probe every couple of seconds so the flag is observed quickly.

## Keep-alive connections survive `server.close()`

This is the second thing that goes wrong, and it is subtle.

`server.close()` does two things: it stops listening, and it waits for all **existing connections** to end before invoking its callback. With HTTP/1.1 keep-alive — which every proxy and every modern client uses — a connection stays open after the response, idle, waiting for another request. `server.close()` will not touch it. Your callback never fires. Your process sits there until the deadline and exits with a non-zero code on every single deploy.

`server.closeIdleConnections()` is the fix: it destroys sockets that have no request in progress and leaves active ones alone. Call it right after `server.close()`, exactly as in the module above.

There is also `server.closeAllConnections()`, which destroys **every** connection including ones mid-response. That is not graceful — reach for it only as a last resort at the very end of the deadline, when you have decided a truncated response is better than a `SIGKILL`.

### `keepAliveTimeout` must exceed the proxy's idle timeout

Separately from shutdown, there is a race that produces intermittent 502s during **normal** operation, and it comes from the same mechanism.

`server.keepAliveTimeout` (Node's default is 5 seconds) is how long Node keeps an idle keep-alive connection before closing it. If your proxy's idle timeout is longer, the proxy still believes the connection is usable. It sends a request onto a socket Node is closing at that exact moment; the request is lost; the proxy reports 502.

The rule: **Node's `keepAliveTimeout` must be longer than the proxy's idle timeout**, so the proxy is always the one that closes first.

| Proxy | Default idle timeout | Set Node's `keepAliveTimeout` to |
| --- | --- | --- |
| AWS Application Load Balancer | 60s | 65s or more |
| nginx (`keepalive_timeout` upstream) | 60s (commonly configured lower) | proxy value + 5s |
| Most ingress controllers | 60s | 65s or more |

Set `headersTimeout` slightly above `keepAliveTimeout`, because it bounds the time from the first byte to the end of the headers and must not fire first:

```js
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
```

Also set `server.requestTimeout` (default 300s) to something related to your actual SLA, so a slow client cannot hold a connection through your entire drain window.

## Draining background work

HTTP requests are the visible half. A worker consuming a queue is doing work the HTTP server knows nothing about, and killing it mid-job either loses the job or duplicates it.

The order for a queue consumer is:

1. **Stop consuming.** Tell the client not to fetch more messages. New work stops arriving.
2. **Finish or return what is held.** Let jobs currently executing complete, or explicitly return them to the queue so another worker picks them up immediately instead of after a visibility timeout.
3. **Then** close the connection.

BullMQ's `worker.close()` does steps 1 and 2 — it stops picking up jobs and waits for active ones. Give it its own timeout so a job that runs for ten minutes does not become your shutdown time.

:::best-practice
Make every job handler idempotent and acknowledge only after the work is committed. Then a `SIGKILL` mid-job costs you a redelivery, not a lost or duplicated side effect. This is the only defence that works against the case you cannot handle.
:::

Long-lived connections need the same treatment. WebSocket clients should be sent a close frame with a reason so they reconnect to a healthy instance, rather than discovering the socket is dead on their next send. Server-sent event streams should be ended. Neither is covered in depth here.

## Closing pools last

`pool.end()` on `pg` waits for checked-out clients to be returned and then closes idle ones. That is only safe if nothing is still going to check one out — which is why it comes after in-flight requests and workers are done.

Close in dependency order, most dependent first:

```js
resources: [
  { name: 'jobs',     close: () => jobWorker.close() },  // may use redis + pg
  { name: 'redis',    close: () => redis.quit() },       // may be used by jobs
  { name: 'postgres', close: () => pool.end() },         // used by everything
]
```

`redis.quit()` sends `QUIT` and waits for pending replies. `redis.disconnect()` drops the socket immediately — the difference is whether commands already in flight complete.

If a resource's close hangs, the outer deadline still fires. That is why each close is wrapped in a `try`/`catch` and logged: a failure to close Redis must not prevent Postgres from closing.

## Production considerations

- **Test it.** Start the server, hold a slow request open with `curl`, send `SIGTERM`, and confirm the request completes with a 200 and the process exits 0. Do this in CI if you can. Almost every broken shutdown path is broken because nobody ever ran it.
- **`docker stop` sends `SIGTERM` to PID 1 only.** If your `CMD` is a shell form, the shell is PID 1 and never forwards the signal — your process is `SIGKILL`ed ten seconds later, every time. Use exec-form `CMD` and an init. See [Dockerfile](dockerfile.md).
- **npm is not a supervisor.** `CMD ["npm", "start"]` puts npm at PID 1; signal forwarding to the child is not something to rely on. Run `node` directly.
- **Watch shutdown duration as a metric.** A creeping p99 shutdown time predicts the deploy where the deadline starts being hit.
- **Alert on non-zero exits after `SIGTERM`.** That is the deadline firing, and it means requests are being dropped.
- **Cover connection draining at the front too.** Set your proxy's deregistration delay to at least your drain delay, so the two agree.
- **Emit a `Connection: close` header during drain if you want proxies to stop reusing sockets sooner.** It is optional; the drain delay handles the common case.
- **The same code path runs on scale-in.** Autoscalers terminate pods for capacity reasons far more often than you deploy.

## Common mistakes

- **No handler at all.** The default behaviour is instant death. Every in-flight request is a connection reset.
- **Closing the socket before readiness has propagated.** The proxy is still routing to you. This is the classic deploy-time 502.
- **Forgetting `closeIdleConnections()`.** `server.close()`'s callback waits on idle keep-alive sockets forever, so every shutdown hits the deadline and exits non-zero.
- **Closing the database first.** Requests that would have succeeded now 500. Resources close *last*.
- **No deadline.** One stuck handler holds the process until `SIGKILL`, and then you lose everything anyway — with no log line explaining why.
- **A deadline longer than the grace period.** `SHUTDOWN_TIMEOUT_MS=60000` with `terminationGracePeriodSeconds: 30` means your timeout never runs.
- **`keepAliveTimeout` left at Node's 5-second default behind a 60-second proxy.** Intermittent 502s in steady state that look random and are not.
- **Trying to handle `SIGKILL`.** `process.on('SIGKILL')` is silently useless — it registers a listener that can never fire.
- **Draining after an `uncaughtException`.** The state is unknown. Log and exit non-zero.
- **Handling `SIGTERM` but not `SIGINT`.** Development then behaves differently from production, so you never notice the path is broken.
- **Leaving workers running while the HTTP server drains.** They will happily start a new job at second fourteen of a fifteen-second window.
- **Assuming `process.exit(0)` flushes pending writes.** It does not wait for asynchronous I/O. Flush your logger before calling it — see [Observability](observability.md).

## Related topics

- [Process management](../express-libraries/process-management-and-graceful-shutdown.md) — supervisors, restart policy, and the wider process lifecycle.
- [Health and readiness probes](health-and-readiness-probes.md) — the readiness flag this sequence flips first.
- [Dockerfile](dockerfile.md) — PID 1 and why `SIGTERM` may never reach your process.
- [Clustering](clustering.md) — shutting down a primary and its workers in the right order.
- [Configuration](configuration.md) — where the timeout values come from.
- [Observability](observability.md) — logging and measuring shutdown, and flushing the logger.
- [Connection pooling](../databases/connection-pooling.md) — what `pool.end()` actually waits for.
- [Error handling](../node/error-handling.md) — why an uncaught exception is not a graceful shutdown.
- [The http module](../node/the-http-module.md) — `server.close`, `keepAliveTimeout` and the timeout family.
- [Deployment checklist](deployment-checklist.md) — the shutdown items to verify before shipping.
