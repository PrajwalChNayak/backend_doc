---
title: MySQL with mysql2
description: Using mysql2 3.24.4 with promises — pools, execute versus query, the prepared-statement cache, type coercion options and why multipleStatements must stay off.
status: current
updated: 2026-09-08
---

`mysql2` is the maintained MySQL driver for Node.js. It supports real server-side prepared statements, promises, and MySQL 8 authentication out of the box. This page covers pool configuration, the `execute`/`query` distinction that decides whether you get a prepared statement, and the type-coercion options that silently corrupt money and dates if you leave them at their defaults.

Full runnable version: [`examples/db-mysql2`](../../examples/db-mysql2/README.md).

## Installing

:::tabs
@tab npm
```bash
npm install mysql2@^3.24.4
```
@tab pnpm
```bash
pnpm add mysql2@^3.24.4
```
@tab yarn
```bash
yarn add mysql2@^3.24.4
```
:::

Always import from `mysql2/promise`. The root `mysql2` export is the callback API; the promise wrapper is the same driver with a promise surface.

## Basic example

```js title="src/db.js"
import mysql from 'mysql2/promise'

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  decimalNumbers: false,
  multipleStatements: false,

  enableKeepAlive: true,
})
```

```js title="src/users.repo.js"
import { pool } from './db.js'

export async function findUserById(id) {
  const [rows] = await pool.execute('SELECT id, email, name FROM users WHERE id = ?', [id])
  return rows[0] ?? null
}
```

Every query returns a two-element array: `[rows, fields]`. Destructure it. Forgetting the destructuring is the single most common `mysql2` mistake and produces a confusing "rows is not iterable".

## execute vs query

This is the distinction that matters most.

| | `execute()` | `query()` |
| --- | --- | --- |
| Protocol | Binary, server-side prepared statement | Text protocol |
| Placeholders | Sent separately to the server | Escaped by the driver and inlined into the SQL string |
| Statement caching | Yes, per connection | No |
| `??` identifier placeholder | No | Yes |
| Array expansion for `IN (?)` | No | Yes |

**Default to `execute()`.** A prepared statement sends the SQL once and the values separately, so the parameter is never part of the statement the parser sees. `query()` builds a single SQL string in the driver and relies on `mysql2`'s escaping being correct for your charset and column type. The escaping is good, but "the value can never be SQL" is a stronger guarantee than "the value is escaped correctly".

```js
// Prepared statement: parameters never touch the SQL parser.
const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email])
```

Two things `execute` cannot do, which is when you fall back to `query`:

**Expanding an array into an `IN` list.** A prepared statement has a fixed number of parameters, so `?` cannot become three values. `query()` can, because it does the substitution in the driver.

```js
// query() expands a nested array into a comma-separated list.
const [rows] = await pool.query('SELECT id, email FROM users WHERE id IN (?)', [[1, 2, 3]])
```

Note the double array: the outer one is the values list, the inner one is the value for that single `?`. This is safe — each element is escaped individually — but it is not a prepared statement, so use it deliberately. It is also the batching fix in [N+1 queries](n-plus-one-queries.md).

**Interpolating an identifier.** `??` escapes an identifier with backticks. It still must be validated against an allow-list, because escaping a column name does not make an arbitrary column name authorized to be read.

```js title="src/users.repo.js"
const SORTABLE = new Set(['created_at', 'email', 'name'])

export async function listUsers({ sort = 'created_at', desc = false, limit = 50 }) {
  if (!SORTABLE.has(sort)) throw new Error('bad sort column')
  const direction = desc ? 'DESC' : 'ASC'
  // lint-sql:allow sort is validated against SORTABLE and escaped by the ?? placeholder
  const sql = `SELECT id, email, name FROM users ORDER BY ?? ${direction} LIMIT ?`
  const [rows] = await pool.query(sql, [sort, limit])
  return rows
}
```

:::danger Never build SQL from input
```js vulnerable title="DO NOT COPY"
const [rows] = await pool.query(`SELECT * FROM users WHERE email = '${req.body.email}'`)
```
`{"email": "' OR 1=1 -- "}` returns every row. With `multipleStatements: true` it returns every row *and* runs whatever comes after the semicolon.
:::

```js good
const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [req.body.email])
```

## Named placeholders

Positional `?` gets unreadable past four parameters and is easy to misorder. `namedPlaceholders` turns on `:name` syntax.

```js title="src/db.js"
export const pool = mysql.createPool({
  // …
  namedPlaceholders: true,
})
```

```js
const [rows] = await pool.execute(
  'SELECT id, email FROM users WHERE tenant_id = :tenantId AND status = :status LIMIT :limit',
  { tenantId, status: 'active', limit: 50 },
)
```

The driver rewrites the named form to positional `?` before sending it, so this is still a real prepared statement. You can enable it per connection or per query rather than globally if you are migrating an existing codebase.

## The prepared-statement cache

`execute()` caches prepared statements **per connection**, keyed by the SQL text. The first call pays a `PREPARE` round trip; subsequent calls with the same SQL on the same connection reuse it.

That works only if the SQL text is constant. If you build the SQL string dynamically — a different `WHERE` clause per filter combination — every variant becomes its own cache entry and you thrash.

`maxPreparedStatements` bounds the cache per connection (the default is 16000). Two rules follow:

- **Keep SQL text stable.** Fixed strings with placeholders, not strings assembled per request. This is also what keeps you safe from injection, so the incentives align.
- **Watch the server too.** MySQL has its own `max_prepared_stmt_count` (server default 16382) across *all* connections. A pool of 30 connections each caching hundreds of distinct statements can hit it, and you get `ER_MAX_PREPARED_STMT_COUNT_REACHED`. Lower `maxPreparedStatements`, or reduce SQL-text variety.

```js
export const pool = mysql.createPool({
  // …
  maxPreparedStatements: 250,
})
```

## Pool options

```js
export const pool = mysql.createPool({
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
})
```

| Option | Default | Why you care |
| --- | --- | --- |
| `connectionLimit` | 10 | Maximum open connections. Multiply by your replica count and compare with the server's `max_connections`. |
| `waitForConnections` | `true` | When `true`, requests queue for a free connection. When `false`, they **fail immediately** with `ER_CON_COUNT_ERROR`. |
| `queueLimit` | `0` (unlimited) | Maximum queued requests. `0` means an overloaded service queues forever and every request times out at the HTTP layer instead. |
| `connectTimeout` | 10000 | Milliseconds to establish a connection. |
| `enableKeepAlive` | `true` | TCP keepalive, so a silently dropped connection is detected rather than hanging. |

`waitForConnections: true` with `queueLimit: 0` is the right default for a web service *only if* you also have an HTTP-level timeout. Otherwise an unbounded queue turns a slow database into an unbounded memory growth problem. Set `queueLimit` to something like `connectionLimit * 5` and return 503 when it is exceeded — failing fast is better than queueing for 90 seconds. See [Connection pooling](connection-pooling.md).

Instrument the pool with its events:

```js
pool.on('acquire', () => metrics.increment('mysql.acquire'))
pool.on('enqueue', () => metrics.increment('mysql.enqueue')) // ← the pressure signal
pool.on('release', () => metrics.increment('mysql.release'))
```

An `enqueue` event means a request had to wait for a connection. A steady stream of them means your pool is too small or a query is too slow.

## Type coercion options

MySQL types do not map cleanly onto JavaScript types. Four options decide how much precision you lose, and the defaults are not the safe ones.

### decimalNumbers

`DECIMAL` and `NEWDECIMAL` come back as **strings** by default. Keep it that way.

```js
decimalNumbers: false, // the default — do not change it
```

Setting `decimalNumbers: true` converts them to JavaScript numbers, which are IEEE-754 doubles. `DECIMAL(20,2)` values beyond `Number.MAX_SAFE_INTEGER` lose digits, and `0.1 + 0.2` arithmetic on money is a bug you find in an audit. Keep the string, and either use a decimal library or store money as integer minor units.

`BIGINT` has the same problem. `supportBigNumbers: true` with `bigNumberStrings: true` returns big integers as strings rather than lossy numbers.

### dateStrings and timezone

By default `DATETIME`, `DATE` and `TIMESTAMP` are converted to JavaScript `Date` objects, interpreted using the `timezone` option (default `'local'` — the Node process's zone).

That is two implicit conversions with two chances to be wrong: MySQL stores `DATETIME` without a zone, so the driver has to guess one.

```js
timezone: 'Z',      // interpret and send datetimes as UTC
dateStrings: true,  // …or skip the conversion entirely
```

`dateStrings: true` returns `'2026-09-08 14:30:00'` as a string and lets you parse it explicitly with the zone you actually mean. That is more code and fewer surprises. Whichever you choose, run the process with `TZ=UTC` and store UTC.

:::warning
Changing `timezone` or `dateStrings` on an existing application changes the values every date-handling code path sees. Make it a deliberate migration with tests, not a config tweak.
:::

## multipleStatements

Leave `multipleStatements` at its default of `false`.

With it off, a connection can execute exactly one statement per call. An injection that reaches a `query()` call can therefore only manipulate *that* statement — bad, but bounded. With it on, `'; DROP TABLE users; -- ` is a working payload, and the same hole becomes arbitrary SQL execution.

:::danger multipleStatements turns one injection into many
```js vulnerable title="DO NOT COPY"
const pool = mysql.createPool({ /* … */ multipleStatements: true })
const [rows] = await pool.query(`SELECT * FROM users WHERE id = ${req.params.id}`)
```
`GET /users/1;%20DROP%20TABLE%20sessions` now runs two statements. Without `multipleStatements`, the same injection is limited to rewriting the `SELECT`.
:::

If you genuinely need to run a batch of statements — a migration file — do it on a dedicated connection created for that purpose, with a different credential, and never on the pool your request handlers use. See [Migrations](migrations.md).

## Charset

Use `utf8mb4`. Not `utf8`.

MySQL's `utf8` is an alias for `utf8mb3`: a three-byte-per-character encoding that cannot represent anything outside the Basic Multilingual Plane. Emoji, many CJK extension characters and mathematical symbols are all four bytes. Inserting one into a `utf8mb3` column raises `ER_TRUNCATED_WRONG_VALUE_FOR_FIELD` in strict mode, or silently truncates the string in a non-strict setup.

Set it in three places, because any one of them can override the others:

```js
// 1. The driver connection
charset: 'utf8mb4'
```

```sql
-- 2. The table
CREATE TABLE posts (
  id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  body   TEXT NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
```

```sql
-- 3. Verify what you actually have
SELECT table_name, table_collation FROM information_schema.tables WHERE table_schema = DATABASE();
```

## Inserts and LAST_INSERT_ID()

MySQL has no `RETURNING`. For an `AUTO_INCREMENT` primary key, the driver surfaces the generated id on the result object.

```js title="src/users.repo.js"
export async function createUser({ email, name }) {
  const [result] = await pool.execute(
    'INSERT INTO users (email, name) VALUES (?, ?)',
    [email, name],
  )
  return { id: result.insertId, email, name }
}
```

The result object also carries `affectedRows` and `changedRows`. They differ: an `UPDATE` that sets a column to the value it already holds reports `affectedRows: 1` and `changedRows: 0`.

`insertId` is `LAST_INSERT_ID()` for the connection, and this is where the pool matters. `LAST_INSERT_ID()` is **per connection**, so running `INSERT` and then a separate `SELECT LAST_INSERT_ID()` through the pool can read a different connection's value. Use `result.insertId` from the same call, or check out a connection explicitly.

```js
const conn = await pool.getConnection()
try {
  await conn.beginTransaction()
  const [result] = await conn.execute('INSERT INTO orders (user_id) VALUES (?)', [userId])
  await conn.execute('INSERT INTO order_items (order_id, sku) VALUES (?, ?)', [result.insertId, sku])
  await conn.commit()
} catch (err) {
  await conn.rollback()
  throw err
} finally {
  conn.release()
}
```

The `try/finally conn.release()` rule is identical to `pg`: release in `finally` or you leak the connection. Multi-row inserts also report only the **first** generated id in `insertId`; the rest are sequential only if `innodb_autoinc_lock_mode` allows it, so do not rely on it for bulk inserts.

Upserts use `ON DUPLICATE KEY UPDATE`:

```js
await pool.execute(
  `INSERT INTO users (email, name)
   VALUES (?, ?)
   ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = NOW()`,
  [email, name],
)
```

## Error codes worth handling

`err.code` is a string name and `err.errno` is the numeric code. Branch on `err.code`.

| `err.code` | `errno` | Meaning |
| --- | --- | --- |
| `ER_DUP_ENTRY` | 1062 | Unique constraint violated → HTTP 409 |
| `ER_NO_REFERENCED_ROW_2` | 1452 | Foreign key violated → HTTP 409/422 |
| `ER_LOCK_DEADLOCK` | 1213 | **Retry the transaction** |
| `ER_LOCK_WAIT_TIMEOUT` | 1205 | `innodb_lock_wait_timeout` hit; usually retryable once |
| `ER_DATA_TOO_LONG` | 1406 | Value longer than the column, often a `utf8mb3` symptom |
| `ER_CON_COUNT_ERROR` | 1040 | Server `max_connections` exceeded |
| `PROTOCOL_CONNECTION_LOST` | — | Connection died; the pool will replace it |

Deadlocks are normal in MySQL under concurrency — InnoDB detects them and kills one transaction. Retrying is the correct handling, not an error to page on. See [Retries and timeouts](retries-and-timeouts.md).

## Statement timeouts

MySQL has no direct equivalent of Postgres's `statement_timeout` for every statement type. What you have:

- **`max_execution_time`** — milliseconds, applies to read-only `SELECT` statements only. Set it per session or per statement.
- **`innodb_lock_wait_timeout`** — seconds a transaction waits for a row lock (default 50, which is far too long for a web request).

```js
const conn = await pool.getConnection()
try {
  await conn.query('SET SESSION max_execution_time = 5000')
  await conn.query('SET SESSION innodb_lock_wait_timeout = 5')
  // … the request's queries …
} finally {
  conn.release()
}
```

:::warning
A pooled connection keeps session settings after `release()`, so the next borrower inherits them. Either set these on every checkout, or set them server-side for the application user, or reset them before release.
:::

Because writes are not covered by `max_execution_time`, always put a timeout in front at the HTTP layer as well — see [Retries and timeouts](retries-and-timeouts.md).

## Security considerations

**Use `execute()` with placeholders.** Values in the array, never in the string. The parameters travel outside the statement, so no escaping bug can promote a value into SQL.

**Keep `multipleStatements: false`.** It is the difference between an injection that can rewrite one query and one that can run arbitrary statements. There is no application-level use for it in a request path.

**Validate identifiers against an allow-list even when using `??`.** `??` protects the *syntax*; it does not decide whether `password_hash` is a column the caller may sort by. Escaping is not authorization.

**Grant the application user no DDL and no `FILE`.** In particular, revoke `FILE` — it permits `LOAD DATA INFILE` and `SELECT … INTO OUTFILE`, which turn an injection into arbitrary file read and write on the server.

```sql
CREATE USER 'app'@'%' IDENTIFIED BY 'redacted';
GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'app'@'%';
```

Note there is no `ALL PRIVILEGES`, no `DROP`, no `CREATE`, no `FILE`. Migrations use a separate user — see [Migrations](migrations.md).

**Disable `LOCAL INFILE` on the client.** `mysql2` leaves local-infile support off unless you pass an `infileStreamFactory`; do not turn it on. A malicious or compromised server can otherwise request arbitrary files from the client host.

**Require TLS to a managed MySQL,** and verify the certificate. As with `pg`, an option that turns off certificate verification gives you encryption without authentication, which does not stop an interception.

**Do not leak driver errors to clients.** `ER_DUP_ENTRY` messages include the duplicated value and the index name, which is a user-enumeration oracle if returned verbatim.

## Production considerations

- **One pool per process.** Export it from a module; never build a pool inside a handler.
- **Size `connectionLimit` against the server.** MySQL 8's default `max_connections` is 151. Eight replicas at `connectionLimit: 20` is 160 — the ninth deploy fails at connect time.
- **Set `queueLimit`.** An unlimited queue converts database slowness into unbounded latency and memory. Bound it and return 503.
- **Alert on `enqueue` events**, not on average query time. Queueing is the leading indicator.
- **Close the pool on `SIGTERM`** with `await pool.end()` so in-flight statements finish. See [Graceful shutdown](../production/graceful-shutdown.md).
- **Watch the prepared-statement counters.** `SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'` against `max_prepared_stmt_count` tells you whether your SQL text is too varied.
- **`enableKeepAlive: true`** so connections idled out by a load balancer or `wait_timeout` are detected rather than hanging until the socket timeout.
- **Expect deadlocks and retry them.** Under concurrent writes to the same rows, InnoDB deadlocks are routine. A transaction that is not retryable is a bug in your design.
- **Read replicas need a second pool.** `mysql2` has no automatic read/write split; route reads explicitly and accept replication lag.

## Common mistakes

- **Forgetting to destructure.** `const rows = await pool.execute(...)` gives you `[rows, fields]`, not rows.
- **Using `query()` everywhere** and losing prepared statements — and, if the SQL is built by interpolation, losing injection safety with it.
- **Expecting `execute()` to expand an array** for `IN (?)`. It cannot; use `query()` with a nested array, or generate the right number of `?` placeholders from `array.length`.
- **`decimalNumbers: true` on a money column.** Silent precision loss with no error.
- **Leaving `charset` at the default and creating tables as `utf8`.** The first emoji is the bug report.
- **Selecting `LAST_INSERT_ID()` in a separate pool call.** It is per connection; you may read someone else's insert. Use `result.insertId`.
- **`multipleStatements: true` "for the migration script"**, on the pool the API uses.
- **Setting session variables on a pooled connection and not resetting them.** The next borrower inherits `max_execution_time = 60000`.
- **Not releasing in `finally`.** Same leak as `pg`, same symptom: requests hang with nothing in the log.
- **Treating a deadlock as a 500.** It is a retry, and the retry almost always succeeds.

## Related topics

- [Connection pooling](connection-pooling.md) — sizing, queueing and exhaustion.
- [Transactions](transactions.md) — repeatable read, `FOR UPDATE`, and retrying on 1213.
- [Retries and timeouts](retries-and-timeouts.md) — which MySQL errors are safe to retry.
- [Migrations](migrations.md) — the separate DDL credential, and MySQL's DDL locking.
- [Indexing basics](indexing-basics.md) — including why InnoDB indexes foreign keys for you.
- [N+1 queries](n-plus-one-queries.md) — batching with `IN (?)`.
- [SQL injection](../security/sql-injection.md) — the exploit, the fix, and how to verify it.
- [Choosing a database](choosing-a-database.md) — when MySQL is the right pick over Postgres.
- [Sequelize](../orms/sequelize.md) — the ORM most commonly paired with MySQL.
