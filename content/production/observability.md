---
title: Observability
description: Structured logs with pino, correlation IDs via AsyncLocalStorage, the metrics that actually matter, OpenTelemetry tracing, and alerting on symptoms rather than causes.
status: current
updated: 2026-09-08
---

Monitoring tells you *that* something is wrong. Observability lets you work out *why* without shipping new code. The difference matters at 3am, when the dashboard says error rate is up and the only question is which of forty things caused it.

## The three signals

| Signal | Answers | Cardinality | Cost model | Typical retention |
| --- | --- | --- | --- | --- |
| **Logs** | What happened to *this* request? | Unbounded — any field, any value | Per byte ingested | Days to weeks |
| **Metrics** | How is the system behaving *overall*? | Must be bounded — every label combination is a time series | Per series, per interval | Months to years |
| **Traces** | Where did the time go, across services? | High, usually sampled | Per span | Days |

They are not substitutes. Metrics show that p99 latency doubled; a trace shows which downstream call caused it; a log line shows the exact query and the user it affected. Skipping one means the other two do more work than they should — most commonly, teams with no metrics try to derive rates from logs, which is both expensive and slow.

Add them in that order: structured logs first, then RED metrics, then tracing when you have more than one service.

## Structured logging with pino

Log **objects**, not sentences. `console.log('user ' + id + ' failed login')` is unsearchable — you cannot filter, count, or aggregate on it. A JSON line with typed fields can be queried like a table.

**pino 10.3.1** is the right default. It serializes to JSON on the fly with very little overhead, which matters because logging sits on the request path.

```js title="src/logger.js"
import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.log.level,

  // Include the fields that let you correlate a line back to a deploy.
  base: {
    service: 'api',
    env: config.env,
    version: process.env.GIT_SHA ?? 'dev',
  },

  // ISO timestamps beat epoch millis for anything a human reads.
  timestamp: pino.stdTimeFunctions.isoTime,

  // Second line of defence. Never rely on it alone.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.token',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
    ],
    censor: '[redacted]',
  },
})
```

```js title="src/app.js"
import pinoHttp from 'pino-http'
import { logger } from './logger.js'

app.use(pinoHttp({
  logger,
  // Probes would otherwise be 95% of your log volume.
  autoLogging: {
    ignore: (req) => req.url === '/livez' || req.url === '/readyz',
  },
  // 4xx is the client's problem; 5xx is yours.
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
}))
```

Rules that hold regardless of library:

- **Write JSON to stdout and stop there.** The platform collects stdout. An application that writes to a file, rotates it, or ships it itself is doing work the platform already does, and it will get it wrong.
- **`pino-pretty` 13.1.3 is a development dependency.** Pipe to it locally (`node src/server.js | pino-pretty`); never run it in production, where it costs CPU to produce a format nothing parses.
- **Log levels mean something.** `error` is "a human should look at this". `warn` is "unusual but handled". `info` is business events — a user registered, an order was placed. `debug` is off in production. If `error` fires a thousand times an hour, it is not an error and people will stop reading it.
- **Log a message once, at the boundary.** Logging the same failure in the repository, the service and the error handler produces three lines that look like three problems.
- **Never log secrets or PII.** Redaction is a safety net, not a policy — see [Logging without leaking PII](../security/logging-without-leaking-pii.md).

## Correlation IDs with `AsyncLocalStorage`

A single request touches a router, a service, two repositories and an outbound HTTP call. Without a shared identifier, those log lines are unrelatable, and under concurrency they are interleaved with fifty other requests.

Threading a `requestId` parameter through every function signature works and is horrible. `AsyncLocalStorage` gives you the same thing implicitly: a value that follows the async call chain, surviving every `await`, `setTimeout` and promise callback, without touching a signature.

```js title="src/context.js"
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { logger } from './logger.js'

const storage = new AsyncLocalStorage()

/** Express middleware: opens a context for the lifetime of the request. */
export function requestContext(req, res, next) {
  // Honour an inbound id from the edge so the trail crosses services.
  const requestId = req.get('x-request-id') ?? randomUUID()
  res.set('x-request-id', requestId)

  const store = {
    requestId,
    // Populated later by auth middleware.
    userId: undefined,
    log: logger.child({ requestId }),
  }

  storage.run(store, next)
}

/** The active context, or undefined outside a request (a job, a timer). */
export function getContext() {
  return storage.getStore()
}

/** A logger that always carries the current request's ids. */
export function log() {
  return getContext()?.log ?? logger
}

export function setUserId(userId) {
  const store = getContext()
  if (store) {
    store.userId = userId
    store.log = store.log.child({ userId })
  }
}
```

Register it as the very first middleware, so everything downstream is inside the context:

```js title="src/app.js"
app.use(requestContext)
app.use(pinoHttp({ /* … */ }))
```

Then any module, at any depth, logs with the id attached and no parameter passing:

```js title="src/services/orders.js"
import { log } from '../context.js'

export async function placeOrder(input) {
  log().info({ sku: input.sku, qty: input.qty }, 'placing order')
  // …
}
```

:::warning
`AsyncLocalStorage` follows the async chain, not the calendar. Work that escapes the request — a `setInterval` registered at boot, a queue consumer, a `process.on` handler — has no store, which is why `log()` falls back to the root logger. For background work, open a fresh context with its own id (a job id) rather than reaching for the request's.
:::

:::best-practice
Propagate the id outbound too. Send `x-request-id` (or the W3C `traceparent` header, if you are using OpenTelemetry) on every call you make to another service, and have every service accept it. A single id that spans your whole stack is worth more than any dashboard.
:::

## Metrics: what to actually measure

Two frameworks, used together:

- **RED**, for request-driven services: **R**ate, **E**rrors, **D**uration. That is the whole of what a user experiences.
- **USE**, for resources: **U**tilization, **S**aturation, **E**rrors. Applied to your event loop, your connection pool, your CPU and your memory.

### The list

| Metric | Type | Why it earns its place |
| --- | --- | --- |
| Request rate, by route and method | counter | The denominator for everything else. A drop is as alarming as a spike. |
| Error rate, by route and status class | counter | Separate 4xx from 5xx: 4xx is clients misbehaving, 5xx is you. |
| Latency p50 / p95 / p99, by route | histogram | The distribution is the signal. |
| **Event-loop delay** | histogram | Node's true saturation metric. Nothing else tells you the process is CPU-bound. |
| Connection-pool saturation | gauge | Waiting count and in-use count. Predicts the outage before it happens. |
| Outbound call duration and error rate, by dependency | histogram + counter | Turns "we are slow" into "the payment provider is slow". |
| Queue depth and job age | gauge | Depth alone is ambiguous; the age of the oldest item is not. |
| GC pause time and heap used | histogram + gauge | Rising heap between GCs is a leak. |
| Active handles / open sockets | gauge | A steady climb is a descriptor leak. |
| Business events — signups, orders, payments | counter | The fastest outage detector you have; nobody notices a 500 faster than an order rate hitting zero. |

**Never average a latency.** A mean of 40 ms hides that 1% of users wait four seconds, and averaging percentiles across instances is mathematically meaningless. Record histograms and let the backend compute quantiles.

### Event-loop delay

This is the Node-specific metric, and the one most services do not have. It measures how late a timer fires relative to when it was scheduled — which is exactly "how long is synchronous work blocking everything else".

```js title="src/metrics/event-loop.js"
import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 20 })
histogram.enable()

export function eventLoopDelay() {
  return {
    // Values are nanoseconds.
    meanMs: histogram.mean / 1e6,
    p50Ms: histogram.percentile(50) / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    maxMs: histogram.max / 1e6,
  }
}

/** Call after each scrape so percentiles reflect the current window. */
export function resetEventLoopDelay() {
  histogram.reset()
}
```

Interpretation: single-digit milliseconds at p99 is healthy. Tens of milliseconds means something synchronous is running on the request path. Hundreds means users are already noticing, and adding replicas will not fix it — find the blocking call. See [Performance](performance.md).

Event-loop delay is also how you answer "would clustering help?" — see [Clustering](clustering.md). If it is near zero under load, you are I/O-bound and more processes will not help.

### Pool saturation

```js title="src/metrics/pool.js"
import { pool } from '../db.js'

export function poolStats() {
  return {
    total: pool.totalCount,     // clients in the pool
    idle: pool.idleCount,       // available right now
    waiting: pool.waitingCount, // requests queued for a client
  }
}
```

`waitingCount` above zero for any sustained period means requests are queuing for a database connection. That queue time is invisible in your query duration metric — the query was fast; getting permission to run it was not. It is one of the most commonly missed sources of latency. See [Connection pooling](../databases/connection-pooling.md).

### Exporting them

:::deprecated
`prom-client` (15.1.3) is **deprecated on npm** in favour of `@prometheus-io/client`. It still works and is widely deployed, but new projects should use the successor package, and existing ones should plan the move. Check the current version on the registry before pinning.
:::

Whichever client you use, the rules are the same:

- **Bound your label cardinality.** Use the route *pattern* (`/users/:id`), never the resolved path (`/users/8f3c…`). One label with a user id in it creates a time series per user and will take your metrics backend down.
- **Expose `/metrics` on a separate port**, or protect it. It reveals your route table, your traffic volume and your error rates.
- **Exclude the probe paths** from request metrics, or they dominate your rate graph.
- **Reset percentile windows on scrape** where the client requires it, so you are reporting the current window rather than since-boot.

## Tracing with OpenTelemetry

A trace is a tree of spans across service boundaries: the request entered the API, spent 12 ms in auth, 340 ms in a database query, 2 ms serializing. In a distributed system it is the only signal that answers "where did the time go" without guessing.

OpenTelemetry is the vendor-neutral standard, and its Node SDK auto-instruments Express, `http`, `pg`, `mysql2`, `redis`, `mongodb` and others — you get spans for the framework and the drivers without touching handler code.

```js title="src/tracing.js — loaded before everything else"
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

```bash
# Must be imported before your app, so instrumentation can patch the modules.
node --import ./src/tracing.js src/server.js
```

:::note
The `@opentelemetry/*` packages version independently and move quickly, and their versions were **not** verified in this site's 2026-09-08 pass. Check the registry for the current release of `@opentelemetry/sdk-node` and the matching auto-instrumentation package before you pin, and read their setup guide — the exporter configuration in particular changes between majors.
:::

Two things to get right:

- **Load the SDK before your application.** Auto-instrumentation works by patching modules at require/import time. `node --import ./src/tracing.js` runs it first; importing it from inside `server.js` after `import express` is too late.
- **Sample.** Tracing every request in a high-traffic service is expensive and mostly redundant. Head sampling at a low percentage plus tail sampling that keeps every error and every slow request gives you the interesting traces at a fraction of the cost.

**Correlate the three signals.** Put the trace id into every log line — with the `AsyncLocalStorage` pattern above, that is one more field on the child logger — and you can jump from a slow trace straight to that request's logs. Without it, you have three tools that each know something and cannot introduce you.

## Dependency health

Every outbound call is a place your service can be slow or wrong through no fault of its own. Instrument the boundary:

- **Duration and error rate per dependency**, as its own metric with a `dependency` label. When latency rises, this table tells you immediately whether it is you or them.
- **Timeouts on everything.** A call with no timeout is a call that can hang until your process runs out of sockets. `AbortSignal.timeout()` is built in.
- **Circuit-breaker state as a gauge**, if you use one — knowing a breaker is open explains a burst of fast failures that would otherwise look like a bug.
- **Retry counts as a counter.** A rising retry rate is an early warning that arrives before the error rate does.
- **Do not confuse the readiness probe with dependency monitoring.** The probe answers "should I get traffic"; the metric answers "is that dependency healthy". See [Health and readiness probes](health-and-readiness-probes.md).

## Alert on symptoms, not causes

The rule: **page a human only for something a user can feel.** Alert on causes and you get a pager that goes off constantly for conditions nobody needs to act on, which trains people to ignore it — and then the real one is ignored too.

| Alert on (symptom) | Not on (cause) |
| --- | --- |
| Error rate above 1% for 5 minutes | A single 500 |
| p99 latency above 2s for 10 minutes | CPU above 80% |
| Order rate at zero for 10 minutes during business hours | Memory at 70% |
| Readiness failing on more than half the fleet | One pod restarted |
| Queue oldest-job age above 5 minutes | Queue depth above 1000 |
| Error budget burning fast enough to exhaust in 6 hours | Disk 60% full |

High CPU is not a problem if latency is fine — it is a well-utilised machine. A pod restart is not a problem if the fleet absorbed it. Those belong on a dashboard you look at while investigating, not on a pager.

Two exceptions worth paging on despite being causes: conditions that are certain to become symptoms and cannot self-recover (disk above 90%, certificate expiring within 7 days), and anything security-relevant.

Every alert needs a runbook link, a clear owner, and an answer to "what should the person do?" An alert with no action is a notification, and it belongs in a channel, not a page.

## SLOs

An SLO turns "the site should be fast" into a number you can hold a decision against.

- **SLI** — the measurement. *The proportion of requests that return non-5xx within 300 ms.*
- **SLO** — the target. *99.5% over a rolling 28 days.*
- **Error budget** — what the target permits. 99.5% over 28 days is about 3.4 hours of failure. That budget is the thing you actually manage.

The budget is what makes SLOs useful rather than decorative. Plenty of budget left means ship the risky migration. Budget nearly gone means stop feature work and spend it on reliability. It converts "are we reliable enough" from an argument into arithmetic.

Practical rules:

- **Measure at the edge, from the user's side.** An SLI computed from your own application metrics cannot see the requests that never reached you.
- **Pick two or three, not twenty.** Availability and latency on your most important endpoint covers most of the value.
- **Alert on burn rate, not on instantaneous failure.** A fast burn — consuming a large fraction of the monthly budget in an hour — pages immediately. A slow burn opens a ticket. This is what stops a five-minute blip from waking someone at 3am for something that self-healed.
- **99.9% is not automatically the right target.** Each additional nine costs roughly an order of magnitude more engineering. Pick the number your users actually need.

## Security considerations

- **Redact at the source, and again on the way out.** pino's `redact` is a net; the policy is not putting the value in the log in the first place. See [Logging without leaking PII](../security/logging-without-leaking-pii.md).
- **Do not log request bodies wholesale.** A generic "log the body on error" middleware will eventually log a password, a card number or a token.
- **Authorization headers and cookies never get logged.** A logged bearer token is a working credential sitting in your log store, where far more people have access than to the secret store.
- **`/metrics` is sensitive.** Route names, traffic volumes and error rates are reconnaissance. Bind it to an internal port or require authentication.
- **Trace attributes leak too.** Auto-instrumentation can attach query parameters and, depending on configuration, statement text. Review what your exporter actually sends.
- **Log access is a privilege.** Logs contain more personal data than your database in most systems. Access-control and retention-limit them.
- **Log security events deliberately** — failed logins, authorization denials, rate-limit trips, token rejections — with enough context to investigate and no credential material.
- **Watch for log injection.** A newline in user-controlled text can forge a log entry in a line-oriented format. JSON output escapes it; plain-text output does not.

## Production considerations

- **Flush the logger before `process.exit()`.** pino's asynchronous transports buffer, and `process.exit` does not wait for pending I/O — so the log lines explaining a shutdown are exactly the ones you lose. Flush in the shutdown handler, before exiting. See [Graceful shutdown](graceful-shutdown.md).
- **Sample high-volume `info` logging.** At high request rates, log ingestion becomes a real cost line. Keep every error, sample the successes.
- **Include the git SHA in `base`.** "Which deploy started this" is the first question, and it should not require a lookup.
- **Instrument before you need it.** Adding metrics during an incident means shipping code during an incident.
- **Watch your own overhead.** Synchronous or over-eager logging on the request path shows up as event-loop delay. Measure it.
- **Cardinality is a production risk, not a style issue.** One unbounded label can take the metrics backend down, and it usually happens at peak traffic.
- **Dashboards should answer questions, not display everything.** One page: RED for the top endpoints, event-loop delay, pool saturation, dependency latency. Everything else is for drilling into.
- **Test the alerts.** An alert that has never fired is an alert you do not know is broken.
- **Keep tracing on in production, sampled.** A tracing setup that only works in staging tells you nothing about production.

## Common mistakes

- **Unstructured logs.** `console.log` with interpolated strings cannot be filtered, counted or aggregated.
- **No correlation id.** Under concurrency, interleaved lines from fifty requests are unreadable.
- **Threading `requestId` through every function.** `AsyncLocalStorage` exists precisely so you do not.
- **Logging the probe endpoints.** Twenty lines a second of `GET /readyz 200` buries everything real.
- **Averaging latency.** The mean hides the tail, and the tail is the user experience.
- **User ids or raw paths as metric labels.** Unbounded cardinality; the classic way to take down a metrics backend.
- **Alerting on CPU.** High CPU with good latency is a well-used machine. Alert on latency.
- **An alert with no runbook.** The person paged has to reinvent the response every time.
- **Loading the OpenTelemetry SDK after your app.** Auto-instrumentation patches at import time; too late is the same as not at all.
- **Tracing 100% of requests at scale.** Expensive and mostly redundant. Sample, keeping errors and slow requests.
- **`pino-pretty` in production.** CPU spent producing a format no aggregator parses.
- **Writing logs to a file inside a container.** Ephemeral, and it competes with the platform's collector. Write to stdout.
- **Exiting without flushing the logger.** You lose the lines describing the shutdown.
- **Treating a readiness probe as dependency monitoring.** Different questions, different consequences.
- **Not measuring event-loop delay.** Without it you cannot distinguish "the process is CPU-bound" from "the database is slow", and the fixes are opposite.

## Related topics

- [Logging](../express-libraries/logging.md) — pino and pino-http configuration in depth.
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — redaction, and what must never be logged.
- [Performance](performance.md) — acting on event-loop delay and latency once you can see them.
- [Health and readiness probes](health-and-readiness-probes.md) — probes versus dependency monitoring.
- [Graceful shutdown](graceful-shutdown.md) — flushing the logger before exit.
- [Clustering](clustering.md) — per-worker identity in logs and metrics.
- [Connection pooling](../databases/connection-pooling.md) — what `waitingCount` is telling you.
- [Configuration](configuration.md) — logging the safe config view at boot.
- [Error handling](../express/error-handling.md) — logging a failure once, at the boundary.
- [Deployment checklist](deployment-checklist.md) — the observability items to verify before shipping.
- [Library index](../reference/library-index.md) — pino and the logging package versions.
