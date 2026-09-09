---
title: Logging
description: Structured JSON logging with pino 10 and pino-http 11, redacting secrets, correlating requests with AsyncLocalStorage, and why you should always log to stdout.
status: current
updated: 2026-09-08
---

Logs are the only record of what your process did when nobody was watching. That makes two properties matter more than anything else: they must be machine-queryable, and they must not contain the secrets and personal data that flow through your API.

## Why it exists

`console.log` produces unstructured text on a single line-oriented stream with no levels, no timestamps you can rely on, and no way to filter. The moment you have more than one instance, you cannot answer "show me every 500 for user 4821 in the last hour" from it.

A structured logger emits one JSON object per line with a level, a timestamp, and whatever fields you attach. Your log platform indexes those fields, and the question above becomes a query.

## Installation

:::tabs
@tab npm
```bash
npm install pino@10 pino-http@11
npm install --save-dev pino-pretty@13
```
@tab pnpm
```bash
pnpm add pino@10 pino-http@11
pnpm add -D pino-pretty@13
```
@tab yarn
```bash
yarn add pino@10 pino-http@11
yarn add -D pino-pretty@13
```
:::

## Basic example

```js title="src/logger.js"
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      'token',
      '*.token',
      'refreshToken',
      'creditCard',
      'ssn',
    ],
    censor: '[Redacted]',
  },
  base: { service: process.env.SERVICE_NAME ?? 'api' },
  formatters: {
    // Emit `level: "info"` instead of `level: 30`.
    level: (label) => ({ level: label }),
  },
})
```

```js title="src/app.js"
import express from 'express'
import { pinoHttp } from 'pino-http'
import { logger } from './logger.js'

const app = express()

app.use(pinoHttp({ logger }))

app.get('/items/:id', async (req, res) => {
  req.log.info({ itemId: req.params.id }, 'fetching item')
  res.json(await findItem(req.params.id))
})

export default app
```

Output, one object per line:

```json
{"level":"info","time":1788000000000,"service":"api","req":{"id":1,"method":"GET","url":"/items/42"},"itemId":"42","msg":"fetching item"}
{"level":"info","time":1788000000004,"service":"api","req":{"id":1,"method":"GET","url":"/items/42"},"res":{"statusCode":200},"responseTime":4,"msg":"request completed"}
```

`pino-http` attaches a child logger at `req.log` that carries the request context automatically, and logs one line per completed request. Use `req.log` inside handlers rather than the root `logger`, so every line is correlated.

## Redaction

Redaction is the feature that decides whether your logs are an asset or a liability. `pino-http` logs `req.headers` wholesale by default — which means `Authorization`, `Cookie` and any API key header land in your log platform, in plaintext, forever, readable by everyone with log access.

```js
redact: {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'password'],
  censor: '[Redacted]',   // or a function: (value, path) => …
  remove: false,          // true drops the key entirely instead of censoring
}
```

Path syntax notes that matter in practice:

- Bracket notation is required for keys containing a hyphen: `req.headers["x-api-key"]`, not `req.headers.x-api-key`.
- `*` matches one level: `*.password` catches `user.password` but not `a.b.password`.
- Paths are applied to the **logged object**, so they must match the shape after serializers have run.
- Redaction is not free — it walks the paths on every log call — but it is fast, and a leaked credential costs more.

`remove: true` is better than censoring for fields you never want indexed at all, because `[Redacted]` still tells an attacker with log access that the field existed.

:::danger
Redaction by path only catches what you named. A `password` inside a request body logged as `{ body: req.body }` is caught by `body.password`, but the same value inside a free-text field, an error message, or a stringified object is not. Prefer allow-listing what you log over logging whole objects and hoping the deny-list is complete.
:::

If you must log a body, pick the fields explicitly:

```js
req.log.info({ email: req.body.email, plan: req.body.plan }, 'signup')
```

## Request IDs and AsyncLocalStorage

`req.log` covers the code that can see `req`. Your service layer, your repository, and your background helpers usually cannot — and passing the logger down through every function signature is noise.

`AsyncLocalStorage` carries the context implicitly across `await` boundaries.

```js title="src/context.js"
import { AsyncLocalStorage } from 'node:async_hooks'

export const requestContext = new AsyncLocalStorage()

export function getRequestId() {
  return requestContext.getStore()?.requestId
}
```

```js title="src/middleware/request-context.js"
import crypto from 'node:crypto'
import { requestContext } from '../context.js'

export function withRequestContext(req, res, next) {
  // Accept an inbound ID from the edge so a trace spans services,
  // but validate it — it is client input.
  const inbound = req.get('x-request-id')
  const requestId =
    typeof inbound === 'string' && /^[\w-]{1,64}$/.test(inbound)
      ? inbound
      : crypto.randomUUID()

  res.setHeader('x-request-id', requestId)
  requestContext.run({ requestId, userId: undefined }, next)
}
```

```js title="src/app.js"
import { pinoHttp } from 'pino-http'
import { logger } from './logger.js'
import { withRequestContext } from './middleware/request-context.js'
import { getRequestId } from './context.js'

app.use(withRequestContext)
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => getRequestId(),
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return 'error'
      if (res.statusCode >= 400) return 'warn'
      return 'info'
    },
    autoLogging: {
      ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
    },
  }),
)
```

Now any module can log with the correlation ID without being handed a logger:

```js title="src/services/orders.js"
import { logger } from '../logger.js'
import { getRequestId } from '../context.js'

export async function placeOrder(input) {
  const log = logger.child({ requestId: getRequestId() })
  log.info({ sku: input.sku }, 'placing order')
  // …
}
```

Two details worth knowing:

- `requestContext.run(store, next)` must wrap the rest of the request. Calling `next()` inside `run` is what makes every downstream `await` see the store.
- The store survives `await`, `setTimeout`, and promise chains. It does **not** survive an explicit `queueMicrotask` from outside the context or a callback registered before `run` was entered.
- Echoing the request ID back in a response header lets a user quote it in a support ticket and lets you find the exact request.

Filtering health checks out of `autoLogging` is not cosmetic: a load balancer probing every second produces 86,400 useless lines per instance per day, which you pay to ingest and store.

## Levels

pino's levels are `trace` (10), `debug` (20), `info` (30), `warn` (40), `error` (50), `fatal` (60). Anything below the configured `level` is discarded cheaply — the object is never even constructed if you use the `logger.level` check, and the call itself is near-free.

| Level | Use it for |
| --- | --- |
| `fatal` | The process cannot continue. Log it, then exit. |
| `error` | An operation failed and a human should look: unhandled exception, 5xx, a failed write |
| `warn` | Handled but abnormal: a 4xx worth noticing, a retry, a deprecated path being hit, a fallback engaged |
| `info` | Business events: request completed, order placed, user registered. The default production level. |
| `debug` | Developer detail: query text, cache hit/miss, branch taken. Off in production, on when investigating. |
| `trace` | Firehose. Local only. |

Log `info` in production and make `LOG_LEVEL` an environment variable so you can drop to `debug` on one instance without a deploy.

A validation failure is a `warn`, not an `error`. Treating expected 4xx responses as errors is how alerting becomes noise that everyone learns to ignore.

Errors need the error object, not a string:

```js
try {
  await chargeCard(order)
} catch (err) {
  req.log.error({ err, orderId: order.id }, 'charge failed')
  throw err
}
```

The key must be `err` — pino's standard error serializer keys off that name and produces `type`, `message`, `stack` and any enumerable own properties. `req.log.error(err.message)` throws away the stack.

## pino-pretty in development only

pino writes JSON because machines read it. Humans reading a terminal want colors and columns, which is what `pino-pretty` provides — as a **separate process**, piped:

```json title="package.json"
{
  "scripts": {
    "dev": "node --watch --env-file=.env src/server.js | pino-pretty",
    "start": "node src/server.js"
  }
}
```

:::warning
Do not use `pino-pretty` as a transport in production, and do not make it a runtime dependency. Pretty-printing costs CPU on the hot path, it is a dev dependency, and your log platform needs the JSON. Piping keeps the formatting entirely outside the server process.
:::

If you prefer a transport during development, use `transport: { target: 'pino-pretty' }` guarded by `NODE_ENV`, and understand that transports run in a worker thread — which has its own implications for shutdown, since pending log lines can be lost if the process exits before the worker flushes.

## morgan, the simpler alternative

`morgan` 1.12.0 writes Apache-style access logs. It is one line of setup and does exactly one thing.

```js
import morgan from 'morgan'

app.use(morgan('combined'))
// => ::1 - - [08/Sep/2026:12:00:00 +0000] "GET /items/42 HTTP/1.1" 200 512 "-" "curl/8.4.0"
```

| | pino + pino-http | morgan |
| --- | --- | --- |
| Output | JSON, queryable by field | Text, needs a regex to parse |
| Scope | Access logs *and* application logs | Access logs only |
| Levels | Yes | No |
| Redaction | Built in | None — you write a custom token |
| Correlation | Child loggers, `req.log` | None |
| Speed | Very fast | Fine |

morgan is a reasonable choice for a small internal service where the logs are read by a person tailing a file. For anything that ships logs to a platform, the text format is a liability — every field you want to query has to be re-extracted with a fragile parser. Use pino.

If you already have morgan and want structure without a rewrite, point it at pino:

```js
app.use(morgan('combined', { stream: { write: (line) => logger.info(line.trim()) } }))
```

That gives you JSON envelopes around unstructured messages, which is a stepping stone rather than a destination.

## Log to stdout

Write to `process.stdout` and stop there. Not to a file, not directly to a log service's HTTP API, not to syslog.

The reasons are practical:

- **The process should not own log delivery.** If the log service is slow or down, an in-process shipper either blocks your event loop or buffers into your heap. Neither belongs in a request path.
- **Files need rotation, disk space and cleanup** — three operational problems you inherit for no benefit. In a container the file disappears with the container anyway.
- **Every platform already collects stdout.** Docker, Kubernetes, systemd, ECS, and every PaaS capture it by default and hand it to whatever you configured.
- **It composes.** `node server.js | pino-pretty` in development, and the platform's collector in production, with no code change.

pino writes to stdout synchronously by default, which is what you want: a `fatal` line immediately before a crash actually gets out. Asynchronous transports are faster under extreme volume and can lose the last lines on an abrupt exit.

If you are on a host without a collector, pipe to a rotator (`pino | rotating-file-stream`, or `logrotate` on the shell side) rather than teaching the app about files.

## Security considerations

**Redact the credentials by default, not as an afterthought.** `authorization`, `cookie`, `set-cookie`, `x-api-key`, `password`, `token`, `refreshToken`, `secret`. Add every one your app uses.

**Do not log request bodies wholesale.** Signup, login, payment and profile bodies contain exactly the fields you must never store. Log the field names you chose, not the object.

**Do not log full URLs on routes with secrets in the path or query.** A password-reset token in `?token=…` is written to your logs, your access logs, and your proxy's logs.

**Personal data in logs is subject to the same rules as personal data in your database.** Retention limits, access controls, deletion requests. The cheapest way to comply is not to log it — see [Logging without leaking PII](../security/logging-without-leaking-pii.md).

**A logged error can leak internals.** Stack traces, SQL, and connection strings are fine in your log platform and must never reach the client. Keep the two paths separate: log the detail, respond with a code.

**Treat inbound `X-Request-Id` as input.** Validate it against a pattern before echoing it into a header or a log field. An unvalidated value can inject newlines into a line-oriented log and forge entries.

**Restrict who can read production logs.** They are a secondary copy of a large fraction of your data.

**Log the security events you will need later:** authentication success and failure, authorization denials, rate-limit rejections, password changes, permission changes — with user ID and request ID, never with credentials.

## Production considerations

**One JSON object per line, to stdout.** That is the entire contract with your platform.

**Set `LOG_LEVEL` from the environment.** Being able to raise verbosity on one instance without deploying is worth the five minutes it costs to wire up.

**Sample high-volume `info` lines if ingestion cost bites.** Keep every `warn` and `error`; sample the routine ones. Do not solve cost by turning logging off.

**Attach the fields you will query on**: `service`, `env`, `version` (the git SHA), `requestId`, `userId` where it is safe. Set them once via `base` and child loggers, not per call site.

**Suppress health-check noise** with `autoLogging.ignore`.

**Flush before exit.** On `SIGTERM`, log the shutdown, then let pino's synchronous stdout write complete before `process.exit`. With an asynchronous transport you must flush explicitly or you lose the last lines — exactly the ones explaining why the process is going away. See [Process management](process-management-and-graceful-shutdown.md).

**Make timestamps unambiguous.** pino emits epoch milliseconds in `time` by default, which is compact and sorts correctly. If your platform wants ISO-8601, set `timestamp: pino.stdTimeFunctions.isoTime` once.

**Alert on rates, not on lines.** "More than N errors per minute" and "the 5xx rate crossed 1%" are actionable; "an error occurred" is not.

**Logs are one of three signals.** Metrics tell you something is wrong, traces tell you where, logs tell you why. See [Observability](../production/observability.md).

## Common mistakes

- **`console.log` in production.** No levels, no structure, no correlation.
- **Leaving `req.headers` unredacted.** Bearer tokens and session cookies straight into the log platform.
- **Logging `req.body` on auth or payment routes.** Plaintext passwords and card numbers.
- **`logger.error(err.message)`.** The stack is the useful part; log `{ err }`.
- **Running `pino-pretty` as a production transport.** CPU on the hot path, and unparseable output.
- **Writing to files from inside the app.** Rotation, disk, and cleanup you did not need to own.
- **Shipping logs over HTTP from inside the process.** The log service's outage becomes your latency.
- **Logging health checks.** Tens of thousands of lines a day per instance, all identical.
- **Using the root logger inside handlers** instead of `req.log`, losing the request correlation.
- **Treating every 4xx as `error`.** Alert fatigue, then ignored alerts.
- **Echoing an unvalidated `X-Request-Id`.** Log injection.
- **Exiting before the logger flushes.** The final, most important lines are lost.

## Related topics

- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — what must never appear in a log line, and how to prove it does not.
- [Observability](../production/observability.md) — metrics and traces alongside these logs.
- [Error handling](../express/error-handling.md) — logging the detail while returning a safe response.
- [Process management](process-management-and-graceful-shutdown.md) — flushing logs before the process exits.
- [Rate limiting](rate-limiting.md) — the 429s worth logging and alerting on.
- [Environment variables and config](../node/environment-variables-and-config.md) — where `LOG_LEVEL` comes from.
