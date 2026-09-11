---
title: PostgreSQL
description: Wiring the pg driver into a Nest application — a pooled provider built from ConfigService, parameterised repository methods, SQLSTATE to HttpException mapping, and closing the pool on shutdown.
status: current
updated: 2026-09-11
---

The `pg` driver does not change inside Nest. What changes is *who owns it*: instead of a module-level `export const pool`, the pool is a provider the injector builds after configuration has been validated and destroys when the application closes. This page is about that wiring. The driver mechanics — `Pool` versus `Client`, type parsers, `ON CONFLICT`, SSL, `rowMode` — are in [PostgreSQL with pg](../databases/postgresql-with-pg.md) and are not repeated here.

## What Nest actually changes

| Plain Node | Inside Nest |
| --- | --- |
| `new Pool()` at import time | a `useFactory` that runs after `ConfigModule` validated the environment |
| `process.env.DATABASE_URL` read inline | `config.getOrThrow('DATABASE_URL')`, so a missing value fails the boot |
| `pool.end()` in a `SIGTERM` handler | `onModuleDestroy()` on the provider, driven by `app.enableShutdownHooks()` |
| nothing can substitute the pool | `overrideProvider(PG_POOL)` in a testing module |
| every module imports `db.js` | only modules that import `DatabaseModule` can reach the database |

Everything else — `$1` placeholders, `statement_timeout`, SQLSTATE codes — is identical.

## Installing

```bash
npm install pg@8.23.0
npm install --save-dev @types/pg
```

`pg` is a pure-JavaScript driver, so there is no native build step and nothing to rebuild in your Docker image. Node 24 LTS is the target; `pg` 8 has no unusual engine requirement.

## The pool provider

[Connections and DI](connections-and-di.md) builds this provider in full. The short version, so this page stands on its own:

```ts title="src/database/pg.tokens.ts"
export const PG_POOL = Symbol('PG_POOL')
```

```ts title="src/database/database.module.ts"
import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { Pool } from 'pg'
import { PG_POOL } from './pg.tokens.js'
import { PgService } from './pg.service.js'

@Global()
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
          // Server-side bounds. These survive a code path nobody wrapped.
          statement_timeout: 5_000,
          idle_in_transaction_session_timeout: 10_000,
          application_name: config.get<string>('SERVICE_NAME') ?? 'api',
        }),
    },
    PgService,
  ],
  exports: [PgService],
})
export class DatabaseModule {}
```

Two of those options are worth the keystrokes on every project:

- **`statement_timeout`** is set on the *connection*, so every query on it is bounded whether or not the calling code remembered. Without it one missing index during an incident holds a pool slot for minutes. See [Retries and timeouts](retries-and-timeouts.md).
- **`application_name`** shows up in `pg_stat_activity`. When four services share a database, it is the difference between "something is holding locks" and "the export worker is holding locks".

`idle_in_transaction_session_timeout` is the safety net for a transaction that was opened and never finished — an `await` that threw between `BEGIN` and `COMMIT` in code that forgot its `finally`.

## Typed configuration

`ConfigService.get('DB_POOL_MAX')` returns whatever was in the environment, which is a string. Reading it straight into `max` gives you a pool of `"10"`, and `pg` will not complain. Use `registerAs` so the coercion happens once:

```ts title="src/config/database.config.ts"
import { registerAs } from '@nestjs/config'

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  poolMax: Number(process.env.DB_POOL_MAX ?? 10),
  statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 5000),
  ssl: process.env.DB_SSL === 'true',
}))
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import databaseConfig from './config/database.config.js'
import { envSchema } from './config/env.schema.js'
import { DatabaseModule } from './database/database.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
      validationSchema: envSchema,
    }),
    DatabaseModule,
  ],
})
export class AppModule {}
```

`@nestjs/config` 12 accepts any Standard Schema for `validationSchema`, so the Zod schema from [Configuration](../nestjs/configuration.md) works directly. A missing `DATABASE_URL` is then a refusal to start, not a 500 on the first request.

## The service that owns the pool

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
    // `pg` emits 'error' when the server kills an idle client. With no
    // listener that is an uncaught exception and the process exits.
    this.pool.on('error', (err) => this.logger.error(`idle client error: ${err.message}`))
  }

  query<T extends QueryResultRow>(text: string, params: readonly unknown[] = []) {
    return this.pool.query<T>(text, params as unknown[])
  }

  connect(): Promise<PoolClient> {
    return this.pool.connect()
  }

  get stats() {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount }
  }

  async onModuleDestroy() {
    await this.pool.end()
  }
}
```

`onModuleDestroy` only fires if `main.ts` calls `app.enableShutdownHooks()`. It is not on by default, and forgetting it is the single most common Nest database bug in production — every rolling deploy then cuts connections mid-statement.

## A repository provider

Keep SQL out of controllers and out of services that also do business logic. A repository provider is one class, one table, and every method takes parameters:

```ts title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

export interface UserRow {
  id: number
  email: string
  display_name: string
  created_at: Date
}

@Injectable()
export class UsersRepository {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  async findById(id: number): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      'SELECT id, email, display_name, created_at FROM users WHERE id = $1',
      [id],
    )
    return rows[0] ?? null
  }

  async findByIds(ids: readonly number[]): Promise<UserRow[]> {
    // = ANY($1) takes one array parameter, so the statement text is the same
    // shape for one id or a thousand. Never build an IN list by joining.
    const { rows } = await this.db.query<UserRow>(
      'SELECT id, email, display_name, created_at FROM users WHERE id = ANY($1::bigint[])',
      [ids],
    )
    return rows
  }

  async upsertByEmail(email: string, displayName: string): Promise<UserRow> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, display_name)
            VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, email, display_name, created_at`,
      [email, displayName],
    )
    return rows[0]
  }
}
```

`$1` is not a formatting convenience. The parameter is sent separately from the statement text, so no value — however hostile — can become part of the statement. That is the whole defence, and it does not weaken as the query grows.

:::danger What the alternative costs
```ts vulnerable title="DO NOT COPY — src/users/users.repository.ts"
async findByEmail(email: string) {
  const { rows } = await this.db.query(
    `SELECT id, email, password_hash FROM users WHERE email = '${email}'`,
  )
  return rows[0]
}
```

A request with `email` set to `x' OR '1'='1' --` returns the first row in the table, which is usually the oldest account and often an administrator. Change it to `x'; UPDATE users SET role='admin' WHERE email='attacker@example.com'; --` and the injected statement is a privilege escalation. Nest's `ValidationPipe` does not help: `@IsEmail()` on the DTO is a *format* check, and there are valid-looking addresses that carry a payload.
:::

```ts good title="src/users/users.repository.ts"
async findByEmail(email: string) {
  const { rows } = await this.db.query<UserRow>(
    'SELECT id, email, display_name, created_at FROM users WHERE email = $1',
    [email],
  )
  return rows[0] ?? null
}
```

[SQL injection](../nestjs-security/sql-injection.md) has the exploit end to end, with the `curl` that proves it and the test that keeps it fixed.

### Sorting by a user-supplied column

An identifier cannot be a parameter — `ORDER BY $1` sorts by the *constant* `$1`, which is a no-op. This is the one case where interpolation is legitimate, and only against an allow-list:

```ts title="src/users/users.repository.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

const SORTABLE = new Set(['created_at', 'email', 'display_name'])

@Injectable()
export class UsersListRepository {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  list(sort: string, limit: number) {
    if (!SORTABLE.has(sort)) throw new BadRequestException('unsupported sort column')
    // lint-sql:allow sort is checked against the SORTABLE allow-list on the line above
    const text = `SELECT id, email, display_name, created_at FROM users ORDER BY ${sort} DESC LIMIT $1`
    return this.db.query(text, [limit])
  }
}
```

The allow-list is the control, not the `BadRequestException`. Escaping the identifier or stripping quotes is not equivalent — a `Set` of literal strings cannot be talked around. Do the same for a direction by mapping `'asc' | 'desc'` onto two fixed strings, never onto the input.

## Mapping SQLSTATE onto HTTP

A unique-violation that reaches the client as a 500 is a bug in your error handling, not in the database. Postgres error codes are stable and small in number, so map them once in an exception filter:

```ts title="src/database/pg-exception.filter.ts"
import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { DatabaseError } from 'pg'

const MAP: Record<string, () => HttpException> = {
  '23505': () => new ConflictException('That value is already taken'),
  '23503': () => new UnprocessableEntityException('Referenced record does not exist'),
  '23514': () => new UnprocessableEntityException('Value failed a database constraint'),
  '40001': () => new ConflictException('Concurrent update, please retry'),
  '40P01': () => new ConflictException('Concurrent update, please retry'),
  '57014': () => new InternalServerErrorException('The query took too long'),
}

@Catch(DatabaseError)
export class PgExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PgExceptionFilter.name)

  catch(error: DatabaseError, host: ArgumentsHost) {
    // The driver error carries the table, column, constraint name and often
    // the offending value. Log it; never let it reach the client.
    this.logger.warn(`pg ${error.code}: ${error.message} (constraint=${error.constraint})`)

    const factory = error.code ? MAP[error.code] : undefined
    super.catch(factory ? factory() : new InternalServerErrorException(), host)
  }
}
```

```ts title="src/main.ts"
import { HttpAdapterHost, NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { PgExceptionFilter } from './database/pg-exception.filter.js'

const app = await NestFactory.create(AppModule)
app.useGlobalFilters(new PgExceptionFilter(app.get(HttpAdapterHost).httpAdapter))
app.enableShutdownHooks()
await app.listen(3000)
```

Extending `BaseExceptionFilter` matters: it keeps Nest's normal response shape for everything the map does not cover, instead of you reinventing it. The codes above are the ones worth handling; the full list is in [PostgreSQL with pg](../databases/postgresql-with-pg.md).

`57014` is `query_canceled`, which is what `statement_timeout` produces. Treat it as an operational alarm, not a client error — a query that hits the timeout is a missing index or a lock, and it will hit it again on the next request.

## Multiple schemas and tenancy

A multi-tenant application that gives each tenant a schema is the one place people are tempted to build a connection per request. Do not. The connection stays a singleton; the *schema* is chosen per query, from an allow-list you loaded at boot:

```ts title="src/tenancy/tenant.repository.ts"
import { ForbiddenException, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { PoolClient } from 'pg'
import { PgService } from '../database/pg.service.js'

@Injectable()
export class TenantRepository {
  private readonly db: PgService
  private readonly schemas: ReadonlySet<string>

  constructor(db: PgService, config: ConfigService) {
    this.db = db
    // Read once, at construction. Never derived from a request.
    this.schemas = new Set(config.getOrThrow<string>('TENANT_SCHEMAS').split(','))
  }

  async withTenant<T>(schema: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.schemas.has(schema)) throw new ForbiddenException('unknown tenant')
    const client = await this.db.connect()
    try {
      // set_config with a parameter — the schema name is a value here, not
      // part of the statement text, and LOCAL scopes it to the transaction.
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['search_path', schema])
      return await fn(client)
    } finally {
      await client.query('COMMIT').catch(() => client.query('ROLLBACK'))
      client.release()
    }
  }
}
```

`set_config($1, $2, true)` is the parameterised form of `SET LOCAL search_path`. `SET` itself does not accept parameters, which is exactly why people reach for interpolation there; `set_config` removes the reason.

The `true` third argument makes it transaction-local, so the setting cannot leak to the next borrower of that pooled connection. A session-scoped `SET search_path` on a pooled connection is a cross-tenant data leak waiting for the next request.

## Security considerations

**Every value is a parameter.** `$1`, always, including inside transactions and inside `IN` lists (`= ANY($1)`). The only interpolation allowed is an identifier validated against a literal allow-list, marked with a `// lint-sql:allow` comment so a reviewer can see the proof next to the code.

**Format validation is not injection defence.** `@IsEmail()`, `@IsUUID()` and a Zod schema are all worth having, and none of them makes concatenation safe. They reduce the payload space; they do not close the hole. Treat [validation](../nestjs-security/validation-as-a-control.md) and parameterisation as independent controls.

**The application role cannot run DDL.** Grant the app user `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the tables it needs and nothing else. Then an injection that does get through cannot `DROP TABLE`, cannot read `pg_shadow`, and cannot create a function. [Migrations](migrations.md) sets up the separate DDL role.

**Select columns explicitly.** `SELECT *` on `users` returns `password_hash` and whatever column someone adds next sprint, and a serializer that was written before that column existed will happily ship it. Name the columns, and keep the entity-to-DTO boundary — see [Serialization](../nestjs-validation/serialization.md).

**Never log the driver error verbatim to a client.** A `DatabaseError` carries `table`, `column`, `constraint`, `detail` and often the conflicting value. That is a free schema dump plus, for a unique violation on an email, a user-enumeration oracle. The filter above logs it and returns a generic message.

**Verify TLS for managed databases.** `ssl: { rejectUnauthorized: false }` accepts any certificate, including one an attacker presents, which turns transport security into decoration. Pass the provider's CA:

```ts
new Pool({
  connectionString: config.getOrThrow<string>('DATABASE_URL'),
  ssl: { ca: config.getOrThrow<string>('DB_CA_CERT'), rejectUnauthorized: true },
})
```

**Keep the connection string out of logs.** Nest's bootstrap error output and `pg`'s own errors both print option objects on occasion, and `connectionString` contains the password. Redact it in the logger — [Safe logging](../nestjs-security/safe-logging.md).

**Do not build the connection from a request value.** A tenant id that reaches the `useFactory` is a path to connecting as credentials the caller was never granted. Tenancy belongs in the `WHERE` clause or in an allow-listed `search_path`, as above.

## Production considerations

- **`app.enableShutdownHooks()` in `main.ts`.** Without it, `onModuleDestroy` never runs and every deploy severs in-flight queries.
- **One pool per process.** The pool is a singleton provider; resist a second `Pool` "just for the report endpoint". [Connection pooling](connection-pooling.md).
- **Set `statement_timeout` on the pool**, not only per call site. A connection-level bound is the only one that survives a code path nobody wrapped.
- **Set `connectionTimeoutMillis`.** The default waits forever, so pool exhaustion presents as hung requests instead of fast 503s.
- **Attach an `'error'` listener to the pool.** One idle client killed by the server is otherwise an uncaught exception and a dead process.
- **Export `totalCount` / `idleCount` / `waitingCount` as metrics.** `waiting > 0` distinguishes "the database is slow" from "the pool is too small"; without it that diagnosis takes twenty minutes. [Observability](../nestjs-production/observability.md).
- **Set `application_name`** so `pg_stat_activity` tells you which service owns a slow query.
- **Keep the `useFactory` pure.** It must not run migrations or seed data — it executes in every environment, including tests.
- **Bound the initial connect.** An `async` factory that never resolves produces a process that is neither started nor failed, which no orchestrator can act on.
- **Watch for prepared-statement incompatibility with poolers.** PgBouncer in transaction mode breaks session-scoped state; see [Connection pooling](connection-pooling.md) before putting one in front of this pool.

## Common mistakes

- **A module-level `new Pool()` next to the Nest module.** Constructed at import time, before config validation, invisible to shutdown hooks, unmockable in tests.
- **Interpolating a value into the statement.** The vulnerable block above. Use `$1`.
- **Building an `IN` list by joining placeholders.** Use `= ANY($1::bigint[])` and pass the array.
- **`ORDER BY $1`.** It sorts by a constant and silently does nothing. Allow-list the identifier instead.
- **`ConfigService.get('DB_POOL_MAX')` straight into `max`.** It is a string; use `registerAs` with `Number()`.
- **Forgetting `app.enableShutdownHooks()`.** Everything on this page that closes anything is dead code without it.
- **No `'error'` listener on the pool.** One disconnected idle client takes the process down.
- **Letting `DatabaseError` reach the client.** It leaks the schema and enumerates users on a unique violation.
- **`rejectUnauthorized: false` to make a TLS error go away.** That is the error telling you the certificate is not trusted.
- **`SET search_path` without `LOCAL`.** The setting outlives the request on a pooled connection and the next tenant reads it.
- **Injecting `PG_POOL` into a controller.** Nothing then sits between HTTP input and SQL.
- **A second pool for background jobs in the same process.** Two pools of ten is twenty connections; size one pool instead.

## Related topics

- [Connections and DI](connections-and-di.md) — the provider, the token and the lifecycle hook in full.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the driver itself: `Pool` vs `Client`, type parsers, `LISTEN/NOTIFY`, the complete error-code table.
- [Transactions](transactions.md) — checking out a client and passing it down the service chain.
- [Connection pooling](connection-pooling.md) — sizing `max`, pool metrics and poolers.
- [Retries and timeouts](retries-and-timeouts.md) — `statement_timeout`, `AbortSignal.timeout()` and which SQLSTATEs are worth retrying.
- [Migrations](migrations.md) — the DDL role, and why the app role must not own the schema.
- [SQL injection](../nestjs-security/sql-injection.md) — the exploit, the fix and the regression test.
- [Configuration](../nestjs/configuration.md) — `registerAs`, `ConfigService` and Standard Schema validation.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — how `BaseExceptionFilter` composes with the global filter.
- [Raw drivers](../nestjs-orms/raw-drivers.md) — when a driver plus a repository beats an ORM.
- [Health checks](health-checks.md) — a readiness probe that uses this pool without exhausting it.
