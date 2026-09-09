---
title: SQLite
description: Using node:sqlite and better-sqlite3 13.0.3 from Node 24, with WAL mode, foreign keys, busy timeouts and the single-writer model that decides where SQLite belongs.
status: current
updated: 2026-09-08
---

SQLite is a library, not a server. There is no connection pool, no socket, and no separate process — a query is a function call against a file on local disk. Node 24 ships a SQLite binding in core, so for many services the entire database dependency is now zero packages.

Full runnable version: [`examples/db-sqlite`](../../examples/db-sqlite/README.md).

## node:sqlite — start here

`node:sqlite` is built into Node. It is synchronous, requires no native build, and is available from Node 22.5 behind `--experimental-sqlite`, unflagged and stable enough to teach on Node 24.

```js title="src/db.js"
import { DatabaseSync } from 'node:sqlite'

export const db = new DatabaseSync('data/app.db')

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT
`)
```

```js title="src/users.repo.js"
import { db } from './db.js'

const selectById = db.prepare('SELECT id, email, name FROM users WHERE id = ?')
const insertUser = db.prepare('INSERT INTO users (email, name) VALUES (?, ?)')

export function findUserById(id) {
  return selectById.get(id) ?? null
}

export function createUser({ email, name }) {
  const info = insertUser.run(email, name)
  return { id: Number(info.lastInsertRowid), email, name }
}
```

Three methods on a prepared statement:

| Method | Returns |
| --- | --- |
| `.get(...params)` | The first row as an object, or `undefined` |
| `.all(...params)` | An array of row objects |
| `.run(...params)` | `{ changes, lastInsertRowid }` — for `INSERT`, `UPDATE`, `DELETE` |

Named parameters work too, and are far more readable past two arguments:

```js
const byTenant = db.prepare(
  'SELECT id, email FROM users WHERE tenant_id = :tenantId AND status = :status LIMIT :limit',
)

const rows = byTenant.all({ tenantId, status: 'active', limit: 50 })
```

Both the bare form (`{ tenantId }`) and the prefixed form (`{ ':tenantId': … }`) bind correctly.

:::danger Interpolation is injection here too
```js vulnerable title="DO NOT COPY"
const row = db.prepare(`SELECT * FROM users WHERE email = '${email}'`).get()
```
SQLite is embedded, not remote, which makes injection *worse*, not better — the attacker is executing SQL inside your process against your whole file, and `ATTACH DATABASE` can reach other files on the disk.
:::

```js good
const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
```

### It is synchronous — and that is usually fine

`DatabaseSync` blocks the event loop for the duration of each query. For a local-disk point lookup that is measured in microseconds, and it avoids an entire class of concurrency bug: there is no interleaving, no pool, no await between reading a row and writing it.

It stops being fine when a single statement does real work — a full table scan over a million rows, a large `GROUP BY`, a `VACUUM`. Those block every other request in the process. Keep analytical queries out of the request path, or run them in a `Worker` with its own `DatabaseSync` handle.

Also note that because it is synchronous, a repository function returns a value rather than a promise. Do not `await` it out of habit — `await` on a non-promise still defers to a microtask and costs you the simplicity you came for.

### Prepare once, reuse

`db.prepare()` compiles the SQL. Preparing inside a request handler recompiles on every call. Hoist the statements to module scope, as in the example above — this is both a performance win and a structural guard against building SQL from strings.

## better-sqlite3

`better-sqlite3` 13.0.3 is the mature third-party binding. It has the same synchronous design and a nearly identical API, plus a larger feature surface and a much larger ecosystem — most SQLite-backed Node libraries (session stores, queue implementations, ORMs) expect it.

The cost is a native build, which means a compiler on the build machine or a matching prebuilt binary, and rebuilds on Node major upgrades. In Docker that usually means a build stage.

:::tabs
@tab npm
```bash
npm install better-sqlite3@^13.0.3
```
@tab pnpm
```bash
pnpm add better-sqlite3@^13.0.3
```
@tab yarn
```bash
yarn add better-sqlite3@^13.0.3
```
:::

```js title="src/db.js"
import Database from 'better-sqlite3'

export const db = new Database('data/app.db')

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
db.pragma('synchronous = NORMAL')
```

```js title="src/users.repo.js"
const selectById = db.prepare('SELECT id, email, name FROM users WHERE id = ?')

export function findUserById(id) {
  return selectById.get(id) ?? null
}
```

Differences from `node:sqlite` worth knowing:

- `db.pragma('…')` instead of `db.exec('PRAGMA …')`, and it returns the resulting value.
- `statement.iterate(...)` streams rows one at a time instead of materialising the whole result — important for exports.
- `db.transaction(fn)` wraps a function in a transaction, including nested calls via savepoints.
- Constructor options: `{ readonly: true }` for a read-only handle, `{ fileMustExist: true }` to fail instead of creating an empty database, `{ timeout }` for the busy timeout, `{ verbose: console.log }` for query logging in development.

Choose `node:sqlite` when you want zero dependencies and a plain repository layer. Choose `better-sqlite3` when you need a library that depends on it, or `iterate`, or the `transaction` helper.

:::note The third option
`sqlite3` 6.0.1 is the older callback-based binding. It is still published and maintained, but it offers nothing the two above do not, and its asynchronous API buys you no real concurrency — SQLite still serialises the work. Prefer `node:sqlite` or `better-sqlite3` for new code.
:::

## WAL mode

Set `journal_mode = WAL` on every SQLite database that serves a running application. It is the difference between "usable in production" and "one report query blocks the site".

In the default rollback-journal mode, a writer takes an exclusive lock on the whole database and **readers block**. In write-ahead-logging mode, writers append to a separate `-wal` file, so:

- Readers never block the writer.
- The writer never blocks readers.
- There is still exactly **one writer at a time**.

```js
db.exec('PRAGMA journal_mode = WAL')
```

WAL is persistent — it is a property of the database file, so you set it once and it survives restarts. Two consequences:

- The database is now **three files**: `app.db`, `app.db-wal`, `app.db-shm`. Copying only `app.db` while the app is running gives you a corrupt or stale backup. Use `sqlite3 app.db ".backup out.db"` or the online backup API.
- WAL requires shared memory, so it does **not** work reliably over a network filesystem (NFS, SMB, most container volume mounts across hosts). SQLite on a shared network mount is a corruption bug waiting for concurrent access.

`PRAGMA synchronous = NORMAL` is the standard companion. With WAL it is safe against application and operating-system crashes — you can lose the most recent transactions only if the *machine* loses power. `FULL` fsyncs on every commit and is markedly slower. For most services `NORMAL` is the right trade; for a ledger, keep `FULL`.

## PRAGMA foreign_keys = ON

**Foreign keys are off by default in SQLite, and the setting is per connection.**

This is the single biggest footgun on this page. Your schema can declare `REFERENCES users(id)` and SQLite will happily insert orphan rows, because the constraint is not being enforced. Nothing warns you.

```js
db.exec('PRAGMA foreign_keys = ON')
```

The reason is backward compatibility: foreign key enforcement was added in SQLite 3.6.19 and defaulting it on would have broken existing databases. It has never been changed.

Set it immediately after opening **every** connection — the application's, your migration tool's, and your test fixtures'. If you use a `Worker` with its own handle, set it there too. And note that it cannot be changed inside a transaction; the statement is a silent no-op there.

Verify it rather than assuming:

```js
const [{ foreign_keys: fk }] = db.prepare('PRAGMA foreign_keys').all()
if (fk !== 1) throw new Error('foreign keys are not enabled')
```

While you are there: use `STRICT` tables (SQLite 3.37+). Without them, SQLite's type affinity lets you store the string `'banana'` in an `INTEGER` column.

```sql
CREATE TABLE users (
  id    INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  age   INTEGER
) STRICT;
```

## busy_timeout and the single writer

SQLite allows one writer at a time. A second writer gets `SQLITE_BUSY` immediately — it does not queue.

`PRAGMA busy_timeout = 5000` tells SQLite to retry internally for up to 5000 ms before returning `SQLITE_BUSY`. Without it, a second concurrent write fails instantly, which looks like random 500s under light load.

```js
db.exec('PRAGMA busy_timeout = 5000')
```

Set it on every connection, including read-only ones.

## Transactions

Transactions in SQLite are cheap and you should use them for any multi-statement write. Batching inserts into one transaction is also the single biggest write-throughput win available — each `COMMIT` is a durability barrier, so a thousand individual inserts is a thousand of them.

```js title="src/orders.repo.js"
import { db } from './db.js'

const insertOrder = db.prepare('INSERT INTO orders (user_id, total_cents) VALUES (?, ?)')
const insertItem = db.prepare('INSERT INTO order_items (order_id, sku, qty) VALUES (?, ?, ?)')

export function createOrder({ userId, totalCents, items }) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const { lastInsertRowid } = insertOrder.run(userId, totalCents)
    for (const item of items) insertItem.run(lastInsertRowid, item.sku, item.qty)
    db.exec('COMMIT')
    return Number(lastInsertRowid)
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
```

**Use `BEGIN IMMEDIATE` for anything that will write.** A plain `BEGIN` starts a *deferred* transaction that takes a read lock first and tries to upgrade to a write lock at the first write. If another connection has written in the meantime, the upgrade fails with `SQLITE_BUSY` — and `busy_timeout` does **not** help here, because retrying would mean re-reading data the transaction has already seen. `BEGIN IMMEDIATE` takes the write lock up front, where `busy_timeout` does apply.

With `better-sqlite3` the helper does this for you:

```js
const createOrder = db.transaction(({ userId, totalCents, items }) => {
  const { lastInsertRowid } = insertOrder.run(userId, totalCents)
  for (const item of items) insertItem.run(lastInsertRowid, item.sku, item.qty)
  return Number(lastInsertRowid)
})

// .immediate() runs the same function as BEGIN IMMEDIATE
createOrder.immediate({ userId, totalCents, items })
```

Because the driver is synchronous, there is no `await` inside the transaction and therefore no way to accidentally hold it open across an HTTP call. That is a real safety property the server databases do not give you — see [Transactions](transactions.md).

## When SQLite is a legitimate production choice

- **A single application node.** One process, or several processes on one machine sharing the file. Read-heavy workloads scale extremely well because reads do not contend under WAL.
- **Read-mostly services.** Documentation sites, catalogs, feature-flag stores, config services, analytics dashboards over a periodically rebuilt file.
- **Per-tenant databases.** One file per customer gives you free isolation, trivially cheap backup and restore per tenant, and a "delete the file" offboarding story.
- **Embedded and edge.** CLIs, desktop apps, on-device caches, sidecar read replicas next to the app process.
- **Tests.** Every database example in this handbook defaults to SQLite so the suite runs with no external service. See [Testing with a database](../orms/testing-with-a-database.md).

It is the wrong choice when two or more machines must write, when you need the file on network storage, when the host filesystem is ephemeral, or when you need concurrent long-running writes.

The honest limit is write concurrency, not size. Multi-gigabyte SQLite databases are ordinary. One writer is the constraint.

## Security considerations

**Parameterise.** Injection is worse in an embedded database, not better: the attacker's SQL runs in your process with your file permissions, and `ATTACH DATABASE` lets a statement open other files the process can read or write.

**The database is a file — file permissions are its access control.** There is no user model, no `GRANT`, no per-role privileges. Anything that can read the file can read every row. Store it outside the web root, `chmod 600` it, and make sure your static-file middleware cannot serve the directory. A `data/app.db` under a served folder is a full database download over HTTP.

**Back up all three files.** `app.db` alone is not a backup in WAL mode. Use the `.backup` command or the online backup API, which take a consistent snapshot while the app runs.

**Open read-only handles read-only.** A reporting or health-check connection should be `new Database(path, { readonly: true })` so a bug cannot write.

**Keep `foreign_keys = ON`.** Referential integrity you believe you have but do not is worse than none, because nothing in the code compensates for it.

**Use `STRICT` tables** so a type confusion in application code cannot store a string where an integer belongs.

**Do not expose SQLite's file path or errors to clients.** `SQLITE_CANTOPEN: unable to open database file /srv/app/data/app.db` in a 500 body tells an attacker exactly what to ask your file-serving bug for.

## Production considerations

- **WAL, `busy_timeout`, `foreign_keys` and `synchronous` on every connection, at open time.** Put them in one `openDatabase()` function and use it everywhere, including tests and scripts.
- **Persistent disk, local disk.** Not NFS, not a shared volume, not a container layer that disappears on restart.
- **Checkpointing.** WAL grows until it is checkpointed. SQLite auto-checkpoints at roughly 1000 pages by default, but a continuously busy database with a long-lived reader can hold checkpoints back and let the `-wal` file grow. Monitor its size; run `PRAGMA wal_checkpoint(TRUNCATE)` on a quiet schedule if it drifts.
- **Backups.** `sqlite3 app.db ".backup /backups/app-$(date +%F).db"` from cron is a complete strategy for many services. For continuous replication and point-in-time recovery, dedicated tools exist that ship the WAL to object storage — evaluate them against your recovery objective.
- **Health checks are trivial** — `SELECT 1` is a local function call, so the cheap-and-cached pattern in [Health checks](health-checks.md) matters less here. Check that the file is writable instead.
- **Long queries block the process.** Keep analytics off the request path, or run them on a separate read-only handle inside a `Worker`.
- **`ANALYZE` occasionally.** SQLite's planner uses statistics from `sqlite_stat1`; without them it guesses. Run `ANALYZE` after bulk loads.
- **Deployment means moving a file.** Zero-downtime deploys need a plan: two processes on the same host can share the file, but a blue/green deploy across hosts cannot.
- **Node major upgrades rebuild `better-sqlite3`.** `node:sqlite` has no such step, which is a real operational advantage.

## Common mistakes

- **Leaving `foreign_keys` off.** The schema says `REFERENCES`, the database does not enforce it, and you find out during a data audit.
- **Not enabling WAL**, then concluding SQLite "does not handle concurrency" when a reader blocks on a writer.
- **Backing up `app.db` only.** In WAL mode the recent commits are in `app.db-wal`.
- **Putting the file on a network mount.** WAL needs shared memory; the failure mode is corruption, not an error message.
- **`BEGIN` instead of `BEGIN IMMEDIATE` for a read-then-write transaction.** Intermittent `SQLITE_BUSY` that `busy_timeout` does not fix.
- **`db.prepare()` inside the request handler.** Recompiles the statement on every request.
- **A thousand inserts, a thousand transactions.** Wrap the loop in one transaction; the difference is orders of magnitude.
- **Assuming a column type is enforced.** Without `STRICT`, `INTEGER` accepts `'banana'`.
- **Serving the data directory as static files.** The whole database becomes a public download.
- **Two application servers, one shared file.** SQLite has one writer, on one machine.

## Related topics

- [Choosing a database](choosing-a-database.md) — deciding whether one node is enough.
- [Transactions](transactions.md) — isolation levels and the patterns the server databases need.
- [Migrations](migrations.md) — versioned schema changes, including SQLite's limited `ALTER TABLE`.
- [Seeding](seeding.md) — idempotent fixtures, and why the examples use SQLite.
- [Indexing basics](indexing-basics.md) — `EXPLAIN QUERY PLAN` and the same B-tree rules.
- [Testing with a database](../orms/testing-with-a-database.md) — per-test databases in milliseconds.
- [SQL injection](../security/sql-injection.md) — the exploit and the verification.
- [Health checks](health-checks.md) — what to probe when there is no server.
