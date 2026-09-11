---
title: Avoiding N+1
description: A concrete N+1 inside a Nest service, three fixes — relation loading, a batched IN query and a per-request DataLoader — plus the Nest-specific places it hides, how to detect it with query counting and pg_stat_statements, and when it is fine.
status: current
updated: 2026-09-11
---

An N+1 is one query to fetch a list, then one more query per item in that list. It is invisible on a laptop, it is the largest single win available in most slow endpoints, and Nest adds two places to hide it that plain Express does not have: an interceptor and a serializer both run *after* your service returned, so a query issued there is one nobody reading the service will see. The framework-independent version of this page — the latency arithmetic, the `= ANY($1)` patterns, a DataLoader implementation in forty lines — is [N+1 queries](../databases/n-plus-one-queries.md), and all of it still applies.

:::note How the examples are written
Nest's constructor injection is usually written with the parameter-property shorthand. The snippets here declare the field and assign it, because the site's snippet checker type-strips every `ts` block. The two forms are equivalent — use the shorthand in your own code.
:::

## A concrete N+1

An endpoint returning the 50 most recent posts with each post's author:

```ts vulnerable title="DO NOT COPY — src/posts/posts.service.ts"
@Injectable()
export class PostsService {
  async recent(limit: number) {
    const posts = await this.posts.find({
      where: { published: true },
      order: { createdAt: 'DESC' },
      take: limit,
    })

    // 1 query above, one more per post below. At limit=50 that is 51.
    for (const post of posts) {
      post.author = await this.users.findOne({ where: { id: post.authorId } })
    }

    return posts
  }
}
```

The queries are not slow. Each is an indexed primary-key lookup the database answers in about 0.2 ms. The cost is the round trip, and it is entirely invisible where you develop:

| Deployment | Round trip | 51 queries, serially | 2 queries |
| --- | --- | --- | --- |
| Database in Docker on your laptop | ~0.15 ms | ~8 ms | ~0.5 ms |
| Same availability zone | ~0.8 ms | **~41 ms** | ~2 ms |
| Cross-AZ, TLS | ~2.5 ms | **~128 ms** | ~5 ms |

At 100 requests per second that endpoint issues **5,100 queries per second** against a database that needed to answer 200. It also occupies a pooled connection for the whole sequence, so the failure it eventually produces looks like pool exhaustion rather than a code problem. [Connection pooling](../nestjs-databases/connection-pooling.md).

`await` inside a `for` loop over query results is the shape to look for.

:::warning `Promise.all` is not the fix
`await Promise.all(posts.map((p) => this.users.findOne(…)))` runs the fifty queries concurrently, so wall-clock time improves. It is still fifty queries, it now wants fifty pooled connections at once — which you do not have — and forty-eight of them queue anyway. You have converted a latency problem into a pool-exhaustion problem. **Reduce the number of queries; do not parallelise them.**
:::

## Where it hides in a Nest application

The loop above is the easy case, because it is visible. These are not.

**An interceptor or a serializer.** A `ClassSerializerInterceptor` runs after the handler returns, and a `@Transform` or a getter on the returned object can touch a lazy relation. The query then fires during serialization, in a file nobody opens when they profile the service.

**A TypeORM lazy relation.** Typing a property as `Promise<Post[]>` means a property *access* is a query. A `.map()` over users that touches `user.posts` is an N+1 with no visible query call anywhere.

**`eager: true` on a relation.** Not an N+1 by itself, but it changes the cost of every `find` on that entity everywhere in the application — including the ten endpoints that never needed the relation.

**A guard or a policy handler that loads per item.** A `@UseGuards` that checks ownership by fetching each object is one query per object, executed before your service even starts.

**A GraphQL `@ResolveField`.** The canonical case: the resolver is invoked once per parent, so a field resolver that queries is an N+1 by construction. This is the one place a DataLoader is not optional. [GraphQL](../nestjs-advanced/graphql.md).

**A `Promise.all` over a service method** that itself does a query. Two layers of code each look reasonable; together they are the loop.

## Fix 1 — load the relation in the same query

When you need the related data for every row and the relationship is to-one, let the database or the ORM do it in a fixed number of statements.

```ts title="src/posts/posts.service.ts"
// TypeORM — object syntax, required since 1.0
const posts = await this.posts.find({
  where: { published: true },
  relations: { author: true },
  select: {
    id: true,
    title: true,
    createdAt: true,
    author: { id: true, name: true },
  },
  order: { createdAt: 'DESC' },
  take: limit,
})
```

```ts title="src/posts/posts.service.ts"
// Prisma — nested select narrows the type as well as the payload
const posts = await this.prisma.post.findMany({
  where: { published: true },
  select: {
    id: true,
    title: true,
    createdAt: true,
    author: { select: { id: true, name: true } },
  },
  orderBy: { createdAt: 'desc' },
  take: limit,
})
```

```ts title="src/posts/posts.service.ts"
// Drizzle — relational query, one statement
const posts = await this.db.query.posts.findMany({
  columns: { id: true, title: true, createdAt: true },
  with: { author: { columns: { id: true, name: true } } },
  where: (posts, { eq }) => eq(posts.published, true),
  limit,
})
```

```ts title="src/posts/posts.service.ts"
// Mongoose — populate on the QUERY, never in a loop
const posts = await this.posts
  .find({ published: true })
  .select('title author createdAt')
  .populate({ path: 'author', select: 'name' })
  .sort({ createdAt: -1 })
  .limit(limit)
  .lean()
  .exec()
```

51 queries become 1 or 2 depending on the tool: TypeORM joins, Drizzle emits one statement, Prisma issues a second query per relation, and Mongoose issues a second query with an `$in`. A fixed small number either way.

Two traps that apply to all four:

- **Do not join a to-many relation in the same query as a `LIMIT`.** Joining 50 posts to their comments multiplies rows, the post columns repeat once per comment, and the limit now limits *comments*. TypeORM's `relationLoadStrategy: 'query'` avoids the multiplication by issuing a second statement; Prisma and Mongoose already do that by default. Otherwise, use Fix 2.
- **Project the columns.** `relations: { author: true }` with no `select` fetches every author column for every post, password hash included. See [Repository vs active record](./repository-vs-active-record.md).

## Fix 2 — batch with one IN query

The general fix, and the one to reach for by default: collect the ids, fetch them in one query, index the results in memory. It is two queries regardless of list size, and unlike a join it never multiplies rows.

```ts title="src/posts/posts.service.ts"
import { Injectable } from '@nestjs/common'
import { In, Repository } from 'typeorm'

@Injectable()
export class PostsService {
  private readonly posts: Repository<Post>
  private readonly users: Repository<User>

  constructor(posts: Repository<Post>, users: Repository<User>) {
    this.posts = posts
    this.users = users
  }

  async recent(limit: number, tenantId: number) {
    const posts = await this.posts.find({
      where: { published: true, tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    })

    // Deduplicate: ten posts by the same author is one id, not ten.
    const authorIds = [...new Set(posts.map((p) => p.authorId))]
    if (authorIds.length === 0) return []

    const authors = await this.users.find({
      // The tenant filter comes with us. Batching must not widen access.
      where: { id: In(authorIds), tenantId },
      select: { id: true, name: true },
    })

    const byId = new Map(authors.map((a) => [a.id, a]))
    return posts.map((p) => ({ ...p, author: byId.get(p.authorId) ?? null }))
  }
}
```

`In([...])` becomes one placeholder per element — a real parameterised list, not a string. The equivalents:

| Tool | Batched form |
| --- | --- |
| TypeORM | `where: { id: In(ids) }` |
| Prisma | `where: { id: { in: ids } }` |
| Drizzle | `where: inArray(users.id, ids)` |
| Mongoose | `find({ _id: { $in: ids } })` |
| Raw `pg` | `WHERE id = ANY($1::bigint[])` |

For a to-many relation the same pattern groups instead of maps — fetch all children with one `IN` on the parent ids, bucket them into a `Map<parentId, child[]>`, and attach. Three queries total for posts, authors and comments, with no row multiplication and a `LIMIT` that still means what you wrote.

**Chunk very large id lists.** Ten thousand ids in one array produces a large plan and, on `pg`, runs into the 65535-bind-parameter cap on the multi-value forms. A thousand per chunk is a reasonable default.

## Fix 3 — a per-request loader

Manual batching works when one method owns the whole request. It breaks down when the data is fetched by code that does not know about the other calls: a GraphQL field resolver, a serializer that loads an association per entity, a permission check invoked per object.

The answer is a **per-request loader** that collects individual `load(id)` calls made in the same tick and issues one batched query. Nest gives you two ways to scope it to a request, and they have genuinely different costs.

### Option A — a request-scoped provider

```ts title="src/users/users.loader.ts"
import { Injectable, Scope } from '@nestjs/common'
import DataLoader from 'dataloader'
import { UsersRepository } from './users.repository.js'

@Injectable({ scope: Scope.REQUEST })
export class UsersLoader {
  readonly byId: DataLoader<number, UserRecord | null>

  constructor(users: UsersRepository) {
    this.byId = new DataLoader(async (ids: readonly number[]) => {
      const rows = await users.findManyByIds([...ids])
      const map = new Map(rows.map((r) => [r.id, r]))
      // MUST return results in the same order as `ids`, with a hole for
      // anything missing — DataLoader matches by position, not by key.
      return ids.map((id) => map.get(id) ?? null)
    })
  }
}
```

Nest builds one instance per request and discards it afterwards, which is exactly the right lifetime.

:::warning Request scope propagates upward
Anything that injects `UsersLoader` becomes request-scoped too, and so does anything that injects *those* — up through services to the controller, and to any guard or interceptor in the chain. Nest then instantiates that whole subtree per request. It is a real throughput cost, and it is a behaviour change: a provider you assumed was a singleton now has per-request state.

It is also unavailable outside HTTP. A BullMQ processor, a `@Cron` job and a microservice handler have no request context, so a request-scoped loader cannot be injected there at all. Read [Injection scopes](../nestjs/injection-scopes.md) before choosing this.

For GraphQL it is still usually the right call, because resolvers are already the request tree and the N+1 is structural.
:::

### Option B — AsyncLocalStorage, everything stays a singleton

A middleware creates the loaders and puts them in a store; a singleton factory reads them. Nothing in the injection graph changes scope, and it works in a queue processor or a cron job as long as something opened a store.

```ts title="src/database/loader.context.ts"
import { AsyncLocalStorage } from 'node:async_hooks'
import type DataLoader from 'dataloader'

export interface LoaderBag {
  user: DataLoader<number, UserRecord | null>
}

export const loaderStorage = new AsyncLocalStorage<LoaderBag>()
```

```ts title="src/database/loaders.middleware.ts"
import { Injectable, NestMiddleware } from '@nestjs/common'
import type { Request, Response, NextFunction } from 'express'
import { loaderStorage } from './loader.context.js'
import { LoaderFactory } from './loader.factory.js'

@Injectable()
export class LoadersMiddleware implements NestMiddleware {
  private readonly factory: LoaderFactory

  constructor(factory: LoaderFactory) {
    this.factory = factory
  }

  use(req: Request, res: Response, next: NextFunction) {
    // A fresh bag per request. The store is discarded when the request ends.
    loaderStorage.run(this.factory.create(), () => next())
  }
}
```

```ts title="src/users/users.service.ts"
import { Injectable } from '@nestjs/common'
import { loaderStorage } from '../database/loader.context.js'

@Injectable()
export class UsersService {
  /** Singleton. The per-request state lives in the store, not the provider. */
  loadAuthor(id: number) {
    const bag = loaderStorage.getStore()
    if (!bag) throw new Error('loader context is not open')
    return bag.user.load(id)
  }
}
```

The trade is the usual one: Option A is explicit and costs provider lifetimes; Option B keeps the graph flat and makes the dependency invisible. It is the same choice as transaction propagation, and it should get the same answer — see [Transactions](../nestjs-databases/transactions.md). Pick one for the codebase and write it down.

:::danger A loader must never be module-scoped
```ts vulnerable title="DO NOT COPY — a cache shared by every user, forever"
// Module scope: one DataLoader for the life of the process.
export const userLoader = new DataLoader(batchLoadUsers)
```
Its cache now spans users and time. That is stale data at best, and one tenant's rows served to another at worst, because the cache key is an id and nothing else. A per-request loader is discarded when the request ends, which is the whole point.
:::

The `dataloader` package implements batching with `maxBatchSize`, custom cache keys and per-key error handling; [N+1 queries](../databases/n-plus-one-queries.md) shows the forty-line version if you would rather not add a dependency. The per-request rule holds either way.

## How to detect it

N+1s do not announce themselves. You have to look.

### 1. Count queries per request

The most direct signal, and the one you can turn into a test. Increment a counter in the ORM's query hook, read it in an interceptor:

```ts title="src/database/query-count.context.ts"
import { AsyncLocalStorage } from 'node:async_hooks'

export const queryCount = new AsyncLocalStorage<{ count: number }>()
```

```ts title="src/database/prisma.service.ts"
async onModuleInit() {
  await this.$connect()
  this.$on('query', () => {
    const ctx = queryCount.getStore()
    if (ctx) ctx.count += 1
  })
}
```

```ts title="src/database/query-count.interceptor.ts"
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import { queryCount } from './query-count.context.js'

@Injectable()
export class QueryCountInterceptor implements NestInterceptor {
  private readonly logger = new Logger('QueryCount')

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = { count: 0 }
    const handler = `${context.getClass().name}.${context.getHandler().name}`

    return queryCount.run(ctx, () =>
      next.handle().pipe(
        tap(() => {
          if (ctx.count > 20) {
            this.logger.warn(`${handler} issued ${ctx.count} queries — possible N+1`)
          }
        }),
      ),
    )
  }
}
```

TypeORM's equivalent hook is a custom `logger` on the DataSource options; Drizzle's is the `logger` option on `drizzle()`; Mongoose's is `mongoose.set('debug', fn)`.

Then make it an assertion. A test that fails when an endpoint exceeds three queries catches the reintroduction on the pull request, which is far more reliable than noticing in production:

```ts title="test/posts.e2e-spec.ts"
const ctx = { count: 0 }
await queryCount.run(ctx, async () => {
  await request(app.getHttpServer()).get('/posts?limit=50').expect(200)
})
expect(ctx.count).toBeLessThanOrEqual(3)
```

N+1s are reintroduced constantly by innocuous refactors — someone adds a field to a DTO and the serializer starts touching a relation. A query-count assertion is the only durable defence. [End-to-end tests](../nestjs-testing/e2e-tests.md).

### 2. Read the query log for one request

Turn on statement logging in development and read the output for a single request. An N+1 is unmistakable: the same statement text repeated with different parameters. TypeORM's `logging: ['query']`, Prisma's `query` event, Drizzle's `logger: true`, Mongoose's `debug` — each prints the SQL and the duration. Log the SQL, never the parameters.

TypeORM's `maxQueryExecutionTime` is the wrong tool here and worth naming as such: it flags *slow* queries, and the queries in an N+1 are individually fast.

### 3. `pg_stat_statements`

The best way to find them in production. It aggregates by normalised statement text, so an N+1 appears as a query with an enormous `calls` count and a tiny `mean_exec_time`:

```sql
SELECT calls,
       round(mean_exec_time::numeric, 3) AS mean_ms,
       round(total_exec_time::numeric)   AS total_ms,
       left(query, 90)                   AS query
  FROM pg_stat_statements
 ORDER BY calls DESC
 LIMIT 20;
```

**Sort by `calls`, not by mean time.** Sorting by mean time finds slow queries; N+1s are made of fast ones and the damage is in the volume. A statement whose `calls` is a clean multiple of another statement's `calls` is an N+1 with that multiple as N.

This is also an argument for parameterised statements everywhere: interpolated values produce a distinct statement text per request, which destroys the aggregation that makes this work. [Raw drivers](./raw-drivers.md).

MySQL's equivalent is `events_statements_summary_by_digest` ordered by `COUNT_STAR`.

### 4. Traces

Any APM that instruments the driver renders an N+1 as a waterfall of fifty identical narrow bars. If you already have tracing, this is the fastest route. [Observability](../nestjs-production/observability.md).

## When an N+1 is actually fine

The cost is `N × round_trip`, so it is negligible when N is small, the round trip is tiny, or the lookups are cached.

- **N is small and bounded.** Three lookups on a page that renders one entity is under a millisecond. Batching it costs readability for no measurable gain.
- **The database is in-process.** `better-sqlite3` and `node:sqlite` have no round trip — a query is a function call. An N+1 with N in the hundreds is often genuinely irrelevant. [SQLite](../nestjs-databases/sqlite.md).
- **The per-item lookup hits a cache.** With a high hit rate you have N cache reads, not N queries. A per-request loader gives you this for free within one request.
- **The batched version needs a different index or a worse plan.** `WHERE id = ANY($1)` with five thousand ids can plan worse than five thousand primary-key lookups. `EXPLAIN ANALYZE` both rather than assuming. [Indexing basics](../databases/indexing-basics.md).
- **The join would explode the row count.** Several to-many relations in one statement can transfer far more data than several statements. Batching, not joining, is the answer there.
- **It is a one-off migration script** with no latency requirement and no concurrent load.

The rule: fix it when N is unbounded — driven by a list whose size the caller controls — when the round trip crosses a network, or when it is in a hot path. Leave it when N is small and fixed. And do not fix it speculatively: an unnecessary join fetching columns nobody uses is its own performance bug.

## Security considerations

**An unbounded N+1 is a denial-of-service endpoint.** A caller-controlled `limit` plus a per-item query means `?limit=10000` issues ten thousand queries in one request, holding a pooled connection for the whole sequence. A handful of concurrent requests exhausts the pool and takes down every endpoint, including the ones that never touch the database — no authentication required.

Cap it in the DTO, so the ceiling is enforced by the global `ValidationPipe` before a service runs:

```ts good title="src/posts/dto/list-posts.dto.ts"
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'

export class ListPostsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)          // a hard ceiling, not a default the caller can raise
  @IsOptional()
  limit = 20
}
```

Cap the page size, cap the id list you will batch, and put a `statement_timeout` behind all of it. [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md).

**Never build the id list into SQL.** Fixing an N+1 is exactly the moment somebody reaches for an `IN` list assembled with `join(',')` — and that is an injection hole created while fixing a performance bug, even when the ids "came from the database", because they were user-supplied on the way in.

```ts vulnerable title="DO NOT COPY"
const rows = await this.dataSource.query(
  `SELECT id, name FROM users WHERE id IN (${ids.join(',')})`,
)
```

```ts good title="src/users/users.repository.ts"
const rows = await this.dataSource.query(
  'SELECT id, name FROM users WHERE id = ANY($1::bigint[])',
  [ids],
)
```

Every ORM has a safe form — `In()`, `{ in: ids }`, `inArray()`, `$in` — and each expands to real placeholders. [SQL injection](../nestjs-security/sql-injection.md).

**Batching must not widen access.** The N+1 version often carries a per-item ownership or tenant check that the batched version quietly drops, because the check lived in the loop. Put the filter into the batched query itself:

```ts good title="src/users/users.repository.ts"
findManyByIds(ids: readonly number[], tenantId: number) {
  return this.users.find({
    where: { id: In([...ids]), tenantId },
    select: { id: true, name: true },
  })
}
```

Returning rows the caller may not see is [IDOR](../nestjs-security/authorization-and-idor.md), and batching turns it into a bulk one.

**Loader caches are per request, and the key must include the tenant.** A loader keyed only by id, reused across a request that spans two tenants — or worse, a module-scoped loader — serves one tenant's rows to another. When in doubt, key by `${tenantId}:${id}`.

**Do not leak columns while batching.** The batched query is a new query, and it needs the same projection discipline as the one it replaced. `find({ where: { id: In(ids) } })` with no `select` fetches password hashes for fifty users at once.

**Timing differences leak existence.** An endpoint measurably slower when a related record exists tells an unauthorized caller that it exists. Batching helps here, because the query count stops depending on the data.

## Production considerations

- **Assert query counts in tests.** The only durable defence. N+1s are reintroduced by refactors that look harmless.
- **Log a warning above a threshold** — twenty queries per request is a reasonable start — with the controller and handler name attached, so the log points at a file.
- **Enable `pg_stat_statements` and review the top queries by `calls` weekly.** It is cheap, and it is where N+1s live.
- **Alert on queries per request, not only latency.** An N+1 against a fast local database shows up as database CPU and connection pressure long before it shows up as user-visible latency.
- **Audit lazy relations and `eager: true` before a release.** They are the N+1s nobody wrote. A `Promise<T[]>` relation property is a query on property access.
- **Watch `populate` counts on Mongoose list endpoints.** Each path is another round trip.
- **Keep the query in one place.** A repository provider means a fifty-one-query endpoint is one method to rewrite. [Repository vs active record](./repository-vs-active-record.md).
- **Re-check indexes after batching.** `WHERE id = ANY($1)` and `WHERE id = $1` can choose different plans. `EXPLAIN ANALYZE` after the change.
- **Cap page sizes.** The fix is worthless if the caller can ask for ten thousand items.
- **Measure in the deployed environment.** The entire cost is the round trip, so a local benchmark understates the problem by an order of magnitude.
- **Prefer Option B (AsyncLocalStorage) for loaders outside GraphQL.** Request scope propagating to controllers and guards is a throughput cost that is hard to undo later. [Injection scopes](../nestjs/injection-scopes.md).

## Common mistakes

- **`await` inside a `for` loop over query results.** The canonical shape. Look for it in every review.
- **`Promise.all` over the same N queries.** Still N queries, now competing for N connections you do not have.
- **Fixing the first level and missing the second.** Posts batched, comments still looped.
- **Joining a to-many relation with a `LIMIT`.** Rows multiply and the limit applies to the wrong thing.
- **Forgetting to deduplicate ids** before batching.
- **Assembling an `IN` list with `join(',')`.** An injection hole created while fixing a performance bug.
- **A module-scoped DataLoader.** Cross-request cache, stale data, cross-tenant leakage.
- **Making the loader request-scoped without reading what that propagates.** Controllers and guards become request-scoped too, and it does not exist in a queue processor.
- **A batch function that returns rows in database order.** DataLoader matches by position — return one entry per key, in key order, with `null` for misses.
- **Losing the tenant or ownership filter** when moving the check out of the loop.
- **Dropping the column projection** in the batched query.
- **Turning on `eager: true` to fix one endpoint.** It changes every query on that entity.
- **Blaming the ORM for a loop you wrote.** Every tool here batches when asked.
- **Sorting `pg_stat_statements` by mean time.** N+1 queries are individually fast; sort by `calls`.
- **Fixing an N+1 where N is three.** Wasted effort and worse code.
- **No hard cap on page size.** The N+1 becomes a denial-of-service endpoint.

## Related topics

- [N+1 queries](../databases/n-plus-one-queries.md) — the latency arithmetic, `= ANY($1)` in plain Node, and a DataLoader in forty lines.
- [TypeORM](./typeorm.md) — `relations`, `eager`, lazy relations and `relationLoadStrategy`.
- [Prisma](./prisma.md) — `include` versus nested `select`, and why relations are extra queries rather than a join.
- [Drizzle](./drizzle.md) — relational queries versus explicit joins.
- [Mongoose](./mongoose.md) — `populate` on the query, `.lean()`, and `$lookup`.
- [Raw drivers](./raw-drivers.md) — batching with `= ANY($1)` and keyset pagination.
- [Repository vs active record](./repository-vs-active-record.md) — one place to write the query, one place to fix it.
- [Injection scopes](../nestjs/injection-scopes.md) — what `Scope.REQUEST` propagates, and what it costs.
- [Interceptors](../nestjs-request-handling/interceptors.md) — where the query-count interceptor fits in the lifecycle.
- [GraphQL](../nestjs-advanced/graphql.md) — why a field resolver is an N+1 by construction.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — why N concurrent queries exhaust the pool.
- [Indexing basics](../databases/indexing-basics.md) — making the batched query fast.
- [Observability](../nestjs-production/observability.md) — traces that make an N+1 obvious.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — asserting a query budget per endpoint.
