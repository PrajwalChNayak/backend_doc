---
title: Drizzle
description: Drizzle ORM 0.45.2 inside NestJS 12 — there is no @nestjs/drizzle, so the integration is a custom provider with a DRIZZLE token, a useFactory, your own shutdown hook, and the sql versus sql.raw rule.
status: current
updated: 2026-09-11
---

Drizzle is a thin, fully typed SQL builder: you define tables in TypeScript and the query you write maps almost one-to-one onto the statement that gets sent. There is no runtime engine, no code generation and no hidden rewriting. The library itself is covered in [Drizzle](../orms/drizzle.md); this page is the Nest integration.

This page documents **`drizzle-orm` 0.45.2** with **`drizzle-kit` 0.31.10** and **`pg` 8.23.0**.

:::warning There is no first-party `@nestjs/drizzle`
Nest ships integration modules for TypeORM and Mongoose only. Everything below is a **community pattern** built from ordinary Nest primitives — a custom provider, a token and a lifecycle hook. It is not a package you install and it is not blessed by either project. If you find a third-party wrapper, weigh it against the thirty lines below: a wrapper you do not control sits between you and two libraries that both move, and this one is small enough to own.

Consequences you own rather than inherit: the connection lifecycle, bootstrap retries, the health indicator, and the token naming if you connect to more than one database.
:::

:::note
A `1.0.0-rc.4` exists on the `rc` dist-tag, and the official documentation site has largely moved to that v1 API — most visibly, v1 replaces `relations()` with `defineRelations()`. The `latest` tag is still `0.45.2`, which is what this page covers. A relations snippet copied from the website that uses `defineRelations` will not compile here.
:::

## Why it exists

You reach for Drizzle in Nest for two reasons the other options do not give you together.

**The SQL stays visible.** `db.select().from(posts).where(eq(posts.authorId, id))` is one readable step from `SELECT … FROM posts WHERE author_id = $1`. When a query is slow you read it, not the ORM's interpretation of it. And CTEs, window functions, `ON CONFLICT` and `FOR UPDATE` are first-class rather than a drop to a raw string.

**It weighs almost nothing.** Zero runtime dependencies, no engine binary, no metadata build at startup. Bootstrap costs whatever constructing a `pg` pool costs — which matters if you deploy to anything that cold-starts, and which is the opposite end of the range from TypeORM building entity metadata at `initialize()`.

The price is the missing module, and it is smaller than it looks: the whole integration is one `useFactory`.

## When to use it

- **Your team knows SQL and wants to keep knowing it.**
- **Cold start or bundle size is a real constraint** — serverless, edge, workers.
- **You need SQL features routinely**, not occasionally: recursive CTEs, window functions, `INSERT … ON CONFLICT`, row locks.
- **You want type inference with no generation step.** Edit the schema, the types update. Nothing to forget in CI.

## When not to use it

- **You want the ORM to hide SQL.** It will not.
- **Deeply nested relational reads across many tables.** The relational API is good; Prisma's nested `select`/`include` ergonomics are better for graph-shaped reads.
- **You want a first-party module, a ready-made health indicator and someone else's lifecycle code.** That is [TypeORM](./typeorm.md).
- **Large schemas on a slow type-check budget.** Inference this deep costs `tsc` time in a way generated types do not.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install drizzle-orm@0.45.2 pg@8.23.0
npm install --save-dev drizzle-kit@0.31.10 @types/pg
```
@tab pnpm
```bash
pnpm add drizzle-orm@0.45.2 pg@8.23.0
pnpm add -D drizzle-kit@0.31.10 @types/pg
```
@tab yarn
```bash
yarn add drizzle-orm@0.45.2 pg@8.23.0
yarn add -D drizzle-kit@0.31.10 @types/pg
```
:::

`drizzle-orm` declares no `engines` and has zero runtime dependencies — the driver is a peer dependency you choose. Swap `pg` for `mysql2` 3.24.4 or `better-sqlite3` 13.0.3 and only the `drizzle()` import path changes.

:::note How the examples are written
Nest's constructor injection is usually written with the parameter-property shorthand, `constructor(@Inject(DRIZZLE) private readonly db: Database) {}`. The snippets here declare the field and assign it, because the site's snippet checker type-strips every `ts` block. The two forms are equivalent — use the shorthand in your own code.
:::

### Schema

Plain TypeScript, no Nest involvement at all.

```ts title="src/database/schema.ts"
import { relations } from 'drizzle-orm'
import {
  boolean, index, integer, pgTable, serial, text, timestamp, varchar,
} from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    published: boolean('published').notNull().default(false),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('posts_author_published_idx').on(table.authorId, table.published)],
)

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}))
```

`relations()` is metadata for the relational query API. It does **not** create foreign keys — `.references()` does that.

### The token and the type

A `Symbol` token, exported from a file with no other imports, so importing the token never drags a driver into a file that does not need one.

```ts title="src/database/drizzle.tokens.ts"
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from './schema.js'

export const DRIZZLE = Symbol('DRIZZLE')

/** The type every consumer injects. Name it once; never spell it out again. */
export type Database = NodePgDatabase<typeof schema>
```

A string token like `'DRIZZLE'` works and is a bad habit: two libraries can both export `'DATABASE'`, and they cannot both export the same symbol. See [Dependency injection](../nestjs/dependency-injection.md).

### The provider

This is the entire integration — a token, a `useFactory` and an `inject` array.

```ts title="src/database/drizzle.module.ts"
import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { DRIZZLE } from './drizzle.tokens.js'
import * as schema from './schema.js'

export const PG_POOL = Symbol('PG_POOL')

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: config.get<number>('DB_POOL_MAX') ?? 10,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          statement_timeout: 5_000,
        })
        // `pg` emits 'error' for idle clients the server disconnected. With no
        // listener that is an uncaught exception and the process dies.
        pool.on('error', (err) => new Logger('PgPool').error(`idle client: ${err.message}`))
        return pool
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      // Passing `schema` is what enables db.query.*. Without it you get the
      // SQL builder and the relational API silently does not exist.
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DrizzleModule implements OnApplicationShutdown {
  private readonly pool: Pool

  constructor(
    @Inject(PG_POOL)
    pool: Pool,
  ) {
    this.pool = pool
  }

  async onApplicationShutdown() {
    await this.pool.end()
  }
}
```

Three deliberate choices in there.

**Two providers, not one.** Drizzle does not pool — the driver does. Keeping the `Pool` as its own provider means you can expose `totalCount`/`idleCount`/`waitingCount` as metrics, write a health indicator against it, and close it on shutdown. A factory that constructs the pool inline hands you a `db` object with no way to reach the pool again. See [Connection pooling](../nestjs-databases/connection-pooling.md).

**The module implements the shutdown hook.** A `useFactory` provider is a plain object, so it cannot implement `OnModuleDestroy` — the hook has to live on a class. A module class works, and so does a small `DrizzleService`; what does not work is hoping something closes the pool for you. Nothing does.

**`@Global()` is defensible here** for the same reason as Prisma: there is no `forFeature`, so one connection serves the whole application and an explicit import in every feature module carries no information. Drop it if you would rather the module graph stay honest.

:::danger `onApplicationShutdown` only runs if you asked for it
`app.enableShutdownHooks()` is not on by default. Without it, `SIGTERM` kills the process, `pool.end()` is never called, and every rolling deploy severs in-flight queries. [Graceful shutdown](../nestjs-production/graceful-shutdown.md).
:::

### Using it in a service

```ts title="src/users/users.service.ts"
import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { desc, eq } from 'drizzle-orm'
import { DRIZZLE, type Database } from '../database/drizzle.tokens.js'
import { users } from '../database/schema.js'
import { CreateUserDto } from './dto/create-user.dto.js'

@Injectable()
export class UsersService {
  private readonly db: Database

  constructor(
    @Inject(DRIZZLE)
    db: Database,
  ) {
    this.db = db
  }

  async create(dto: CreateUserDto) {
    const [user] = await this.db
      .insert(users)
      // Named fields, not the DTO object. See Security considerations.
      .values({ email: dto.email, name: dto.name ?? null, passwordHash: dto.passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name })
    return user
  }

  async findById(id: number) {
    const [user] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
    if (!user) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  list(limit: number, offset: number) {
    return this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset)
  }
}
```

`@Inject(DRIZZLE)` is the one piece of ceremony a class-based provider (`PrismaService`) avoids. In exchange, the injected value is a plain object with no class identity — which makes the test fake a plain object too:

```ts title="src/users/users.service.spec.ts"
import { Test } from '@nestjs/testing'
import { DRIZZLE } from '../database/drizzle.tokens.js'
import { UsersService } from './users.service.js'

const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [{ id: 1, email: 'a@example.com' }] }) }),
  }),
}

const moduleRef = await Test.createTestingModule({
  providers: [UsersService, { provide: DRIZZLE, useValue: db }],
}).compile()

const service = moduleRef.get(UsersService)
```

The chained fake is noisy, which is a real signal: a service method that chains eight builder calls is hard to fake because it is hard to reason about. For anything past trivial, run the real thing against a disposable database — [Database fixtures](../nestjs-testing/database-fixtures.md).

## How it works

### Relational queries versus joins

Two ways to read related rows, and the difference is what shape you want back.

```ts title="src/posts/posts.service.ts"
// Relational — a nested object graph, one statement, types inferred
const feed = await this.db.query.users.findMany({
  columns: { id: true, email: true },
  with: {
    posts: {
      columns: { id: true, title: true },
      where: (posts, { eq }) => eq(posts.published, true),
      limit: 5,
    },
  },
  limit: 20,
})

// Join — flat rows you shape yourself
const rows = await this.db
  .select({ userId: users.id, email: users.email, postTitle: posts.title })
  .from(users)
  .leftJoin(posts, eq(posts.authorId, users.id))
  .where(eq(users.id, id))
```

Neither issues a query per parent row, so neither is an N+1 — that only happens when you write the loop. [Avoiding N+1](./avoiding-n-plus-one.md).

The relational API requires `{ schema }` to have been passed to `drizzle()`. If `db.query` is `undefined`, that is why.

### Transactions

```ts title="src/billing/transfer.service.ts"
import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { and, eq, gte, sql } from 'drizzle-orm'
import { DRIZZLE, type Database } from '../database/drizzle.tokens.js'
import { accounts } from '../database/schema.js'

@Injectable()
export class TransferService {
  private readonly db: Database

  constructor(
    @Inject(DRIZZLE)
    db: Database,
  ) {
    this.db = db
  }

  transfer(fromId: number, toId: number, cents: number) {
    return this.db.transaction(async (tx) => {
      // Conditional UPDATE: the check and the arithmetic both happen in the
      // database, so two concurrent transfers cannot both spend the last cent.
      const debited = await tx
        .update(accounts)
        .set({ balance: sql`${accounts.balance} - ${cents}` })
        .where(and(eq(accounts.id, fromId), gte(accounts.balance, cents)))
        .returning({ id: accounts.id })

      if (debited.length === 0) throw new BadRequestException('Insufficient funds')

      await tx
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${cents}` })
        .where(eq(accounts.id, toId))
    })
  }
}
```

Every statement inside goes through `tx`. `this.db` takes a different connection from the pool and is not part of the transaction — the same trap as TypeORM's injected repository and Prisma's `this.prisma`, and just as silent.

The `sql` template doing the arithmetic is the important detail: it produces `balance = "accounts"."balance" - $1`, which is atomic in the database. Reading a balance into JavaScript and writing back a computed number is a lost-update race.

A transaction spanning several Nest services needs `tx` threaded through as a parameter or carried in `AsyncLocalStorage`. Drizzle's transaction type is the same `Database` shape, so an optional `tx: Database = this.db` parameter works cleanly. The trade-off is in [Transactions](../nestjs-databases/transactions.md).

### Migrations

`drizzle-kit` is configured outside the Nest application, because the CLI cannot read your module graph:

```ts title="drizzle.config.ts"
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
})
```

```bash
npx drizzle-kit generate    # diff against the snapshot, write a .sql migration
npx drizzle-kit migrate     # apply pending migrations
npx drizzle-kit check       # validate the migration folder for conflicts
```

Commit the whole `drizzle/` folder including `meta/` — the JSON snapshot is the diff baseline, and losing it makes the next `generate` emit your entire schema. Read every generated migration: a column rename arrives as `DROP COLUMN` plus `ADD COLUMN`, and the files are plain SQL precisely so you can rewrite it.

Run migrations from a release-job script with its own single-connection pool, never from `onModuleInit`:

```ts title="scripts/migrate.ts"
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
await pool.end()
```

Three replicas booting together would otherwise race the same migration. [Migrations](../nestjs-databases/migrations.md).

### A health indicator, since there is not one

`@nestjs/terminus` has indicators for TypeORM, Mongoose and Prisma, and none for Drizzle. Write one with `HealthIndicatorService`:

```ts title="src/database/drizzle.health.ts"
import { Inject, Injectable } from '@nestjs/common'
import { HealthIndicatorService } from '@nestjs/terminus'
import { sql } from 'drizzle-orm'
import { DRIZZLE, type Database } from './drizzle.tokens.js'

@Injectable()
export class DrizzleHealthIndicator {
  private readonly health: HealthIndicatorService
  private readonly db: Database

  constructor(
    health: HealthIndicatorService,
    @Inject(DRIZZLE)
    db: Database,
  ) {
    this.health = health
    this.db = db
  }

  async isHealthy(key: string) {
    const indicator = this.health.check(key)
    try {
      await this.db.execute(sql`SELECT 1`)
      return indicator.up()
    } catch (err) {
      return indicator.down({ message: (err as Error).message })
    }
  }
}
```

Use it in readiness, never in liveness — a database outage should not restart your pods. [Health checks](../nestjs-databases/health-checks.md).

## Common patterns

### Keep the schema import out of your controllers

`import { users } from '../database/schema.js'` belongs in a service or a repository, not a controller. Drizzle's table objects are the query language, so a controller that imports one is writing SQL — see [Repository vs active record](./repository-vs-active-record.md).

### Dynamic filters compose safely

```ts title="src/posts/posts.service.ts"
import { and, eq, gte, type SQL } from 'drizzle-orm'

list(filters: { published?: boolean; since?: Date }, limit: number) {
  const conditions: SQL[] = []
  if (filters.published !== undefined) conditions.push(eq(posts.published, filters.published))
  if (filters.since) conditions.push(gte(posts.createdAt, filters.since))

  return this.db
    .select()
    .from(posts)
    .where(conditions.length ? and(...conditions) : undefined)
    .limit(limit)
}
```

Every condition carries its value as a bind parameter. Building a filter list this way is safe by construction — nothing becomes SQL text.

### Prepared statements on hot paths

```ts title="src/users/users.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { DRIZZLE, type Database } from '../database/drizzle.tokens.js'
import { users } from '../database/schema.js'

/** Declared outside the class so the field can borrow its return type. */
function prepareById(db: Database) {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, sql.placeholder('id')))
    .prepare('users_by_id')
}

@Injectable()
export class UsersReadService {
  private readonly byId: ReturnType<typeof prepareById>

  constructor(
    @Inject(DRIZZLE)
    db: Database,
  ) {
    this.byId = prepareById(db)
  }

  findById(id: number) {
    return this.byId.execute({ id })
  }
}
```

`sql.placeholder` marks a value slot filled at execution time, so the SQL text is stable and the database can reuse the plan. Build the statement in the constructor rather than as a field initializer — initializers run before the constructor body has assigned the injected `db`.

## Security considerations

### The sql tagged template parameterises

`sql` is a tagged template. Interpolated values become numbered placeholders and travel to the driver separately from the statement text:

```ts good title="src/reports/reports.service.ts"
import { sql } from 'drizzle-orm'

findByEmail(email: string) {
  return this.db.execute(
    sql`SELECT id, email FROM users WHERE email = ${email}`,
  )
  // Sent as: SELECT id, email FROM users WHERE email = $1   -- ['x@example.com']
}
```

Interpolating a **table or column object** is also safe, for a different reason — Drizzle knows it is an identifier and quotes it:

```ts good
await this.db.execute(sql`SELECT * FROM ${users} WHERE ${users.id} = ${id}`)
// SELECT * FROM "users" WHERE "users"."id" = $1
```

### sql.raw() does not

`sql.raw()` splices a string into the statement verbatim. No escaping, no parameter:

```ts vulnerable title="DO NOT COPY — src/reports/reports.service.ts"
import { sql } from 'drizzle-orm'

// GET /reports?email=x'%20OR%20'1'%3D'1
@Get()
async report(@Query('email') email: string) {
  return this.db.execute(sql.raw(`SELECT * FROM users WHERE email = '${email}'`))
}
```

:::danger
`sql.raw()` nested inside a `sql` template inherits none of the template's safety. A `sql` template containing `${sql.raw(userInput)}` is exactly as dangerous as string concatenation — the tag protects its own interpolations, not the contents of a `raw`. Treat every `sql.raw(x)` as if you had written `+ x`.
:::

The correct form for a dynamic **value** is always the plain interpolation:

```ts good
await this.db.execute(sql`SELECT * FROM users WHERE email = ${email}`)
```

### Dynamic identifiers and ORDER BY

Placeholders are value slots, so an `ORDER BY` column can never be one. Drizzle gives you two safe routes, and the first needs no linter exemption at all.

**Route one — map to schema column objects.** The map values are real columns, so Drizzle quotes the identifier and no attacker-controlled string is ever concatenated:

```ts good title="src/posts/posts.service.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { asc, desc } from 'drizzle-orm'
import { posts } from '../database/schema.js'

// Module scope: the only sorts this endpoint will ever accept.
const SORT_COLUMNS = { created_at: posts.createdAt, title: posts.title } as const
const SORT_DIRECTIONS = { asc, desc } as const

@Injectable()
export class PostsService {
  async listSorted(sort: string, dir: string, limit: number) {
    const column = SORT_COLUMNS[sort as keyof typeof SORT_COLUMNS]
    const direction = SORT_DIRECTIONS[dir as keyof typeof SORT_DIRECTIONS]
    if (!column || !direction) throw new BadRequestException('Invalid sort')

    return this.db.select().from(posts).orderBy(direction(column)).limit(limit)
  }
}
```

**Route two — `sql.identifier()`**, when you genuinely only have a name, still behind an allow-list:

```ts good title="src/reports/reports.service.ts"
import { BadRequestException } from '@nestjs/common'
import { sql } from 'drizzle-orm'

// Module scope: the only column names this endpoint will ever group by.
const GROUPABLE = new Set(['created_at', 'title'])

@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: NodePgDatabase<typeof schema>) {}

  async rollup(column: string, limit: number) {
    if (!GROUPABLE.has(column)) throw new BadRequestException('Invalid column')
    // lint-sql:allow column is checked against GROUPABLE and quoted by sql.identifier
    return this.db.execute(
      sql`SELECT ${sql.identifier(column)} AS value, count(*) AS total
            FROM posts GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`,
    )
  }
}
```

`sql.identifier()` quotes the name so it cannot break out of the identifier position; it does **not** restrict which identifier, so an attacker could still name a column you never meant to expose. The allow-list does the real work — `sql.identifier()` only handles quoting. The `LIMIT` stays a bind parameter throughout.

Pair either route with the global `ValidationPipe`, so `sort`, `dir` and `limit` are the right types and within range before the service runs. Full threat model: [SQL injection](../nestjs-security/sql-injection.md).

### Mass assignment

```ts vulnerable title="DO NOT COPY"
@Patch(':id')
update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
  return this.db.update(users).set(body).where(eq(users.id, Number(id)))
}
```

`.values()` and `.set()` write whatever keys match columns — `role`, `passwordHash`, anything. `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` strips unknown properties, and the service should still build the object from named fields. See [The ValidationPipe](../nestjs-validation/validation-pipe.md) and [Mass assignment](../security/mass-assignment.md).

### Select columns explicitly

`db.select().from(users)` returns every column including `passwordHash`. Pass a projection object on anything that reaches a response body, and map to a DTO at the service boundary — [Serialization](../nestjs-validation/serialization.md).

Drizzle has no `select: false` equivalent, so unlike TypeORM and Mongoose there is no schema-level net under a forgotten projection. That makes the projection a habit rather than a nicety.

### Do not put the pool in a controller

`PG_POOL` is exported so metrics and a health indicator can reach it. Injecting it into a controller puts raw SQL one keystroke from an HTTP handler with nothing in between. Keep it in the database module and the indicator.

## Production considerations

**`app.enableShutdownHooks()`**, or the pool is never closed. Nothing else on this page works without it.

**Own the retry on initial connect.** There is no `retryAttempts` here. A `pg` pool connects lazily, so a wrong `DATABASE_URL` surfaces on the first request unless you probe in `onModuleInit` — and if you do probe, bound it with a timeout, because an `async` factory that never resolves hangs the bootstrap with no error at all.

**Size the pool against the database.** `max` × replica count is your real connection count. [Connection pooling](../nestjs-databases/connection-pooling.md).

**Set `connectionTimeoutMillis` and `statement_timeout`.** The `pg` default for acquisition is wait-forever, which turns pool exhaustion into an outage rather than fast 503s. [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md).

**Handle the pool's `error` event.** One idle-client disconnect with no listener is an uncaught exception and a dead process.

**Commit `drizzle/meta`.** Without the snapshot the next `generate` emits a full-schema migration.

**Never `drizzle-kit push` against anything holding real data.** It applies the diff with no migration file and no history.

**Pin `drizzle-orm` and `drizzle-kit` together.** They share a snapshot format; upgrading one alone can force a migration-folder upgrade.

**Turn on query logging in staging.** `drizzle(pool, { schema, logger: true })` prints the generated SQL. Drizzle's output is predictable, and "predictable" is worth verifying once per non-trivial query.

**Watch `tsc` time as the schema grows.** If type-checking starts taking minutes, split the schema across modules and consider whether the deepest relational queries should be joins.

**Write the health indicator on day one.** It is fifteen lines, and the alternative is a readiness probe that returns 200 while the database is unreachable.

## Common mistakes

- **Expecting a `@nestjs/drizzle` package.** There is not one; the provider above is the integration.
- **Forgetting `{ schema }` in `drizzle(pool, …)`.** `db.query` is then `undefined` and the relational API silently does not exist.
- **Copying `defineRelations` from the website.** That is the 1.0 RC API; 0.45.2 uses `relations()`.
- **Expecting `relations()` to create foreign keys.** It is query metadata; `.references()` is the constraint.
- **No shutdown hook.** A `useFactory` provider cannot implement `OnModuleDestroy` — put it on a class.
- **Constructing the pool inside the `drizzle()` factory.** You then have no handle to close, meter or health-check.
- **A string token instead of a `Symbol`.** Collides across libraries.
- **Mismatched `inject` order.** `inject` is positional; a reordered array injects the wrong thing and the error appears much later.
- **`this.db` instead of `tx` inside a transaction callback.** Different connection, not in the transaction.
- **Using `sql.raw()` for a value.** Plain interpolation in the `sql` template is exactly what that is for.
- **Assuming `sql.raw()` is safe because it is inside a `sql` template.** It is not.
- **`.set(body)` from a request.** Mass assignment.
- **`db.select()` with no projection on a response path.** Ships the password hash, and there is no `select: false` to save you.
- **Reading a balance into JavaScript and writing it back.** Do the arithmetic in a `sql` template.
- **Not committing `drizzle/meta`.** The next `generate` produces nonsense.
- **Running migrations from `onModuleInit`.** Replicas race each other on every deploy.

## Related topics

- [Drizzle](../orms/drizzle.md) — the library itself: schema builders, relational queries, `drizzle-kit` and the v1 RC divergence.
- [Choosing an ORM](./choosing-an-orm.md) — when the missing Nest module is and is not a reason to pick something else.
- [Comparison table](./comparison.md) — Drizzle against TypeORM, Prisma, Mongoose and raw drivers inside Nest.
- [Raw drivers](./raw-drivers.md) — the same provider shape with no query builder on top.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — custom providers, `useFactory`, `inject` and `Symbol` tokens in full.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — sizing the `pg` pool Drizzle sits on.
- [Transactions](../nestjs-databases/transactions.md) — threading `tx` across services.
- [Migrations](../nestjs-databases/migrations.md) — running `drizzle-kit migrate` in a release job.
- [Health checks](../nestjs-databases/health-checks.md) — `HealthIndicatorService` and custom indicators.
- [Avoiding N+1](./avoiding-n-plus-one.md) — relational queries, joins and the loop that is neither.
- [SQL injection](../nestjs-security/sql-injection.md) — the threat behind the `sql.raw()` rule.
- [PostgreSQL](../nestjs-databases/postgresql.md) — the `pg` provider, SQLSTATE mapping and timeouts.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — why `pool.end()` needs `enableShutdownHooks()`.
