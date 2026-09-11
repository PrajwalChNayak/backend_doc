---
title: MySQL
description: The mysql2 promise pool as a Nest provider — ConfigService-driven options, execute with ? placeholders, mapping MySQL error codes to HttpExceptions, and ending the pool on shutdown.
status: current
updated: 2026-09-11
---

`mysql2` gives you a pool with its own `end()`, its own error codes and a prepared-statement cache. Inside Nest all three become lifecycle concerns the container can manage for you. The driver detail — `execute` versus `query`, type coercion flags, charset, `LAST_INSERT_ID()` — is in [MySQL with mysql2](../databases/mysql-with-mysql2.md); this page covers only the wiring.

## Installing

```bash
npm install mysql2@3.24.4
```

Always import from `mysql2/promise`. The root export is the callback API, and mixing the two in one codebase produces methods that return `undefined` where you expected a promise.

## The pool provider

```ts title="src/database/mysql.tokens.ts"
export const MYSQL_POOL = Symbol('MYSQL_POOL')
```

```ts title="src/database/database.module.ts"
import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { createPool } from 'mysql2/promise'
import { MYSQL_POOL } from './mysql.tokens.js'
import { MysqlService } from './mysql.service.js'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MYSQL_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createPool({
          uri: config.getOrThrow<string>('DATABASE_URL'),
          connectionLimit: config.get<number>('database.poolMax') ?? 10,
          waitForConnections: true,
          queueLimit: 0,
          connectTimeout: 5_000,
          enableKeepAlive: true,
          keepAliveInitialDelay: 10_000,
          namedPlaceholders: true,
          timezone: 'Z',
          decimalNumbers: false,
        }),
    },
    MysqlService,
  ],
  exports: [MysqlService],
})
export class DatabaseModule {}
```

The options that change behaviour rather than performance:

| Option | Why it is set this way |
| --- | --- |
| `waitForConnections: true` | A borrow request queues instead of throwing instantly when the pool is full. |
| `queueLimit: 0` | Unbounded queue. Bound it (e.g. `100`) if you would rather shed load than queue — then a full pool is a fast 503. |
| `enableKeepAlive: true` | Managed MySQL and most load balancers drop idle TCP connections silently; without keepalive the first query after a quiet period fails. |
| `namedPlaceholders: true` | Enables `:name` placeholders alongside `?`. Both are still parameters. |
| `timezone: 'Z'` | Without it the driver converts `DATETIME` using the *server process's* local zone, so the same row reads differently on a laptop and in a container. |
| `decimalNumbers: false` | The default. `DECIMAL` arrives as a string, which is correct — turning it on silently loses precision on money columns. |

:::warning `multipleStatements` stays off
`multipleStatements: true` lets one call run several statements separated by `;`. It also turns every parameterised query into a potential injection point, because a value that escapes its quoting can then append a whole second statement rather than just distorting one. Leave it `false` (the default). If a migration tool needs it, give that tool its own connection — not the application pool.
:::

## The service and the shutdown hook

```ts title="src/database/mysql.service.ts"
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { MYSQL_POOL } from './mysql.tokens.js'

@Injectable()
export class MysqlService implements OnModuleDestroy {
  private readonly logger = new Logger(MysqlService.name)
  private readonly pool: Pool

  constructor(@Inject(MYSQL_POOL) pool: Pool) {
    this.pool = pool
    this.pool.on('connection', () => this.logger.debug('mysql connection opened'))
  }

  async select<T extends RowDataPacket>(sql: string, params: readonly unknown[] | object = []) {
    const [rows] = await this.pool.execute<T[]>(sql, params as never)
    return rows
  }

  async write(sql: string, params: readonly unknown[] | object = []) {
    const [result] = await this.pool.execute<ResultSetHeader>(sql, params as never)
    return result
  }

  getConnection(): Promise<PoolConnection> {
    return this.pool.getConnection()
  }

  async onModuleDestroy() {
    // Waits for in-flight queries, then closes every connection.
    await this.pool.end()
  }
}
```

`pool.end()` is a promise in `mysql2/promise`; awaiting it inside `onModuleDestroy` is what makes Nest wait for it. It only runs at all if `main.ts` calls `app.enableShutdownHooks()`.

## execute, not query

```ts title="src/orders/orders.repository.ts"
import { Injectable } from '@nestjs/common'
import type { RowDataPacket } from 'mysql2/promise'
import { MysqlService } from '../database/mysql.service.js'

export interface OrderRow extends RowDataPacket {
  id: number
  user_id: number
  status: string
  total_cents: number
}

@Injectable()
export class OrdersRepository {
  private readonly db: MysqlService

  constructor(db: MysqlService) {
    this.db = db
  }

  findById(id: number) {
    return this.db.select<OrderRow>(
      'SELECT id, user_id, status, total_cents FROM orders WHERE id = ?',
      [id],
    )
  }

  findForUser(userId: number, status: string, limit: number) {
    return this.db.select<OrderRow>(
      'SELECT id, user_id, status, total_cents FROM orders WHERE user_id = :userId AND status = :status ORDER BY id DESC LIMIT :limit',
      { userId, status, limit },
    )
  }

  async create(userId: number, totalCents: number) {
    const result = await this.db.write(
      'INSERT INTO orders (user_id, status, total_cents) VALUES (?, ?, ?)',
      [userId, 'pending', totalCents],
    )
    return result.insertId
  }
}
```

`execute` prepares the statement on the server and sends the values separately, so a value can never become syntax. `query` interpolates client-side using the driver's escaping — safer than string concatenation, but it is still one escaping bug away from injection and it gives up the statement cache. Use `execute` everywhere; reach for `query` only for the handful of statements MySQL refuses to prepare (`SET`, some `SHOW` forms), and then with no user input in them at all.

Named placeholders work the same way — `:userId` is substituted by the driver as a bound parameter, not pasted into the text. They are worth turning on once a statement has more than three `?`, where positional arguments become a counting exercise.

:::danger The shape that gets people breached
```ts vulnerable title="DO NOT COPY — src/orders/orders.repository.ts"
findForUser(userId: string, status: string) {
  return this.db.select(
    `SELECT id, total_cents FROM orders WHERE user_id = ${userId} AND status = '${status}'`,
  )
}
```

`userId` arriving as `1 UNION SELECT id, password_hash FROM users` returns every password hash in the table through an endpoint that looks like an order list. `@IsNumberString()` on the DTO narrows the payload space; it does not close the hole, because the next refactor removes the decorator and nothing fails.
:::

## Mapping MySQL errors onto HTTP

`mysql2` errors carry a string `code` and a numeric `errno`. Match on `code` — it is stable across versions and readable in a diff.

```ts title="src/database/mysql-exception.filter.ts"
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

interface MysqlError extends Error {
  code?: string
  errno?: number
  sqlState?: string
}

const MAP: Record<string, () => HttpException> = {
  ER_DUP_ENTRY: () => new ConflictException('That value is already taken'),
  ER_NO_REFERENCED_ROW_2: () => new UnprocessableEntityException('Referenced record does not exist'),
  ER_ROW_IS_REFERENCED_2: () => new ConflictException('Record is still referenced'),
  ER_LOCK_DEADLOCK: () => new ConflictException('Concurrent update, please retry'),
  ER_LOCK_WAIT_TIMEOUT: () => new ConflictException('Concurrent update, please retry'),
  ER_DATA_TOO_LONG: () => new UnprocessableEntityException('Value is too long'),
}

@Catch()
export class MysqlExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(MysqlExceptionFilter.name)

  catch(error: unknown, host: ArgumentsHost) {
    const code = (error as MysqlError)?.code
    const factory = code ? MAP[code] : undefined
    if (!factory) return super.catch(error, host)

    // error.sqlMessage names the constraint and often the value. Log only.
    this.logger.warn(`mysql ${code}: ${(error as Error).message}`)
    super.catch(factory(), host)
  }
}
```

`ER_LOCK_DEADLOCK` (errno 1213) and `ER_LOCK_WAIT_TIMEOUT` (errno 1205) are not application bugs — they are normal outcomes under concurrency and the correct response is a retry of the whole transaction. Returning 409 is the fallback after the retries are exhausted. [Transactions](transactions.md) has the retry loop.

## What differs from PostgreSQL

Two defaults will bite a team that develops on one and deploys on the other.

| | PostgreSQL | MySQL (InnoDB) |
| --- | --- | --- |
| Default isolation | read committed | **repeatable read** |
| Placeholder | `$1` | `?` or `:name` |
| Returning the inserted row | `RETURNING` | a second `SELECT`, or `result.insertId` |
| Case sensitivity of identifiers | folded to lower case | depends on the filesystem and `lower_case_table_names` |
| Unique violation | SQLSTATE `23505` | `ER_DUP_ENTRY` |
| Statement timeout | `statement_timeout` on the connection | `max_execution_time` (SELECT only), or a per-query `MAX_EXECUTION_TIME` hint |

The isolation difference is the dangerous one: the same `SELECT` run twice inside one transaction can return different rows on Postgres and cannot on MySQL. Code written against one and deployed on the other will surprise you. See [Transactions](../databases/transactions.md).

The timeout difference matters for [Retries and timeouts](retries-and-timeouts.md): MySQL has no connection-wide bound that covers writes, so a slow `UPDATE` is bounded by `innodb_lock_wait_timeout` and your own `AbortSignal`, not by a single server setting.

## Security considerations

**`?` and `:name` for every value, `execute` for every statement.** The parameter never joins the statement text. Nothing about a class-validator decorator on the DTO changes that requirement.

**Keep `multipleStatements` off.** It converts "an attacker can distort one query" into "an attacker can append arbitrary statements", which is the difference between a data leak and a schema rewrite.

**Grant the application user no DDL and no `FILE` privilege.** `FILE` allows `LOAD DATA INFILE` and `SELECT … INTO OUTFILE`, which turns an injection into arbitrary file read and write on the database host. It is not granted by default — verify that nobody granted it "to make the import work".

**Do not run the application as `root@%`.** A dedicated user, scoped to one schema, with `SELECT/INSERT/UPDATE/DELETE` only. Migrations use a different user — [Migrations](migrations.md).

**Never return `error.sqlMessage` to a client.** It contains the constraint name, the table and frequently the conflicting value, which is a schema dump plus a user-enumeration oracle on a unique email.

**Require TLS to a managed instance and verify the certificate.** `ssl: { rejectUnauthorized: false }` accepts any certificate presented, which is not transport security. Supply the provider's CA:

```ts
createPool({
  uri: config.getOrThrow<string>('DATABASE_URL'),
  ssl: { ca: config.getOrThrow<string>('DB_CA_CERT'), rejectUnauthorized: true },
})
```

**Set `charset` deliberately.** A mismatch between the connection charset and the column charset has historically been an injection vector, because a multi-byte sequence can swallow an escaping backslash. `utf8mb4` on both sides removes the question — and `utf8mb4` is also the only charset that stores the full Unicode range, so emoji and many CJK characters are a correctness issue too.

**Bound `queueLimit` on any public endpoint.** With `queueLimit: 0`, a burst of slow queries queues without limit and every request times out at the client instead of failing fast. A bounded queue turns a flood into 503s you can see.

## Production considerations

- **`app.enableShutdownHooks()`**, or `pool.end()` never runs and every deploy cuts connections mid-statement.
- **`enableKeepAlive: true`.** Managed MySQL closes idle connections without telling the client; the first request after a quiet period otherwise fails with `ECONNRESET`.
- **Size `connectionLimit` against `max_connections`.** Total is `connectionLimit` × replicas × processes. See [Connection pooling](connection-pooling.md).
- **Set `connectTimeout`.** The default is generous, and a slow DNS or security-group problem then presents as hung requests.
- **Keep `decimalNumbers: false` for money.** A `DECIMAL(12,2)` as a JavaScript number is a rounding bug you will find in an invoice.
- **Set `timezone: 'Z'` and store UTC.** Otherwise the same row renders differently depending on the container's `TZ`.
- **Watch the prepared-statement cache.** `execute` caches per connection; thousands of distinct statement shapes (a query built per filter combination) exhaust it and `max_prepared_stmt_count` on the server. Keep the shapes fixed and vary only the parameters.
- **Retry deadlocks, do not page on them.** A rising deadlock *rate* is the signal; each individual deadlock is expected.
- **Export pool metrics.** `mysql2` does not expose counters as richly as `pg`, so instrument borrow latency around `getConnection()` and alert on it.
- **Use the same MySQL major in CI as in production.** Behaviour around `sql_mode`, `ONLY_FULL_GROUP_BY` and JSON functions differs enough to matter.

## Common mistakes

- **Importing from `mysql2` instead of `mysql2/promise`.** You get the callback API and `await` resolves to `undefined`.
- **`query` with an interpolated value.** Client-side escaping is not parameterisation; use `execute`.
- **`multipleStatements: true` on the application pool.** One injection becomes arbitrary statement execution.
- **A module-level `createPool()`.** Built at import time, before config validation, invisible to shutdown hooks.
- **Forgetting `app.enableShutdownHooks()`.** `onModuleDestroy` never fires.
- **Leaving `timezone` unset.** Dates shift depending on the host's `TZ`.
- **`decimalNumbers: true` on a money column.** Silent precision loss.
- **Treating `ER_LOCK_DEADLOCK` as a 500.** It is a retry that almost always succeeds on the second attempt.
- **Returning `sqlMessage` in the response.** Schema disclosure and user enumeration.
- **Building an `IN` list by joining `?` into the string.** Pass the array to a `?` — `mysql2` expands it — or restructure the query.
- **Sharing one pool with a migration tool that needs `multipleStatements`.** Give the tool its own connection.
- **`connectionLimit` copied from a tutorial.** Ten per replica across twelve replicas is 120 connections before anything else connects.

## Related topics

- [MySQL with mysql2](../databases/mysql-with-mysql2.md) — the driver itself: `execute` vs `query`, the statement cache, charset, type coercion and the full error table.
- [Connections and DI](connections-and-di.md) — the provider pattern this page instantiates.
- [Transactions](transactions.md) — `beginTransaction` on a checked-out connection, and the deadlock retry loop.
- [Connection pooling](connection-pooling.md) — sizing `connectionLimit` and what `queueLimit` buys you.
- [Retries and timeouts](retries-and-timeouts.md) — bounding a MySQL query when there is no connection-wide statement timeout.
- [Migrations](migrations.md) — the separate DDL user and the deploy-pipeline step.
- [SQL injection](../nestjs-security/sql-injection.md) — the exploit and the regression test.
- [PostgreSQL](postgresql.md) — the same wiring for `pg`, with the differences called out.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — extending `BaseExceptionFilter` without losing Nest's response shape.
- [Configuration](../nestjs/configuration.md) — `registerAs` and validated environment variables.
