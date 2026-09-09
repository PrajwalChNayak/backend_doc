---
title: Process management
description: Handling SIGTERM correctly in Express 5, draining connections with server.close and closeIdleConnections, and choosing between PM2, systemd and an orchestrator.
status: current
updated: 2026-09-08
---

A deploy, a scale-down, or an OOM kill all end the same way: something sends your process a signal and expects it to disappear. What happens to the requests in flight, the database transactions mid-commit, and the log lines not yet written is entirely up to the code you wrote for that signal.

This page covers the process and library mechanics. The deployment-level view — rolling updates, load-balancer behavior, zero-downtime sequencing — is in [Graceful shutdown](../production/graceful-shutdown.md).

## What a shutdown has to do, in order

The ordering is the whole problem. Get it wrong and you drop requests even though every individual step was implemented correctly.

1. **Flip readiness to "not ready".** Stop being sent new work.
2. **Wait for the load balancer to notice.** It polls; it does not get a notification.
3. **Stop accepting new connections** (`server.close()`).
4. **Close idle keep-alive connections** so they do not hold the server open.
5. **Let in-flight requests finish**, up to a deadline.
6. **Close downstream resources** — job workers, then the database pool, then the cache.
7. **Flush logs**, then exit 0.
8. **If the deadline passes, exit non-zero** rather than hanging forever.

Steps 1 and 2 are the ones most implementations skip, and they are the reason a "graceful" shutdown still produces 502s.

## Why readiness must flip first

`server.close()` stops the listener accepting **new** connections. It does nothing about the connections the load balancer already holds open, and — more importantly — the load balancer does not know anything changed.

The sequence without a readiness flip:

1. Orchestrator sends `SIGTERM`.
2. Your process calls `server.close()`.
3. The load balancer, still believing this instance is healthy, routes a new request to it.
4. The connection is refused, or lands on a socket that is closing.
5. The client gets a 502.

The fix is to make the readiness probe fail *before* you stop accepting, and then wait longer than the probe interval before proceeding:

```js title="src/health.js"
export const state = { ready: true }

export function readiness(req, res) {
  if (!state.ready) return res.status(503).json({ status: 'shutting_down' })
  res.json({ status: 'ready' })
}

// Liveness must stay green during shutdown — a failing liveness probe
// causes the orchestrator to SIGKILL you mid-drain.
export function liveness(req, res) {
  res.json({ status: 'ok' })
}
```

The wait in step 2 is not optional and it is not zero. If the readiness probe runs every 5 seconds and needs 2 consecutive failures, you must wait at least 10 seconds — during which you keep serving normally — before calling `server.close()`. Anything shorter and traffic is still arriving when you stop listening.

## The shutdown handler

```js title="src/server.js"
import { createApp } from './app.js'
import { createPool } from './db.js'
import { logger } from './logger.js'
import { state } from './health.js'

const pool = await createPool(process.env.DATABASE_URL)
const app = createApp({ pool })

const server = app.listen(Number(process.env.PORT ?? 3000), (err) => {
  if (err) throw err
  logger.info({ port: server.address().port }, 'listening')
  // Tell a supervisor configured with wait_ready that we are up.
  process.send?.('ready')
})

// Cap how long a client can hold an idle keep-alive connection, and how long
// a single request may take. Both bound the drain window.
server.keepAliveTimeout = 5_000
server.headersTimeout = 10_000
server.requestTimeout = 30_000

const DRAIN_DELAY_MS = Number(process.env.DRAIN_DELAY_MS ?? 10_000)
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 20_000)

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutdown started')

  // 1. Fail readiness so the load balancer stops sending new traffic.
  state.ready = false

  // 2. Keep serving while it notices.
  await new Promise((resolve) => setTimeout(resolve, DRAIN_DELAY_MS).unref())

  // 8. Hard deadline for everything below.
  const hardExit = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  hardExit.unref()

  try {
    // 3 + 5. Stop accepting; the callback fires when the last request ends.
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
      // 4. Without this, an idle keep-alive connection keeps the server open
      //    until keepAliveTimeout expires.
      server.closeIdleConnections()
    })
    logger.info('http server closed')

    // 6. Downstream, in dependency order: consumers first, then the pool.
    await stopBackgroundWorkers()
    await pool.end()
    logger.info('database pool closed')

    clearTimeout(hardExit)
    // 7. pino writes to stdout synchronously, so this line is already out.
    logger.info('shutdown complete')
    process.exitCode = 0
  } catch (err) {
    logger.error({ err }, 'shutdown failed')
    process.exit(1)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
```

Points that are easy to get wrong:

- **`server.close()` waits for in-flight requests but not for idle sockets.** With HTTP keep-alive, a browser or a load balancer holds a connection open with no request on it, and the `close` callback never fires until that socket times out. `server.closeIdleConnections()` (Node 18.2+) closes exactly those — sockets with no request in progress — and leaves active requests alone. Call it immediately after `close()`.
- **`server.closeAllConnections()` exists too and is a different tool.** It destroys active requests as well. It is the sledgehammer for the deadline path, not the normal one.
- **The hard-exit timer must be `unref()`ed** or it keeps the event loop alive and prevents the clean exit it was meant to guard.
- **Prefer `process.exitCode = 0` over `process.exit(0)`** on the success path. Setting the code lets the loop drain naturally; calling `exit()` truncates pending I/O, including log writes.
- **Guard against a second signal.** Orchestrators and impatient humans send `SIGTERM` more than once; without the `shuttingDown` flag you start two drains and double-close the pool.
- **Handle both signals.** `SIGTERM` from orchestrators and systemd, `SIGINT` from Ctrl-C and from PM2, which uses `SIGINT` by default.

### Resource close order

Close in reverse dependency order — the things that *use* a resource before the resource itself:

1. **Background consumers and schedulers.** A BullMQ worker or a cron job that starts a new task after you closed the pool throws.
2. **In-flight HTTP requests** (handled by `server.close()`).
3. **The database pool.** `pool.end()` waits for checked-out clients to be returned, which is why it comes after the HTTP drain.
4. **Redis, and any other cache or broker.**

Calling `pool.end()` first is the classic bug: requests still draining suddenly fail with "cannot use a pool after calling end", turning a graceful shutdown into a burst of 500s.

### What to do about very long requests

A file upload, a report export, or a streamed response can outlive any sane deadline. You have three options and must pick one deliberately:

- **Let the deadline kill it.** Simple, and the client sees a broken connection. Acceptable for idempotent, retryable work.
- **Reject new long requests during the drain** with a 503 and `Retry-After`, and let the existing ones finish inside a longer deadline.
- **Move the work off the request path entirely** — accept, enqueue, return 202. This is the only answer that scales, and it makes shutdown a non-event.

### Uncaught exceptions and unhandled rejections

```js
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled rejection')
  process.exit(1)
})
```

:::warning
Do **not** "recover" from an uncaught exception by logging and carrying on. The process is in an unknown state — a half-applied mutation, a connection in an undefined protocol state, a lock never released. Log it, exit, and let the supervisor restart a clean process.

Note that in Express 5 a rejected promise from a route handler is forwarded to your error middleware automatically, so an `unhandledRejection` here means a rejection *outside* the request lifecycle — a background task, an event listener, a `setInterval`. Those are the ones worth alerting on.
:::

## PM2, systemd, or an orchestrator

| | PM2 7.0.4 | systemd | Kubernetes / ECS / a PaaS |
| --- | --- | --- | --- |
| Restarts | Yes | Yes | Yes |
| Multiple instances | `instances` + cluster mode | One unit per instance, or a template | Replicas |
| Log handling | Its own files, needs `pm2-logrotate` | journald | The platform's collector |
| Zero-downtime reload | `pm2 reload` | Depends on socket activation | Rolling deploy |
| Extra moving part | **Yes — a supervisor written in Node** | No, it is already there | No, it is the platform |
| Right when | A single VM with no container platform | A single VM you already manage with systemd | Anything containerized |

**If you deploy containers, use neither PM2 nor systemd.** The orchestrator already restarts, scales and health-checks; running a supervisor inside the container gives you two things that both think they own the process lifecycle, and PID 1 problems where signals never reach your app. One container, one Node process.

### PM2

```js title="ecosystem.config.cjs"
module.exports = {
  apps: [
    {
      name: 'api',
      script: 'src/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      wait_ready: true, // wait for process.send('ready')
      listen_timeout: 10000, // how long to wait for it
      kill_timeout: 30000, // grace period before SIGKILL
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
}
```

Three PM2 specifics that catch people out:

- **PM2 sends `SIGINT`, not `SIGTERM`.** Handle both, as the code above does.
- **`kill_timeout` defaults to 1.6 seconds.** That is far shorter than any real drain, so PM2 `SIGKILL`s you mid-shutdown by default. Set it longer than `DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS`.
- **`wait_ready: true` requires `process.send('ready')`** from your app, or PM2 gives up after `listen_timeout` and treats the start as failed. It is what makes `pm2 reload` genuinely zero-downtime: the old worker is not killed until the new one says it is listening.

On Windows, signals do not work the same way; PM2 offers `shutdown_with_message: true`, which sends a `'shutdown'` message you listen for with `process.on('message', …)` instead.

### systemd

```ini title="/etc/systemd/system/api.service"
[Service]
Type=simple
ExecStart=/usr/bin/node /srv/api/src/server.js
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=45
Environment=NODE_ENV=production
EnvironmentFile=/etc/api.env
StandardOutput=journal
StandardError=journal
```

`TimeoutStopSec` is the systemd equivalent of `kill_timeout` and must likewise exceed your total shutdown budget. `KillMode=mixed` sends `SIGTERM` to the main process and `SIGKILL` to any survivors after the timeout.

### An orchestrator

The two settings that matter:

- **`terminationGracePeriodSeconds`** must be larger than `DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS`. If it is smaller, you get `SIGKILL` in the middle of the drain and the whole handler was pointless.
- **A `preStop` hook that sleeps** is the platform-level version of the drain delay, and is worth having *in addition to* the in-process one — it covers the window between the pod being removed from the endpoints list and the change propagating to every proxy.

Also make sure the container runs Node as PID 1 with signal forwarding, or use an init shim. A `sh -c "node server.js"` entrypoint on some shells does not forward `SIGTERM` at all, and your handler never runs.

## `--watch` instead of nodemon

In development you want a restart on file change, not a supervisor.

```json title="package.json"
{
  "scripts": {
    "dev": "node --watch --env-file=.env src/server.js",
    "dev:pretty": "node --watch --env-file=.env src/server.js | pino-pretty",
    "start": "node src/server.js"
  }
}
```

`node --watch` is stable from Node 22 and covers what most projects used `nodemon` for: it watches the files the process actually imported, restarts on change, and needs no dependency or config file. `--watch-path` narrows the watched set, and `--watch-preserve-output` stops it clearing the terminal on each restart.

`--env-file=.env` removes `dotenv` as a runtime dependency too (`--env-file-if-exists` if the file is optional).

nodemon is still useful for the cases `--watch` does not cover — watching non-imported files such as templates or SQL, or running a non-Node command on change. For a plain Express app, it is a dependency you no longer need.

:::warning
`--watch` is a development tool. It is not a process supervisor: it does not restart on crash in production, has no backoff, and watching a filesystem in a container is wasted work. Never put it in a production start script.
:::

## Security considerations

**A hung shutdown is a denial of service on yourself.** Without a hard deadline, one stuck request pins an instance forever and a rolling deploy stalls with capacity halved.

**Do not leak internals through the shutdown path.** The 503 body during a drain should say "shutting down" and nothing else — no hostname, no version, no stack.

**Keep liveness green while draining.** A liveness probe that fails during shutdown makes the orchestrator `SIGKILL` you, which drops the in-flight requests you were protecting. Only readiness flips.

**An unauthenticated shutdown endpoint is remote code execution's polite cousin.** Never expose an HTTP route that terminates the process. Signals are the interface.

**Restarts hide crash loops.** A supervisor that restarts instantly turns a repeatable crash — potentially an attacker triggering it deliberately — into a quiet loop nobody notices. Use backoff (`RestartSec`, PM2's exponential backoff, or the platform's) and alert on restart rate.

**Flush security-relevant logs before exiting.** Authentication failures and authorization denials buffered at the moment of exit are exactly the ones an incident investigation needs.

## Production considerations

**One Node process per container.** Let the orchestrator handle replicas. Node's `cluster` module and PM2 cluster mode both make sense on a bare VM and are redundant inside a container platform — see [Clustering](../production/clustering.md).

**Make the timeouts consistent across every layer.** Roughly: `keepAliveTimeout` < request timeout < `SHUTDOWN_TIMEOUT_MS` < supervisor grace period < the load balancer's own drain timeout. A mismatch anywhere in that chain produces the connection resets you were trying to eliminate.

**`server.keepAliveTimeout` must exceed the load balancer's idle timeout,** or the balancer will reuse a connection Node has just closed and return a 502. This is one of the most common causes of intermittent 502s behind AWS ALB and nginx.

**Test the shutdown path.** Send `SIGTERM` while a load generator is running and assert zero failed requests. It is the only way to know the ordering is right, and it is the kind of thing that silently regresses.

```bash
autocannon -c 50 -d 30 http://localhost:3000/items
```

Then, from a second terminal while that is running:

```bash
kill -TERM $(pgrep -f 'node src/server.js')
```

**Log every phase with timings.** "shutdown started", "readiness flipped", "http closed after Nms", "pool closed", "complete". When a deploy takes 45 seconds per instance you want to know which phase.

**Set `DRAIN_DELAY_MS` from the probe configuration,** not from a guess. Probe interval × failure threshold, plus a margin.

**Exit non-zero on a forced shutdown** so the platform records it as a failure rather than a clean stop. A silent exit 0 after a timeout hides the problem.

**Consider `pm2-logrotate` if you use PM2 on a VM** — PM2 writes its own log files and they grow without bound otherwise. Better still, log to stdout and let the supervisor's log collector handle it; see [Logging](logging.md).

## Common mistakes

- **No `SIGTERM` handler at all.** Every in-flight request is severed on every deploy.
- **Calling `server.close()` before flipping readiness.** The load balancer keeps sending traffic to a socket that is closing.
- **No drain delay.** The readiness flip has not propagated when you stop accepting.
- **Forgetting `server.closeIdleConnections()`.** The `close` callback never fires because an idle keep-alive socket is still open, and the deadline kills you every time.
- **Using `closeAllConnections()` in place of `closeIdleConnections()`.** It destroys active requests, which is the opposite of graceful.
- **Closing the database pool before the HTTP server drains.** Draining requests fail with "pool has ended".
- **No hard deadline.** One stuck request hangs the process indefinitely.
- **Not `unref()`ing the deadline timer.** It keeps the loop alive and prevents the clean exit.
- **`process.exit(0)` on the success path.** Pending log writes are truncated.
- **Failing the liveness probe during shutdown.** The orchestrator `SIGKILL`s you mid-drain.
- **PM2's default `kill_timeout` of 1.6 seconds.** Far shorter than any real drain.
- **`terminationGracePeriodSeconds` shorter than your shutdown budget.** Same outcome.
- **Handling only `SIGTERM` when PM2 sends `SIGINT`.**
- **Running PM2 inside a container.** Two supervisors, and signals that do not reach your code.
- **`node --watch` in a production start script.**
- **Continuing after an `uncaughtException`.** The process state is unknown; restart it.

## Related topics

- [Graceful shutdown](../production/graceful-shutdown.md) — the deployment-level sequencing, load-balancer behavior and rolling-update view.
- [Health and readiness probes](../production/health-and-readiness-probes.md) — the endpoints this page flips.
- [Clustering](../production/clustering.md) — when multiple processes are worth it and when the platform already does it.
- [Logging](logging.md) — flushing before exit, and why stdout makes supervisors simple.
- [Connection pooling](../databases/connection-pooling.md) — what `pool.end()` is waiting for.
- [File uploads](file-uploads.md) — the long-running requests that will not drain in five seconds.
- [Dockerfile](../production/dockerfile.md) — running Node as PID 1 with signals forwarded.
