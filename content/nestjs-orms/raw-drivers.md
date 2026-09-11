---
title: Raw drivers
description: When an ORM is the wrong tool inside Nest — reporting queries, bulk operations and exact plan control — and how to wire a pg Pool as a provider with parameterised queries, typed rows and a clean shutdown.
status: current
updated: 2026-09-11
---

An ORM is a trade: it buys you type safety, migrations and relation loading, and it charges you a query language that is narrower than SQL. For most of an application that is a good trade. For reporting, for bulk work, and for anything where you need to control the plan, it is not — and the answer is not to fight the ORM, it is to drop to the driver for those paths and keep the ORM for the rest. This page is about doing that inside Nest without giving up the container.

Verified versions: **`pg` 8.23.0**, **`mysql2` 3.24.4**, **`better-sqlite3` 13.0.3**. The `pg` provider in full — typed config, SQLSTATE mapping, schema-per-tenant — is in [PostgreSQL](../nestjs-databases/postgresql.md); this page is about when to reach for it and how it coexists with an ORM.

:::note How the examples are written
Nest's constructor injection is usually written with the parameter-property shorthand, `constructor(private readonly db: PgService) {}`. The snippets here declare the field and assign it, because the site's snippet checker type-strips every `ts` block. The two forms are equivalent — use the shorthand in your own code.
:::

## When an ORM is the wrong tool

### Reporting queries

Window functions, recursive CTEs, `GROUP BY ROLLUP`, `LATERAL` joins, `DISTINCT ON`, `FILTER (WHERE …)` aggregates. Every query API in this section either cannot express these or expresses them through a raw escape hatch — at which point you have the raw string plus the ORM's ceremony around it.

```sql
-- Rolling 7-day active users per plan, with the previous week's figure.
-- There is no useful ORM formulation of this.
WITH daily AS (
  SELECT date_trunc('day', e.occurred_at) AS day,
         u.plan,
         count(DISTINCT e.user_id)        AS actives
    FROM events e
    JOIN users u ON u.id = e.user_id
   WHERE e.occurred_at >= $1
   GROUP BY 1, 2
)
SELECT day,
       plan,
       sum(actives) OVER (PARTITION BY plan ORDER BY day
                          ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_7d,
       lag(actives, 7) OVER (PARTITION BY plan ORDER BY day)        AS same_day_last_week
  FROM daily
 ORDER BY plan, day
```

The honest version of "we use Prisma" is "we use Prisma for the CRUD surface and a `pg` pool for eleven reporting queries", and that is a better codebase than one where those eleven queries are `$queryRaw` calls pretending to be part of the model layer.

### Bulk operations

Per-row ORM calls cost a round trip and an object allocation each. A single statement does not.

| Job | ORM shape | Driver shape |
| --- | --- | --- |
| Import 200k rows | 200k `create()` calls | `COPY … FROM STDIN` (Postgres) or `LOAD DATA` (MySQL) |
| Upsert 5k rows | 5k `upsert()` calls | one multi-row `INSERT … ON CONFLICT DO UPDATE` |
| Delete by predicate | fetch, then delete each | one `DELETE … WHERE` |
| Backfill a column | read-modify-write loop | one `UPDATE … FROM` |

The gap is one to two orders of magnitude, and it is not an optimisation you tune into — it is a different statement.

### Exact plan control

`SET LOCAL work_mem`, `MATERIALIZED` / `NOT MATERIALIZED` CTE fencing, `FOR UPDATE SKIP LOCKED` on a queue table, an index hint on MySQL, a deliberate `OFFSET`-free keyset pagination. These are instructions to the database. No ORM surfaces all of them, and the ones it does surface it surfaces partially.

### A service that is small enough

A service with a dozen well-understood queries does not need a schema file, a generated client, a migration tool bound to that client, and a major version to keep pinned. A repository class over a pool is less code and has no upgrade path to manage.

### When *not* to drop to the driver

- **Ordinary CRUD.** Hand-writing `INSERT`/`UPDATE` for twenty tables is how column lists go stale.
- **Anything whose shape changes often.** No compiler checks your row interfaces against the database.
- **Because one query was awkward.** Use the ORM's raw escape hatch for one query; add a driver repository when there is a *category* of them.

## The provider

The shape is the one in [Connections and DI](../nestjs-databases/connections-and-di.md): a token, a `useFactory`, and a class that owns the lifecycle.

```ts title="src/database/pg.tokens.ts"
export const PG_POOL = Symbol('PG_POOL')
```

A `Symbol` rather than `'DATABASE'`: two libraries can export the same string and cannot export the same symbol. Keeping the token in a file with no other imports means importing it never drags `pg` into a module that does not need it.

```ts title="src/database/database.module.ts"
import { Global, Logger, Module } from '@nestjs/common'
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
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: config.get<number>('DB_POOL_MAX') ?? 10,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          statement_timeout: 10_000,
          application_name: 'api-reports',
        })
        pool.on('error', (err) => new Logger('PgPool').error(`idle client: ${err.message}`))
        return pool
      },
    },
    PgService,
  ],
  exports: [PgService],
})
export class DatabaseModule {}
```

`application_name` is the cheapest operational win on this page: it shows up in `pg_stat_activity`, so when a query is holding a lock you know which service opened it.

```ts title="src/database/pg.service.ts"
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { PG_POOL } from './pg.tokens.js'

@Injectable()
export class PgService implements OnModuleDestroy {
  private readonly logger = new Logger(PgService.name)
  private readonly pool: Pool

  constructor(
    @Inject(PG_POOL)
    pool: Pool,
  ) {
    this.pool = pool
  }

  /** The only way this service will let you build a statement: text + params. */
  query<T extends QueryResultRow>(text: string, params: readonly unknown[] = []) {
    return this.pool.query<T>(text, params as unknown[])
  }

  /** For a transaction or anything that needs one connection for several statements. */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await fn(client)
    } finally {
      // Without this, one connection leaks per call and every endpoint
      // eventually hangs.
      client.release()
    }
  }

  /** Escape hatch for a cursor or a stream, where the lifetime is not a call. */
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

:::danger `onModuleDestroy` only runs if you asked for it
`app.enableShutdownHooks()` in `main.ts` is not on by default. Without it `SIGTERM` kills the process, `pool.end()` is never called, and every rolling deploy severs in-flight queries mid-statement. [Graceful shutdown](../nestjs-production/graceful-shutdown.md).
:::

`withClient` is worth having rather than exposing `connect()` directly: it makes `release()` structural instead of a thing every caller remembers. A leaked `PoolClient` is the one way a Nest app runs out of connections by hand, and the symptom — every endpoint hanging, including ones that never touch the database — looks nothing like the cause. [Connection pooling](../nestjs-databases/connection-pooling.md).

## The repository

Raw SQL belongs in a repository provider, not in a service and never in a controller. That gives you one file per aggregate where the statements live, one place to review when a column changes, and one thing to fake in a test.

```ts title="src/reports/reports.repository.ts"
import { Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

/** The row shape this repository promises. Nothing checks it against the
 *  database — that is the trade, and it is why the repository is one file. */
export interface ActiveUsersRow {
  day: Date
  plan: string
  rolling_7d: string
  same_day_last_week: string | null
}

@Injectable()
export class ReportsRepository {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  async activeUsers(since: Date, plans: readonly string[]): Promise<ActiveUsersRow[]> {
    const { rows } = await this.db.query<ActiveUsersRow>(
      `WITH daily AS (
         SELECT date_trunc('day', e.occurred_at) AS day,
                u.plan,
                count(DISTINCT e.user_id)        AS actives
           FROM events e
           JOIN users u ON u.id = e.user_id
          WHERE e.occurred_at >= $1
            AND u.plan = ANY($2::text[])
          GROUP BY 1, 2
       )
       SELECT day, plan,
              sum(actives) OVER (PARTITION BY plan ORDER BY day
                                 ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_7d,
              lag(actives, 7) OVER (PARTITION BY plan ORDER BY day)        AS same_day_last_week
         FROM daily
        ORDER BY plan, day`,
      [since, plans],
    )
    return rows
  }
}
```

Three things about that statement.

**Every value is a placeholder.** `$1` is a date, `$2` is a string array. The statement text is a constant — it is the same string on every request, which is also why `pg_stat_statements` can aggregate it usefully.

**`= ANY($2::text[])` is one placeholder taking an array.** There is no way to expand an array into an `IN (…)` list with placeholders, and building `IN ('a','b')` by joining strings is an injection hole. `= ANY` is the answer, and the cast helps the planner and makes an empty array unambiguous.

**Counts come back as strings.** `count()` is `bigint` in Postgres and `pg` returns `bigint` as a string to avoid losing precision. Typing the row as `string` is honest; typing it as `number` is a lie that surfaces as `"12" + 1 === "121"` in a chart.

## Coexisting with an ORM

The usual arrangement is one ORM owning the schema and the CRUD surface, plus raw SQL for the paths above. Two rules make it work.

**One tool owns the schema.** Migrations come from the ORM (or from plain `.sql` files), never from both. Two migration sources of truth is a guaranteed drift.

**Prefer one pool.** `max` × replica count is your real connection count, and a second pool doubles it. How you share depends on the ORM:

| ORM | Reaching the driver without a second pool |
| --- | --- |
| [TypeORM](./typeorm.md) | `dataSource.query('… $1', [v])` — runs on the DataSource's pool |
| [Prisma](./prisma.md) | `` $queryRaw`…` `` — runs on the adapter's pool |
| [Drizzle](./drizzle.md) | You constructed the `pg` `Pool` yourself; inject the same token |
| [Mongoose](./mongoose.md) | `connection.db.command(…)` and `Model.collection` use the same connection |

A separate pool is justified when the workload genuinely differs — a reporting pool with `max: 2`, a long `statement_timeout` and a distinct `application_name` protects the request path from a report that scans a year of events. That is a deliberate isolation decision, not a default.

```ts title="src/reports/reports.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { Pool } from 'pg'
import { ReportsRepository } from './reports.repository.js'

export const REPORTING_POOL = Symbol('REPORTING_POOL')

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REPORTING_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          // A read replica, a tiny pool, and a long statement timeout: a slow
          // report can never starve the request path of connections.
          connectionString: config.getOrThrow<string>('REPORTING_DATABASE_URL'),
          max: 2,
          connectionTimeoutMillis: 2_000,
          statement_timeout: 120_000,
          application_name: 'api-reports',
        }),
    },
    ReportsRepository,
  ],
  exports: [ReportsRepository],
})
export class ReportsModule {}
```

A read replica lags, so a write followed by a read on the replica can legitimately return the old row. Route only queries that tolerate staleness there.

## Bulk work

### Multi-row insert with a parameterised VALUES list

The placeholder list is generated from the **array length**, never from the data, so nothing user-controlled reaches the statement text:

```ts title="src/events/events.repository.ts"
import { Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

export interface NewEvent {
  userId: number
  kind: string
  occurredAt: Date
}

@Injectable()
export class EventsRepository {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  async insertMany(events: readonly NewEvent[]): Promise<number> {
    if (events.length === 0) return 0

    // ($1,$2,$3),($4,$5,$6),… — derived from events.length alone.
    const tuples = events
      .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
      .join(', ')
    const params = events.flatMap((e) => [e.userId, e.kind, e.occurredAt])

    // lint-sql:allow `tuples` is a placeholder list generated from the array length; every value is bound
    const text = `INSERT INTO events (user_id, kind, occurred_at) VALUES ${tuples}
                  ON CONFLICT DO NOTHING`

    const result = await this.db.query(text, params)
    return result.rowCount ?? 0
  }
}
```

Two caveats. Postgres caps a statement at **65535 bind parameters**, so chunk the input — at three columns per row that is about 21,000 rows per statement, and a few thousand is a better batch size anyway. And the statement text varies with the batch size, which fragments `pg_stat_statements`; chunking to a fixed size fixes that too.

### Streaming a large export

Loading a million rows into memory to write a CSV is how a pod gets OOM-killed. Page through the table by key instead — **keyset pagination**, which is fully parameterised, holds no connection between batches, and does not pin a snapshot the way a cursor does:

```ts title="src/exports/exports.service.ts"
import { Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

@Injectable()
export class ExportsService {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  /** Yields rows in bounded batches. Each batch is its own short query. */
  async *streamEvents(since: Date, batchSize = 1_000) {
    let lastId = 0
    for (;;) {
      const { rows } = await this.db.query<{ id: number; user_id: number; kind: string }>(
        `SELECT id, user_id, kind
           FROM events
          WHERE occurred_at >= $1 AND id > $2
          ORDER BY id
          LIMIT $3`,
        [since, lastId, batchSize],
      )
      if (rows.length === 0) return
      yield rows
      lastId = rows[rows.length - 1].id
    }
  }
}
```

`id > $2 ORDER BY id LIMIT $3` uses the primary-key index for every page, so the thousandth batch costs the same as the first — unlike `OFFSET`, which makes the database count and discard everything before it.

The alternative is a server-side cursor, and it has a cost worth knowing: a cursor lives inside a transaction, so a long export holds a connection **and** pins a snapshot that blocks vacuum for its whole duration. Keyset pagination gives up the consistent snapshot (rows written mid-export may or may not appear) and gets both of those back. Pick deliberately.

Either way, bound it: a `statement_timeout`, a hard row cap, and the reporting pool above rather than the request pool. If the export can be asynchronous, put it behind a queue — [Background jobs with BullMQ](../nestjs-libraries/bullmq.md).

### Transactions

Same rule as every other page in this section: everything inside the unit of work goes through the handle the callback gives you.

```ts title="src/billing/transfer.repository.ts"
async transfer(fromId: number, toId: number, cents: number) {
  return this.db.withClient(async (client) => {
    await client.query('BEGIN')
    try {
      const debited = await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
        [cents, fromId],
      )
      if (debited.rowCount === 0) throw new Error('insufficient funds')

      await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [cents, toId])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  })
}
```

The conditional `UPDATE` does the check and the arithmetic in one statement, so two concurrent transfers cannot both spend the last cent. Isolation levels, deadlock retries and spanning services are in [Transactions](../nestjs-databases/transactions.md).

## Other drivers

```ts title="src/database/mysql.service.ts"
// mysql2 3.24.4 — `?` placeholders, values array, promise API
import mysql from 'mysql2/promise'

const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10 })
const [rows] = await pool.execute('SELECT id, email FROM users WHERE id = ?', [id])
```

`execute()` uses a real prepared statement; `query()` does client-side escaping and is what you need for `IN (?)` array expansion, because a prepared statement cannot expand one placeholder into a list. Know which one you called.

```ts title="src/database/sqlite.service.ts"
// better-sqlite3 13.0.3 — synchronous, so no pool and no connection to release
import Database from 'better-sqlite3'

const db = new Database(process.env.SQLITE_PATH ?? 'data.db')
const row = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id)
```

SQLite is synchronous and in-process, so an N+1 costs microseconds rather than round trips, and there is no pool to size — but a slow statement blocks the event loop for every request. Prefer `node:sqlite` where you can; see [SQLite](../nestjs-databases/sqlite.md).

## Security considerations

### Placeholders, always

The whole security story of a raw driver is one rule: **the statement text is a constant and every value is a bind parameter.** A parameter is sent to the server separately from the SQL and can never be parsed as syntax, whatever it contains.

```ts vulnerable title="DO NOT COPY — src/users/users.repository.ts"
// GET /users?email=x'%20OR%20'1'%3D'1
async findByEmail(email: string) {
  const { rows } = await this.db.query(
    `SELECT id, email, password_hash FROM users WHERE email = '${email}'`,
  )
  return rows[0] ?? null
}
```

That returns every user, hash included.

```ts good title="src/users/users.repository.ts"
async findByEmail(email: string) {
  const { rows } = await this.db.query<{ id: number; email: string }>(
    'SELECT id, email FROM users WHERE email = $1',
    [email],
  )
  return rows[0] ?? null
}
```

The placeholder syntax is the driver's: `$1` for `pg`, `?` for `mysql2` and `better-sqlite3`. There is no version of "escape it first" that is as good, and the `pg` API makes the safe form shorter than the unsafe one.

Pair it with the global `ValidationPipe` so `email` is a validated string before the repository runs. A validated DTO and a bind parameter are two independent controls; a mistake in one is then not a breach.

### What parameterisation does not cover

Bind parameters are **value slots**. Table names, column names, `ORDER BY` targets and `LIMIT` direction keywords are syntax, so no placeholder can carry them. Validate against an allow-list you wrote, and mark the line so the linter knows you did.

```ts good title="src/reports/reports.repository.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { PgService } from '../database/pg.service.js'

// Module scope: a fixed map from the public sort key to the real column, and a
// fixed set of directions. The request picks; it never supplies.
const SORT_COLUMNS = new Map([
  ['created_at', 'o.created_at'],
  ['total', 'o.total_cents'],
])
const SORT_DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])

@Injectable()
export class OrdersRepository {
  private readonly db: PgService

  constructor(db: PgService) {
    this.db = db
  }

  async list(sort: string, dir: string, limit: number, tenantId: number) {
    const column = SORT_COLUMNS.get(sort)
    const direction = SORT_DIRECTIONS.get(dir)
    if (!column || !direction) throw new BadRequestException('Invalid sort')

    // lint-sql:allow column and direction are literals from the maps above; limit and tenant are bound
    const text = `SELECT o.id, o.total_cents, o.created_at
                    FROM orders o
                   WHERE o.tenant_id = $1
                   ORDER BY ${column} ${direction}
                   LIMIT $2`

    const { rows } = await this.db.query(text, [tenantId, limit])
    return rows
  }
}
```

The interpolated values are strings *you* wrote, looked up by a key the caller supplied. The caller can pick between two columns and two directions and can never add a third. `LIMIT` and the tenant stay real bind parameters.

The same rule covers a dynamic table name: a `Set` you control, checked before the interpolation, with the marker on the line. Never a regex "sanitiser" — an allow-list enumerates what is permitted, a denylist enumerates what somebody thought of.

### Error messages disclose your schema

A raw `pg` error carries the constraint name, the table, sometimes the offending value. Forwarded to a client, that is free schema reconnaissance. Map SQLSTATE codes to HTTP in one exception filter — `23505` to 409, `23503` to 409, `22P02` to 400 — and log the detail rather than returning it. [PostgreSQL](../nestjs-databases/postgresql.md) has the filter.

### Bulk paths bypass your controls

This is the failure mode specific to this page. Validation pipes, guards, soft-delete filters, tenant scoping and audit hooks all live on the CRUD path. A bulk `UPDATE` written straight against the driver has none of them unless you put them there:

- **Tenancy belongs in the `WHERE` clause**, in every statement, including the reporting ones. A report that omits `tenant_id` is a cross-tenant disclosure that looks like a chart.
- **Authorization is not inherited.** The ORM path may filter by owner; your statement does not until you write it.
- **Soft deletes are not inherited either.** A repository that forgets `deleted_at IS NULL` resurrects rows users believe are gone.

### Least privilege still applies

The application connects with a role that can read and write rows, not change the schema. DDL belongs to the migration job's role. With raw SQL in the codebase that control matters more, not less — it is what keeps an injection you missed from becoming a `DROP TABLE`. [Migrations](../nestjs-databases/migrations.md).

Full threat model with exploits and verification: [SQL injection](../nestjs-security/sql-injection.md).

## Production considerations

**`app.enableShutdownHooks()`**, or `pool.end()` never runs and every deploy cuts live queries.

**`release()` in a `finally`, always.** Wrapping it in a `withClient` helper is the only reliable way; a leaked client is the one way a Nest app exhausts its own pool by hand.

**Handle the pool's `error` event.** `pg` emits `'error'` for idle clients the server disconnected. Unhandled, that is an uncaught exception and a dead process.

**Set `connectionTimeoutMillis` and `statement_timeout`.** The `pg` acquisition default is wait-forever; a server-side statement timeout is the only bound that survives a code path nobody wrapped. [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md).

**Set `application_name`.** It costs nothing and turns `pg_stat_activity` from a list of anonymous sessions into a list of services.

**Expose `totalCount`, `idleCount`, `waitingCount` as metrics.** `waiting > 0` is the difference between "the database is slow" and "the pool is too small", and it takes twenty minutes to work out without them.

**Isolate the reporting workload.** A small pool against a replica with a long `statement_timeout` keeps one analytical query from starving the request path.

**Enable `pg_stat_statements` and read it weekly.** Constant statement text is what makes it useful, which is another reason values must be parameters rather than inlined.

**Chunk bulk statements.** The 65535-parameter cap is a hard error, and a fixed chunk size keeps `pg_stat_statements` aggregation intact.

**Write the health indicator.** There is no Terminus indicator for a bare pool; a `SELECT 1` through `HealthIndicatorService` is fifteen lines, and it goes in readiness, not liveness. [Health checks](../nestjs-databases/health-checks.md).

**Keep the row interfaces next to the statement.** Nothing checks them against the database, so the only defence is that they are reviewed together — and an integration test that actually runs the query. [Database fixtures](../nestjs-testing/database-fixtures.md).

## Common mistakes

- **Interpolating a value into the statement text.** `$1`, `?`, always. There is no exception.
- **Building an `IN` list with `join(',')`.** Use `= ANY($1::int[])` on Postgres, or `query()` with a nested array on `mysql2`.
- **Forgetting `client.release()`.** One leaked connection per call; every endpoint eventually hangs.
- **Injecting the `Pool` into a controller.** Nothing then sits between an HTTP handler and SQL.
- **Raw SQL scattered through services.** Put it in a repository provider, one file per aggregate.
- **Typing a `count()` result as `number`.** `pg` returns `bigint` as a string.
- **Forwarding driver errors to the client.** They name your tables, columns and constraints.
- **Omitting the tenant or owner filter in a reporting query.** The ORM path had it; yours does not.
- **Assuming soft deletes apply.** A driver query sees deleted rows unless you exclude them.
- **A second pool by accident.** `max` × replicas × pools is your real connection count.
- **A cursor export with no timeout or row cap.** It holds a connection and blocks vacuum.
- **Exceeding the 65535-parameter cap** on a large multi-row insert.
- **Calling `execute()` on `mysql2` and expecting `IN (?)` to expand.** That is `query()`.
- **No `'error'` listener on the pool.** One idle-client disconnect takes the process down.
- **Hand-writing CRUD for twenty tables** because one reporting query was awkward.

## Related topics

- [PostgreSQL](../nestjs-databases/postgresql.md) — the `pg` provider in full: typed config, SQLSTATE mapping, schema-per-tenant.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — tokens, `useFactory`, `inject` and provider lifecycles.
- [Choosing an ORM](./choosing-an-orm.md) — when no ORM is the right answer for a whole service.
- [Comparison table](./comparison.md) — raw drivers scored against the four ORMs.
- [Repository vs active record](./repository-vs-active-record.md) — why the SQL lives in a repository provider.
- [Avoiding N+1](./avoiding-n-plus-one.md) — `= ANY($1)` batching and detection with `pg_stat_statements`.
- [Transactions](../nestjs-databases/transactions.md) — `BEGIN`/`COMMIT` across services, deadlock retries and isolation.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — sizing, leak detection and the pool counters.
- [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md) — `statement_timeout` and bounding a query storm.
- [SQLite](../nestjs-databases/sqlite.md) — the synchronous case, and `node:sqlite`.
- [SQL injection](../nestjs-security/sql-injection.md) — the threat the placeholder rule exists for.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the driver itself, outside any framework.
- [N+1 queries](../databases/n-plus-one-queries.md) — the batching patterns in plain Node.
