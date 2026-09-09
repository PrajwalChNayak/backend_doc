---
title: Runtime and the event loop
description: How Node 24 schedules your code — libuv phases, microtask ordering, the threadpool, and how to measure a blocked loop.
status: current
updated: 2026-09-08
---

Node runs your JavaScript on a single thread and hands slow work — sockets, files, DNS, compression — to the operating system or to a small pool of background threads. The event loop is the scheduler that decides which completed piece of work gets its callback next. Almost every confusing latency bug in a Node service is a misunderstanding of that ordering, so it is worth learning properly once.

## Why it exists

A traditional thread-per-request server spends most of its memory and context-switching budget on threads that are blocked waiting for I/O. Node inverts that: one thread, a non-blocking syscall interface (`epoll` on Linux, `kqueue` on macOS, IOCP on Windows), and a queue of callbacks for the operations that have finished.

That is why Node is excellent at I/O-bound work — an API that mostly waits on a database — and poor at CPU-bound work. A 200 ms JSON transform is not "slow for that one request"; it is 200 ms during which *no other request in the process makes any progress*.

:::note
Target **Node 24.20.0 (Active LTS)**. Node 20 reached end of life on 2026-04-30, and Node 26 is still **Current** — it becomes LTS on 2026-10-28. Everything on this page applies to Node 24 unless a version gate is stated.
:::

## How it works

### The phases

libuv runs the loop in a fixed cycle. Each turn ("tick") visits these phases in order:

| Phase | What runs there |
| --- | --- |
| **timers** | `setTimeout` and `setInterval` callbacks whose threshold has elapsed |
| **pending callbacks** | a few deferred system callbacks, mostly TCP error handling |
| **idle, prepare** | internal to libuv |
| **poll** | retrieves new I/O events and runs their callbacks; blocks here when there is nothing else to do |
| **check** | `setImmediate` callbacks |
| **close callbacks** | `'close'` events, e.g. `socket.on('close')` |

The **poll** phase is where the process spends its idle time. If there are pending `setImmediate` callbacks, the loop does not block in poll — it goes straight on to **check**.

### nextTick and microtasks are not phases

Two queues sit *between* callbacks rather than inside a phase:

1. The **`process.nextTick`** queue.
2. The **microtask** queue — `Promise` reactions and `queueMicrotask()`.

After every individual callback the loop runs the nextTick queue to exhaustion, then the microtask queue to exhaustion. `process.nextTick` therefore always wins against a promise continuation scheduled at the same moment.

```js title="ordering.js"
setTimeout(() => console.log('4 timeout'), 0)
setImmediate(() => console.log('5 immediate'))
process.nextTick(() => console.log('2 nextTick'))
queueMicrotask(() => console.log('3a microtask'))
Promise.resolve().then(() => console.log('3b promise'))
console.log('1 sync')
```

Output is `1 sync`, `2 nextTick`, `3a microtask`, `3b promise`, and then `4 timeout` / `5 immediate` **in an order you cannot rely on**.

`queueMicrotask()` and `.then()` share one queue, drained in the order they were scheduled — that is why `3a` precedes `3b`.

### setImmediate vs setTimeout(0)

At the top level of a module the race is genuinely nondeterministic: it depends on how many milliseconds process startup consumed before the loop's first timers phase. Inside an I/O callback the answer is fixed, because you are already past the timers phase for this tick:

```js title="io-ordering.js"
import { readFile } from 'node:fs'

readFile(import.meta.filename, () => {
  setTimeout(() => console.log('timeout'), 0)
  setImmediate(() => console.log('immediate'))
})
// always: immediate, timeout
```

Use `setImmediate()` when you mean "after the current I/O completes, before any timers". Use `setTimeout()` only when you actually mean a delay.

:::warning
`process.nextTick()` is not a smaller `setImmediate()`. A `nextTick` callback that schedules another `nextTick` callback starves the event loop forever — the loop never reaches the poll phase and the process stops answering requests while burning 100% CPU. `setImmediate()` cannot do this, because each callback yields back to the loop.
:::

### The libuv threadpool

Some operations have no non-blocking kernel interface, so libuv runs them on a **threadpool of 4 threads by default**, sized with the `UV_THREADPOOL_SIZE` environment variable.

| Uses the threadpool | Does **not** use the threadpool |
| --- | --- |
| `node:fs` (almost all async file operations) | TCP/HTTP sockets — kernel event notification |
| `dns.lookup()` (calls `getaddrinfo`) | `dns.resolve*()` — c-ares, over the network |
| `crypto.pbkdf2`, `crypto.scrypt`, async `randomBytes`, key generation | synchronous `crypto` hashing/HMAC |
| `node:zlib` async compression | `JSON.parse` and your own code — those run on the main thread |

This matters because the pool is a shared, tiny resource. Four concurrent `scrypt` password hashes will delay every file read and every `dns.lookup()` in the process, which looks exactly like a network problem and is not one.

```bash
UV_THREADPOOL_SIZE=16 node server.js
```

Raise it before starting the process — the variable is read once, when the pool is first used.

:::tip
Set `UV_THREADPOOL_SIZE` as an environment variable in your process manager or Dockerfile, not with `process.env` inside the app. By the time your module code runs, the first `fs` call may already have created the pool at the old size.
:::

### Blocking the loop

Anything synchronous blocks everything. The usual offenders:

- `fs.readFileSync` / `writeFileSync` on a request path.
- `JSON.parse` on a multi-megabyte body.
- `crypto.pbkdf2Sync`, `bcrypt.hashSync`, `zlib.gzipSync`.
- A regular expression with catastrophic backtracking on user input.
- A `for` loop over a large array doing string concatenation.

Synchronous calls are fine **at startup** — reading a config file before `listen()` costs nothing. They are never fine per request.

### CPU work belongs in a worker thread

`node:worker_threads` gives you a real OS thread with its own V8 isolate. Use it for genuine computation; use a queue or a separate service for work that takes seconds.

```js title="src/hash-worker.js"
import { parentPort, workerData } from 'node:worker_threads'
import { scryptSync } from 'node:crypto'

const derived = scryptSync(workerData.password, workerData.salt, 64)
parentPort.postMessage(derived.toString('hex'))
```

```js title="src/hash.js"
import { Worker } from 'node:worker_threads'

export function hashInWorker(password, salt) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash-worker.js', import.meta.url), {
      workerData: { password, salt },
    })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`))
    })
  })
}
```

Spawning a worker costs a few milliseconds and several megabytes, so pool them rather than creating one per request.

:::note
`worker_threads` does not multiply your throughput on I/O-bound work. If the profile says you are waiting on Postgres, more threads will not help — connection pooling and query shape will.
:::

## Common patterns

### Measure the loop instead of guessing

`monitorEventLoopDelay` from `node:perf_hooks` samples how late the loop is against a fixed timer, into a histogram. Values are in **nanoseconds**.

```js title="src/loop-delay.js"
import { monitorEventLoopDelay } from 'node:perf_hooks'

const histogram = monitorEventLoopDelay({ resolution: 20 })
histogram.enable()

setInterval(() => {
  const ms = (n) => (n / 1e6).toFixed(1)
  console.log({ mean: ms(histogram.mean), p99: ms(histogram.percentile(99)), max: ms(histogram.max) })
  histogram.reset()
}, 10_000).unref()
```

A healthy service sits near the `resolution` value. A p99 of 300 ms means requests are queueing behind something synchronous — go find it with `--cpu-prof` (see [Debugging](./debugging.md)).

`.unref()` on the interval tells the loop that this timer alone should not keep the process alive.

### Yield inside long loops

If you must process a large batch in-process, break it up so the loop can serve requests between chunks:

```js title="src/batch.js"
import { setImmediate as yieldToLoop } from 'node:timers/promises'

export async function processAll(items, handler) {
  for (const [i, item] of items.entries()) {
    handler(item)
    if (i % 500 === 499) await yieldToLoop()
  }
}
```

This does not make the work faster — it makes the process responsive while the work happens.

### Keep the process alive, or don't

Handles and requests keep the loop running. `server.listen()` keeps the process up; a pending `setInterval` does too. `unref()` opts a handle out of that count. This is the mechanism behind graceful shutdown: once you close the server and the last connection drains, the loop has nothing left and the process exits on its own.

## Common mistakes

- **Assuming `setTimeout(fn, 0)` runs before `setImmediate(fn)`.** At the top level the order is nondeterministic. Inside an I/O callback `setImmediate` always wins.
- **Using `process.nextTick()` for "later".** It runs *before* the loop continues, not after. Recursive `nextTick` calls starve the loop; use `setImmediate()`.
- **Believing `async` makes code non-blocking.** `async` only affects how a function returns. A synchronous 500 ms `for` loop inside an `async function` blocks the loop for 500 ms.
- **Awaiting in a loop when the calls are independent.** Ten sequential 50 ms queries take 500 ms; `Promise.all` takes 50 ms. See [Async/await and promises](./async-await-and-promises.md).
- **Blaming the network for threadpool exhaustion.** Concurrent `scrypt`/`pbkdf2` or heavy `zlib` work saturates 4 threads and delays every `fs` and `dns.lookup()` call in the process.
- **Reaching for `worker_threads` on an I/O-bound service.** Profile first; the bottleneck is usually the database.
- **Setting `UV_THREADPOOL_SIZE` from inside the app.** The pool is created on first use and never resized.
- **Adding `setTimeout` "just to let things settle".** That hides a missing `await` and turns a deterministic bug into a flaky one.

## Related topics

- [Async/await and promises](./async-await-and-promises.md) — the microtask side of the ordering rules, and how to run work concurrently.
- [Streams and buffers](./streams-and-buffers.md) — how to process large payloads without ever holding them in memory.
- [The http module](./the-http-module.md) — the server that sits on top of the poll phase.
- [Debugging](./debugging.md) — `--cpu-prof` and the inspector, for finding what actually blocked the loop.
- [Clustering](../production/clustering.md) — using every core when one loop is not enough.
- [Performance](../production/performance.md) — measuring and tuning a running service.
