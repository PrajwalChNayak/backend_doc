---
title: Retries and timeouts
description: Bounding database work at every layer with AbortSignal.timeout, retrying only the errors that are retryable, exponential backoff with full jitter, idempotency keys and circuit breaking.
status: current
updated: 2026-09-08
---

Every call to a database can hang or fail. A timeout bounds how long you are willing to wait; a retry decides whether to try again. Get either wrong and a small database problem becomes a total outage — retries amplify load exactly when the system is least able to take it.

## Timeouts at every layer

A request passes through several layers, and each one needs its own bound. A timeout at only one layer leaves the others free to hang.

| Layer | Setting | Typical value |
| --- | --- | --- |
| HTTP server | `server.requestTimeout` | 15 s |
| Route handler | `AbortSignal.timeout()` | 10 s |
| Pool acquisition | `connectionTimeoutMillis` / `connectTimeout` | 3 s |
| Statement execution | `statement_timeout` (PG) / `max_execution_time` (MySQL) | 5 s |
| Lock acquisition | `lock_timeout` / `innodb_lock_wait_timeout` | 3 s |
| Transaction idleness | `idle_in_transaction_session_timeout` | 30 s |
| Outbound HTTP | `AbortSignal.timeout()` on `fetch` | 5 s |

**Budgets must nest.** Each inner timeout should be shorter than the one containing it, or the outer one fires first and you lose the specific error that would have told you what went wrong. The order above is roughly outermost to innermost.

```js title="src/db/pool.js"
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 3_000,      // acquiring a connection
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,            // enforced by the server
  query_timeout: 6_000,                // enforced by the driver, slightly later
  idle_in_transaction_session_timeout: 30_000,
})
```

`query_timeout` sits just above `statement_timeout` deliberately. The server-side cancel should win, because it actually stops the work and returns a real SQLSTATE (`57014`). A driver-side timeout only rejects the promise in Node — the query keeps running and keeps holding a connection.

:::warning A timeout that does not cancel is not a timeout
`Promise.race` against a `setTimeout` rejects your promise but does nothing to the query. The database keeps executing it, the connection stays checked out, and under load you accumulate abandoned work while your pool empties. Always pair a client-side bound with a server-side one.
:::

## AbortSignal.timeout()

`AbortSignal.timeout(ms)` (available from Node 17.3) returns a signal that aborts itself. It is the standard way to bound anything that accepts a signal, and it composes with `AbortSignal.any()`.

For `fetch`, it does the whole job:

```js title="src/clients/billing.js"
export async function fetchInvoice(id) {
  const res = await fetch(`https://billing.internal/invoices/${id}`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`billing responded ${res.status}`)
  return res.json()
}
```

The `pg` driver does not take an `AbortSignal`, so bound it at the server and use the signal to give up waiting:

```js title="src/db/query.js"
import { pool } from './pool.js'

export async function queryWithDeadline(text, values, signal) {
  const client = await pool.connect()
  try {
    const running = client.query(text, values)

    const aborted = new Promise((_, reject) => {
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })

    return await Promise.race([running, aborted])
  } finally {
    // Destroy rather than reuse: the connection may still be running the query.
    client.release(signal.aborted ? new Error('aborted') : undefined)
  }
}
```

Note the `release(err)`. If you abandon a query, returning that connection to the pool hands the next caller a connection with a query still in flight on it.

Tie a per-request deadline to the client actually going away, so work stops when nobody is waiting for it:

```js title="src/routes/reports.js"
router.get('/reports/:id', async (req, res) => {
  // Abort when the client goes away…
  const disconnect = new AbortController()
  res.on('close', () => disconnect.abort(new Error('client disconnected')))

  // …or when the deadline passes, whichever happens first.
  const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(10_000)])

  const report = await buildReport(req.params.id, signal)
  res.json(report)
})
```

`AbortSignal.any()` is available from Node 20. Combining a deadline with a disconnect signal means an abandoned request stops doing database work rather than running to completion for nobody — which matters most for exactly the expensive endpoints users give up on.

## Which errors are retryable

Retrying the wrong error is worse than not retrying: you turn one failure into three, at the moment the system is already struggling.

The test is: **would running this again, unchanged, plausibly succeed?**

### Retryable

| Error | Postgres | MySQL | Why |
| --- | --- | --- | --- |
| Connection reset | `ECONNRESET` | `ECONNRESET`, `PROTOCOL_CONNECTION_LOST` | The connection died; a new one may work. |
| Connection refused | `ECONNREFUSED` | `ECONNREFUSED` | Server restarting or failing over. |
| Serialization failure | `40001` | — | Concurrency conflict; the retry sees a new snapshot. |
| Deadlock | `40P01` | `ER_LOCK_DEADLOCK` (1213) | The other transaction has finished. |
| Lock wait timeout | — | `ER_LOCK_WAIT_TIMEOUT` (1205) | The lock holder has probably committed. |
| Too many connections | `53300` | `ER_CON_COUNT_ERROR` (1040) | Transient — but back off hard; retrying fast makes it worse. |
| Cannot connect now | `57P03` | — | The server is starting up. |

### Never retryable

| Error | Postgres | MySQL | Why |
| --- | --- | --- | --- |
| Unique violation | `23505` | `ER_DUP_ENTRY` (1062) | Deterministic. It fails identically forever. |
| Foreign key violation | `23503` | 1452 | The referenced row still will not exist. |
| Not-null / check violation | `23502`, `23514` | 1048, 3819 | The data is wrong; retrying does not change it. |
| Syntax error | `42601` | 1064 | A bug in your code. |
| Undefined column or table | `42703`, `42P01` | 1054, 1146 | A missing migration. |
| Permission denied | `42501` | 1142 | A configuration problem. |
| Invalid input syntax | `22P02` | — | Bad input; return 400. |

### It depends

- **`57014` query_canceled** — `statement_timeout` fired. Retrying an identical query that just exceeded its budget usually exceeds it again. Retry only if you believe the cause was transient contention, and never more than once.
- **Application-level timeouts** on writes — see the idempotency section below. You do not know whether the write landed.

```js title="src/db/retry.js"
const RETRYABLE_PG = new Set(['40001', '40P01', '53300', '57P03', '08006', '08003'])
const RETRYABLE_NET = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'])

export function isRetryable(err) {
  return RETRYABLE_PG.has(err?.code) || RETRYABLE_NET.has(err?.code)
}
```

An **allow-list, never a deny-list.** A deny-list retries every error you have not thought of yet, which is the set most likely to be a bug in your code.

## Exponential backoff with full jitter

Retrying immediately, or on a fixed interval, is how you turn a brief blip into a sustained outage. Every client that failed at the same moment retries at the same moment — a synchronized wave that keeps the recovering database saturated.

Exponential backoff spreads the retries out over time. **Jitter** spreads them across *clients*, which is the part that actually matters.

```js title="src/db/retry.js"
const BASE_MS = 50
const CAP_MS = 2_000

/** Full jitter: sleep for a uniformly random duration in [0, min(cap, base * 2^n)]. */
function fullJitterDelay(attempt) {
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** attempt)
  return Math.random() * ceiling
}

export async function withRetry(fn, { attempts = 3, retryable = isRetryable } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (!retryable(err) || attempt >= attempts - 1) throw err
      await new Promise((r) => setTimeout(r, fullJitterDelay(attempt)))
    }
  }
}
```

Why **full** jitter rather than a small random addition: with `delay = base * 2^n + random(0, 100)`, a thousand clients still retry inside the same narrow window. With `delay = random(0, base * 2^n)` they spread across the whole window, and the load on the recovering database is roughly flat instead of spiky. This is the variant AWS's architecture guidance recommends, and the difference is measurable.

The resulting windows:

| Attempt | Window | Example delay |
| --- | --- | --- |
| 0 | 0–50 ms | 31 ms |
| 1 | 0–100 ms | 74 ms |
| 2 | 0–200 ms | 12 ms |
| 3 | 0–400 ms | 355 ms |

**Cap the attempts, and cap the total.** Three attempts is usually right for a request path. The whole retry sequence must fit inside the request's deadline — retrying for 8 seconds inside a 5-second budget just means the client sees a timeout instead of the real error.

```js
const user = await withRetry(() =>
  pool.query('SELECT id, email FROM users WHERE id = $1', [id]),
)
```

:::warning Do not retry at more than one layer
A retry in the repository, inside a retry in the service, inside a retry in the HTTP client, is 3 × 3 × 3 = 27 attempts for one logical request. Retry at exactly one layer — usually the closest one to the failure — and make the others propagate.
:::

## Idempotency keys for retried writes

Reads are safe to retry. Writes are not, and the dangerous case is not a clean failure — it is a **timeout**, where you genuinely do not know whether the write landed.

```text
Client → INSERT INTO payments … → server executes it → COMMIT → response lost
Client sees ETIMEDOUT. Retries. Now there are two payments.
```

The fix is to make the operation idempotent, so that executing it twice has the same effect as executing it once.

**1. A unique constraint on a caller-supplied key.** The database is the arbiter; no application check can race.

```sql
CREATE TABLE payments (
  id              bigserial PRIMARY KEY,
  idempotency_key text NOT NULL,
  user_id         bigint NOT NULL REFERENCES users (id),
  amount_cents    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_idempotency_key_uniq UNIQUE (idempotency_key)
);
```

```js title="src/services/payments.service.js"
export async function createPayment({ idempotencyKey, userId, amountCents }) {
  const { rows } = await pool.query(
    `INSERT INTO payments (idempotency_key, user_id, amount_cents)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, user_id, amount_cents, created_at`,
    [idempotencyKey, userId, amountCents],
  )

  // Zero rows means this key was already used — return the original result.
  if (rows.length === 0) {
    const existing = await pool.query(
      'SELECT id, user_id, amount_cents, created_at FROM payments WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    return { payment: existing.rows[0], replayed: true }
  }

  return { payment: rows[0], replayed: false }
}
```

A retry with the same key returns the original payment and creates nothing. The `ON CONFLICT DO NOTHING` plus the follow-up `SELECT` is the important shape — `DO NOTHING` returns no rows, which is why the second query exists.

**2. The key comes from the client**, in an `Idempotency-Key` header, and it must be generated once for the logical operation — not once per attempt.

```js title="src/routes/payments.js"
router.post('/payments', async (req, res) => {
  const key = req.get('Idempotency-Key')
  if (!key || key.length > 255) {
    return res.status(400).json({ error: 'Idempotency-Key header required' })
  }

  const { payment, replayed } = await createPayment({
    idempotencyKey: key,
    userId: req.user.id,
    amountCents: req.body.amountCents,
  })

  res.status(replayed ? 200 : 201).json(payment)
})
```

**3. Scope the key to the user.** A global key namespace lets one caller guess or collide with another's key and read back their result. Make the unique constraint `(user_id, idempotency_key)`.

**4. Expire old keys.** The table grows forever otherwise. A 24-hour retention with a scheduled delete is normal, and it must be longer than your longest retry window.

**5. Conditional updates are idempotent for free.** `UPDATE orders SET status = 'shipped' WHERE id = $1 AND status = 'paid'` applied twice ships once; the second call affects zero rows.

Pass the same key to downstream providers too — most payment APIs accept an idempotency key for exactly this reason. See [Transactions](transactions.md) for the state-machine pattern that makes external calls recoverable.

## Circuit breaking

Retries assume the failure is transient. When the database is genuinely down, every request retries three times with backoff, and you have tripled the load on a dead dependency while every request holds a connection and a request slot for seconds.

A circuit breaker stops that. After enough consecutive failures it **fails immediately** for a cooldown period, without attempting the call.

```js title="src/db/breaker.js"
export function createBreaker({ threshold = 5, cooldownMs = 10_000, halfOpenTrials = 1 } = {}) {
  let failures = 0
  let openedAt = 0
  let trials = 0

  return async function run(fn) {
    const now = Date.now()

    if (failures >= threshold) {
      if (now - openedAt < cooldownMs) {
        // OPEN: fail fast. No connection is used, no time is spent.
        const err = new Error('circuit open')
        err.code = 'CIRCUIT_OPEN'
        throw err
      }
      // HALF-OPEN: let a small number of probes through.
      if (trials >= halfOpenTrials) {
        const err = new Error('circuit open')
        err.code = 'CIRCUIT_OPEN'
        throw err
      }
      trials += 1
    }

    try {
      const result = await fn()
      failures = 0
      trials = 0
      return result
    } catch (err) {
      failures += 1
      if (failures === threshold) openedAt = Date.now()
      trials = 0
      throw err
    }
  }
}
```

The three states:

| State | Behavior | Transition |
| --- | --- | --- |
| **Closed** | Calls pass through | Opens after `threshold` consecutive failures |
| **Open** | Every call fails instantly | After `cooldownMs`, becomes half-open |
| **Half-open** | A small number of probes pass | One success closes it; one failure re-opens it |

What the breaker buys you:

- **The failing dependency gets a chance to recover** instead of being hammered by retries.
- **Requests fail in microseconds**, so your connection pool and request slots stay free for endpoints that do not need this dependency.
- **The failure is explicit.** `CIRCUIT_OPEN` is a clear signal to return 503 with a `Retry-After` header.

Order matters: **retry inside, breaker outside.** A retry handles a single flaky call; the breaker observes the outcome of the whole retried operation. Reversed, the breaker counts each retry as a failure and opens far too eagerly.

```js
const result = await breaker(() => withRetry(() => pool.query(sql, values)))
```

Scope one breaker per dependency — one for Postgres, one for Redis, one per external API. A shared breaker takes out healthy dependencies when one fails.

For a cache, the breaker's open state should mean "skip the cache and go to the database", not "fail the request". See [Redis](redis.md).

## Security considerations

**Retries multiply load, including attacker-supplied load.** An endpoint that retries three times turns each malicious request into three database queries. Put rate limiting in front of anything expensive, and count the retries in your capacity planning. See [Rate limiting](../express-libraries/rate-limiting.md).

**Never retry an authentication failure automatically.** Retrying a failed login triples the rate at which you consume your own brute-force protection budget, and a retry loop around a credential check is an accidental password-spraying tool.

**Idempotency keys are a security boundary.** Scope the unique constraint to the user. A global namespace means a caller who guesses another user's key can read back that user's result from the replay path — an information disclosure. Require an opaque, high-entropy key such as a UUID, and reject keys that are too short.

**Do not leak retry internals to clients.** "Attempt 3 of 3 failed: connection to prod-pg-primary.internal:5432 refused" tells an attacker your topology and that you are currently degraded. Return 503 with a `Retry-After`.

**A missing timeout is a denial-of-service vector.** One unbounded query on an unauthenticated endpoint occupies a connection indefinitely. A handful of them exhaust the pool and take the service down without any authentication at all. `statement_timeout` is a security control.

**Bound the retry budget per request.** Without a total cap, a retry loop with backoff holds a request slot and a connection for the full sequence. Attacker-controlled slow requests plus retries is a resource-exhaustion attack.

**Circuit-breaker state is a signal.** Do not expose it publicly — an endpoint that reports which dependencies are open tells an attacker exactly what is currently fragile.

## Production considerations

- **Set every timeout in the table at the top.** Missing one means that layer can hang forever.
- **Keep budgets nested** — inner shorter than outer — so the specific error surfaces rather than the generic one.
- **Prefer server-enforced timeouts.** `statement_timeout` stops the work; a client-side race only stops waiting for it.
- **Retry at exactly one layer.** Audit for nested retries; the multiplication is invisible until an incident.
- **Always use full jitter.** Fixed or lightly-jittered backoff synchronizes your fleet into waves.
- **Cap total retry time inside the request deadline.** Otherwise the client sees a timeout instead of your careful error.
- **Instrument retries as a metric,** with the error code as a label. A rising `40P01` rate is a lock-ordering problem; a rising `ECONNRESET` rate is an infrastructure problem. Both are invisible if the retry succeeds.
- **Alert on the circuit opening.** It is the cleanest possible signal that a dependency is down.
- **Make writes idempotent before you make them retryable.** Otherwise a timeout produces duplicates and you will not find out from the logs.
- **Test the failure paths.** Stop the database mid-test; kill a connection with `pg_terminate_backend`; add latency with a proxy. Retry logic that has never failed in a test has never been verified.
- **Do not retry inside a transaction.** Retry the whole transaction — see [Transactions](transactions.md).
- **Set `Retry-After` on 503 responses** so well-behaved clients back off with you rather than against you.

## Common mistakes

- **No timeout at all**, relying on the driver's defaults — which are frequently unlimited.
- **A client-side timeout with no server-side cancel.** The query keeps running and keeps holding the connection.
- **Retrying a unique violation.** Three identical failures and a 409 three round trips later.
- **Retrying with a deny-list.** Every unanticipated error — including your bugs — gets retried.
- **Fixed-interval retries.** A synchronized retry storm that prevents recovery.
- **Jitter added to the delay rather than replacing it.** Still synchronized, just fuzzier.
- **Nested retries at three layers.** 27 attempts for one request.
- **Retrying a write with no idempotency key.** Duplicate payments, duplicate orders, duplicate emails.
- **Generating a new idempotency key per attempt.** Defeats the entire mechanism.
- **A global idempotency namespace.** Cross-user replay.
- **Retrying a single statement inside a failed transaction.** It is already rolled back.
- **A breaker inside a retry.** The breaker counts retries and opens on a single flaky call.
- **One breaker for every dependency.** Redis being down takes Postgres out too.
- **Not releasing an abandoned connection with an error.** The next caller gets a connection with a query still running on it.

## Related topics

- [Transactions](transactions.md) — retrying whole transactions on 40001 and 1213.
- [Connection pooling](connection-pooling.md) — acquisition timeouts and why exhaustion looks like latency.
- [Health checks](health-checks.md) — bounded probes, and reporting degraded instead of dead.
- [PostgreSQL with pg](postgresql-with-pg.md) — `statement_timeout`, `query_timeout` and SQLSTATE codes.
- [MySQL with mysql2](mysql-with-mysql2.md) — `max_execution_time` and the deadlock codes.
- [Redis](redis.md) — failing open on a cache instead of failing the request.
- [Error handling](../express/error-handling.md) — mapping retry exhaustion to 503 with `Retry-After`.
- [Rate limiting](../express-libraries/rate-limiting.md) — capping the load that retries amplify.
- [Observability](../production/observability.md) — the metrics that make retries visible.
