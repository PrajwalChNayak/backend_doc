---
title: SQLite
description: better-sqlite3 and node:sqlite as Nest providers — synchronous access inside an async framework, PRAGMAs applied in onModuleInit, prepared-statement caching, and where SQLite is and is not a production answer.
status: current
updated: 2026-09-11
---

SQLite is the odd one out in this section: there is no pool, no network, and the API is synchronous. That makes the Nest wiring simpler than any other driver and introduces exactly one new concern — a synchronous query blocks the event loop for every other request in the process. The engine itself, WAL mode, the single-writer model and the `PRAGMA` set are covered in [SQLite](../databases/sqlite.md); this page is about living with it inside a Nest application.

## Which library

| | `node:sqlite` | `better-sqlite3` 13.0.3 |
| --- | --- | --- |
| Install | built in from Node 22.5, stable enough to teach on 24 | native module, needs a compiler or a prebuilt binary |
| API | synchronous | synchronous |
| Statement cache | you keep the `StatementSync` | you keep the `Statement` |
| Extensions, backup API, user functions | limited | extensive |
| Docker image | nothing to add | a build stage or a matching prebuild |

Prefer `node:sqlite` when it covers what you need — a zero-dependency database in a Nest service is a genuinely good deal, and it removes a native build from your image. Reach for `better-sqlite3` when you need its backup API, custom SQL functions, or `WAL` checkpointing control. Both are used identically from a Nest provider, so switching later is a one-file change.

```bash
npm install better-sqlite3@13.0.3
npm install --save-dev @types/better-sqlite3
```

## The provider

There is no pool, so the provider is the database handle itself. It is still a singleton, still built from validated config, and still closed by a lifecycle hook.

```ts title="src/database/sqlite.tokens.ts"
export const SQLITE = Symbol('SQLITE')
```

```ts title="src/database/database.module.ts"
import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import Database from 'better-sqlite3'
import { SQLITE } from './sqlite.tokens.js'
import { SqliteService } from './sqlite.service.js'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SQLITE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Database(config.getOrThrow<string>('SQLITE_PATH'), {
          // Opening a missing file creates an empty database, which looks
          // like "all my data vanished" rather than a configuration error.
          fileMustExist: config.get<string>('NODE_ENV') === 'production',
          timeout: 5_000,
        }),
    },
    SqliteService,
  ],
  exports: [SqliteService],
})
export class DatabaseModule {}
```

`fileMustExist` deserves the conditional. In development you want the file created on first run; in production a typo in the path should be a boot failure, not a silently empty database serving 404s.

## PRAGMAs belong in onModuleInit

SQLite's defaults are tuned for an embedded device, not a server. Three of them have to be changed on every connection, and `onModuleInit` is the place — it runs after the handle exists and before any controller is reachable.

```ts title="src/database/sqlite.service.ts"
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { Database } from 'better-sqlite3'
import { SQLITE } from './sqlite.tokens.js'

@Injectable()
export class SqliteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqliteService.name)
  private readonly db: Database

  constructor(@Inject(SQLITE) db: Database) {
    this.db = db
  }

  onModuleInit() {
    // Readers no longer block the writer. Persistent — set once per file —
    // but harmless to repeat, and the repeat documents the requirement.
    this.db.pragma('journal_mode = WAL')
    // OFF by default. Without it a foreign key is a comment.
    this.db.pragma('foreign_keys = ON')
    // How long a writer waits for the lock before SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000')
    // WAL + NORMAL is the usual server trade: durable across process crashes,
    // can lose the last transactions on an OS crash or power loss.
    this.db.pragma('synchronous = NORMAL')

    const mode = this.db.pragma('journal_mode', { simple: true })
    this.logger.log(`sqlite ready (journal_mode=${String(mode)})`)
  }

  get handle(): Database {
    return this.db
  }

  onModuleDestroy() {
    this.db.close()
  }
}
```

`foreign_keys = ON` is the one people lose data to. It is off by default and it is a *per-connection* setting, so a foreign key declared in your schema does nothing until you turn it on — deletes cascade into nothing and orphan rows accumulate for months before anybody notices.

:::note node:sqlite instead
The same provider with the built-in module:

```ts title="src/database/sqlite.provider.ts"
import type { Provider } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DatabaseSync } from 'node:sqlite'
import { SQLITE } from './sqlite.tokens.js'

export const sqliteProvider: Provider = {
  provide: SQLITE,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new DatabaseSync(config.getOrThrow<string>('SQLITE_PATH')),
}
```

`DatabaseSync` exposes `exec()`, `prepare()` and `close()`, so `SqliteService` above needs only its `pragma()` calls rewritten as `this.db.exec('PRAGMA journal_mode = WAL')`.
:::

## Prepared statements as provider state

`prepare()` compiles a statement. Doing it on every request throws that work away, and it is the single easiest performance mistake in a SQLite service. Because a Nest provider is a singleton constructed once, it is the natural place to hold the compiled statements.

```ts title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import type { Statement } from 'better-sqlite3'
import { SqliteService } from '../database/sqlite.service.js'

export interface UserRow {
  id: number
  email: string
  display_name: string
}

@Injectable()
export class UsersRepository {
  private readonly byId: Statement<[number], UserRow>
  private readonly byEmail: Statement<[string], UserRow>
  private readonly insert: Statement<[string, string]>

  constructor(sqlite: SqliteService) {
    const db = sqlite.handle
    this.byId = db.prepare('SELECT id, email, display_name FROM users WHERE id = ?')
    this.byEmail = db.prepare('SELECT id, email, display_name FROM users WHERE email = ?')
    this.insert = db.prepare('INSERT INTO users (email, display_name) VALUES (?, ?)')
  }

  findById(id: number): UserRow | undefined {
    return this.byId.get(id)
  }

  findByEmail(email: string): UserRow | undefined {
    return this.byEmail.get(email)
  }

  create(email: string, displayName: string): number {
    const result = this.insert.run(email, displayName)
    return Number(result.lastInsertRowid)
  }
}
```

Preparing in the constructor also gives you a real boot-time check. SQLite compiles the statement against the live schema, so a typo in a column name fails the application start with a clear error instead of failing the one request that happens to call that method. The provider is constructed once, so the cost is paid once.

`?` placeholders, as everywhere. Named parameters (`@id`, `:id`, `$id`) work too and read better past three arguments — `stmt.get({ id })`.

## The synchronous problem

`better-sqlite3` and `node:sqlite` block the event loop while a statement runs. For a point lookup on an indexed column that is tens of microseconds and genuinely faster than an async driver, because there is no round trip and no scheduling. For a report query it is a hundred milliseconds during which your Nest process serves nobody — not the health endpoint, not the other tenant's request, nothing.

The consequences inside a Nest app:

- **Latency is additive, not concurrent.** Ten requests each doing a 20 ms query take 200 ms for the last one. There is no overlap to hide behind.
- **A liveness probe measuring event-loop delay will fire.** That is the probe working correctly; it is telling you the process is wedged. See [Health checks](health-checks.md).
- **Timeouts you set in an interceptor do not fire.** An RxJS `timeout()` operator cannot interrupt synchronous work — the timer callback cannot run until the statement finishes.

Three practical rules:

1. **Index everything you filter on.** `EXPLAIN QUERY PLAN` in front of every query in the repository; a `SCAN TABLE` line on a table that grows is a future outage.
2. **Never run an unbounded aggregate on a request path.** Precompute into a summary table, or move it to a worker process with its own read-only handle.
3. **Do not `await` anything between `prepare()` and `run()` inside a transaction.** The transaction is synchronous; yielding to the event loop in the middle of one lets another request interleave a write and you get `SQLITE_BUSY` at best.

```ts title="src/orders/orders.service.ts"
import { Injectable } from '@nestjs/common'
import { SqliteService } from '../database/sqlite.service.js'

@Injectable()
export class OrdersService {
  private readonly sqlite: SqliteService

  constructor(sqlite: SqliteService) {
    this.sqlite = sqlite
  }

  createOrder(userId: number, items: readonly { sku: string; qty: number }[]) {
    const db = this.sqlite.handle
    const insertOrder = db.prepare('INSERT INTO orders (user_id, status) VALUES (?, ?)')
    const insertItem = db.prepare('INSERT INTO order_items (order_id, sku, qty) VALUES (?, ?, ?)')

    // db.transaction() returns a synchronous function. Everything inside runs
    // to completion with no chance for another request to interleave.
    const run = db.transaction((uid: number, lines: readonly { sku: string; qty: number }[]) => {
      const orderId = Number(insertOrder.run(uid, 'pending').lastInsertRowid)
      for (const line of lines) insertItem.run(orderId, line.sku, line.qty)
      return orderId
    })

    return run(userId, items)
  }
}
```

The callback passed to `db.transaction()` **must not be `async`**. An `async` function returns a promise immediately, so `better-sqlite3` commits an empty transaction and your inserts land outside it. This is the SQLite version of the "repository used the pool instead of `tx`" bug.

## Where SQLite fits in a Nest service

It is a legitimate production choice when the whole application is one process with one writer: an internal tool, a single-tenant appliance, a CLI's state, an edge cache, a queue of outbound events. It stops being one the moment you run two replicas — SQLite over a network filesystem corrupts, and two processes on the same file serialise on a single writer lock with no coordination beyond `busy_timeout`.

That rules out most Kubernetes deployments and every serverless platform with more than one instance. It does not rule out the two places SQLite is unambiguously the right answer in a Nest codebase:

- **Tests.** A file-backed throwaway database per test file, or `:memory:`, with your real migrations applied. It is fast, isolated and needs no Docker — with the dialect caveats in [Testing with a database](testing-with-a-database.md).
- **Local development** for a service that will run on Postgres, *only* if you accept that you are testing a different database. The dialect differences are real and they do not surface until CI.

## Security considerations

**Parameterise, exactly as everywhere else.** SQLite parses SQL the same way Postgres does, and `stmt.get(id)` is the only correct form. The linter in this repository will reject a concatenated statement in a `ts` block, and the reason is that nothing about an embedded database makes injection less severe — the attacker is already inside your process's file system boundary.

**Injection reaches the file system.** `ATTACH DATABASE` in an injected statement lets an attacker open or create another database file, and `readfile()`/`writefile()` exist if the CLI extensions are loaded. Do not enable extension loading (`db.loadExtension`) on a handle that ever sees user-derived SQL, and keep the database file in a directory the process cannot write anything else into.

**The file is the entire security boundary.** There are no users, no roles and no `GRANT`. Anyone who can read the file has read every row, including password hashes. Set restrictive file permissions, and treat the containing volume as secret material — including backups and the `-wal` and `-shm` sidecar files, which contain recent transactions.

**Never serve the database file over HTTP.** A static-files middleware rooted at a directory that also holds `app.db` publishes your database. Keep the file outside any served path — see [Static files](../express/static-files.md).

**`PRAGMA` statements must never take user input.** They are not parameterisable, and several change durability or open files. Every `pragma()` call in your code should have a literal string argument.

**Encrypt at rest if the file leaves your host.** SQLite stores plaintext; a backup copied to object storage is a plaintext dump of your database. Encrypt the artifact, not just the transport.

## Production considerations

- **WAL mode, always**, on anything with concurrent readers. The default rollback journal blocks readers during a write.
- **`foreign_keys = ON` in `onModuleInit`.** It is per-connection and off by default.
- **`busy_timeout` of a few seconds.** Without it, a concurrent write is an immediate `SQLITE_BUSY` error rather than a short wait.
- **One writer.** If you add a worker process, give it a read-only handle (`readonly: true`) and route writes through the API process.
- **Back up with the online backup API or `VACUUM INTO`,** never `cp` on a live database — copying the main file without the `-wal` gives you a torn snapshot.
- **Checkpoint the WAL.** A long-running process with continuous reads can prevent automatic checkpointing, and the `-wal` file grows without bound. `PRAGMA wal_checkpoint(TRUNCATE)` on a schedule bounds it.
- **Measure event-loop delay.** It is the metric that tells you a query got slow, because request latency alone looks like general slowness.
- **Set `fileMustExist` in production.** A wrong path is otherwise a new empty database.
- **Do not put the file on NFS, EFS, or any network mount.** SQLite's locking assumptions do not hold and the failure mode is corruption.
- **`PRAGMA optimize` on shutdown** keeps the query planner's statistics current on a long-lived file.
- **Pin the `better-sqlite3` version to your Node major.** It is a native module; a Node upgrade without a rebuild produces `NODE_MODULE_VERSION` errors at boot.

## Common mistakes

- **Forgetting `PRAGMA foreign_keys = ON`.** Foreign keys silently do nothing.
- **`prepare()` inside the request handler.** Recompiling the statement every call; hold it on the provider.
- **An `async` callback passed to `db.transaction()`.** It commits immediately and the writes land outside the transaction.
- **`await` in the middle of a synchronous transaction.** Another request interleaves and you get `SQLITE_BUSY` or a torn unit of work.
- **Running two replicas against one file.** Serialised writes at best, corruption on a network filesystem.
- **An unbounded aggregate on a request path.** The whole process stops for the duration.
- **`cp app.db backup.db` on a live database.** The `-wal` file holds transactions the copy does not.
- **Assuming SQLite types match Postgres.** There are no real `BOOLEAN`, `DATE` or `NUMERIC` types; `1`/`0` and ISO strings are what you get. This is what makes SQLite-only tests miss bugs.
- **Leaving `fileMustExist` off in production.** A typo creates an empty database and the service answers 404 for everything.
- **Serving the directory that holds the database file.** The whole database is then a download.
- **Not closing on shutdown.** `onModuleDestroy` calling `db.close()` is what flushes and checkpoints cleanly.

## Related topics

- [SQLite](../databases/sqlite.md) — the engine: `node:sqlite`, WAL, the single-writer model, `BEGIN IMMEDIATE` and the full PRAGMA set.
- [Connections and DI](connections-and-di.md) — the provider pattern and the lifecycle hooks used here.
- [Testing with a database](testing-with-a-database.md) — throwaway SQLite versus a disposable Postgres, and where the dialects diverge.
- [Transactions](transactions.md) — the cross-service transaction problem, and why SQLite's synchronous transaction sidesteps most of it.
- [Migrations](migrations.md) — running the same migrations against SQLite in tests and Postgres in production.
- [Health checks](health-checks.md) — why event-loop delay is the liveness signal that matters here.
- [Choosing a database](../databases/choosing-a-database.md) — when embedded beats a server.
- [Raw drivers](../nestjs-orms/raw-drivers.md) — repositories over an ORM for a small, synchronous database.
- [Docker](../nestjs-production/docker.md) — building a native module into the image, or avoiding one with `node:sqlite`.
- [Static files](../express/static-files.md) — keeping the database file out of anything served.
