---
title: Async/await and promises
description: Running asynchronous work correctly in Node 24 — combinators, cancellation with AbortSignal, concurrency control, and the mistakes that cost latency.
status: current
updated: 2026-09-08
---

Every Node API you should be using in 2026 returns a promise, and `async`/`await` is how you consume them. The syntax is easy; the hard parts are knowing when work should run concurrently, how to cancel it, and where an error goes when nobody is awaiting. This page is about those parts.

## The shape of modern Node async

Prefer the promise-based module for anything that has one:

| Callback module | Promise module |
| --- | --- |
| `node:fs` | `node:fs/promises` |
| `node:dns` | `node:dns/promises` |
| `setTimeout`, `setImmediate` | `node:timers/promises` |
| `stream.pipeline` | `node:stream/promises` |
| `node:readline` | `node:readline/promises` |

```js title="src/wait.js"
import { setTimeout as sleep } from 'node:timers/promises'

await sleep(250)
```

Top-level `await` works in ES modules, so a startup sequence reads straight down the file without an IIFE wrapper.

For the last few callback APIs that have no promise twin, wrap once with `util.promisify`:

```js title="src/gzip.js"
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'

export const gzip = promisify(gzipCb)
```

## Sequential vs concurrent

This is the single highest-value thing on the page. `await` in a loop serializes independent work:

```js title="slow.js"
const users = []
for (const id of ids) {
  users.push(await getUser(id))   // 10 ids x 50 ms = 500 ms
}
```

```js title="fast.js"
const users = await Promise.all(ids.map((id) => getUser(id)))  // ~50 ms
```

Await sequentially only when a later call needs an earlier result, or when you are deliberately rate-limiting.

### Choosing a combinator

| Combinator | Resolves when | Rejects when | Use for |
| --- | --- | --- | --- |
| `Promise.all` | all fulfil | **first** rejection | work where any failure fails the request |
| `Promise.allSettled` | all settle | never | independent work where you want every outcome |
| `Promise.any` | first fulfils | **all** reject, with `AggregateError` | racing redundant sources |
| `Promise.race` | first settles | first settles with a rejection | timeouts and cancellation races |

```js title="src/dashboard.js"
const [profile, orders, invoices] = await Promise.all([
  getProfile(userId),
  getOrders(userId),
  getInvoices(userId),
])
```

```js title="src/notify.js"
const results = await Promise.allSettled(recipients.map(send))
const failed = results.filter((r) => r.status === 'rejected')
if (failed.length) logger.warn({ count: failed.length, reason: failed[0].reason }, 'some sends failed')
```

:::warning
`Promise.all` rejects on the first failure, but the other promises **keep running**. It does not cancel them. If those tasks hold connections or write to a database, you now have work continuing after the response has gone out — pass an `AbortSignal` if you need it to actually stop.
:::

### Start now, await later

Sometimes you want two calls in flight but need to handle them separately:

```js title="src/checkout.js"
const inventoryPromise = checkInventory(cart)   // starts immediately
const user = await getUser(userId)              // runs concurrently
const inventory = await inventoryPromise
```

The promise starts executing the moment it is created, not when it is awaited. That is also the trap: if `inventoryPromise` rejects before you reach the `await`, and the `await getUser` throws first, you get an unhandled rejection.

## Cancellation with AbortSignal

`AbortController` is the standard cancellation primitive, and most modern Node APIs accept a `signal` option — `fetch`, `fs/promises`, `timers/promises`, `stream/promises` `pipeline`, `events.once`.

```js title="src/upstream.js"
export async function getUpstream(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  return res.json()
}
```

`AbortSignal.timeout(ms)` creates a signal that aborts itself. When it fires, the awaiting promise rejects with a `DOMException` whose `name` is `'TimeoutError'`; a manual `controller.abort()` rejects with `name === 'AbortError'`.

```js title="src/errors.js"
try {
  await getUpstream(url)
} catch (err) {
  if (err.name === 'TimeoutError') return res.status(504).json({ error: 'upstream timed out' })
  if (err.name === 'AbortError') return              // client went away; nothing to send
  throw err
}
```

Combine a request-scoped controller with a deadline using `AbortSignal.any()`:

```js title="src/deadline.js"
const controller = new AbortController()
req.on('close', () => controller.abort())          // client disconnected

const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
const data = await fetch(url, { signal })
```

:::best-practice
Every outbound network call needs a timeout. `fetch` has **no default timeout** — without a signal, a hung upstream holds your handler, its database connection and its memory open indefinitely, and one slow dependency takes down the whole service.
:::

## Common patterns

### Limiting concurrency

`Promise.all` over 10,000 items opens 10,000 connections. Bound it with a small pool over a shared iterator — no dependency required:

```js title="src/pool.js"
export async function mapWithConcurrency(items, limit, fn) {
  const iterator = items[Symbol.iterator]()
  const results = []
  let index = 0

  async function worker() {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      const i = index++
      results[i] = await fn(next.value, i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
```

```js title="src/import.js"
const rows = await mapWithConcurrency(records, 8, (record) => upsert(record))
```

Pick the limit from the constrained resource: your database pool size, or the upstream's rate limit — not from a round number.

### `Promise.withResolvers()`

For the cases where you need to settle a promise from outside its executor (Node 22+):

```js title="src/deferred.js"
const { promise, resolve, reject } = Promise.withResolvers()

emitter.once('ready', resolve)
emitter.once('error', reject)

await promise
```

Cleaner than the old `let resolve; new Promise(r => resolve = r)` dance.

### Bridging events to promises

```js title="src/listen.js"
import { once } from 'node:events'

server.listen(3000)
await once(server, 'listening')
```

`events.once` also takes `{ signal }`, so a startup step can have a deadline.

For a stream of events, `events.on()` gives an async iterator:

```js title="src/consume.js"
import { on } from 'node:events'

for await (const [message] of on(queue, 'message', { signal })) {
  await handle(message)
}
```

### Async iteration

`for await` works over async iterables, including streams and async generators, and applies backpressure naturally because the loop body must finish before the next value is pulled.

```js title="src/read-lines.js"
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const lines = createInterface({ input: createReadStream('data.csv'), crlfDelay: Infinity })
for await (const line of lines) {
  await handle(line)
}
```

### Retrying with backoff

```js title="src/retry.js"
import { setTimeout as sleep } from 'node:timers/promises'

export async function retry(fn, { attempts = 3, baseMs = 100, signal } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === attempts - 1) break
      const delay = baseMs * 2 ** attempt + Math.random() * baseMs
      await sleep(delay, undefined, { signal })
    }
  }
  throw new Error(`failed after ${attempts} attempts`, { cause: lastError })
}
```

Retry only **idempotent** operations, and only on transient failures — a retried `POST /payments` charges twice. The random jitter matters: without it, every client in a fleet retries at the same instant and re-creates the outage.

## Common mistakes

- **`await` inside a loop for independent work.** Serializes everything. Use `Promise.all` or a bounded pool.
- **`forEach` with an `async` callback.** `Array.prototype.forEach` ignores the returned promise, so nothing is awaited and errors become unhandled rejections. Use `for…of` or `map` + `Promise.all`.
- **Mixing `await` with `.then()` in the same function.** Pick one. The mixed form is where "why did this run twice" bugs live.
- **`return await` inside `try` removed as "redundant".** Without `await`, the rejection escapes the `try` block and your `catch` never runs. Inside `try`, keep the `await`.
- **Forgetting `fetch` has no default timeout.** Always pass a signal.
- **Assuming `Promise.all`'s rejection cancels the others.** It does not; they run to completion.
- **Creating a promise and awaiting it much later.** If it rejects in between, you get an unhandled rejection that crashes the process by default.
- **`new Promise(async (resolve, reject) => …)`.** An error thrown in the async executor rejects nothing — it becomes an unhandled rejection. If you already have a promise, do not wrap it.
- **Unbounded `Promise.all` over a large list.** Exhausts the connection pool, the file-descriptor limit, or the upstream's rate limit.

## Related topics

- [Runtime and the event loop](./runtime-and-event-loop.md) — where microtasks sit in the scheduling order.
- [Error handling](./error-handling.md) — unhandled rejections, `AggregateError`, and `Error.cause`.
- [Streams and buffers](./streams-and-buffers.md) — async iteration over large data with backpressure.
- [Error handling](../express/error-handling.md) — Express 5 forwards rejected handler promises to the error middleware automatically.
- [Retries and timeouts](../databases/retries-and-timeouts.md) — the same patterns applied to database calls.
