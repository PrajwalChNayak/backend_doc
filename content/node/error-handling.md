---
title: Error handling
description: Error classes, Error.cause, AggregateError, unhandled rejections, and why a Node process should crash instead of limping on.
status: current
updated: 2026-09-08
---

Node's error model is small: throw `Error` objects, catch them where you can do something useful, and let everything else reach a top-level handler that logs and exits. What trips people up is the difference between a failure you expected and a bug you did not — the first deserves a response, the second deserves a restart.

## Two kinds of errors

| | Operational | Programmer |
| --- | --- | --- |
| Examples | upstream 503, invalid input, duplicate key, ENOENT, timeout | `undefined is not a function`, a failed invariant, a bad `await` |
| Expected? | yes — they are part of the system's contract | no — the code is wrong |
| Response | handle it: retry, 4xx/5xx, fall back | log with full context and **crash** |

Trying to recover from a programmer error is how you get a process that serves half-initialized state to users for six hours. Recovering from an operational error is just doing your job.

## Throwing well

### Always throw an `Error`

```js title="src/bad.js"
throw 'user not found'      // no stack, no name, no cause — useless in a log
```

Strings, objects and `null` are all legal to throw and all lose the stack trace. Throw an `Error` (or a subclass) every time.

### `Error.cause` — keep the original

`Error.cause` lets you add context without discarding the underlying failure:

```js title="src/repo.js"
export async function loadUser(id) {
  try {
    return await db.get('SELECT * FROM users WHERE id = ?', [id])
  } catch (err) {
    throw new Error(`failed to load user ${id}`, { cause: err })
  }
}
```

`console.error(err)` and most loggers print the whole chain, so you keep both "what were we doing" and "what actually broke". Before `cause`, people concatenated messages and lost the original stack — do not go back to that.

### Custom error classes

Give your application a small set of error types carrying the data your HTTP layer needs:

```js title="src/errors.js"
export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', expose = false, cause } = {}) {
    super(message, { cause })
    this.name = this.constructor.name
    this.status = status
    this.code = code
    this.expose = expose
  }
}

export class NotFound extends AppError {
  constructor(resource, options = {}) {
    super(`${resource} not found`, { status: 404, code: 'not_found', expose: true, ...options })
  }
}

export class ValidationFailed extends AppError {
  constructor(details, options = {}) {
    super('validation failed', { status: 400, code: 'validation_failed', expose: true, ...options })
    this.details = details
  }
}
```

`expose` is the important field: it says whether the message is safe to send to a client. Internal messages leak table names, file paths and query fragments, so default it to `false` and opt in.

:::danger
Never return `err.message` to a client by default. `connect ECONNREFUSED 10.0.3.14:5432` tells an attacker your internal topology, and a driver error can echo back a query containing other users' data. Send the `code` and a generic message; log the detail server-side with a request id.
:::

### `AggregateError`

`Promise.any` rejects with an `AggregateError` when every input fails. Its `.errors` array holds each individual failure:

```js title="src/mirror.js"
try {
  const data = await Promise.any([fromPrimary(), fromReplica()])
} catch (err) {
  if (err instanceof AggregateError) {
    logger.error({ errors: err.errors.map((e) => e.message) }, 'all mirrors failed')
  }
  throw err
}
```

You can construct one yourself when a batch operation has multiple independent failures:

```js
throw new AggregateError(failures, `${failures.length} of ${total} records failed`)
```

### Match on `code`, not `message`

Node's own errors carry a stable `code`; messages change between releases.

```js title="src/config.js"
import { readFile } from 'node:fs/promises'

try {
  return JSON.parse(await readFile(path, 'utf8'))
} catch (err) {
  if (err.code === 'ENOENT') return {}     // no config file is fine
  throw err
}
```

The same applies to your own errors — that is what the `code` field on `AppError` is for — and to database drivers, where `err.code === '23505'` (Postgres unique violation) is far more robust than a substring match.

### Cancellation errors

An aborted operation rejects with a `DOMException`:

| Trigger | `err.name` |
| --- | --- |
| `controller.abort()` | `AbortError` |
| `AbortSignal.timeout(ms)` firing | `TimeoutError` |

Neither is a bug. An `AbortError` after the client disconnected means there is nobody left to answer — log it at debug level and return, do not report a 500 to your error tracker.

## Process-level handlers

### Unhandled rejections crash by default

**Since Node 15, an unhandled promise rejection terminates the process.** That is the correct default: a rejected promise nobody handled is an unfinished operation, and continuing means running with unknown state.

The `--unhandled-rejections` flag changes the mode:

| Mode | Behavior |
| --- | --- |
| `throw` | **default** — emit `'unhandledRejection'`; if no listener, raise as an uncaught exception |
| `strict` | always raise as an uncaught exception, even with a listener |
| `warn` | print a warning, never crash |
| `warn-with-error-code` | warn, and set the process exit code to 1 |
| `none` | silence it entirely |

:::danger
Do not set `--unhandled-rejections=warn` or `none` to "stabilize" a service. It converts a loud crash into silent data loss — the operation that failed still did not complete, you just stopped being told.
:::

### The top-level handlers

```js title="src/server.js"
import { logger } from '#logger'

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection')
  throw reason                       // promote to uncaughtException
})

process.on('uncaughtException', (err, origin) => {
  logger.fatal({ err, origin }, 'uncaught exception')
  process.exit(1)                    // log, then die
})
```

The only legitimate job of these handlers is **to log with your logger and exit**. Node's default output goes to stderr in a format your log pipeline probably cannot parse; catching it lets you emit structured JSON with a request id first.

Do not attempt to keep serving. After an uncaught exception, an arbitrary function stopped halfway: a transaction may be open, a lock held, a socket half-written. Let the supervisor — systemd, Kubernetes, PM2 — start a clean process.

:::best-practice
Crash fast, restart fast. Pair this with a graceful shutdown path on `SIGTERM` so planned restarts drain connections, and with a readiness probe so the orchestrator does not route traffic to a process that is still booting. See [Graceful shutdown](../production/graceful-shutdown.md).
:::

### Exit codes

`process.exit(code)` terminates immediately and **discards buffered stdout writes** — your last log line can be lost. When you are not in a corrupted state, set `process.exitCode` instead and let the loop drain naturally:

```js
process.exitCode = 1     // exits with 1 once nothing is left to do
```

Reserve `process.exit()` for the `uncaughtException` handler, where waiting is the greater risk.

### Warnings

`process.on('warning', …)` catches deprecation and `MaxListenersExceededWarning` notices. In development, `node --trace-warnings` prints the stack that produced the warning, which is the only practical way to find which package is triggering it.

## `node:assert` — for invariants, not input

`node:assert` throws an `AssertionError` when a condition you believe is guaranteed turns out not to be. Use the strict variant so `==` semantics never enter the picture:

```js title="src/invoice.js"
import assert from 'node:assert/strict'

export function applyDiscount(total, discount) {
  assert(discount >= 0 && discount <= total, 'discount must be within [0, total]')
  return total - discount
}
```

An assertion failure is a **programmer error** — it should crash. That makes `assert` wrong for validating request bodies: user input being wrong is expected, and deserves a 400, not a stack trace. Use a schema validator for that; see [Validation](../express-libraries/validation.md).

`node:assert` is also the assertion library for the built-in test runner — `assert.deepStrictEqual`, `assert.rejects`, `assert.throws`, `assert.match`. See [The built-in test runner](./built-in-test-runner.md).

## Common patterns

### Readable stack traces from compiled code

If you ship compiled or bundled JavaScript, run with source maps enabled so stacks point at your sources:

```bash
node --enable-source-maps src/server.js
```

### Do not swallow

```js title="src/bad.js"
try {
  await doWork()
} catch (err) {
  console.log('something went wrong')   // no err, no rethrow — the failure vanishes
}
```

An empty or message-only `catch` is how outages become unexplainable. Either handle the error meaningfully, or attach context and rethrow with `cause`.

### Errors from event emitters

A promise-based API rejects; an `EventEmitter` emits `'error'`, and **an unhandled `'error'` event throws**. Every long-lived emitter — servers, sockets, streams, database clients — needs a listener:

```js title="src/server.js"
server.on('error', (err) => {
  logger.fatal({ err }, 'server error')
  process.exit(1)
})
```

## Common mistakes

- **Throwing strings or plain objects.** No stack trace, and every logger formats them differently.
- **Losing the original error.** `throw new Error('db failed')` inside a `catch` without `{ cause: err }` throws away the only useful information.
- **Matching on `err.message`.** Messages are not API. Match on `err.code` or `instanceof`.
- **Sending `err.message` to clients.** Leaks internal hostnames, paths and SQL. Gate it behind an explicit `expose` flag.
- **Setting `--unhandled-rejections=warn` to stop crashes.** The failure still happened; you only removed the alarm.
- **Continuing to serve after `uncaughtException`.** Process state is unknown. Log and exit.
- **`process.exit()` right after a `console.log`.** Buffered output can be dropped. Use `process.exitCode` where you can.
- **Using `assert` on request bodies.** Bad input is not a bug; it is a 400.
- **No `'error'` listener on a stream or emitter.** An unhandled `'error'` event is thrown and takes the process down.
- **Wrapping async Express handlers in `try/catch` just to call `next(err)`.** Express 5 forwards rejected promises automatically.

## Related topics

- [Async/await and promises](./async-await-and-promises.md) — where unhandled rejections come from, and `AggregateError`.
- [The built-in test runner](./built-in-test-runner.md) — `assert.rejects` and testing failure paths.
- [Debugging](./debugging.md) — `--trace-warnings`, `--stack-trace-limit`, and source maps.
- [Error handling](../express/error-handling.md) — turning these errors into HTTP responses in Express 5.
- [Graceful shutdown](../production/graceful-shutdown.md) — the restart half of "crash fast".
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — serializing errors without dumping secrets.
