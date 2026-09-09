---
title: Transactions
description: Correct BEGIN/COMMIT/ROLLBACK patterns in pg and mysql2, a reusable withTransaction helper, isolation levels, row locking, and retrying deadlocks and serialization failures.
status: current
updated: 2026-09-08
---

A transaction makes several statements one atomic unit: all of them apply, or none do. Getting this right in Node is mostly about two mechanical rules — every statement must run on the *same* connection, and the connection must be released on every path — plus knowing which isolation level you are actually running under.

## Why it exists

Two statements that must both succeed will eventually not. The process is killed between them, the second violates a constraint, the network drops. Without a transaction you are left with a debit and no credit, an order with no line items, a user with no default workspace.

Transactions also give you a consistent *read* view. Inside one, `SELECT`s see a stable snapshot rather than a database mutating under them.

## The connection rule

`BEGIN` applies to a connection, not to a pool. This is the single most common bug:

```js vulnerable title="DO NOT COPY — this does not do what it looks like"
await pool.query('BEGIN')
await pool.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromId])
await pool.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toId])
await pool.query('COMMIT')
```

Each `pool.query` borrows whatever connection is free, so those four statements can land on four different connections. The `BEGIN` opens a transaction that is never committed — it sits idle holding locks until `idle_in_transaction_session_timeout` kills it — while the two `UPDATE`s auto-commit independently. There is no atomicity at all, and no error is raised.

Check out a client explicitly:

```js good title="src/transfer.js"
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

Even that has a flaw: if the connection died, `ROLLBACK` throws too, and that error replaces the original one. Write the helper once instead.

## A reusable withTransaction helper

```js title="src/db/with-transaction.js"
import { pool } from './pool.js'

/**
 * Runs `fn` inside a transaction on a single checked-out client.
 * Commits on success, rolls back on any throw, always releases.
 */
export async function withTransaction(fn) {
  const client = await pool.connect()
  let released = false

  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection is in an unknown state — destroy it instead of pooling it.
      client.release(rollbackErr)
      released = true
    }
    throw err
  } finally {
    if (!released) client.release()
  }
}
```

```js title="src/orders.service.js"
import { withTransaction } from '../db/with-transaction.js'

export function createOrder({ userId, items }) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      'INSERT INTO orders (user_id, status) VALUES ($1, $2) RETURNING id',
      [userId, 'pending'],
    )
    const orderId = rows[0].id

    for (const item of items) {
      await tx.query(
        'INSERT INTO order_items (order_id, sku, qty, price_cents) VALUES ($1, $2, $3, $4)',
        [orderId, item.sku, item.qty, item.priceCents],
      )
    }

    return orderId
  })
}
```

Three properties worth naming:

- **The callback receives `tx`.** Every repository call inside must take it and use it. A repository function that reaches for the module-level `pool` instead runs *outside* the transaction and will not roll back — this is the second most common transaction bug, after the pool one above.
- **`ROLLBACK` failure is handled.** `client.release(err)` with a truthy argument destroys the connection rather than returning a possibly-broken one to the pool.
- **The original error propagates.** Your error middleware sees the constraint violation, not a confusing rollback error.

The `mysql2` version uses the driver's own transaction methods:

```js title="src/db/with-transaction.js"
import { pool } from './pool.js'

export async function withTransaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    try {
      await conn.rollback()
    } catch { /* connection is gone; the pool will replace it */ }
    throw err
  } finally {
    conn.release()
  }
}
```

```js
await withTransaction(async (tx) => {
  const [result] = await tx.execute('INSERT INTO orders (user_id) VALUES (?)', [userId])
  await tx.execute('INSERT INTO order_items (order_id, sku) VALUES (?, ?)', [result.insertId, sku])
})
```

For SQLite the same idea is simpler because the driver is synchronous — see [SQLite](sqlite.md).

## Isolation levels

The isolation level decides what a transaction sees of concurrent transactions. The defaults differ between the two databases you are most likely to use, which is a real portability trap.

| Level | Dirty read | Non-repeatable read | Phantom read | Lost update |
| --- | --- | --- | --- | --- |
| Read uncommitted | Possible in the standard; **not in Postgres** | Possible | Possible | Possible |
| **Read committed** — Postgres default | No | Possible | Possible | Possible |
| **Repeatable read** — MySQL InnoDB default | No | No | No in InnoDB and Postgres | Possible |
| Serializable | No | No | No | No — the transaction is aborted instead |

- **PostgreSQL** defaults to **read committed**. Each *statement* sees a fresh snapshot taken when that statement starts.
- **MySQL InnoDB** defaults to **repeatable read**. The whole *transaction* sees the snapshot taken at its first read.

The consequence: identical code behaves differently. In Postgres, running the same `SELECT` twice inside one transaction can return different rows. In MySQL it cannot. Code written and tested against one and deployed on the other will surprise you.

Neither default prevents a lost update.

### A concrete lost update

Two requests both add 100 credits to the same account, starting from 500. The correct result is 700.

```js vulnerable title="DO NOT COPY — read, compute in JS, write back"
await withTransaction(async (tx) => {
  const { rows } = await tx.query('SELECT credits FROM accounts WHERE id = $1', [accountId])
  const next = rows[0].credits + 100
  await tx.query('UPDATE accounts SET credits = $1 WHERE id = $2', [next, accountId])
})
```

Interleaved under read committed (and under repeatable read):

| Time | Request A | Request B | Row value |
| --- | --- | --- | --- |
| t0 | `BEGIN` | | 500 |
| t1 | `SELECT credits` → 500 | | 500 |
| t2 | | `BEGIN` | 500 |
| t3 | | `SELECT credits` → 500 | 500 |
| t4 | `UPDATE … = 600` | | 600 |
| t5 | `COMMIT` | | 600 |
| t6 | | `UPDATE … = 600` | 600 |
| t7 | | `COMMIT` | **600** |

100 credits vanished. No error, no warning, no failed constraint. Under load this happens constantly and shows up as an accounting discrepancy nobody can reproduce.

There are three fixes, in order of preference.

**1. Let the database do the arithmetic.** The best fix, because it removes the read-then-write entirely.

```js good
await pool.query('UPDATE accounts SET credits = credits + $1 WHERE id = $2', [100, accountId])
```

A single `UPDATE` takes a row lock for its own duration. The second one blocks until the first commits, then reads the *new* value. No transaction needed, and the result is 700.

**2. Lock the row when you must read it first.** When the new value genuinely depends on application logic.

```js good
await withTransaction(async (tx) => {
  const { rows } = await tx.query(
    'SELECT credits FROM accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  )
  const next = computeNewBalance(rows[0].credits)
  await tx.query('UPDATE accounts SET credits = $1 WHERE id = $2', [next, accountId])
})
```

`FOR UPDATE` takes an exclusive row lock at `SELECT` time. Request B blocks at its `SELECT` until A commits, then reads 600 and writes 700.

**3. Optimistic concurrency.** No locks; detect the conflict instead.

```js good
const { rowCount } = await pool.query(
  'UPDATE accounts SET credits = $1, version = version + 1 WHERE id = $2 AND version = $3',
  [next, accountId, expectedVersion],
)
if (rowCount === 0) throw new ConflictError('account changed, retry')
```

Best when conflicts are rare and lock contention would be worse than an occasional retry.

## SELECT … FOR UPDATE

`FOR UPDATE` locks the selected rows against other writers until the transaction ends. Variants:

| Clause | Effect |
| --- | --- |
| `FOR UPDATE` | Exclusive. Blocks other `FOR UPDATE`, `FOR SHARE`, and writes. |
| `FOR NO KEY UPDATE` | Postgres. Weaker — allows concurrent foreign-key references to the row. |
| `FOR SHARE` | Others may read-lock, nobody may write. |
| `FOR UPDATE NOWAIT` | Errors immediately instead of waiting. |
| `FOR UPDATE SKIP LOCKED` | Skips rows already locked. |

`SKIP LOCKED` is the clean way to build a work queue on a relational database — several workers each claim different rows without contending:

```js title="src/jobs.repo.js"
export function claimJobs(limit) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, payload
         FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    )
    if (rows.length === 0) return []

    await tx.query(
      "UPDATE jobs SET status = 'running', started_at = now() WHERE id = ANY($1::bigint[])",
      [rows.map((r) => r.id)],
    )
    return rows
  })
}
```

Rules for locking:

- **Always lock rows in a consistent order** — by primary key, ascending. Two transactions that lock A then B, and B then A, deadlock.
- **`FOR UPDATE` requires a transaction.** Outside one, the lock is released the instant the statement finishes and buys you nothing.
- **Lock the smallest set for the shortest time.** `SELECT … FOR UPDATE` without a `WHERE` locks the table's worth of rows.
- **Do not lock and then call an external service.** See below.

## Deadlocks and retries

A deadlock is two transactions each holding a lock the other needs. The database detects it and kills one. This is not a bug you can eliminate — it is a normal outcome under concurrency, and the correct handling is to **retry**.

| Database | Condition | Error |
| --- | --- | --- |
| PostgreSQL | Serialization failure | SQLSTATE `40001` |
| PostgreSQL | Deadlock detected | SQLSTATE `40P01` |
| MySQL | Deadlock found, transaction rolled back | `ER_LOCK_DEADLOCK`, errno **1213** |
| MySQL | Lock wait timeout exceeded | `ER_LOCK_WAIT_TIMEOUT`, errno 1205 |

Under `SERIALIZABLE` isolation, Postgres raises `40001` routinely by design — the level is only usable if you retry.

```js title="src/db/with-transaction.js"
const RETRYABLE = new Set(['40001', '40P01'])

export async function withRetryableTransaction(fn, { attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTransaction(fn)
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= attempts) throw err

      // Full jitter: random over the whole backoff window, so retries spread out
      // instead of colliding again on the same schedule.
      const ceiling = Math.min(50 * 2 ** attempt, 1_000)
      await new Promise((r) => setTimeout(r, Math.random() * ceiling))
    }
  }
}
```

For `mysql2`, the retryable set is `['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']` checked against `err.code`.

Two hard requirements:

- **The whole transaction restarts from the top.** You cannot retry one statement — the transaction is already rolled back and its snapshot is gone. This is why `withTransaction` takes a function.
- **`fn` must be safe to run more than once.** It must not send an email, charge a card, or mutate module state. Side effects belong after the commit.

Never retry a constraint violation (`23505`, `ER_DUP_ENTRY`) or a check failure. Those are deterministic — the retry produces the same error and you have burned three round trips to return the same 409. See [Retries and timeouts](retries-and-timeouts.md).

### Setting the isolation level

```js
await withTransaction(async (tx) => {
  await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
  // …
})
```

In Postgres this must be the first statement after `BEGIN`. MySQL uses `SET TRANSACTION ISOLATION LEVEL …` before `START TRANSACTION`, or `SET SESSION TRANSACTION ISOLATION LEVEL …` — and remember that a *session* setting persists on a pooled connection for the next borrower.

## Transactions belong in the service layer

Put the transaction boundary in the service, not the controller and not the repository.

```js title="src/routes/orders.js"
import { Router } from 'express'
import { createOrderSchema } from '../schemas/orders.js'
import * as orders from '../services/orders.service.js'

export const router = Router()

router.post('/orders', async (req, res) => {
  const input = createOrderSchema.parse(req.body)
  const order = await orders.create(req.user.id, input)
  res.status(201).json(order)
})
```

```js title="src/services/orders.service.js"
import { withTransaction } from '../db/with-transaction.js'
import * as orderRepo from '../repos/orders.repo.js'
import * as stockRepo from '../repos/stock.repo.js'
import { emitOrderCreated } from '../events.js'

export async function create(userId, input) {
  const order = await withTransaction(async (tx) => {
    await stockRepo.reserve(tx, input.items)
    return orderRepo.insert(tx, userId, input)
  })

  // Side effects AFTER the commit — never inside.
  emitOrderCreated(order)
  return order
}
```

Why not the controller: the controller's job is HTTP. A transaction that starts there is scoped to the *request*, which means it is open while you validate, serialize and write the response — all time a connection is held and locks are kept.

Why not the repository: a repository function that opens its own transaction cannot be composed. `reserveStock()` and `insertOrder()` each being atomic does not make them atomic *together*, which is the entire requirement. Repository functions should accept `tx` as their first argument and never check out a connection themselves.

The service layer is the only place that knows the business operation, which is exactly the unit that must be atomic. See [Layered architecture](../express/layered-architecture.md).

## Never hold a transaction across a network call

:::danger This will take your database down
```js vulnerable title="DO NOT COPY"
await withTransaction(async (tx) => {
  const { rows } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])

  const charge = await stripe.charges.create({ amount: rows[0].total_cents })  // ← 200ms… or 30s

  await tx.query('UPDATE orders SET status = $1, charge_id = $2 WHERE id = $3',
    ['paid', charge.id, orderId])
})
```
:::

The transaction is open for the entire duration of the HTTP call. Everything that follows is a consequence:

- **A pooled connection is held** for hundreds of milliseconds instead of single digits. At 50 requests per second with a 300 ms provider, you need 15 connections just for this endpoint.
- **Row locks are held** for the same period, so every other request touching that order queues.
- **The provider is slow one day** — a 30-second timeout instead of 200 ms — and your pool is exhausted, your database is full of `idle in transaction` sessions, and the whole service is down. A dependency's latency became your outage.
- **Postgres cannot vacuum** past the oldest open transaction, so long transactions cause table bloat.
- **Correctness is not achieved anyway.** If the commit fails after the charge succeeds, you have taken money and recorded nothing. The transaction did not make the external call atomic; nothing can.

Split it into short transactions with a durable state machine between them:

```js good title="src/services/payments.service.js"
export async function payOrder(orderId, idempotencyKey) {
  // 1. Short transaction: claim the order. Conditional update = no lost race.
  const claimed = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE orders SET status = 'charging', idempotency_key = $1
        WHERE id = $2 AND status = 'pending'
        RETURNING id, total_cents`,
      [idempotencyKey, orderId],
    )
    return rows[0] ?? null
  })
  if (!claimed) throw new ConflictError('order is not payable')

  // 2. No transaction open. The external call can take as long as it likes.
  const charge = await stripe.charges.create(
    { amount: claimed.total_cents },
    { idempotencyKey },
  )

  // 3. Short transaction: record the outcome.
  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE orders SET status = 'paid', charge_id = $1 WHERE id = $2",
      [charge.id, orderId],
    )
  })
}
```

The `'charging'` state is what makes this recoverable. A crash between steps 2 and 3 leaves an order stuck in `charging`, and a reconciliation job can query the provider with the stored idempotency key and finish the job. That is a real system; the single big transaction only looked like one.

The same rule covers anything slow inside a transaction: a queue publish, an S3 upload, a `sleep`, a `console.log` to a blocking stream, and — most often — a loop that awaits per item.

## Security considerations

**Parameterise inside transactions too.** Nothing about `BEGIN` changes injection risk, and a transaction gives an injected statement a larger blast radius: it can read rows the surrounding transaction locked and modify several tables before the commit.

**Do the authorization check inside the transaction, on locked rows.** Checking ownership and then acting in a separate statement is a time-of-check/time-of-use race. `SELECT … WHERE id = $1 AND owner_id = $2 FOR UPDATE` checks and locks in one step.

```js
const { rows } = await tx.query(
  'SELECT id, balance FROM accounts WHERE id = $1 AND owner_id = $2 FOR UPDATE',
  [accountId, req.user.id],
)
if (rows.length === 0) throw new NotFoundError()
```

**Enforce invariants in the database, not only in the transaction.** A `CHECK (balance >= 0)` constraint holds even when a future code path forgets the check. Application logic protects the paths you thought of.

**Long transactions are a denial-of-service vector.** An endpoint that opens a transaction and waits on user-controlled input holds locks and connections. Set `idle_in_transaction_session_timeout` (Postgres) and `innodb_lock_wait_timeout` (MySQL) so an abandoned transaction cannot hold locks indefinitely.

**Do not leak lock or deadlock errors to clients.** A deadlock message names tables, indexes and the competing query. Return 409 and log the detail.

**Money and quota changes must be atomic.** A read-then-write on a balance is not just a bug, it is a way to spend the same funds twice by issuing concurrent requests. Use `UPDATE … SET x = x - $1 WHERE x >= $1` with a `rowCount` check, or `FOR UPDATE`.

## Production considerations

- **Keep transactions short.** Milliseconds. The metric to watch in Postgres is the age of the oldest transaction:

  ```sql
  SELECT pid, state, now() - xact_start AS xact_age, query
    FROM pg_stat_activity
   WHERE xact_start IS NOT NULL
   ORDER BY xact_age DESC
   LIMIT 10;
  ```

- **Set `idle_in_transaction_session_timeout`** (30 s is a reasonable start). Without it, one abandoned transaction blocks vacuum and holds locks forever.
- **Alert on `idle in transaction` sessions.** A rising count is a leaked transaction, and it precedes an outage.
- **Long transactions cause bloat in Postgres.** Vacuum cannot remove row versions newer than the oldest running transaction, so a nightly report that runs for two hours bloats every table written during it.
- **Instrument retries.** A rising deadlock rate means lock ordering changed or contention grew — it is a signal, even though each individual retry succeeded.
- **Cap retry attempts** — three is usually enough — and make the failure a 409, not a 500.
- **Test the rollback path.** Most transaction bugs are on the error path, which is the path that never runs in development. Write a test that throws inside `withTransaction` and asserts the row is absent. See [Testing with a database](../orms/testing-with-a-database.md).
- **Verify the isolation level in each environment.** It is a server setting and can differ between your laptop, CI and production.
- **Fire side effects after the commit.** Emails, webhooks and queue publishes triggered inside a transaction that then rolls back are events for things that never happened.

## Common mistakes

- **`pool.query('BEGIN')`.** The statements land on different connections; nothing is atomic and nothing errors.
- **A repository function inside the callback that uses `pool` instead of `tx`.** It runs outside the transaction and is not rolled back.
- **Releasing outside `finally`.** One error path leaks a connection permanently.
- **Read, compute in JavaScript, write back.** The lost update above. Use `SET x = x + $1`, or `FOR UPDATE`.
- **Assuming `SELECT` inside a transaction is repeatable.** In Postgres's default read committed, it is not.
- **Assuming Postgres and MySQL behave the same.** Different defaults: read committed versus repeatable read.
- **Treating a deadlock as a 500.** It is a retry, and it almost always succeeds on the second attempt.
- **Retrying a unique-constraint violation.** Deterministic — it fails identically every time.
- **Retrying a single statement instead of the whole transaction.** The transaction is already dead.
- **An HTTP call inside a transaction.** The dependency's latency becomes your database's problem.
- **Opening the transaction in the controller.** It stays open across validation and serialization.
- **Sending the confirmation email inside the transaction.** The rollback cannot un-send it.
- **`FOR UPDATE` outside a transaction.** The lock is released immediately; it does nothing.

## Related topics

- [PostgreSQL with pg](postgresql-with-pg.md) — client checkout, SQLSTATE codes and timeouts.
- [MySQL with mysql2](mysql-with-mysql2.md) — `beginTransaction`, deadlock codes and lock wait timeouts.
- [SQLite](sqlite.md) — `BEGIN IMMEDIATE` and the single-writer model.
- [MongoDB](mongodb.md) — sessions, `withTransaction`, and the replica-set requirement.
- [Connection pooling](connection-pooling.md) — why a long transaction is a pool problem.
- [Retries and timeouts](retries-and-timeouts.md) — backoff, jitter and idempotency keys.
- [Layered architecture](../express/layered-architecture.md) — why the boundary belongs in the service.
- [Error handling](../express/error-handling.md) — mapping 40001 and 23505 to sensible status codes.
- [Testing with a database](../orms/testing-with-a-database.md) — testing the rollback path.
