---
title: Performance
description: Measuring before optimizing, the event loop as the real bottleneck, and why the database usually dominates everything else you might tune.
status: current
updated: 2026-09-08
---

Almost every Node performance discussion is about the wrong thing. Teams tune JSON serialization while a missing index costs them 400 ms per request. The discipline is simple and rarely followed: measure, find the largest cost, fix that, measure again.

## Measure first

You cannot reason your way to a bottleneck. Intuition about JavaScript performance is wrong often enough that acting on it is a coin flip, and the cost of guessing wrong is a week of work that changes nothing.

Three tools, three different questions.

### Load generation

**`autocannon`** — a Node HTTP benchmarking tool, the fastest way to get a latency distribution for one endpoint.

```bash
npx autocannon -c 100 -d 30 -p 10 http://localhost:3000/books
```

`-c` connections, `-d` duration in seconds, `-p` pipelined requests per connection. It reports requests per second and a latency table including p97.5 and p99.

**`k6`** — a scriptable load tester for realistic scenarios: a login, then a search, then a purchase, with think time and ramping virtual users. Use it when the shape of the traffic matters, which it does as soon as you have more than one endpoint.

```js title="load/checkout.js"
import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up
    { duration: '2m', target: 50 },    // hold
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.01'],
  },
}

export default function () {
  const res = http.get('http://localhost:3000/books?limit=20')
  check(res, { 'status is 200': (r) => r.status === 200 })
  sleep(1)
}
```

:::warning
A benchmark against an empty database on your laptop measures nothing useful. Production has a table with ten million rows, a network hop to the database, TLS, cold caches, and a connection pool shared with forty other replicas. Load-test against a realistic dataset in a realistic environment, or you will optimize for a system you do not run.

Benchmark from a **different machine** than the one running the server, too. Otherwise the load generator competes with the application for the CPU you are trying to measure.
:::

### CPU profiling

`--cpu-prof` is built in. Run the process under load, stop it, and open the resulting `.cpuprofile` in Chrome DevTools or VS Code.

```bash
node --cpu-prof --cpu-prof-dir=./profiles src/server.js
# apply load, then SIGINT
```

Read it bottom-up: the functions with the most **self time** are where the CPU actually went. A wide, flat profile with everything in libuv and V8 internals means you are I/O-bound and there is no CPU problem to solve.

For a running production process you can attach the inspector instead — `node --inspect` plus a profiler session — but never expose the inspector port; see [Debugging](../node/debugging.md).

Heap snapshots (`--heap-prof`, or `writeHeapSnapshot()`) answer a different question: what is retaining memory. Take two under steady load, several minutes apart, and compare. Objects whose count only ever grows are your leak.

### Diagnosis

**`clinic`** wraps the above with automatic interpretation. `clinic doctor` runs your app under load and tells you which category of problem you have — event-loop blocking, I/O bound, garbage collection, or none of them. `clinic flame` produces a flamegraph; `clinic bubbleprof` visualizes async delay.

It is the right first tool when you do not yet know what kind of problem you have.

## The event loop is the bottleneck

Node runs your JavaScript on one thread. Every millisecond that thread spends executing is a millisecond in which no other request is served — not queued behind a fast handler, just not served.

That single fact reframes performance work. It is not "how fast is this function", it is "how long does this function hold the only thread everyone shares".

**Measure event-loop delay.** It is the one number that tells you whether you have a CPU problem at all:

```js title="src/metrics/event-loop.js"
import { monitorEventLoopDelay } from 'node:perf_hooks'

const h = monitorEventLoopDelay({ resolution: 20 })
h.enable()

setInterval(() => {
  console.log({ p99Ms: h.percentile(99) / 1e6, maxMs: h.max / 1e6 })
  h.reset()
}, 10_000).unref()
```

| p99 delay under load | Diagnosis | Action |
| --- | --- | --- |
| Under ~10 ms | I/O bound. The thread is idle waiting. | Look at the database and downstream calls. More CPU will not help. |
| 10–50 ms | Something synchronous is on the request path. | Profile; find the blocking call. |
| Over 100 ms | Users are experiencing it directly. | Fix before anything else. Adding replicas will not help. |

This is also how you answer "should we cluster?" — see [Clustering](clustering.md). Near-zero delay under load means more processes buy you nothing.

## Never call a synchronous API on the request path

The classic mistake, because the synchronous version is the one with the shorter name.

```js title="Don't: blocks the thread for every concurrent request"
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

app.get('/report', (req, res) => {
  const template = readFileSync('./template.html', 'utf8')  // blocks
  const body = gzipSync(render(template, req.query))        // blocks, expensively
  res.type('html').send(body)
})
```

```js title="Do: async, and hoist what never changes"
import { readFile } from 'node:fs/promises'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

// Read once at boot, not per request.
const template = await readFile('./template.html', 'utf8')

app.get('/report', async (req, res) => {
  const body = await gzipAsync(render(template, req.query))
  res.type('html').send(body)
})
```

Under 100 concurrent requests, a 20 ms synchronous call means the hundredth request waits two full seconds — for work that took 20 ms.

The offenders, roughly in order of how often they appear:

| Blocking | Non-blocking |
| --- | --- |
| `fs.readFileSync`, `writeFileSync`, `existsSync` | `node:fs/promises` — or read once at boot |
| `zlib.gzipSync`, `brotliCompressSync` | `zlib` async APIs, or compress at the proxy |
| `crypto.pbkdf2Sync`, `crypto.scryptSync`, `crypto.randomBytes(size)` with no callback | The callback/promise forms — they use libuv's threadpool |
| `bcrypt.hashSync`, `compareSync` | `await bcrypt.hash(...)`, or `argon2` |
| `child_process.execSync` | `execFile` with a promise |
| `JSON.parse` on a very large body | Stream it, or cap the body size |
| A tight loop over 100k rows | Paginate, or move it to a worker thread |

`await` does not make something non-blocking. `await gzipSync(buf)` blocks exactly as long as `gzipSync(buf)` — the function has to be asynchronous internally.

:::best-practice
Do CPU-heavy work **off** the request path: at boot, on a schedule, in a queue worker, or in a `worker_threads` pool. A user waiting for a PDF should get a 202 and a job id, not a held connection and a stalled event loop for everyone else.
:::

## JSON serialization and response size

`res.json()` calls `JSON.stringify`, which is synchronous. For small payloads it is irrelevant — tens of microseconds. For a 5 MB array it is tens of milliseconds of blocked event loop, per request.

The fix is almost never a faster serializer. It is **sending less data**:

- **Paginate.** An endpoint that can return an unbounded list is a denial-of-service vector as well as a performance problem. Cap `limit` server-side; do not trust the client's value.
- **Select the columns you need.** `SELECT *` on a table with a `text` column ships that column over the network, into your heap, and through `JSON.stringify`, so the same waste is paid three times.
- **Do not embed everything.** A list endpoint that inlines every relation is how a 2 KB response becomes 2 MB. Return ids and let the client fetch what it needs.
- **Strip nulls and internal fields** in your serialization layer — it also stops accidental field leakage.

If you have measured serialization as a genuine cost and cannot reduce the payload, schema-based serializers (the kind Fastify uses) are meaningfully faster than `JSON.stringify` because they know the shape in advance. That is a real but narrow optimization, and it comes after pagination.

For genuinely large responses, stream instead of buffering. See [Streams and buffers](../node/streams-and-buffers.md).

## Compression belongs at the proxy

`compression` 1.8.1 works and is the right answer when nothing sits in front of you. When something does — nginx, an ALB, Cloudflare, an ingress controller — let it compress.

The reason is the event loop again. gzip is CPU work, and doing it in Node takes the one thread away from request handling. nginx does it on a worker process that is not serving your JavaScript, and a CDN does it on someone else's hardware entirely.

| Situation | Compress where |
| --- | --- |
| Behind nginx, an ALB, a CDN or an ingress | At the proxy. Turn Express compression off. |
| Node directly exposed | `compression` middleware. |
| Already-compressed payloads (JPEG, PNG, video, zip) | Nowhere. Compressing them burns CPU to make them slightly larger. |
| Small responses (under ~1 KB) | Nowhere. The overhead exceeds the saving. Use the `threshold` option. |

Never run compression in both places. Double-compressing wastes CPU twice and some clients handle the result badly. See [Compression](../express-libraries/compression.md).

## Outbound calls: keep-alive and agent reuse

An HTTP request that opens a new TCP connection pays a handshake, and over TLS a second round trip on top. On a 30 ms link that is 60–90 ms of pure latency before a byte of your request is sent — often more than the remote service's processing time.

Connection reuse eliminates it. **undici 8.10.2** is Node's HTTP client and backs the global `fetch`, and its `Agent` pools connections per origin.

```js title="src/http-client.js"
import { Agent, setGlobalDispatcher, request } from 'undici'

const agent = new Agent({
  // Sockets kept open per origin.
  connections: 64,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
  // Fail fast rather than piling up requests behind a dead upstream.
  headersTimeout: 5_000,
  bodyTimeout: 10_000,
})

// Makes global fetch() use this pool too.
setGlobalDispatcher(agent)

export async function getUser(id) {
  const { statusCode, body } = await request(
    `https://users.internal/api/users/${encodeURIComponent(id)}`,
    { dispatcher: agent, signal: AbortSignal.timeout(5000) },
  )
  if (statusCode !== 200) throw new Error(`users service returned ${statusCode}`)
  return body.json()
}
```

Three rules:

- **Create the agent once, at module scope.** A new agent per request is a new connection pool per request, which is the problem you were solving.
- **Always set a timeout.** A downstream call with no timeout can hang until your socket limit is exhausted, and then your service is down because of theirs. `AbortSignal.timeout()` is built in.
- **Bound the pool.** `connections` caps how much load you can put on a downstream service, which is also a courtesy to it.

Bare `fetch()` without a configured dispatcher uses undici's default agent, which does keep connections alive — but with defaults you did not choose and no timeout. Configure it explicitly.

## Caching

Caching is the highest-leverage optimization available, and the one with the most ways to be subtly wrong. In increasing order of cost and coordination:

| Layer | Latency | Good for | Watch out for |
| --- | --- | --- | --- |
| HTTP caching (`Cache-Control`, `ETag`) | Zero — the request never arrives | Public, cacheable GETs | Caching a personalized response publicly is a data leak |
| In-process (`Map`, an LRU) | Microseconds | Config, feature flags, small reference data | Per-process, so N replicas means N caches and N versions of the truth |
| Redis | ~1 ms | Sessions, computed results, rate limits | Now a dependency; decide what happens when it is down |
| Materialized view / denormalized column | A query | Expensive aggregates | Invalidation is a schema problem |

Before adding a cache, ask what the hit rate will be. A cache with a 20% hit rate adds a dependency, a consistency problem and an invalidation bug in exchange for a 20% improvement on one query. Measure the access pattern first.

Two rules that prevent the worst outcomes: **set a TTL on everything**, so a stale entry is a temporary problem rather than a permanent one; and **decide the failure mode explicitly** — if Redis is down, does the request fail or fall through to the database? Falling through is usually right, but a cold cache falling through under full load is a stampede that can take the database out. Guard against it with request coalescing.

Never cache a response containing another user's data. Vary on the identity, or do not cache it.

## The database dominates everything

This is the section that matters. In a typical Express API, the request-time budget looks roughly like:

| Component | Typical share |
| --- | --- |
| Database queries (including pool wait) | 60–90% |
| Downstream HTTP calls | 5–25% |
| Your JavaScript — routing, validation, serialization | 1–10% |
| Framework overhead | Under 1% |

Which means: a query that drops from 200 ms to 5 ms because of one index beats every micro-optimization in this page combined. Micro-optimizing handlers while a full table scan runs underneath is the most common form of wasted performance work.

Where the time actually goes:

- **Missing indexes.** `EXPLAIN ANALYZE` the slow query. A sequential scan on a large table is the single most common production performance bug. See [Indexing basics](../databases/indexing-basics.md).
- **N+1 queries.** One query for the list plus one per row. It looks fine on ten rows and destroys you on a thousand. See [N+1 queries](../databases/n-plus-one-queries.md).
- **Pool wait.** Time queued for a connection is not in your query duration metric. `waitingCount` above zero means every request is paying an invisible tax.
- **`SELECT *`.** More bytes off disk, over the network, into the heap, through the serializer.
- **Transactions held open across an HTTP call.** A lock held for a network round trip serializes everything behind it.
- **Chatty ORMs.** Log the actual SQL your ORM emits under a realistic workload; the count is often surprising.

Turn on your database's slow-query log. It is the highest-value five minutes of performance work available.

### Connection pool sizing

Bigger is not faster. A pool larger than the database can usefully serve just moves the queue from your process to the database, where it is more expensive — every connection costs memory and, in Postgres, a backend process.

The arithmetic that surprises people:

```text
pool max per process   10
processes per container  1
replicas                 8
                        ---
connections to the DB    80

Postgres default max_connections: 100
```

Add a second service, or scale to 16 replicas, and you exhaust it. The symptom is `sorry, too many clients already` under load — an outage caused by a number in a config file.

Guidance:

- **Start small.** 5–10 per process is plenty for most services. Raise it only if `waitingCount` is consistently above zero *and* the database is not saturated.
- **Count total connections across every replica and every service**, and compare against `max_connections`.
- **Set an acquire timeout.** Failing fast when the pool is exhausted is better than an unbounded queue that turns into a total stall.
- **Serverless needs a proxy.** PgBouncer or RDS Proxy — see [Connection pooling](../databases/connection-pooling.md).
- **Clustering multiplies it.** Divide the per-process pool by the worker count.

## Blocking crypto

Password hashing is deliberately slow — that is the entire point, and a fast hash is a broken one. The question is only which thread pays.

**`argon2` 0.45.1** runs its hashing in libuv's threadpool via N-API, so the event loop stays free while it works. `bcrypt` 6.0.0's async API does the same. Their `*Sync` variants do not, and neither does a pure-JavaScript implementation.

```js title="src/auth/password.js"
import argon2 from 'argon2'

export function hashPassword(plain) {
  // Async: the work happens on the threadpool, not the event loop.
  return argon2.hash(plain, { type: argon2.argon2id })
}

export function verifyPassword(hash, plain) {
  return argon2.verify(hash, plain)
}
```

The threadpool is **4 threads by default**, and `fs`, DNS and `zlib` share it. With argon2 tuned to ~100 ms, four concurrent logins saturate it and the fifth queues behind them — and so does every file read in the process.

- Raise `UV_THREADPOOL_SIZE` (before the process starts; it is read once) if login concurrency justifies it. It is not free — more threads means more contention for the same cores.
- **Rate-limit the login endpoint.** It is the correct fix for both the performance problem and the credential-stuffing problem. See [Rate limiting](../express-libraries/rate-limiting.md).
- **Do not lower the argon2 cost parameters to make logins faster.** You would be trading your users' password security for latency on the one endpoint where nobody minds 100 ms. See [Password hashing](../express-libraries/password-hashing.md).

Symmetric crypto is different: `crypto.createHash`, HMAC and AES on small inputs are microseconds and fine inline. JWT verification with HMAC is cheap; with RSA it is not free, so cache the verification result for the life of the request rather than re-verifying in three middlewares.

## Realistic numbers

"Node is fast" is not useful. These are rough orders of magnitude on a modern cloud vCPU — measure your own, but they will be in these neighbourhoods.

| Operation | Order of magnitude |
| --- | --- |
| Express routing and middleware overhead | tens of microseconds |
| `JSON.stringify` on a 10 KB object | tens of microseconds |
| `JSON.stringify` on a 5 MB object | tens of milliseconds — **blocking** |
| Indexed single-row Postgres query, same VPC | 0.5–2 ms |
| Unindexed scan over a million rows | 100 ms – seconds |
| Redis `GET`, same VPC | under 1 ms |
| HTTPS call to another service, warm connection | 5–50 ms |
| The same call, cold connection | +60–90 ms for the handshakes |
| `argon2` hash at recommended parameters | ~50–200 ms, by design, on a threadpool |
| Event-loop delay, healthy service | under 10 ms at p99 |

What that adds up to: a well-written Express service doing one indexed query per request handles thousands of requests per second per process, and its p99 is dominated by the database. A service doing an N+1 across 50 rows handles a few dozen, and no amount of framework tuning changes that.

Two conclusions worth internalizing:

- **Framework overhead is noise.** Choosing Fastify over Express because of a benchmark comparing empty handlers optimizes something like 1% of a real request.
- **A cold connection costs more than most of your code.** Connection reuse and a nearby database beat almost any code change.

## Production considerations

- **Set a latency SLO and measure against it.** "Fast" is not a target. `p99 < 300 ms for GET /books` is. See [Observability](observability.md).
- **Percentiles, never averages.** The mean hides the tail, and the tail is what people complain about.
- **Load-test before launch, and again before a traffic event.** The first time you find your breaking point should not be when customers do.
- **Watch event-loop delay and pool saturation in production.** Both predict the outage before latency moves.
- **Size the heap under a container limit.** `--max-old-space-size` at roughly 75% of the memory limit gives V8 headroom to GC before the OOM killer intervenes. See [Dockerfile](dockerfile.md).
- **Scale horizontally, not vertically.** More vCPUs do not help one Node process. More replicas do.
- **Timeouts everywhere.** Server request timeout, database statement timeout, outbound HTTP timeout. Without them a slow dependency becomes an outage.
- **Profile in production, sampled.** Staging load is not production load, and the interesting slow paths only exist under real traffic.
- **Re-measure after every change.** An optimization you did not verify is a change you made for no reason.

## Common mistakes

- **Optimizing without profiling.** A week spent on serialization while a full table scan runs underneath.
- **Benchmarking on a laptop against an empty database.** The result predicts nothing about production.
- **Running the load generator on the server being tested.** They compete for the same CPU.
- **Reporting an average latency.** It hides everything that matters.
- **A `*Sync` call in a handler.** One 20 ms block costs the hundredth concurrent request two seconds.
- **Assuming `await` makes something non-blocking.** `await gzipSync(x)` blocks for exactly as long.
- **Reading a file per request.** Read it once at boot.
- **Unbounded list endpoints.** A performance problem and a denial-of-service vector at the same time.
- **`SELECT *`.** Paid three times over: disk, network, heap.
- **Compressing in Node behind a proxy that also compresses.** CPU spent twice on the request thread.
- **A new HTTP client or agent per request.** No connection reuse, so every call pays the handshakes.
- **No timeout on an outbound call.** Their outage becomes yours.
- **Enlarging the connection pool to fix latency.** It moves the queue to the database and eventually exhausts `max_connections`.
- **Caching before measuring the hit rate.** A new dependency and an invalidation bug for a marginal gain.
- **Caching a personalized response in a shared cache.** That is a data leak, not a performance win.
- **Weakening password-hash parameters for speed.** Rate-limit the endpoint instead.
- **Reaching for clustering while I/O-bound.** More processes, more connections, same database.
- **Switching frameworks for a benchmark number.** Framework overhead is under 1% of a real request.

## Related topics

- [Observability](observability.md) — event-loop delay, pool saturation, and latency percentiles in production.
- [Clustering](clustering.md) — when more processes help, and when they do not.
- [Dockerfile](dockerfile.md) — heap sizing under a container memory limit.
- [Connection pooling](../databases/connection-pooling.md) — sizing, acquire timeouts, and proxies.
- [Indexing basics](../databases/indexing-basics.md) — the single highest-leverage fix available.
- [N+1 queries](../databases/n-plus-one-queries.md) — the most common ORM performance bug.
- [Retries and timeouts](../databases/retries-and-timeouts.md) — bounding the time a dependency can cost you.
- [Compression](../express-libraries/compression.md) — configuring it when there is no proxy.
- [Password hashing](../express-libraries/password-hashing.md) — argon2 parameters and why they are slow on purpose.
- [Runtime and the event loop](../node/runtime-and-event-loop.md) — why one blocked thread stalls everything.
- [Streams and buffers](../node/streams-and-buffers.md) — moving large payloads without buffering them.
- [Debugging](../node/debugging.md) — the inspector, CPU profiles and heap snapshots.
- [Redis](../databases/redis.md) — the cache layer, and its failure modes.
- [Deployment checklist](deployment-checklist.md) — the performance items to verify before shipping.
