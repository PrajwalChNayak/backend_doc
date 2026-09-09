---
title: PostgreSQL with pg
description: Using the pg 8.23.0 driver directly — pools, client checkout, type parsers, timeouts, upserts, JSONB and SSL for managed providers.
status: current
updated: 2026-09-08
---

`pg` is the reference PostgreSQL driver for Node.js. It is a thin, predictable layer: you send SQL with numbered placeholders and get rows back. This page covers the parts that decide whether your service survives production — pooling, timeouts, type parsing, and the SSL configuration every managed provider needs.

Full runnable version: [`examples/db-postgres-pg`](../../examples/db-postgres-pg/README.md).

## Installing

:::tabs
@tab npm
```bash
npm install pg@^8.23.0
```
@tab pnpm
```bash
pnpm add pg@^8.23.0
```
@tab yarn
```bash
yarn add pg@^8.23.0
```
:::

`pg` is pure JavaScript — there is no native build step. It ships CommonJS, so with ESM you import the default export and destructure.

## Basic example

```js title="src/db.js"
import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
})

pool.on('error', (err) => {
  // Fired for errors on *idle* clients, e.g. the server closed the connection.
  // Without this listener the error is unhandled and crashes the process.
  console.error('idle client error', err)
})
```

```js title="src/users.repo.js"
import { pool } from './db.js'

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [id])
  return rows[0] ?? null
}
```

Placeholders are `$1`, `$2`, … and values go in the array. They are sent separately from the SQL text, so a value can never be parsed as SQL. This is the whole of SQL-injection defense for `pg`.

:::danger Never build SQL by interpolation
```js vulnerable title="DO NOT COPY"
const { rows } = await pool.query(`SELECT * FROM users WHERE email = '${req.body.email}'`)
```
A body of `{"email": "x' OR '1'='1"}` returns every user. A body of `{"email": "x'; DROP TABLE users; --"}` does what it looks like.
:::

```js good title="src/users.repo.js"
const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [req.body.email])
```

## Pool vs Client

`Client` is a single connection. `Pool` manages a set of them and hands them out.

Use a `Pool`. A `Client` is correct in exactly three situations: a one-shot script, a long-lived `LISTEN` connection, and a migration runner that must hold session state.

The reason is cost. A PostgreSQL connection is a separate operating-system process on the server, forked at connect time, plus a TCP handshake and a TLS handshake. Opening one per HTTP request adds tens of milliseconds and will exhaust `max_connections` under load. A pool amortises all of that.

```js
import pg from 'pg'

// One-shot script: a Client is fine, and you must close it.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM users')
  console.log(rows[0].n)
} finally {
  await client.end()
}
```

Create exactly **one** pool per process and export it. A pool created inside a request handler is not a pool.

## pool.query vs pool.connect

`pool.query()` checks out a connection, runs one statement, and returns it. It is the right call for every single-statement read and write.

`pool.connect()` gives you a dedicated client that you must release. You need it when several statements must run on the *same* connection — transactions, `SET LOCAL`, advisory locks, cursors, temporary tables.

```js title="src/transfer.js"
import { pool } from './db.js'

export async function transfer(fromId, toId, amountCents) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amountCents, fromId])
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amountCents, toId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

:::warning The try/finally release rule
`client.release()` must be in a `finally`. If you release only on the success path, one thrown error leaks a connection permanently. Ten such errors against a pool of ten and every subsequent request hangs waiting for a client that will never come back.
:::

Two details in that snippet that are easy to get wrong:

- `ROLLBACK` is itself a query and can fail if the connection has already died. Wrap it, or use the `withTransaction` helper in [Transactions](transactions.md), which handles it.
- `release(err)` — passing a truthy argument destroys the connection instead of returning it to the pool. Do that when you suspect the connection is in an unknown state.

## Timeouts

Four separate timeouts exist and they do different jobs. Set all of them.

| Option | Where it lives | What it bounds |
| --- | --- | --- |
| `connectionTimeoutMillis` | pool | Waiting for a free client *and* establishing a new connection |
| `idleTimeoutMillis` | pool | How long an unused client sits in the pool before it is closed |
| `statement_timeout` | server session | How long the **server** will execute a statement before cancelling it |
| `query_timeout` | client, in Node | How long the **driver** waits before erroring the promise |

`statement_timeout` is the important one, because it is enforced by PostgreSQL. When it fires, the server cancels the query and returns SQLSTATE `57014` — the work actually stops. `query_timeout` only rejects the promise in Node; the query keeps burning CPU on the server until it finishes.

```js
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  // Passed through as a session setting on every new connection.
  statement_timeout: 10_000,
  query_timeout: 12_000,
  // Kill a session that BEGINs and then stops talking, so it stops holding locks.
  idle_in_transaction_session_timeout: 30_000,
})
```

Set `query_timeout` slightly *above* `statement_timeout` so the server-side cancel wins and you get a real PostgreSQL error code rather than an opaque driver timeout.

For a slow report you can raise the limit for one transaction only:

```js
await client.query('BEGIN')
await client.query("SET LOCAL statement_timeout = '60s'")
// … the long query …
await client.query('COMMIT')
```

More on layering these with HTTP timeouts in [Retries and timeouts](retries-and-timeouts.md).

## Type parsers and the string surprise

`pg` maps PostgreSQL types to JavaScript types. Two of those mappings surprise everyone.

```js
const { rows } = await pool.query('SELECT count(*) AS n FROM users')
typeof rows[0].n // 'string'  ← not a number
```

`count(*)` returns `bigint` (`int8`, OID 20), and `numeric` (OID 1700) behaves the same way. Both come back as **strings**.

This is deliberate and correct. A `bigint` can hold values above `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991) and a `numeric` is arbitrary-precision decimal. Silently coercing either to a JavaScript `number` loses money and ids. The driver refuses to lie to you.

You have three options, in order of preference:

**1. Cast in the query.** Explicit, local, no global side effects.

```js
const { rows } = await pool.query('SELECT count(*)::int AS n FROM users')
typeof rows[0].n // 'number'
```

**2. Convert at the boundary.** Best for money — keep `numeric` as a string and hand it to a decimal library, or store money as `bigint` cents and convert deliberately.

**3. Override the parser globally.** Do this once, at startup, and know that it is process-wide.

```js title="src/db.js"
import pg from 'pg'

// int8 (bigint) -> BigInt instead of string. Note: BigInt does not JSON.stringify.
pg.types.setTypeParser(pg.types.builtins.INT8, BigInt)

// numeric -> keep as string (this is already the default; shown to make the choice explicit)
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value)
```

:::warning
`pg.types.setTypeParser` is global to the process and affects every pool and every query, including your migration tool's. `BigInt` values also throw on `JSON.stringify`, so if you convert `int8` to `BigInt` you need a serializer that handles it. Casting in the query is usually the smaller hammer.
:::

The same parser registry is published separately as `pg-types` if you want to import the OID constants without importing `pg`.

Timestamps have a related gotcha: `timestamptz` parses to a JavaScript `Date` in the Node process's local time zone. Store `timestamptz`, never `timestamp`, and set `TZ=UTC` on the process.

## rowMode

By default each row is an object keyed by column name. Duplicate column names collide — `SELECT u.id, o.id FROM users u JOIN orders o …` gives you one `id`.

`rowMode: 'array'` returns each row as an array of values instead, with the column metadata in `result.fields`.

```js
const result = await pool.query({
  text: 'SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = $1',
  values: [userId],
  rowMode: 'array',
})

result.fields.map((f) => f.name) // ['id', 'id']
result.rows[0]                   // [42, 1001]
```

It is also measurably cheaper for wide result sets, because the driver skips building an object per row. Reach for it when you are streaming a large export, not for ordinary reads.

## Upserts with ON CONFLICT

`ON CONFLICT` makes "insert or update" a single atomic statement. Doing it as `SELECT` then `INSERT` is a race: two concurrent requests both see no row and both insert.

```js title="src/users.repo.js"
export async function upsertUser({ email, name }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, updated_at = now()
     RETURNING id, email, name, updated_at`,
    [email, name],
  )
  return rows[0]
}
```

- The conflict target `(email)` must be covered by a unique index or constraint. Without one, PostgreSQL raises an error rather than guessing.
- `EXCLUDED` is the row that would have been inserted.
- `DO NOTHING` returns **zero rows** when the row already existed, which is a common source of `undefined` bugs. If you always need the row back, use `DO UPDATE SET id = users.id` or follow with a `SELECT`.

`RETURNING` works on `INSERT`, `UPDATE` and `DELETE`, and saves you a round trip and a race:

```js
const { rows, rowCount } = await pool.query(
  'UPDATE orders SET status = $1 WHERE id = $2 AND status = $3 RETURNING id, status',
  ['shipped', orderId, 'paid'],
)
if (rowCount === 0) throw new Error('order not in a shippable state')
```

That `AND status = $3` is a conditional update: the database decides, atomically, whether the transition is legal.

## Arrays and IN lists

There is no placeholder that expands into an `IN (…)` list. Use `= ANY($1)` with a JavaScript array — one placeholder, one value.

```js
export async function findUsersByIds(ids) {
  const { rows } = await pool.query(
    'SELECT id, email FROM users WHERE id = ANY($1::int[])',
    [ids],
  )
  return rows
}
```

The `::int[]` cast tells the planner the element type, which matters when `ids` is empty — an untyped empty array is ambiguous. This is also the batching fix for [N+1 queries](n-plus-one-queries.md).

Array columns round-trip as JavaScript arrays:

```js
await pool.query('UPDATE posts SET tags = $1 WHERE id = $2', [['node', 'postgres'], postId])
const { rows } = await pool.query('SELECT id FROM posts WHERE $1 = ANY(tags)', ['node'])
```

## JSONB

Pass an object and `pg` serializes it to JSON for you. Do **not** call `JSON.stringify` yourself for a `jsonb` parameter — you would send a JSON *string* rather than a JSON object.

```js
await pool.query(
  'INSERT INTO events (kind, payload) VALUES ($1, $2)',
  ['signup', { source: 'web', plan: 'pro' }],
)
```

Querying containment with the `@>` operator, parameterised:

```js
const { rows } = await pool.query(
  'SELECT id, payload FROM events WHERE payload @> $1',
  [{ plan: 'pro' }],
)
```

To make that fast you need a GIN index:

```sql
CREATE INDEX events_payload_idx ON events USING gin (payload jsonb_path_ops);
```

Extracting a single key is `payload ->> 'plan'` (text) or `payload -> 'plan'` (jsonb). A B-tree index on the expression is cheaper than GIN when you only ever query one key:

```sql
CREATE INDEX events_plan_idx ON events ((payload ->> 'plan'));
```

:::best-practice
Use `JSONB`, not `JSON`. `JSON` stores the raw text and reparses on every access; `JSONB` stores a parsed binary form and is the only one of the two that can be indexed usefully.
:::

Use `JSONB` for genuinely variable data — third-party webhook payloads, feature flags, audit detail. Do not use it as a way to skip designing columns; you lose type checking, constraints and cheap indexing.

## Sorting by a user-supplied column

Column and table names are **identifiers**, and identifiers cannot be parameterised. `ORDER BY $1` sorts by a constant string, which does nothing. The only safe approach is an allow-list.

```js title="src/users.repo.js"
const SORTABLE = new Set(['created_at', 'email', 'name'])

export async function listUsers({ sort = 'created_at', desc = false, limit = 50 }) {
  if (!SORTABLE.has(sort)) throw new Error('bad sort column')
  const direction = desc ? 'DESC' : 'ASC'
  // lint-sql:allow sort is validated against the SORTABLE allow-list above; direction is a literal
  const text = `SELECT id, email, name, created_at FROM users ORDER BY ${sort} ${direction} LIMIT $1`
  const { rows } = await pool.query(text, [limit])
  return rows
}
```

The allow-list is a `Set` of literal strings you wrote. Note that `direction` is chosen from two literals, never taken from input, and `limit` is still a real placeholder.

## LISTEN/NOTIFY

`LISTEN` registers interest on **one specific connection**. That makes it fundamentally incompatible with a pool: `pool.query('LISTEN jobs')` subscribes whichever client the pool happened to hand you, and that client returns to the pool immediately and may serve unrelated queries or be closed by `idleTimeoutMillis`.

Use a dedicated `Client` for listening, outside the pool.

```js title="src/notify.js"
import pg from 'pg'

const CHANNELS = new Set(['jobs', 'cache_invalidation'])

export async function listen(channel, onPayload) {
  if (!CHANNELS.has(channel)) throw new Error('unknown channel')

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  client.on('notification', (msg) => onPayload(msg.payload))
  client.on('error', (err) => {
    console.error('listener connection lost', err)
    // Reconnect and re-issue LISTEN — see the reconnect note below.
  })

  // lint-sql:allow channel is validated against the CHANNELS allow-list above
  await client.query(`LISTEN ${client.escapeIdentifier(channel)}`)
  return client
}
```

Caveats that bite in production:

- **Notifications are not durable.** If the listener is disconnected when `NOTIFY` fires, that notification is gone. It is a wake-up signal, not a queue. Pair it with a table you poll on reconnect.
- **You must re-issue `LISTEN` after every reconnect.** A network blip silently unsubscribes you and the process looks healthy.
- **Payloads are limited to 8000 bytes.** Send an id, not the object.
- **PgBouncer in transaction mode drops `LISTEN` entirely.** See [Connection pooling](connection-pooling.md).
- The channel name is an identifier, so it cannot be a placeholder — hence the allow-list plus `escapeIdentifier` above. Sending is different: `NOTIFY` has a function form that *does* take parameters.

```js
await pool.query('SELECT pg_notify($1, $2)', ['jobs', String(jobId)])
```

## SSL for managed providers

Nearly every managed PostgreSQL (RDS, Cloud SQL, Neon, Supabase, Heroku) requires TLS. The dangerous half of this is that the fix most people copy from a search result disables verification.

:::danger
```js vulnerable title="DO NOT COPY"
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
```
This encrypts the connection but accepts *any* certificate, so it does not authenticate the server. Anyone who can intercept the route can present their own certificate, read your queries and your credentials, and forward them on. It is TLS with the security removed.
:::

Verify against the provider's CA instead:

```js good title="src/db.js"
import fs from 'node:fs'
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8'),
  },
})
```

Download the CA bundle your provider publishes and ship it with the deployment, or point `PGSSLROOTCERT` at it. `pg` also reads the standard libpq environment variables — `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE` — so in a container you can configure the whole connection with environment variables and no code.

:::note
`sslmode=require` in a connection string means "encrypt", not "verify". `verify-full` is the mode that checks both the CA chain and the hostname. Prefer `verify-full` with an explicit CA.
:::

## Error codes worth handling

`err.code` on a `pg` error is the PostgreSQL SQLSTATE. Branch on it rather than on the message text, which is localized and version-dependent.

| SQLSTATE | Name | What to do |
| --- | --- | --- |
| `23505` | unique_violation | Map to HTTP 409. Read `err.constraint` to say which one. |
| `23503` | foreign_key_violation | Map to HTTP 409 or 422. |
| `23502` | not_null_violation | A bug in your code — 500. |
| `22P02` | invalid_text_representation | Bad input reached a typed column — 400. |
| `40001` | serialization_failure | **Retry the transaction.** |
| `40P01` | deadlock_detected | **Retry the transaction.** |
| `57014` | query_canceled | `statement_timeout` fired. Do not blindly retry. |
| `53300` | too_many_connections | Your pools are oversized. See [Connection pooling](connection-pooling.md). |

```js
try {
  await createUser(email)
} catch (err) {
  if (err.code === '23505' && err.constraint === 'users_email_key') {
    throw new HttpError(409, 'email already registered')
  }
  throw err
}
```

## Security considerations

**Parameterise everything.** Values go in the array, always. The only exception is an identifier validated against an allow-list you wrote, marked with `// lint-sql:allow`, as shown above. There is no third case.

**Never enable multiple statements.** `pg` sends parameterised queries through the extended protocol, which permits exactly one statement per message. This is why `'SELECT 1; DROP TABLE users'` fails as a parameterised query — keep it that way by never using the simple-query path for anything containing user input.

**Give the application role no DDL.** The app connects as a role that can `SELECT`, `INSERT`, `UPDATE` and `DELETE` on its tables and nothing else. Migrations connect as a different role that owns the schema. An SQL injection in an app that cannot `DROP` is a data leak; the same injection in an app running as the owner is a data loss event.

```sql
CREATE ROLE app_user LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE appdb TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
REVOKE CREATE ON SCHEMA public FROM app_user;
```

**Verify TLS.** `rejectUnauthorized: false` is not a workaround, it is the vulnerability.

**Do not log query parameters at info level.** The `values` array contains password hashes, tokens and personal data. See [Logging without leaking PII](../security/logging-without-leaking-pii.md).

**Do not return raw driver errors to clients.** A `pg` error object carries `detail`, `table`, `column` and `constraint`. `Key (email)=(alice@example.com) already exists` in a 500 body is a user-enumeration oracle. Map errors to safe messages in your error middleware — see [Error handling](../express/error-handling.md).

**Set `statement_timeout`.** Without it, one pathological query holds a pooled connection open indefinitely and becomes a denial-of-service vector.

## Production considerations

- **One pool per process, created at module load, closed on shutdown.** Call `await pool.end()` from your `SIGTERM` handler so in-flight queries finish. See [Graceful shutdown](../production/graceful-shutdown.md).
- **Always attach `pool.on('error')`.** Errors on idle clients — a failover, an idle timeout on the server side, a `pg_terminate_backend` — are emitted on the pool. Unhandled, they take the process down.
- **Size the pool from the server's `max_connections`, not from your traffic.** `max: 10` across eight replicas is 80 connections plus your migration job plus your monitoring. See [Connection pooling](connection-pooling.md).
- **Instrument `pool.totalCount`, `pool.idleCount` and `pool.waitingCount`.** A non-zero `waitingCount` is your earliest signal of pool exhaustion, and it appears well before request latency does.
- **`statement_timeout` on the pool, `lock_timeout` on migrations.** Different problems, different settings.
- **Expect connection resets during failover.** Managed providers move the primary. Idle clients die, in-flight queries fail with `ECONNRESET`. Retry idempotent reads with backoff — see [Retries and timeouts](retries-and-timeouts.md).
- **Use `SET application_name`** (or the `application_name` connection option) so `pg_stat_activity` tells you which service is holding a connection.

```js
const stats = () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
})
```

## Common mistakes

- **Releasing the client outside `finally`.** One thrown error leaks a connection; enough of them and the service hangs with no error in the logs.
- **Creating a `Pool` per request.** Every request now pays a full connect, and the connection count climbs until the server refuses new ones.
- **Expecting `count(*)` to be a number.** It is a string, because `bigint` does not fit in a JavaScript `number`. Cast with `::int` or convert deliberately.
- **`JSON.stringify` on a `jsonb` parameter.** The driver already serializes objects; doing it yourself stores a quoted string.
- **`WHERE id IN ($1)` with an array.** That is one scalar placeholder. Use `= ANY($1::int[])`.
- **`LISTEN` through the pool.** It subscribes a connection that is about to be handed to someone else, and then times out.
- **`ssl: { rejectUnauthorized: false }`** copied from an error message. It removes the only part of TLS that authenticates the server.
- **Assuming `ON CONFLICT DO NOTHING` returns the existing row.** It returns nothing at all.
- **Catching on `err.message`.** Use `err.code` — the SQLSTATE is stable, the message is not.
- **No `pool.on('error')` handler.** A failover becomes a crash loop.

## Related topics

- [Connection pooling](connection-pooling.md) — sizing, exhaustion, PgBouncer and serverless.
- [Transactions](transactions.md) — the `withTransaction` helper and isolation levels.
- [Indexing basics](indexing-basics.md) — making the queries on this page fast.
- [N+1 queries](n-plus-one-queries.md) — the `= ANY($1)` batching pattern in context.
- [Retries and timeouts](retries-and-timeouts.md) — which SQLSTATEs are safe to retry.
- [Migrations](migrations.md) — changing the schema without locking the table.
- [SQL injection](../security/sql-injection.md) — the exploit and the proof it is fixed.
- [Health checks](health-checks.md) — a cheap `SELECT 1` that does not cause restart storms.
- [Knex](../orms/knex.md) — the query-builder layer if raw SQL stops scaling for you.
