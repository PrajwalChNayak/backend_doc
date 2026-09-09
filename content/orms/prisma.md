---
title: Prisma
description: Prisma 7 with driver adapters and prisma.config.ts — schema, migrations, transactions, and keeping $queryRaw safe.
status: current
updated: 2026-09-08
---

Prisma gives you a declarative schema file, a migration engine that diffs that schema against your database, and a fully typed client generated from it. Version 7 is a substantial rework: driver adapters are the default, connection URLs moved out of `schema.prisma` into a `prisma.config.ts`, and the client is generated into your source tree rather than `node_modules`.

:::warning
`npm install prisma` currently installs a **release candidate**. As of 2026-09-08 the npm `latest` dist-tag for `prisma` points at `8.0.0-rc.13`, while `@prisma/client` `latest` is the stable `7.10.0`. Installing without a range gives you a mismatched pair and an RC in production.

Pin the major explicitly:

```bash
npm install prisma@7 --save-dev
npm install @prisma/client@7
```

This page documents the current stable release, **7.10.0**.
:::

## Why it exists

The schema file is the point. `schema.prisma` is a single declarative description of your tables, relations, indexes, and enums that three separate tools read: the migration engine diffs it against the database, the generator turns it into TypeScript types, and Prisma Studio renders it. Nothing else on this page gets that from one artifact.

The generated client is not "typed enough" — it is exactly typed. `select: { id: true, email: true }` produces a return type with exactly `id` and `email`, and `include` narrows the relation types too. That is the strongest type story of any ORM here.

## When to use it

- **PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, or CockroachDB with a TypeScript app.** This is Prisma's home ground.
- **You want migrations you did not write.** `prisma migrate dev` diffs the schema and emits SQL. It is the best generated-migration experience in this list.
- **The team is mixed-seniority.** The client is hard to misuse and the errors are readable.
- **You want a data browser.** `prisma studio` is genuinely useful and costs nothing to set up.

## When not to use it

- **MongoDB.** Prisma 7 does not support MongoDB. Use [Mongoose](./mongoose.md) or the driver directly.
- **You need arbitrary SQL as your primary interface.** Prisma's query API is deliberately narrow. Window functions, recursive CTEs and `GROUP BY ROLLUP` all mean dropping to `$queryRaw`, and at that point [Drizzle](./drizzle.md) or [Knex](./knex.md) fits better.
- **You cannot afford the generation step.** `prisma generate` must run before the app type-checks, and in v7 it no longer runs automatically after `npm install`. That is one more thing in your CI pipeline and Dockerfile.
- **Bundle-size-sensitive edge deployments.** The generated client is large. Drizzle is a much smaller runtime.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install prisma@7 --save-dev
npm install @prisma/client@7 @prisma/adapter-pg@7
```
@tab pnpm
```bash
pnpm add -D prisma@7
pnpm add @prisma/client@7 @prisma/adapter-pg@7
```
@tab yarn
```bash
yarn add -D prisma@7
yarn add @prisma/client@7 @prisma/adapter-pg@7
```
:::

Prisma 7 requires Node `^20.19 || ^22.12 || >=24.0` and TypeScript `>=5.4`. On this site that means Node 24 LTS.

Prisma 7 ships as ES modules. Your project needs `"type": "module"` in `package.json`, and `tsconfig.json` needs `"module": "ESNext"` with `"moduleResolution": "bundler"`.

### Initialize

```bash
npx prisma init --datasource-provider postgresql
```

That creates `prisma/schema.prisma` and `prisma.config.ts`.

### Configure

In Prisma 7 the connection URL lives in `prisma.config.ts`, **not** in the schema. The `adapter`, `engine` and `studio` config properties from v6 were removed.

```ts title="prisma.config.ts"
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
```

### Schema

```prisma title="prisma/schema.prisma"
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  posts     Post[]

  @@map("users")
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  body      String
  published Boolean  @default(false)
  authorId  Int      @map("author_id")
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)

  @@index([authorId, published])
  @@map("posts")
}
```

Two v7 details in that block. The `datasource` has **no `url` field** — that moved to `prisma.config.ts`. And the generator is `prisma-client` with a **required** `output`; `prisma-client-js` is deprecated and the client is no longer written into `node_modules`.

:::tip
Add the generated directory to `.gitignore` and run `prisma generate` in CI and in your Docker build. Checking generated code in works too — pick one and be consistent, because a stale generated client produces type errors that look like schema errors.
:::

### Client instance

Prisma 7 instantiates the client with a **driver adapter**. There is no Rust-managed connection pool any more; the Node driver owns the pool.

```ts title="src/db.ts"
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
})

export const prisma = new PrismaClient({ adapter })
```

Adapter packages track the client version: `@prisma/adapter-pg`, `@prisma/adapter-mariadb`, `@prisma/adapter-better-sqlite3`, `@prisma/adapter-mssql` and `@prisma/adapter-libsql` are all published at `7.10.0`.

### CRUD

```ts title="src/routes/users.ts"
import express from 'express'
import { prisma } from '../db.js'

const router = express.Router()

router.post('/users', async (req, res) => {
  const user = await prisma.user.create({
    data: { email: req.body.email, name: req.body.name },
    select: { id: true, email: true, name: true },
  })
  res.status(201).json(user)
})

router.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.params.id) },
    select: { id: true, email: true, name: true, createdAt: true },
  })
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.patch('/users/:id', async (req, res) => {
  const user = await prisma.user.update({
    where: { id: Number(req.params.id) },
    data: { name: req.body.name },
    select: { id: true, name: true },
  })
  res.json(user)
})

router.delete('/users/:id', async (req, res) => {
  await prisma.user.delete({ where: { id: Number(req.params.id) } })
  res.status(204).end()
})

export default router
```

No `try`/`catch` and no async wrapper. Express 5 forwards a rejected promise from an `async` handler straight to your error middleware.

Full runnable version: [`examples/orm-prisma`](../../examples/orm-prisma/README.md).

## How it works

### Relations and eager loading

`include` pulls a relation; `select` picks columns and can nest.

```ts
// Whole related rows
const users = await prisma.user.findMany({
  include: { posts: true },
})

// Only the columns you need, at both levels
const users = await prisma.user.findMany({
  select: {
    id: true,
    email: true,
    posts: { select: { id: true, title: true }, where: { published: true }, take: 5 },
  },
})
```

Prisma resolves relations with additional queries rather than a single join by default. That is *not* an N+1: it is a fixed small number of statements regardless of row count. It does mean two round trips where a join would take one, which matters on a high-latency link and does not matter on a local socket.

The thing to avoid is the manual loop:

```ts vulnerable title="DO NOT COPY — N+1"
const users = await prisma.user.findMany()
for (const u of users) {
  u.posts = await prisma.post.findMany({ where: { authorId: u.id } })
}
```

### Transactions

Two forms. The array form batches independent operations into one transaction:

```ts
const [posts, totalPosts] = await prisma.$transaction([
  prisma.post.findMany({ where: { title: { contains: 'prisma' } } }),
  prisma.post.count(),
])
```

The interactive form gives you a scoped client and lets later queries depend on earlier results:

```ts title="src/services/transfer.ts"
import { Prisma } from '../generated/prisma/client'
import { prisma } from '../db.js'

export async function transfer(fromId: number, toId: number, cents: number) {
  return prisma.$transaction(
    async (tx) => {
      const from = await tx.account.update({
        where: { id: fromId },
        data: { balance: { decrement: cents } },
      })
      if (from.balance < 0) throw new Error('insufficient funds')

      return tx.account.update({
        where: { id: toId },
        data: { balance: { increment: cents } },
      })
    },
    {
      maxWait: 5_000,
      timeout: 10_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  )
}
```

`maxWait` defaults to 2000ms (how long to wait for a connection) and `timeout` to 5000ms (how long the transaction may run). Both are short on purpose. Throwing inside the callback rolls back.

Supported isolation levels are `ReadUncommitted`, `ReadCommitted`, `RepeatableRead`, `Snapshot` and `Serializable`, subject to what the database offers — SQLite only does `Serializable`.

:::warning
**Only use `tx` inside the callback.** Calling `prisma.something()` instead of `tx.something()` inside an interactive transaction runs that query on a *different* connection, outside the transaction. It will not roll back, and it can deadlock against the transaction holding the row locks.
:::

:::note
Prisma 8 replaces `$transaction` with a `transaction()` callback and drops the array form entirely. If you expect to upgrade, keep transaction usage behind a few service functions rather than scattered through route handlers.
:::

### Migrations

```bash
# Development: diff the schema, write a migration, apply it
npx prisma migrate dev --name add_posts_index

# CI / production: apply committed migrations only, never generate
npx prisma migrate deploy

# Is the database up to date?
npx prisma migrate status

# Mark a failed migration resolved after a manual fix
npx prisma migrate resolve --applied 20260908120000_add_posts_index
```

`prisma migrate dev` needs a **shadow database** to compute the diff safely, so the migration user needs `CREATEDB` in development. `prisma migrate deploy` does not — it only replays committed SQL files, which is exactly what you want in production.

Two v7 CLI changes to know: `prisma migrate dev` **no longer triggers `prisma generate` or the seed script automatically**, and the `--skip-generate` / `--skip-seed` flags were removed because there is nothing left to skip. Run `prisma generate` and `prisma db seed` yourself.

`prisma migrate diff` lost its `--from-url` / `--to-url` / `--shadow-database-url` flags; use `--from-config-datasource` / `--to-config-datasource`, which read from `prisma.config.ts`.

`prisma db push` writes the schema straight to the database with no migration file. It is a prototyping tool. Never point it at production.

### TypeScript story

Prisma's is the best in this section, and it comes from generation rather than inference. The generated client re-exports the model types and the argument types:

```ts title="src/repos/users.ts"
import { Prisma } from '../generated/prisma/client'

// A payload type that exactly matches a query's shape
type UserWithPosts = Prisma.UserGetPayload<{
  include: { posts: { select: { id: true; title: true } } }
}>

// Reusable, type-checked query fragments
const publicUser = { id: true, email: true, name: true } satisfies Prisma.UserSelect
```

Because the types are generated from the schema rather than inferred from a builder chain, IDE performance stays good on large schemas — the main practical advantage over inference-heavy alternatives.

The cost: types are only correct after `prisma generate`. A schema edit without a regenerate gives you confidently wrong types.

### Connection pooling

Prisma 7 removed its own pool. Pool settings are now **driver options passed to the adapter**, and the v6 URL query parameters (`connection_limit`, `pool_timeout`) no longer apply.

For `@prisma/adapter-pg`, the options are `pg` pool options:

| Option | Default | What it does |
| --- | --- | --- |
| `max` | `10` | Maximum connections in the pool |
| `idleTimeoutMillis` | `10000` | How long an idle connection is kept |
| `connectionTimeoutMillis` | `0` (wait forever) | How long to wait for a free connection |

```ts title="src/db.ts"
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,
})
```

Set `connectionTimeoutMillis`. The default of `0` means a request that cannot get a connection hangs forever instead of failing fast, which turns a pool exhaustion into an outage rather than a burst of 503s.

Total connections are `max` × replicas. Four replicas at `max: 10` is 40 connections before anything else connects. Compare that against your Postgres `max_connections` and put a pooler in front if it does not fit — see [Connection pooling](../databases/connection-pooling.md).

## Common patterns

### One client per process

`PrismaClient` owns a pool. Construct it once, export it, import it everywhere. Creating one per request exhausts the database in minutes.

### Query logging

```ts title="src/db.ts"
export const prisma = new PrismaClient({
  adapter,
  log: [{ emit: 'event', level: 'query' }, 'warn', 'error'],
})

prisma.$on('query', (e) => {
  if (e.duration > 200) logger.warn({ query: e.query, ms: e.duration }, 'slow query')
})
```

The `query` event gives you the SQL and the duration. Log the SQL, log the duration, and **do not log `e.params`** in production — that is your user data.

### Client extensions instead of middleware

The `$use` middleware API was removed in v7. Use client extensions:

```ts title="src/db.ts"
export const prisma = basePrisma.$extends({
  query: {
    user: {
      async findMany({ args, query }) {
        args.where = { ...args.where, deletedAt: null }
        return query(args)
      },
    },
  },
})
```

## Security considerations

### The raw escape hatch

Prisma has four raw methods, and the naming tells you which two to avoid.

| Method | Input | Safe? |
| --- | --- | --- |
| `$queryRaw` | Tagged template | **Yes** — interpolations become bind parameters |
| `$executeRaw` | Tagged template | **Yes** — same |
| `$queryRawUnsafe` | Plain string | **No** — you own the escaping |
| `$executeRawUnsafe` | Plain string | **No** — same |

`$queryRaw` is a *tagged template*. Prisma reads the interpolations as values and sends them as bind parameters — the SQL text never contains the user input:

```ts good title="src/repos/search.ts"
const email = req.body.email
const users = await prisma.$queryRaw<Array<{ id: number; email: string }>>`
  SELECT id, email FROM users WHERE email = ${email}
`
```

Send `' OR 1=1 --` as the email and the database looks for a user whose email is literally `' OR 1=1 --`. It finds nothing. That is the whole mechanism.

The `Unsafe` variants take a plain string, so building that string is on you:

```ts vulnerable title="DO NOT COPY"
// curl "localhost:3000/users?email=x'%20OR%20'1'%3D'1"
const users = await prisma.$queryRawUnsafe(
  `SELECT id, email, password_hash FROM users WHERE email = '${req.query.email}'`,
)
```

`$queryRawUnsafe` does accept positional placeholders, so if you genuinely need a dynamic statement, keep the *values* parameterized:

```ts good title="src/repos/search.ts"
const rows = await prisma.$queryRawUnsafe(
  'SELECT id, email FROM users WHERE email = $1',
  req.body.email,
)
```

### Prisma.sql, Prisma.join, Prisma.empty, Prisma.raw

`Prisma.sql` builds a parameterized fragment you can compose. `Prisma.join` expands an array into a parameterized `IN` list — one placeholder per element, not a string join. `Prisma.empty` is a no-op fragment for conditional clauses.

```ts good title="src/repos/posts.ts"
import { Prisma } from '../generated/prisma/client'

const ids = [1, 3, 5, 10, 20]
const posts = await prisma.$queryRaw`
  SELECT id, title FROM posts WHERE id IN (${Prisma.join(ids)})
`

// Conditional WHERE, still fully parameterized
const authorName: string | undefined = req.query.author
const rows = await prisma.$queryRaw`
  SELECT p.id, p.title FROM posts p JOIN users u ON u.id = p.author_id
  ${authorName ? Prisma.sql`WHERE u.name = ${authorName}` : Prisma.empty}
`
```

`Prisma.raw` is the exception. It splices its argument into the SQL text **verbatim**, with no escaping and no parameter. It re-opens exactly the hole the tagged template closed:

```ts vulnerable title="DO NOT COPY"
const users = await prisma.$queryRaw`
  SELECT * FROM users WHERE name = ${Prisma.raw(req.query.name)}
`
```

:::danger
`Prisma.raw()` inside a `$queryRaw` template looks safe because it is inside a tagged template. It is not. Anything you pass to `Prisma.raw` becomes SQL syntax. Treat `Prisma.raw(x)` as identical in risk to string-concatenating `x`.
:::

### What parameterization does not cover

Bind parameters are value slots. Table names, column names, and `ORDER BY` targets are syntax, so they cannot be parameters — in Prisma that means they can only reach the query through `Prisma.raw` or `$queryRawUnsafe`, and both require an allow-list.

```ts good title="src/repos/posts.ts"
import { Prisma } from '../generated/prisma/client'

const SORT_COLUMNS = new Map([
  ['created_at', 'p.created_at'],
  ['title', 'p.title'],
])
const SORT_DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])

export async function listPosts(sort: string, dir: string, limit: number) {
  const column = SORT_COLUMNS.get(sort)
  const direction = SORT_DIRECTIONS.get(dir)
  if (!column || !direction) throw new Error('invalid sort')

  // lint-sql:allow column/direction resolve to literals from the maps above; limit is a bind parameter
  const orderBy = Prisma.raw(`${column} ${direction}`)
  return prisma.$queryRaw`
    SELECT p.id, p.title FROM posts p ORDER BY ${orderBy} LIMIT ${limit}
  `
}
```

The `LIMIT` stays a real bind parameter. Only the identifier goes through `Prisma.raw`, and only after being looked up in a map whose values you wrote.

For the common case, prefer the typed API — `orderBy: { createdAt: 'desc' }` needs no raw SQL at all, and the allowed keys are the schema's field names by construction.

### Mass assignment

```ts vulnerable title="DO NOT COPY"
await prisma.user.update({ where: { id }, data: req.body }) // sets role: 'admin'
```

Prisma will write any field in `data` that exists on the model. Validate the body and construct `data` from named fields — see [Validation](../express-libraries/validation.md) and [Mass assignment](../security/mass-assignment.md).

### Do not leak columns

`findUnique({ where: { id } })` returns every scalar column, password hash included. Always pass `select` on anything that reaches a response body.

## Production considerations

**`prisma generate` is now an explicit build step.** It does not run on install and it does not run after `migrate dev`. Put it in your Dockerfile before `tsc`, and in CI before type-checking. A missing generate produces "Cannot find module './generated/prisma/client'", which reads like a path bug.

**`migrate deploy` in a release job, not on boot.** It takes a lock, but three replicas racing it still produces confusing failures and a half-migrated window. See [Migration strategy](./migration-strategy.md).

**Size the pool against the database, not the app.** `max` × replica count is your real connection count.

**Set `connectionTimeoutMillis`.** The `pg` adapter's default is unlimited.

**Redact query parameters in logs.** The `query` event's `params` field is raw user data.

**Add a `statement_timeout` at the database.** Prisma's transaction `timeout` covers interactive transactions only; a runaway single statement needs a server-side limit.

**Pin the major version.** With `latest` pointing at an RC, an unpinned `npm install` in a fresh CI container gives you a different major than your lockfile expects.

**Graceful shutdown.** Call `await prisma.$disconnect()` on `SIGTERM` so in-flight queries finish and the pool closes cleanly.

## Common mistakes

- **Installing without a version range** and getting `8.0.0-rc.13` from the `latest` tag while `@prisma/client` stays on 7. Pin `prisma@7` and `@prisma/client@7`.
- **Leaving `url` in the `datasource` block.** In v7 it belongs in `prisma.config.ts`.
- **Using the `prisma-client-js` generator** in a new project. It is deprecated; use `prisma-client` with an explicit `output`.
- **Expecting `migrate dev` to regenerate the client.** It no longer does.
- **Using `connection_limit` in the connection URL.** Ignored in v7 — configure the adapter instead.
- **Calling `prisma.x` instead of `tx.x` inside an interactive transaction.** That query is not in the transaction.
- **Reaching for `$queryRawUnsafe` because a value needed to be dynamic.** Values are what tagged templates are for.
- **Assuming `Prisma.raw` is safe because it lives inside a `$queryRaw` template.** It is the one part that is not.
- **`data: req.body`.** Mass assignment.
- **Constructing `PrismaClient` per request.** One per process.
- **Running `prisma db push` against production.** It applies schema changes with no migration history and can drop columns.

## Related topics

- [Comparison table](./comparison.md) — Prisma against the other five.
- [Drizzle](./drizzle.md) — the closest alternative if you want the SQL to stay visible.
- [Migration strategy](./migration-strategy.md) — running `migrate deploy` safely in CI/CD.
- [Testing with a database](./testing-with-a-database.md) — migrating and isolating a test database.
- [SQL injection](../security/sql-injection.md) — the threat behind the `$queryRawUnsafe` rules.
- [Connection pooling](../databases/connection-pooling.md) — sizing `max` for your Postgres.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the driver the `pg` adapter wraps.
- [Mass assignment](../security/mass-assignment.md) — why `data: req.body` is a hole.
- [`examples/orm-prisma`](../../examples/orm-prisma/README.md) — the runnable version of this page.
