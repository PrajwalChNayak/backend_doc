---
title: Prisma
description: Prisma 7.10.0 inside NestJS 12 — the PrismaService provider, a PrismaModule, driver adapters, relation queries, both $transaction forms, the raw escape hatch, and why you must pin prisma@7.
status: current
updated: 2026-09-11
---

There is no `@nestjs/prisma`. The integration is a provider you write: a class that extends `PrismaClient`, implements `OnModuleInit` and `OnModuleDestroy`, and is exported by a small module. That is about twenty-five lines, and it is the officially documented approach — not a workaround. Everything about the library itself (the schema DSL, `prisma.config.ts`, migrations, client extensions) is in [Prisma](../orms/prisma.md); this page covers the Nest half.

This page documents **`@prisma/client` 7.10.0** with **`prisma` 7** and **`@prisma/adapter-pg` 7.10.0**.

:::warning Pin `prisma@7`
The npm `latest` dist-tag for `prisma` points at **`8.0.0-rc.13`, a release candidate**, while `@prisma/client` `latest` is the stable **`7.10.0`**. An unpinned `npm install prisma` in a fresh CI container gives you an RC CLI against a v7 client — a mismatched pair, and an RC in your pipeline.

```bash
npm install --save-dev prisma@7
npm install @prisma/client@7
```
:::

## Why it exists

`PrismaClient` owns a connection pool and has to be a singleton. In a plain Node app you export one from a module and import it everywhere. In Nest that is the pattern [Connections and DI](../nestjs-databases/connections-and-di.md) argues against: it is constructed at import time, before `ConfigModule` has validated anything, nothing can substitute it in a test, and nobody closes it on `SIGTERM`.

Wrapping the client in a provider fixes all three. The instance is built by the injector after configuration is available, `overrideProvider(PrismaService)` gives tests a seam, and `onModuleDestroy` closes the pool when the framework tears the app down.

There is a second, subtler reason to use a class rather than a `useFactory`. A class is its own injection token, so services declare `constructor(prisma: PrismaService)` with no `@Inject()` decorator — which keeps Prisma out of the decorator noise in every file that touches the database.

## When to use it

- **A new TypeScript service on PostgreSQL, MySQL/MariaDB, SQLite, SQL Server or CockroachDB.** This is Prisma's home ground and the default recommendation in [Choosing an ORM](./choosing-an-orm.md).
- **You want migrations you did not write.** `prisma migrate dev` diffs the schema against a shadow database and emits SQL.
- **Mixed-seniority team.** The client is hard to misuse and the errors are readable.

## When not to use it

- **MongoDB.** Prisma 7 dropped support. Use [Mongoose](./mongoose.md).
- **SQL is your primary interface.** Window functions, recursive CTEs and `GROUP BY ROLLUP` all mean dropping to `$queryRaw`, which is a hard boundary — you leave the type system and hand-annotate the row type. [Drizzle](./drizzle.md) fits better.
- **You cannot add a build step.** `prisma generate` must run before the app type-checks, and in v7 it does not run automatically after `npm install` or after `migrate dev`.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install @prisma/client@7 @prisma/adapter-pg@7
npm install --save-dev prisma@7
```
@tab pnpm
```bash
pnpm add @prisma/client@7 @prisma/adapter-pg@7
pnpm add -D prisma@7
```
@tab yarn
```bash
yarn add @prisma/client@7 @prisma/adapter-pg@7
yarn add -D prisma@7
```
:::

Prisma 7 requires Node `^20.19 || ^22.12 || >=24.0` and TypeScript `>=5.4`; Nest 12 requires Node `>=20`. Node 24 LTS satisfies both.

Prisma 7 ships as ES modules, and so do `@nestjs/core` and `@nestjs/common` 12. A CommonJS Nest app still consumes both through `require(esm)` and needs no rewrite — see [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md).

:::note How the examples are written
Nest's constructor injection is usually written with the parameter-property shorthand, `constructor(private readonly prisma: PrismaService) {}`. The snippets here declare the field and assign it, because the site's snippet checker type-strips every `ts` block. The two forms are equivalent — use the shorthand in your own code.
:::

### Configure and generate

Prisma 7 keeps the connection URL in `prisma.config.ts`, not in `schema.prisma`, and the generator writes the client into your source tree:

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

```prisma title="prisma/schema.prisma"
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id           Int      @id @default(autoincrement())
  email        String   @unique
  name         String?
  passwordHash String   @map("password_hash")
  createdAt    DateTime @default(now()) @map("created_at")
  posts        Post[]

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

The `datasource` block has **no `url`** — that moved to `prisma.config.ts` — and the generator is `prisma-client` with a required `output`. The older `prisma-client-js` generator is deprecated and no longer writes into `node_modules`.

```bash
npx prisma generate
```

### The PrismaService provider

This is the whole integration.

```ts title="src/database/prisma.service.ts"
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor(config: ConfigService) {
    // Prisma 7 has no Rust connection pool. The adapter IS the pool, and its
    // options are the driver's options — `pg`'s, here.
    const adapter = new PrismaPg({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: config.get<number>('DB_POOL_MAX') ?? 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    })

    super({
      adapter,
      log: [{ emit: 'event', level: 'query' }, 'warn', 'error'],
    })
  }

  async onModuleInit() {
    // Connect during bootstrap so a bad URL fails the deploy, not the first
    // request. Without this the client connects lazily on first query.
    await this.$connect()

    this.$on('query', (e) => {
      // Log the SQL and the duration. Never `e.params` — that is user data.
      if (e.duration > 200) this.logger.warn(`slow query ${e.duration}ms: ${e.query}`)
    })
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
```

Both hooks matter, and for different reasons.

**`onModuleInit`** turns a wrong `DATABASE_URL` into a failed bootstrap instead of a 500 on the first request that touches the database. Without it the client connects lazily, so a misconfigured deploy passes its startup probe and fails under traffic.

**`onModuleDestroy`** is the one people skip, and it is the expensive one. Prisma's pool holds open TCP connections. On a rolling deploy `SIGTERM` arrives, the pod is removed from the load balancer, and in-flight queries need to finish and the pool needs to close — otherwise the server is left to reap half-open sessions on its own timeout, and Postgres accumulates `idle in transaction` entries across every deploy.

:::danger `onModuleDestroy` only runs if you asked for it
```ts title="src/main.ts"
const app = await NestFactory.create(AppModule)
app.enableShutdownHooks()   // NOT on by default
await app.listen(3000)
```

Without `enableShutdownHooks()`, `SIGTERM` kills the process and no lifecycle hook fires. `$disconnect()` is never called on any deploy. See [Graceful shutdown](../nestjs-production/graceful-shutdown.md).
:::

:::note `$on('beforeExit')` is not the hook to use
Older Nest recipes wire shutdown through `prisma.$on('beforeExit')`. That event belongs to Prisma's own process lifecycle, not Nest's, and it does not fire for every exit path. `OnModuleDestroy` plus `enableShutdownHooks()` is the framework's mechanism and the one that composes with every other provider's teardown.
:::

### The PrismaModule

```ts title="src/database/prisma.module.ts"
import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaService } from './prisma.service.js'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

`@Global()` is defensible here and almost nowhere else. Prisma has no `forFeature` equivalent — there is one client for the whole schema, not one provider per model — so without it every feature module imports `PrismaModule` and the import list says nothing useful. It changes visibility, not cardinality: the instance is still a single object.

If you would rather keep the module graph honest about who touches the database, drop `@Global()` and import `PrismaModule` explicitly. Both are correct; pick one and be consistent. See [Modules](../nestjs/modules.md).

### Using it in a service

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service.js'
import { CreateUserDto } from './dto/create-user.dto.js'

@Injectable()
export class UsersService {
  private readonly prisma: PrismaService

  constructor(prisma: PrismaService) {
    this.prisma = prisma
  }

  create(dto: CreateUserDto) {
    return this.prisma.user.create({
      // Named fields, not `data: dto`. See Security considerations.
      data: { email: dto.email, name: dto.name ?? null, passwordHash: dto.passwordHash },
      select: { id: true, email: true, name: true, createdAt: true },
    })
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, createdAt: true },
    })
    if (!user) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  list(limit: number, offset: number) {
    return this.prisma.user.findMany({
      select: { id: true, email: true, name: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    })
  }
}
```

No `@Inject()` anywhere. `PrismaService` is a class, so it is its own token — which is also why overriding it in a test is one line:

```ts title="src/users/users.service.spec.ts"
import { Test } from '@nestjs/testing'
import { PrismaService } from '../database/prisma.service.js'
import { UsersService } from './users.service.js'

const prisma = {
  user: {
    findUnique: async () => ({ id: 1, email: 'a@example.com', name: null }),
    create: async (args: { data: { email: string } }) => ({ id: 1, ...args.data }),
  },
}

const moduleRef = await Test.createTestingModule({
  providers: [UsersService, { provide: PrismaService, useValue: prisma }],
}).compile()

const service = moduleRef.get(UsersService)
```

No database and no container. More in [Mocking providers](../nestjs-testing/mocking-providers.md).

## How it works

### Relation queries

`include` pulls whole related rows; `select` picks columns and nests.

```ts title="src/users/users.service.ts"
// Whole related rows — every scalar column of every post
const withPosts = await this.prisma.user.findMany({
  include: { posts: true },
  take: 20,
})

// Only the columns you need, at both levels, with a filter and a cap on the
// child collection. This is the form to reach for on a list endpoint.
const feed = await this.prisma.user.findMany({
  select: {
    id: true,
    email: true,
    posts: {
      select: { id: true, title: true },
      where: { published: true },
      orderBy: { id: 'desc' },
      take: 5,
    },
  },
  take: 20,
})
```

Prisma resolves relations with **additional queries** rather than one join. That is a fixed small number of statements regardless of row count, so it is not an N+1 — but it is two round trips where a join takes one, which matters across an availability zone and does not matter on a local socket. [Avoiding N+1](./avoiding-n-plus-one.md) covers the loop that *is* an N+1.

The return types narrow exactly. `feed[0].posts[0]` is `{ id: number; title: string }` and nothing else, so removing a column from the `select` is a compile error in every consumer — which is the main reason to pick Prisma in the first place.

### Transactions

Two forms, and they answer different questions.

**The array form** batches independent operations into one transaction and one round trip:

```ts title="src/posts/posts.service.ts"
const [post, audit] = await this.prisma.$transaction([
  this.prisma.post.create({ data: { title, body, authorId } }),
  this.prisma.auditLog.create({ data: { userId: authorId, action: 'post.create' } }),
])
```

It cannot express "use the id from the first statement in the second". That is what the interactive form is for:

```ts title="src/billing/transfer.service.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../database/prisma.service.js'

@Injectable()
export class TransferService {
  private readonly prisma: PrismaService

  constructor(prisma: PrismaService) {
    this.prisma = prisma
  }

  transfer(fromId: number, toId: number, cents: number) {
    return this.prisma.$transaction(
      async (tx) => {
        // A conditional update: the database does the check and the arithmetic,
        // so two concurrent transfers cannot both spend the last cent.
        const debited = await tx.account.updateMany({
          where: { id: fromId, balance: { gte: cents } },
          data: { balance: { decrement: cents } },
        })
        if (debited.count === 0) throw new BadRequestException('Insufficient funds')

        await tx.account.update({
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
}
```

`maxWait` (how long to wait for a connection, default 2000 ms) and `timeout` (how long the transaction may run, default 5000 ms) are short on purpose. Throwing rolls back — including a thrown `BadRequestException`, which then becomes a 400 through the normal exception filter.

:::warning `this.prisma` inside the callback is not in the transaction
`this.prisma.account.update(…)` instead of `tx.account.update(…)` runs on a **different connection**. It will not roll back, and it can deadlock against the rows the transaction holds. The type system does not catch it, because both objects have the same shape. This is the single most common Prisma bug in a Nest codebase.
:::

The Nest-shaped version of that problem is a transaction that must span **several services**, each with its own injected `PrismaService`. Pass `Prisma.TransactionClient` down as a parameter, or carry it in `AsyncLocalStorage` — the trade-off, with working code for both, is in [Transactions](../nestjs-databases/transactions.md). Decide once for the whole codebase.

:::note
Prisma 8 replaces `$transaction` with a `transaction()` callback and drops the array form. Keeping transaction usage behind a handful of service methods rather than scattering it through controllers makes that upgrade a small diff.
:::

### Client extensions and the class pattern

`$use` middleware was removed in v7; extensions replace it. There is a real friction with the `PrismaService` class here, and it is worth knowing before you design around it: **`$extends` returns a new client object, not your service instance.** You cannot extend `this` inside the class and have `this.user` pick up the extension.

The clean way out is a second provider whose factory extends the base client, with a token for the extended type:

```ts title="src/database/extended-prisma.provider.ts"
import { Provider } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

export const EXTENDED_PRISMA = Symbol('EXTENDED_PRISMA')

export const extendedPrismaProvider: Provider = {
  provide: EXTENDED_PRISMA,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) =>
    prisma.$extends({
      query: {
        post: {
          async findMany({ args, query }) {
            args.where = { ...args.where, deletedAt: null }
            return query(args)
          },
        },
      },
    }),
}

export type ExtendedPrisma = ReturnType<typeof extendedPrismaProvider.useFactory>
```

Both providers share one connection pool, because the extended client wraps the same underlying client. Export `EXTENDED_PRISMA` from `PrismaModule` and inject it with `@Inject(EXTENDED_PRISMA)` where you want the soft-delete behaviour.

:::warning A soft-delete extension is not an authorization control
It filters `findMany`. It does not filter `$queryRaw`, and a model you forget to extend is unfiltered. Enforce deletion semantics in the query the service writes; treat the extension as a convenience, not a boundary.
:::

### Migrations

The commands are the library's, unchanged by Nest:

```bash
# Development: diff the schema, write a migration, apply it. Needs a shadow
# database, so the dev user needs CREATEDB.
npx prisma migrate dev --name add_posts_index

# Pipeline: replay committed migration files only. No diffing.
npx prisma migrate deploy

npx prisma migrate status
npx prisma migrate resolve --applied 20260911120000_add_posts_index
```

Two v7 changes break copied pipelines: `migrate dev` **no longer runs `prisma generate` or the seed script**, and `--skip-generate` / `--skip-seed` were removed because there is nothing left to skip.

Never run `migrate deploy` from `onModuleInit`. Three replicas booting together race the same migration, and the half-migrated window is the worst possible state to serve traffic from. [Migrations](../nestjs-databases/migrations.md) has the release-job shape and the two-database-user setup.

## Common patterns

### Do not return Prisma results from controllers

A `findUnique` with no `select` returns every scalar column, `passwordHash` included. Pass `select` on every read that reaches a response body, and map to a DTO at the service boundary so a new column does not silently join your public API. See [Serialization](../nestjs-validation/serialization.md).

### Map Prisma errors to HTTP in one filter

`P2002` is a unique-constraint violation, `P2025` is "record not found". Catching them in every service produces the same `try`/`catch` twenty times; an exception filter does it once:

```ts title="src/database/prisma-exception.filter.ts"
import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, NotFoundException } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { Prisma } from '../generated/prisma/client'

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    if (exception.code === 'P2002') {
      return super.catch(new ConflictException('Resource already exists'), host)
    }
    if (exception.code === 'P2025') {
      return super.catch(new NotFoundException(), host)
    }
    // Everything else keeps its default 500 — and its message stays in the log,
    // not in the response body. Prisma errors name your tables and columns.
    return super.catch(exception, host)
  }
}
```

The message is the point: a raw `PrismaClientKnownRequestError` reaching a client discloses the constraint name, which discloses your schema. See [Exception filters](../nestjs-request-handling/exception-filters.md).

## Security considerations

### The raw escape hatch

Four raw methods, and the naming tells you which two to avoid.

| Method | Input | Safe? |
| --- | --- | --- |
| `$queryRaw` | Tagged template | **Yes** — interpolations become bind parameters |
| `$executeRaw` | Tagged template | **Yes** — same |
| `$queryRawUnsafe` | Plain string | **No** — you own the escaping |
| `$executeRawUnsafe` | Plain string | **No** — same |

`$queryRaw` is a *tagged template*. Prisma reads each interpolation as a value and sends it as a bind parameter; the statement text never contains the input:

```ts good title="src/reports/reports.service.ts"
const rows = await this.prisma.$queryRaw<Array<{ id: number; email: string }>>`
  SELECT id, email FROM users WHERE email = ${email}
`
```

Send `' OR 1=1 --` as the email and the database looks for a user whose address is literally `' OR 1=1 --`. It finds nothing. That is the entire mechanism.

The `Unsafe` variants take a plain string, so building it is on you:

```ts vulnerable title="DO NOT COPY — src/reports/reports.service.ts"
// GET /reports/users?email=x'%20OR%20'1'%3D'1
@Get('users')
async byEmail(@Query('email') email: string) {
  return this.prisma.$queryRawUnsafe(
    `SELECT id, email, password_hash FROM users WHERE email = '${email}'`,
  )
}
```

`$queryRawUnsafe` does accept positional placeholders, so when you genuinely need a dynamic statement, keep the **values** parameterised:

```ts good title="src/reports/reports.service.ts"
const rows = await this.prisma.$queryRawUnsafe(
  'SELECT id, email FROM users WHERE email = $1',
  email,
)
```

### Prisma.sql, Prisma.join and Prisma.empty compose safely

`Prisma.sql` builds a parameterised fragment. `Prisma.join` expands an array into a parameterised `IN` list — one placeholder per element, not a string join. `Prisma.empty` is a no-op fragment for a conditional clause.

```ts good title="src/posts/posts.service.ts"
import { Prisma } from '../generated/prisma/client'

async search(ids: number[], authorName?: string) {
  return this.prisma.$queryRaw<Array<{ id: number; title: string }>>`
    SELECT p.id, p.title
      FROM posts p
      JOIN users u ON u.id = p.author_id
     WHERE p.id IN (${Prisma.join(ids)})
       ${authorName ? Prisma.sql`AND u.name = ${authorName}` : Prisma.empty}
  `
}
```

Every value in that statement — every id, and the optional name — is a bind parameter. The conditional clause is composed, not concatenated.

### Prisma.raw is the trap

`Prisma.raw` splices its argument into the SQL text **verbatim**: no escaping, no parameter. It re-opens exactly the hole the tagged template closed.

```ts vulnerable title="DO NOT COPY"
const users = await this.prisma.$queryRaw`
  SELECT * FROM users WHERE name = ${Prisma.raw(name)}
`
```

:::danger
`Prisma.raw()` looks safe because it sits inside a tagged template. It is not. Anything you pass to it becomes SQL syntax. Treat `Prisma.raw(x)` as identical in risk to string-concatenating `x`, wherever it appears.
:::

### What parameterisation does not cover

Bind parameters are **value slots**. Table names, column names and `ORDER BY` targets are syntax, so no placeholder can carry them — which means in Prisma they can only reach a query through `Prisma.raw` or `$queryRawUnsafe`, and both need an allow-list.

```ts good title="src/posts/posts.service.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../database/prisma.service.js'

// Module scope: a fixed map from the public sort key to the real column.
const SORT_COLUMNS = new Map([
  ['created_at', 'p.created_at'],
  ['title', 'p.title'],
])
const SORT_DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])

@Injectable()
export class PostsService {
  private readonly prisma: PrismaService

  constructor(prisma: PrismaService) {
    this.prisma = prisma
  }

  async listSorted(sort: string, dir: string, limit: number) {
    const column = SORT_COLUMNS.get(sort)
    const direction = SORT_DIRECTIONS.get(dir)
    if (!column || !direction) throw new BadRequestException('Invalid sort')

    // lint-sql:allow column and direction are literals from the maps above
    const orderBy = Prisma.raw(`${column} ${direction}`)
    return this.prisma.$queryRaw<Array<{ id: number; title: string }>>`
      SELECT p.id, p.title FROM posts p ORDER BY ${orderBy} LIMIT ${limit}
    `
  }
}
```

The `LIMIT` stays a real bind parameter. Only the identifier goes through `Prisma.raw`, and only after being looked up in a map whose values you wrote — the request picks between two options it can never add to.

For the common case you need none of this. `orderBy: { createdAt: 'desc' }` is the typed API, and its allowed keys are the schema's field names by construction:

```ts good
return this.prisma.post.findMany({ orderBy: { createdAt: 'desc' }, take: limit })
```

Pair either form with the global `ValidationPipe` so `sort`, `dir` and `limit` are already the right types and within range before the service runs. A validated DTO and an allow-list are two independent controls, and having both means one mistake is not a breach. Full threat model: [SQL injection](../nestjs-security/sql-injection.md).

### Mass assignment

```ts vulnerable title="DO NOT COPY"
@Patch(':id')
update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
  return this.prisma.user.update({ where: { id: Number(id) }, data: body })
}
```

Prisma writes any field in `data` that exists on the model — `role`, `passwordHash`, anything. The global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` strips unknown properties, and the service should still build `data` from named fields, because a DTO can legitimately contain values the model must not accept from a request. See [The ValidationPipe](../nestjs-validation/validation-pipe.md) and [Mass assignment](../security/mass-assignment.md).

### Never log query parameters

The `query` event's `params` field is raw user data — passwords in an insert, tokens in a lookup. Log `e.query` and `e.duration`; never `e.params`. Same rule for the Prisma error objects, which carry the offending values in `meta`. [Safe logging](../nestjs-security/safe-logging.md).

### The application user is not the migration user

`migrate deploy` needs DDL rights. Your running service does not. Two roles means an injection that reaches the application connection cannot `DROP TABLE` or create a function. [Migrations](../nestjs-databases/migrations.md) sets it up.

## Production considerations

**`prisma generate` is an explicit build step.** It does not run on install and it does not run after `migrate dev`. Put it in the Dockerfile before `nest build` and in CI before type-checking. A missing generate produces "Cannot find module './generated/prisma/client'", which reads like a path bug and costs an hour.

**`migrate deploy` runs in a release job, not from `onModuleInit`.** It takes a lock, but replicas racing it still produce confusing failures.

**`app.enableShutdownHooks()` in `main.ts`.** Without it `onModuleDestroy` never runs and `$disconnect()` is dead code.

**Size the pool at the adapter.** `max` × replica count is your real connection count, and the v6 URL parameters (`connection_limit`, `pool_timeout`) are ignored in v7. Four replicas at `max: 10` is 40 connections before anything else connects. [Connection pooling](../nestjs-databases/connection-pooling.md).

**Set `connectionTimeoutMillis`.** The `pg` adapter's default is `0` — wait forever — which turns pool exhaustion into an outage instead of a burst of fast 503s.

**Add a `statement_timeout` at the database.** Prisma's transaction `timeout` covers interactive transactions only; a runaway single statement needs a server-side limit.

**Pin both majors and check the lockfile in CI.** `latest` for `prisma` is an RC, so a fresh container with an unpinned install resolves differently from your laptop.

**Health checks use `PrismaHealthIndicator`** from `@nestjs/terminus`, which takes the client explicitly because `PrismaService` is your provider, not one Terminus registered. [Health checks](../nestjs-databases/health-checks.md).

**Watch the generated client's size in your image.** It is large; a multi-stage Docker build that copies only `dist`, `node_modules` and the generated directory keeps it manageable. [Docker](../nestjs-production/docker.md).

## Common mistakes

- **Installing `prisma` without a range** and getting `8.0.0-rc.13` from the `latest` tag while `@prisma/client` stays on 7.
- **Leaving `url` in the `datasource` block.** In v7 it lives in `prisma.config.ts`.
- **Forgetting the driver adapter.** Prisma 7 requires one; there is no built-in pool any more.
- **No `OnModuleDestroy`.** Every rolling deploy severs open connections.
- **`enableShutdownHooks()` missing from `main.ts`.** Then `OnModuleDestroy` never runs anyway.
- **Skipping `$connect()` in `onModuleInit`.** A bad URL then surfaces as a 500 under traffic instead of a failed boot.
- **Wiring shutdown through `$on('beforeExit')`.** Use the Nest lifecycle hook.
- **Constructing `PrismaClient` in a service instead of injecting `PrismaService`.** One pool per process, not one per provider.
- **`this.prisma.x` instead of `tx.x` inside `$transaction`.** That query is outside the transaction and can deadlock against it.
- **Expecting `this.$extends(...)` to mutate the service.** It returns a new client; use a second provider.
- **`data: req.body`.** Mass assignment.
- **`findUnique` with no `select` on a response path.** Ships the password hash.
- **Reaching for `$queryRawUnsafe` because a value had to be dynamic.** Values are exactly what the tagged template is for.
- **Assuming `Prisma.raw` is safe because it is inside `$queryRaw`.** It is the one part that is not.
- **Logging `e.params`.** That is user data.
- **Running `prisma db push` against anything that holds real data.** No migration file, no history, and it will drop columns.

## Related topics

- [Prisma](../orms/prisma.md) — the library itself: schema DSL, `prisma.config.ts`, adapters, extensions and the v7 CLI changes.
- [Choosing an ORM](./choosing-an-orm.md) — whether Prisma is the right pick for this service.
- [Comparison table](./comparison.md) — Prisma against TypeORM, Mongoose, Drizzle and raw drivers inside Nest.
- [Avoiding N+1](./avoiding-n-plus-one.md) — why `include` is safe and a `for` loop is not.
- [Repository vs active record](./repository-vs-active-record.md) — keeping the generated types out of your controllers.
- [Transactions](../nestjs-databases/transactions.md) — making `$transaction` span several services.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — the provider lifecycle `PrismaService` is implementing.
- [Migrations](../nestjs-databases/migrations.md) — `migrate deploy` in a release job, and the two database users.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — sizing `max` on the adapter.
- [Health checks](../nestjs-databases/health-checks.md) — `PrismaHealthIndicator` and readiness probes.
- [SQL injection](../nestjs-security/sql-injection.md) — the threat behind the `$queryRawUnsafe` and `Prisma.raw` rules.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — overriding `PrismaService` in a testing module.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — why `enableShutdownHooks()` is the first line of `main.ts`.
