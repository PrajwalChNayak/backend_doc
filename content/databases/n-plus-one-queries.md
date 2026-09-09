---
title: N+1 queries
description: What an N+1 costs in real numbers, three ways to fix it with a JOIN, a batched ANY query or DataLoader-style batching, how to detect it, and when it is actually fine.
status: current
updated: 2026-09-08
---

An N+1 is one query to fetch a list, then one more query per item in that list. It is the most common performance bug in application code, it is invisible in development, and it is almost always the single largest win available in a slow endpoint.

## A concrete N+1

An endpoint returning the 50 most recent orders with each order's customer:

```js vulnerable title="DO NOT COPY — src/orders.service.js"
export async function recentOrders() {
  const { rows: orders } = await pool.query(
    'SELECT id, user_id, total_cents, created_at FROM orders ORDER BY created_at DESC LIMIT 50',
  )

  for (const order of orders) {
    const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [
      order.user_id,
    ])
    order.user = rows[0]
  }

  return orders
}
```

That is 1 query for the orders and 50 for the users: **51 queries**.

The queries themselves are not slow. Each one is an indexed primary-key lookup that the database answers in about 0.2 ms. The cost is the round trip.

| Deployment | Round trip | 51 queries, serially | 2 queries |
| --- | --- | --- | --- |
| Same host, Unix socket | ~0.15 ms | ~8 ms | ~0.5 ms |
| Same availability zone | ~0.8 ms | **~41 ms** | ~2 ms |
| Cross-AZ, TLS | ~2.5 ms | **~128 ms** | ~5 ms |

On a developer laptop with the database in Docker, 51 queries costs about 8 ms and nobody notices. Deployed across an availability zone, the same code costs 128 ms — and at 100 requests per second it issues **5100 queries per second** against a database that only needed to answer 200.

The problem compounds. Add each order's line items and you have 1 + 50 + 50 queries. Add the product for each line item — 1 + 50 + 50 + 400. Endpoints like this routinely reach a thousand queries per request, and the pool exhaustion that follows looks like a database problem rather than a code problem. See [Connection pooling](connection-pooling.md).

`await` inside a `for` loop is the shape to look for. It is serial by construction: each iteration waits for the previous round trip before starting the next.

:::warning `Promise.all` is not the fix
Replacing the loop with `Promise.all(orders.map(o => pool.query(...)))` runs the 50 queries concurrently, so wall-clock time improves. But it is still 50 queries, it now needs 50 pooled connections at once — which you do not have — and 49 of them queue anyway. You have converted a latency problem into a pool-exhaustion problem. Reduce the number of queries; do not parallelize them.
:::

## Fix 1: a JOIN

When you need the related data for every row and the relationship is to-one, let the database do the join. One query, one round trip.

```js good title="src/orders.service.js"
export async function recentOrders() {
  const { rows } = await pool.query(
    `SELECT o.id, o.total_cents, o.created_at,
            u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM orders o
       JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
      LIMIT 50`,
  )

  return rows.map((r) => ({
    id: r.id,
    totalCents: r.total_cents,
    createdAt: r.created_at,
    user: { id: r.user_id, name: r.user_name, email: r.user_email },
  }))
}
```

51 queries become 1, and 128 ms becomes about 3 ms.

Two things to be careful about:

- **Alias every column.** Both tables have `id`; without aliases the driver's row object keeps only one. `rowMode: 'array'` is the alternative — see [PostgreSQL with pg](postgresql-with-pg.md).
- **Do not join to-many relationships in the same query as a `LIMIT`.** Joining `orders` to `order_items` multiplies rows: 50 orders with 6 items each is 300 rows, the customer data is repeated six times, and `LIMIT 50` now limits *items*, not orders. That is the "cartesian explosion" problem, and it is why the next fix exists.

## Fix 2: batch with WHERE id = ANY($1)

The general fix, and the one to reach for by default. Collect the ids, fetch them in one query, index the results in memory.

```js good title="src/orders.service.js"
export async function recentOrders() {
  const { rows: orders } = await pool.query(
    'SELECT id, user_id, total_cents, created_at FROM orders ORDER BY created_at DESC LIMIT 50',
  )

  const userIds = [...new Set(orders.map((o) => o.user_id))]

  const { rows: users } = await pool.query(
    'SELECT id, name, email FROM users WHERE id = ANY($1::bigint[])',
    [userIds],
  )

  const byId = new Map(users.map((u) => [u.id, u]))
  return orders.map((o) => ({ ...o, user: byId.get(o.user_id) ?? null }))
}
```

**2 queries, regardless of the list size.** This is why it is called batching rather than joining.

Details that matter:

- **Deduplicate the ids.** Ten orders from the same customer is one id, not ten. `new Set` handles it.
- **`= ANY($1)` is one placeholder taking an array.** There is no way to expand an array into an `IN (…)` list with placeholders, and building `IN (1,2,3)` by string concatenation is an injection hole.
- **Cast the array type** (`::bigint[]`). It helps the planner and it makes an empty array unambiguous.
- **Chunk very large id lists.** Ten thousand ids in one array produces a large query plan and a large parameter. Chunk at around 1000.

For a to-many relationship, the same pattern groups instead of maps:

```js good title="src/orders.service.js"
const { rows: items } = await pool.query(
  'SELECT order_id, sku, qty, price_cents FROM order_items WHERE order_id = ANY($1::bigint[])',
  [orders.map((o) => o.id)],
)

const itemsByOrder = new Map()
for (const item of items) {
  if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, [])
  itemsByOrder.get(item.order_id).push(item)
}

const result = orders.map((o) => ({ ...o, items: itemsByOrder.get(o.id) ?? [] }))
```

Three queries total for orders, customers and line items — no row multiplication, and `LIMIT 50` still means 50 orders.

The `mysql2` equivalent uses `query()` with a nested array, because a prepared statement cannot expand one placeholder into a list:

```js good
const [users] = await pool.query('SELECT id, name, email FROM users WHERE id IN (?)', [userIds])
```

And MongoDB uses `$in`:

```js good
const users = await db.collection('users')
  .find({ _id: { $in: userIds } }, { projection: { name: 1, email: 1 } })
  .toArray()
```

## Fix 3: DataLoader-style batching

Manual batching works when one function owns the whole request. It breaks down when the data is fetched by code that does not know about the other calls — a GraphQL resolver, a serializer that loads an association per entity, a permission check invoked per object.

The solution is a **per-request loader** that collects individual `load(id)` calls made during one tick of the event loop and issues a single batched query.

```js title="src/db/loader.js"
/**
 * Batches individual load(key) calls made in the same tick into one query.
 * `batchFn(keys)` must return values in the same order as `keys`.
 */
export function createLoader(batchFn) {
  const cache = new Map()
  let queue = []
  let scheduled = false

  async function flush() {
    const batch = queue
    queue = []
    scheduled = false

    const keys = batch.map((entry) => entry.key)
    try {
      const values = await batchFn(keys)
      batch.forEach((entry, i) => entry.resolve(values[i]))
    } catch (err) {
      batch.forEach((entry) => entry.reject(err))
    }
  }

  return {
    load(key) {
      if (cache.has(key)) return cache.get(key)

      const promise = new Promise((resolve, reject) => {
        queue.push({ key, resolve, reject })
      })
      cache.set(key, promise)

      if (!scheduled) {
        scheduled = true
        // queueMicrotask defers past every synchronous .load() in this tick.
        queueMicrotask(flush)
      }
      return promise
    },
  }
}
```

```js title="src/db/loaders.js"
import { createLoader } from './loader.js'
import { pool } from './pool.js'

export function createUserLoader() {
  return createLoader(async (ids) => {
    const { rows } = await pool.query(
      'SELECT id, name, email FROM users WHERE id = ANY($1::bigint[])',
      [ids],
    )
    const byId = new Map(rows.map((u) => [u.id, u]))
    // Same order as `ids`, with null for anything missing.
    return ids.map((id) => byId.get(id) ?? null)
  })
}
```

Wire one set of loaders per request:

```js title="src/middleware/loaders.js"
import { createUserLoader } from '../db/loaders.js'

export function loaders(req, res, next) {
  req.loaders = { user: createUserLoader() }
  next()
}
```

```js title="src/routes/orders.js"
router.get('/orders', async (req, res) => {
  const orders = await orderRepo.recent(50)

  // 50 independent .load() calls collapse into ONE query.
  const withUsers = await Promise.all(
    orders.map(async (o) => ({ ...o, user: await req.loaders.user.load(o.user_id) })),
  )

  res.json(withUsers)
})
```

Each call site asks for one user and does not know about the others. The loader turns 50 requests into one query, and its cache means a repeated id costs nothing.

:::danger Loaders must be per request, never module-level
A loader created at module scope caches across users and across time. That means stale data — and, far worse, one user's data served to another when the cache key does not include the tenant. A per-request loader is discarded when the request ends, which is exactly the right lifetime.
:::

The `dataloader` package implements this pattern (with `maxBatchSize`, custom cache keys and better error handling). The 40 lines above show what it does; use the package when you need it, and keep the per-request rule either way.

## How to detect it

N+1s do not announce themselves. You have to look.

**1. Count queries per request.** The most direct signal, and it works everywhere.

```js title="src/db/pool.js"
import { AsyncLocalStorage } from 'node:async_hooks'

export const requestContext = new AsyncLocalStorage()

const originalQuery = pool.query.bind(pool)
pool.query = (...args) => {
  const ctx = requestContext.getStore()
  if (ctx) ctx.queryCount += 1
  return originalQuery(...args)
}
```

```js title="src/middleware/query-count.js"
export function countQueries(req, res, next) {
  const ctx = { queryCount: 0 }
  requestContext.run(ctx, () => {
    res.on('finish', () => {
      if (ctx.queryCount > 20) {
        logger.warn({ path: req.route?.path, queries: ctx.queryCount }, 'possible N+1')
      }
    })
    next()
  })
}
```

Then make it a test assertion. A test that asserts an endpoint issues at most 3 queries fails the moment someone reintroduces the loop — which is far more reliable than noticing in production.

**2. Log queries in development.** Turn on statement logging and read the output for one request. An N+1 is unmistakable: the same query text repeated with different parameters.

```sql
-- Postgres, for a development instance only
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();
```

**3. `pg_stat_statements`.** The best tool for finding them in production. It aggregates by normalized query text, so an N+1 appears as a query with an enormous `calls` count and a tiny `mean_exec_time`.

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

```sql
SELECT calls,
       round(mean_exec_time::numeric, 3) AS mean_ms,
       round(total_exec_time::numeric)   AS total_ms,
       left(query, 90)                   AS query
  FROM pg_stat_statements
 ORDER BY calls DESC
 LIMIT 20;
```

```text
 calls  | mean_ms | total_ms |                  query
--------+---------+----------+------------------------------------------
 482913 |   0.204 |    98514 | SELECT id, name, email FROM users WHERE id = $1
   9481 |   1.882 |    17845 | SELECT id, user_id, total_cents FROM orders ORDER BY ...
```

Read that: 482,913 calls of a 0.2 ms query, against 9,481 calls of the list query. The ratio is almost exactly 51:1. That is the N+1, and it is the top consumer of total database time despite being individually fast.

**Sort by `calls`, not by `mean_exec_time`.** Sorting by mean time finds slow queries; N+1s are made of fast ones. The damage is in the volume.

MySQL's equivalent is the performance schema's `events_statements_summary_by_digest`, ordered by `COUNT_STAR`.

**4. APM traces.** Any tracing tool that instruments the database driver renders an N+1 unmistakably: a waterfall with fifty identical narrow bars in a row. This is the fastest way to find them if you already have tracing. See [Observability](../production/observability.md).

**5. ORM query logs.** Every ORM has a logging option, and lazy-loaded associations are the classic source. See [When to use an ORM](../orms/when-to-use-an-orm.md).

## When N+1 is actually fine

Not every N+1 is worth fixing. The cost is `N × round_trip`, so it is negligible when N is small, when the round trip is tiny, or when the queries are cached.

- **N is small and bounded.** Three lookups for a page that renders one entity is 0.6 ms. Refactoring it into a batched query costs readability for no measurable gain.
- **The database is local.** SQLite has no round trip at all — a query is a function call, measured in microseconds. An N+1 against `node:sqlite` with N in the hundreds is often genuinely irrelevant. See [SQLite](sqlite.md).
- **The per-item lookup hits a cache.** If `load(id)` is served from Redis or an in-process map with a high hit rate, you have N cache reads, not N database queries. A per-request loader gives you this for free.
- **The batched version needs a different index.** `WHERE id = ANY($1)` with 5000 ids can produce a worse plan than 5000 primary-key lookups. Measure rather than assume; `EXPLAIN ANALYZE` both. See [Indexing basics](indexing-basics.md).
- **The JOIN would explode the row count.** Joining several to-many relationships in one query can transfer far more data than several separate queries. Batching, not joining, is the answer there.
- **It is a one-off script** with no latency requirement and no concurrent load.

The rule: fix it when N is unbounded (driven by a list whose size the caller controls), when the round trip is over a network, or when it appears in a hot path. Leave it when N is small and fixed.

Do not fix it speculatively either — an unnecessary `JOIN` that fetches columns nobody uses is its own performance bug.

## Security considerations

**An unbounded N+1 is a denial-of-service vector.** An endpoint with a caller-controlled `limit` and a per-item query lets `?limit=10000` issue ten thousand queries in one request. That occupies a pooled connection for the whole sequence, and a handful of concurrent requests exhausts the pool and takes the service down — no authentication required.

```js good
const limit = Math.min(Number(req.query.limit) || 50, 100) // hard ceiling, always
```

Cap page sizes at a hard maximum, cap the id list you will batch, and put a `statement_timeout` behind it all. See [Retries and timeouts](retries-and-timeouts.md).

**Never build the id list into SQL.** The batched fix is the moment people reach for an `IN` list assembled with `join(',')`, and that is an injection hole even when the ids "come from the database" — they were user-supplied on the way in.

```js vulnerable title="DO NOT COPY"
const { rows } = await pool.query(`SELECT id, name FROM users WHERE id IN (${ids.join(',')})`)
```

```js good
const { rows } = await pool.query('SELECT id, name FROM users WHERE id = ANY($1::bigint[])', [ids])
```

**Batching must not bypass authorization.** The N+1 version often has a per-item ownership check that the batched version quietly drops. Put the tenant or owner filter into the batched query itself:

```js good
const { rows } = await pool.query(
  'SELECT id, name FROM users WHERE id = ANY($1::bigint[]) AND tenant_id = $2',
  [ids, req.user.tenantId],
)
```

Returning rows the caller may not see is [IDOR](../security/broken-object-level-authorization.md), and batching makes it a bulk one.

**Loader caches are per request.** A module-scoped loader cache serves one user's rows to the next request. Include the tenant in the cache key if there is any doubt.

**Timing differences leak existence.** An endpoint that is measurably slower when a related record exists tells an unauthorized caller that it exists. Batching actually helps here, since the query count stops depending on the data.

## Production considerations

- **Assert query counts in tests.** A test that fails when an endpoint exceeds N queries is the only durable defense; N+1s are reintroduced constantly by innocuous refactors.
- **Log a warning above a threshold** (20 queries per request is a reasonable start) with the route name.
- **Enable `pg_stat_statements` in production** and review the top queries by `calls` weekly. It is cheap and it is where N+1s live.
- **Alert on queries per request, not just latency.** An N+1 on a fast local database shows up as database CPU and connection pressure long before it shows up as user-visible latency.
- **Watch the ratio.** A repeated query whose `calls` is a clean multiple of another query's `calls` is an N+1 with the multiple as N.
- **Fix the worst one first.** Order by `total_exec_time`; usually one endpoint accounts for most of it.
- **Beware ORM lazy loading in production.** Accessing an unloaded association issues a query. In a serializer that runs per row, that is an N+1 nobody wrote. See [When to use an ORM](../orms/when-to-use-an-orm.md).
- **Batching changes your index needs.** `WHERE id = ANY($1)` and `WHERE id = $1` can choose different plans. Check with `EXPLAIN ANALYZE` after the change.
- **Cap page sizes.** The fix is worthless if the caller can ask for 10,000 items.
- **Measure before and after** in the deployed environment. The whole cost is the round trip, so a local benchmark understates the problem by an order of magnitude.

## Common mistakes

- **`await` inside a `for` loop over query results.** The canonical shape. Look for it in every code review.
- **`Promise.all` over the same N queries.** Still N queries, now competing for N connections you do not have.
- **Fixing the first level and missing the second.** Orders batched, line items still looped.
- **`JOIN` for a to-many relationship with a `LIMIT`.** Rows multiply and the limit applies to the wrong thing.
- **Forgetting to deduplicate ids** before batching.
- **Assembling an `IN` list with `join(',')`.** An injection hole created while fixing a performance bug.
- **A module-level DataLoader.** Cross-request cache, stale data, cross-tenant leakage.
- **Losing the per-item authorization check** when batching.
- **Only measuring locally.** 8 ms on a laptop, 128 ms across an availability zone.
- **Sorting `pg_stat_statements` by mean time.** N+1 queries are individually fast; sort by `calls`.
- **Fixing an N+1 where N is 3.** Wasted effort and worse code.
- **No hard cap on page size.** The N+1 becomes a denial-of-service endpoint.

## Related topics

- [Indexing basics](indexing-basics.md) — making both the batched and the joined query fast.
- [Connection pooling](connection-pooling.md) — why N concurrent queries exhaust the pool.
- [PostgreSQL with pg](postgresql-with-pg.md) — `= ANY($1)`, `rowMode` and column aliasing.
- [MySQL with mysql2](mysql-with-mysql2.md) — `IN (?)` array expansion with `query()`.
- [MongoDB](mongodb.md) — the `$in` batching form and cursor iteration.
- [When to use an ORM](../orms/when-to-use-an-orm.md) — lazy loading, the main source of accidental N+1s.
- [Observability](../production/observability.md) — traces that make an N+1 obvious.
- [Performance](../production/performance.md) — measuring before optimizing.
- [Retries and timeouts](retries-and-timeouts.md) — bounding a query storm.
