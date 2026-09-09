---
title: Connections and DI
description: A database connection is a provider in the Nest container — forRootAsync with ConfigService, custom providers wrapping a pg Pool, module scoping, and closing the pool on shutdown.
status: current
updated: 2026-09-09
---

Everything on the rest of these pages follows from one idea: in Nest, a database connection is a **provider**. It is constructed once by the injector, handed to whoever declares it as a dependency, and destroyed when the application shuts down. That is a different lifecycle from the module-level `export const pool = new Pool()` you would write in a plain Express app, and the difference is what makes configuration, testing and shutdown work.

:::note How the examples are written
Nest's constructor injection is usually written with the TypeScript parameter-property shorthand, `constructor(private readonly repo: Repository<User>) {}`. The snippets here declare the field and assign it in the constructor instead, because the site's snippet checker type-strips every `ts` block and parameter properties are emitting syntax. The two forms are exactly equivalent — use the shorthand in your own code.
:::

## Why it exists

A plain Node app resolves its database handle through the module graph: `import { pool } from './db.js'`. That works, and Part 1 documents it that way. It also has three properties that hurt once the app is more than one file:

- **Configuration is read at import time.** The `Pool` is constructed the moment the module is first imported, which is before `ConfigModule` has validated anything and before a test has had a chance to point it somewhere else.
- **There is no seam.** Nothing can substitute the pool. Every test that touches a repository touches the real database at the real URL.
- **Nobody owns shutdown.** `pool.end()` has to be called from a `SIGTERM` handler that imports the pool from the other side of the app.

Making the connection a provider fixes all three at once. The factory runs when the injector builds the module — after config, in an order Nest controls. `overrideProvider` gives tests a seam. And a provider implementing `OnModuleDestroy` is closed by the framework.

## The three ways to get a connection into the container

| Approach | Use it for | What you get |
| --- | --- | --- |
| An integration module — `TypeOrmModule.forRootAsync`, `MongooseModule.forRootAsync` | ORMs with a Nest package | The connection, plus repository/model providers, plus health indicators |
| A **custom provider** — `{ provide: TOKEN, useFactory, inject }` | Raw drivers (`pg`, `mysql2`, `ioredis`), Prisma, Drizzle | Total control; you write the lifecycle hook |
| A `@Injectable()` service that owns the client | Prisma, and anywhere you want methods alongside the handle | A class token, so no `@Inject()` at call sites |

They are not exclusive. A real app usually has an ORM module *and* a custom provider for Redis.

## TypeOrmModule.forRootAsync with ConfigService

`forRoot` takes a static options object. Use it only when the options are literally constants; the moment a value comes from the environment, use `forRootAsync` so the factory runs after `ConfigModule` has loaded and validated.

```bash
npm install @nestjs/typeorm@12.0.1 typeorm@1.1.1 pg@8.23.0 reflect-metadata
```

```ts title="src/config/database.config.ts"
import { registerAs } from '@nestjs/config'

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  poolMax: Number(process.env.DB_POOL_MAX ?? 10),
  ssl: process.env.DB_SSL === 'true',
}))
```

```ts title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
        poolSize: config.get<number>('database.poolMax') ?? 10,
        logging: ['error', 'warn', 'migration'] as const,
        maxQueryExecutionTime: 200,
        retryAttempts: 5,
        retryDelay: 1_000,
      }),
    }),
  ],
})
export class DatabaseModule {}
```

Five of those options carry real weight:

- **`synchronize: false`.** Always. `synchronize: true` rewrites your schema to match your entities on boot and will drop columns. See [Migrations](migrations.md).
- **`migrationsRun: false`.** Migrations are a deploy step, not a boot step, once you have more than one replica. Same page.
- **`autoLoadEntities: true`** collects every entity registered through `TypeOrmModule.forFeature()` so you do not maintain a second list. It only works with the Nest module — a bare `DataSource` still needs `entities`.
- **`retryAttempts` / `retryDelay`** control how many times Nest retries the *initial* connection before failing the bootstrap. Useful in Docker Compose, where the app starts before the database is listening. It does nothing for connections lost later; that is [Retries and timeouts](retries-and-timeouts.md).
- **`maxQueryExecutionTime`** logs any query slower than the threshold. It does not cancel it.

Feature modules then register their entities and get repositories:

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from './user.entity.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

```ts title="src/users/users.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { User } from './user.entity.js'

@Injectable()
export class UsersService {
  private readonly users: Repository<User>

  constructor(@InjectRepository(User) users: Repository<User>) {
    this.users = users
  }

  findById(id: number) {
    return this.users.findOne({ where: { id } })
  }
}
```

`TypeOrmModule.forFeature([User])` registers a provider whose token is `getRepositoryToken(User)`; `@InjectRepository(User)` is a shorthand for `@Inject(getRepositoryToken(User))`. Knowing that matters when you override it in a test — see [Testing with a database](testing-with-a-database.md).

:::warning `forFeature` is per-module
The repository provider is exported by the dynamic module that `forFeature` returns, so it is only injectable inside the module that imported it. Another module that wants `Repository<User>` must import `TypeOrmModule.forFeature([User])` itself. Prefer exporting `UsersService` and going through it — that is the point of having a service.
:::

## MongooseModule.forRootAsync

Same shape, different package.

```bash
npm install @nestjs/mongoose@12.0.0 mongoose@9.9.5
```

```ts title="src/database/mongo.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGO_URL'),
        maxPoolSize: 10,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5_000,
        socketTimeoutMS: 20_000,
      }),
    }),
  ],
})
export class MongoModule {}
```

`MongooseModule` manages one `Connection` per registered name and closes it on shutdown. Models are registered per feature module with `MongooseModule.forFeature([...])` and injected with `@InjectModel()`; the connection itself is available through `@InjectConnection()`, which is what you need for transactions and health checks. See [MongoDB](mongodb.md).

## A custom provider wrapping a pg Pool

For a raw driver there is no integration module, so you write the provider. This is the pattern worth learning properly, because Redis, Drizzle and anything else you bolt on uses the same three pieces: a **token**, a **`useFactory`**, and an **`inject`** array.

```ts title="src/database/pg.tokens.ts"
export const PG_POOL = Symbol('PG_POOL')
```

```ts title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { Pool } from 'pg'
import { PG_POOL } from './pg.tokens.js'
import { PgService } from './pg.service.js'

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: config.get<number>('database.poolMax') ?? 10,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          statement_timeout: 5_000,
        }),
    },
    PgService,
  ],
  exports: [PgService],
})
export class DatabaseModule {}
```

Three things about `useFactory` that are easy to get wrong:

- **`inject` is positional.** The array maps one-to-one onto the factory's parameters, in order. There is no name matching, so adding a dependency in the middle silently shifts everything.
- **The factory may be `async`.** Nest awaits it before any dependent provider is constructed, which is how `PrismaService`-style eager connects work. An `async` factory that never resolves hangs the bootstrap with no error, so always put a timeout on anything it awaits.
- **A `Symbol` token is safer than a string.** Two libraries can both export `'DATABASE'`; they cannot both export the same symbol. Export the symbol from a tiny module that has no other imports, so importing the token never drags a driver into a file that does not need one.

### The service that owns the lifecycle

The `Pool` itself has no idea it is in a container. Wrap it in a provider that does:

```ts title="src/database/pg.service.ts"
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { PG_POOL } from './pg.tokens.js'

@Injectable()
export class PgService implements OnModuleDestroy {
  private readonly logger = new Logger(PgService.name)
  private readonly pool: Pool

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.pool = pool
    // A pool emits 'error' for idle clients killed by the server. Unhandled,
    // this is an uncaught exception and the process dies.
    this.pool.on('error', (err) => this.logger.error(`idle client error: ${err.message}`))
  }

  query<T extends QueryResultRow>(text: string, params: readonly unknown[] = []) {
    return this.pool.query<T>(text, params as unknown[])
  }

  connect(): Promise<PoolClient> {
    return this.pool.connect()
  }

  get stats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    }
  }

  async onModuleDestroy() {
    this.logger.log('closing pg pool')
    await this.pool.end()
  }
}
```

`onModuleDestroy` runs when the application is closing. It only runs if you asked for it:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

// Without this, SIGTERM kills the process and no lifecycle hook ever fires:
// the pool is never drained and in-flight queries are cut mid-statement.
app.enableShutdownHooks()

await app.listen(3000)
```

:::danger The most common Nest database bug in production
`app.enableShutdownHooks()` is **not** on by default. Without it `onModuleDestroy` and `onApplicationShutdown` never run on `SIGTERM`. Every rolling deploy then severs open connections, leaving the server to clean up transactions on its own timeout, and any queue consumer or cron job is killed mid-work.
:::

Use `onModuleDestroy` for closing a handle you created. Use `onApplicationShutdown(signal)` when you need to know *why* you are shutting down, or when the work must happen after every module has already torn down. Nest 12 changed hook ordering to run by component hierarchy level, so do not depend on two independent providers' hooks firing in a particular order — see [Graceful shutdown](../nestjs-production/graceful-shutdown.md).

### Using it

```ts title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

export interface UserRow {
  id: number
  email: string
  created_at: Date
}

@Injectable()
export class UsersRepository {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      'SELECT id, email, created_at FROM users WHERE email = $1',
      [email],
    )
    return rows[0] ?? null
  }
}
```

`$1`, always. The parameter never becomes part of the statement text, so no value — however hostile — can change what the statement does. [SQL injection](../nestjs-security/sql-injection.md) shows what the alternative costs.

## Why the connection must be a singleton provider

A provider is a **singleton by default**: one instance for the whole application, created once. That is exactly right for a pool, and both of the alternatives are wrong.

**A module-level global** — `export const pool = new Pool(...)` in `db.ts` — is constructed at import time. That is *before* `ConfigModule` has read `.env`, before validation has rejected a missing `DATABASE_URL`, and before a test has had any chance to intervene. You get a pool pointed at `undefined` and a failure that surfaces on the first query rather than at boot. It is also invisible to `enableShutdownHooks()`.

**A request-scoped provider** is worse. Marking the connection `Scope.REQUEST` makes Nest build a new instance **per request**, and the whole dependency chain above it becomes request-scoped too:

```ts vulnerable title="DO NOT COPY — one pool per request"
{
  provide: PG_POOL,
  scope: Scope.REQUEST,
  useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }),
}
```

At 200 requests per second you are creating 200 pools per second, each opening its own TCP connections and TLS handshakes, and none of them are ever closed. The database hits `max_connections` in seconds. Read [Injection scopes](../nestjs/injection-scopes.md) before making anything request-scoped, and [Transactions](transactions.md) for why request scope is also the wrong tool for transaction propagation.

The rule: **the connection is a singleton; the unit of work is a parameter.**

## Module scoping — who can inject what

Providers are not global. `PgService` is injectable only in modules that import `DatabaseModule`, and only because `DatabaseModule` lists it in `exports`. That is a feature: it stops a controller reaching past the service layer straight into the pool.

Two ways to make it broadly available, in order of preference:

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { UsersRepository } from './users.repository.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [DatabaseModule],
  providers: [UsersRepository, UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Import it where you need it. Explicit, greppable, and the module graph tells you honestly which parts of the app touch the database.

```ts title="src/database/database.module.ts"
import { Global, Module } from '@nestjs/common'

@Global()
@Module({ providers: [PgService], exports: [PgService] })
export class DatabaseModule {}
```

`@Global()` registers the exports once in the root injector so nobody has to import the module. It is genuinely convenient for the database, config and logging modules — and it is a one-way door for everything else. Use it sparingly; a codebase where every module is global has no module boundaries left. See [Modules](../nestjs/modules.md).

Either way the instance is the **same object**. `@Global()` changes visibility, not cardinality.

## Multiple databases

Both integration modules take a `name`, and the inject decorators take it too. The tokens are distinct, so nothing collides.

```ts
TypeOrmModule.forRoot({
  name: 'reporting',
  type: 'postgres',
  url: process.env.REPORTING_DATABASE_URL,
  entities: [Report],
  synchronize: false,
})
```

```ts
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Injectable()
export class ReportingService {
  private readonly reporting: DataSource

  constructor(@InjectDataSource('reporting') reporting: DataSource) {
    this.reporting = reporting
  }
}
```

A read replica is the common case, and it is worth saying out loud that it is not free: replicas lag, so a write followed by a read on the replica can legitimately return the old row. Route only queries that tolerate staleness there.

## Security considerations

**Never construct the connection from a request value.** A tenant id that reaches a `useFactory` — via a request-scoped provider, a `REQUEST` injection, or a lookup table keyed by a header — is a path to connecting to a database the caller was not supposed to reach, with whatever credentials that entry holds. Tenancy belongs in the `WHERE` clause or in a schema chosen from an allow-list, never in a connection string built at request time.

**Credentials come from the environment and are validated at boot.** `ConfigModule.forRoot({ validationSchema })` with a schema that requires `DATABASE_URL` turns "the URL was empty" from a runtime 500 into a refusal to start. A process that will not start is a far better failure than one that starts and silently connects to a default local database.

```ts title="src/config/env.schema.ts"
import { z } from 'zod'

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  NODE_ENV: z.enum(['development', 'test', 'production']),
})
```

`@nestjs/config` 12 accepts any Standard Schema for `validationSchema`, so Zod works directly. See [Secrets and config validation](../nestjs-security/secrets-and-config.md).

**The application user is not the migration user.** The app connects with a role that can `SELECT`/`INSERT`/`UPDATE`/`DELETE` and nothing else. DDL belongs to a separate role used only by the deploy pipeline, so a SQL injection that reaches your application connection cannot `DROP TABLE`. [Migrations](migrations.md) sets this up.

**Do not log the connection options.** A driver error and a Nest bootstrap failure both love to print the options object, and `url` contains the password. Redact `url`, `password` and `connectionString` in your logger before anything reaches a log aggregator — [Safe logging](../nestjs-security/safe-logging.md).

**Turn on TLS for managed databases and verify the certificate.** `ssl: { rejectUnauthorized: false }` is the setting people paste to make a connection error go away; it turns TLS into obfuscation, because it accepts any certificate including an attacker's. Supply the provider's CA instead.

**`synchronize: true` is a security problem, not just an availability one.** It derives DDL from whatever entity files the running process loaded. A deploy of a bad branch rewrites production's schema, and dropping a column drops its data.

## Production considerations

- **`app.enableShutdownHooks()` in `main.ts`, on day one.** Nothing else in this list works without it.
- **One pool per process.** Do not construct a second `Pool` for "just this one thing". See [Connection pooling](connection-pooling.md).
- **Bound the initial connect.** `retryAttempts`/`retryDelay` (TypeORM) or a timeout inside your `useFactory` — an `async` factory that hangs produces a process that is neither started nor failed, which no orchestrator can act on.
- **Handle the pool's `error` event.** `pg` emits `'error'` on idle clients that the server disconnected. With no listener that is an uncaught exception, and the process exits.
- **Set `statement_timeout` on the connection**, not just per query. It is the only bound that survives a code path someone forgot to wrap. [Retries and timeouts](retries-and-timeouts.md).
- **Expose the pool counters.** `totalCount`, `idleCount`, `waitingCount` as metrics — `waiting > 0` is the difference between "the database is slow" and "the pool is too small", and it takes twenty minutes to work out without them.
- **Keep `forRootAsync` factories pure.** They must not perform migrations, seed data, or call another service. A factory is a constructor, and it runs in every environment including tests.
- **Prefer explicit `imports` over `@Global()`** for everything except config, logging and the database itself.
- **Name the second connection.** An unnamed second `TypeOrmModule.forRoot` overwrites the default, and the failure looks like queries going to the wrong database.

## Common mistakes

- **`forRoot` with `process.env` read inline.** It is evaluated at module-definition time, before config validation, so a typo'd variable is `undefined` rather than an error.
- **Forgetting `app.enableShutdownHooks()`.** Every hook on this page is dead code without it.
- **A module-level `new Pool()`.** Constructed at import time, invisible to the container, unclosable, unmockable.
- **Making the connection request-scoped.** A pool per request, and the entire injection chain above it silently becomes request-scoped too.
- **A string token like `'DATABASE'`.** Collides across libraries. Use a `Symbol`.
- **Mismatched `inject` order.** `inject` is positional; a reordered array injects `ConfigService` where the factory expects a `Logger`, and the error appears much later.
- **Expecting `forFeature` repositories to be visible everywhere.** They are scoped to the importing module.
- **`synchronize: true` anywhere but a scratch database.** It drops columns.
- **`migrationsRun: true` with more than one replica.** Concurrent migration runs on boot — [Migrations](migrations.md).
- **No `'error'` listener on the pool.** One idle-client disconnect takes the process down.
- **A second unnamed `forRoot`.** It replaces the first one instead of adding a connection.
- **Injecting the raw `Pool` into controllers.** The controller now owns database concerns, and nothing sits between HTTP and SQL.

## Related topics

- [Dependency injection](../nestjs/dependency-injection.md) — tokens, custom providers and how the injector resolves them.
- [Injection scopes](../nestjs/injection-scopes.md) — why `Scope.REQUEST` propagates, and what it costs.
- [Modules](../nestjs/modules.md) — `imports`, `exports` and when `@Global()` is justified.
- [Configuration](../nestjs/configuration.md) — `ConfigModule`, `registerAs` and Standard Schema validation.
- [Connection pooling](connection-pooling.md) — sizing the pool you just created.
- [Transactions](transactions.md) — passing the unit of work down the service chain.
- [PostgreSQL](postgresql.md) — the `pg` provider in full, with timeouts and error codes.
- [TypeORM](../nestjs-orms/typeorm.md) — entities, repositories and the query builder inside Nest.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — the order in which everything is torn down.
- [Testing with a database](testing-with-a-database.md) — overriding the connection provider in a testing module.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the driver itself, outside any framework.
