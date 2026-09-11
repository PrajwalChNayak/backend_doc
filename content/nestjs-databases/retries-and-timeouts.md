---
title: Retries and timeouts
description: Bounding database work in a Nest service — statement timeouts on the connection, AbortSignal.timeout(), a retry provider with backoff and jitter, which errors are retryable, and a circuit breaker that fails fast.
status: current
updated: 2026-09-11
---

Every database call needs an upper bound on how long it may take and a decision about what happens when it fails. Nest adds two wrinkles to that: the framework's own `TimeoutInterceptor` ends the *request* without stopping the *query*, and `TypeOrmModule`'s `retryAttempts` covers only the initial connection — both of which read like they solve the problem and do not. The general material on backoff, jitter, idempotency keys and circuit breaking is in [Retries and timeouts](../databases/retries-and-timeouts.md).

## Timeouts at every layer

A request that reaches a database passes through several bounds. Each one must be shorter than the one outside it, or the outer bound fires first and the inner work keeps running.

| Layer | Where it is set in Nest | Typical |
| --- | --- | --- |
| Client / load balancer | outside the app | 30 s |
| HTTP server keep-alive and headers | `server.requestTimeout`, `headersTimeout` | 20 s |
| Request-level interceptor | RxJS `timeout()` in an interceptor | 10 s |
| Connection acquisition | `connectionTimeoutMillis` / `connectTimeout` | 5 s |
| **Statement execution** | `statement_timeout` on the pool | 5 s |
| Transaction lifetime | `idle_in_transaction_session_timeout`, Prisma `timeout` | 10 s |

The one that does real work is `statement_timeout`, because it is enforced by the **server**: the database stops executing and returns an error. Everything above it merely stops waiting.

```ts title="src/database/database.module.ts"
{
  provide: PG_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000,
    }),
}
```

Set it on the connection, not per call site. A connection-level bound is the only one that covers the code path nobody remembered to wrap, and it is the difference between one slow query and a pool full of them.

Where a specific query legitimately needs longer, raise it for that transaction only:

```ts good title="src/reports/reports.repository.ts"
async monthlyRollup(month: string) {
  const client = await this.db.connect()
  try {
    await client.query('BEGIN')
    // SET LOCAL is scoped to this transaction, so the pooled connection goes
    // back to the 5s default for the next borrower.
    await client.query("SET LOCAL statement_timeout = '60s'")
    const { rows } = await client.query('SELECT * FROM monthly_rollup($1)', [month])
    await client.query('COMMIT')
    return rows
  } finally {
    client.release()
  }
}
```

`SET LOCAL`, never `SET`. A session-scoped `SET statement_timeout = '60s'` on a pooled connection is inherited by whichever request borrows it next, and you have quietly removed the bound from a random slice of your traffic.

MySQL has no connection-wide equivalent for writes. `max_execution_time` covers `SELECT` only, and per-statement it is an optimizer hint:

```sql
SELECT /*+ MAX_EXECUTION_TIME(5000) */ id, total_cents FROM orders WHERE user_id = ?
```

For everything else on MySQL the bounds are `innodb_lock_wait_timeout`, `wait_timeout`, and your own `AbortSignal` — which is why the [MySQL](mysql.md) page treats this as a real gap rather than a footnote.

## The interceptor timeout does not cancel the query

This is the Nest-specific trap.

```ts title="src/common/timeout.interceptor.ts"
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, RequestTimeoutException } from '@nestjs/common'
import { Observable, throwError, TimeoutError } from 'rxjs'
import { catchError, timeout } from 'rxjs/operators'

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(10_000),
      catchError((err) =>
        throwError(() => (err instanceof TimeoutError ? new RequestTimeoutException() : err)),
      ),
    )
  }
}
```

This is worth having — it stops a request hanging forever. But understand exactly what it does: it unsubscribes from the observable and sends a 408. **The promise underneath keeps running.** The query is still executing, the connection is still checked out, and the row locks are still held. Under load you now have a client that gave up and a database that has not, which is the worst combination: the caller retries, and each retry adds another query nobody is waiting for.

The interceptor is the outer bound. `statement_timeout` is the one that stops the work. You need both, and the interceptor's value must be larger.

## AbortSignal

`AbortSignal.timeout()` (Node 17.3+) is the composable bound for anything that accepts a signal — `fetch`, `@nestjs/axios`, a driver that supports it, and Terminus's `attempt` callback.

```ts title="src/enrichment/enrichment.service.ts"
import { Injectable, ServiceUnavailableException } from '@nestjs/common'

@Injectable()
export class EnrichmentService {
  async lookup(id: string) {
    try {
      const res = await fetch(`https://api.example.com/v1/records/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!res.ok) throw new Error(`upstream ${res.status}`)
      return res.json()
    } catch (err) {
      // A timeout arrives as a TimeoutError / AbortError, not as a network error.
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ServiceUnavailableException('enrichment timed out')
      }
      throw err
    }
  }
}
```

`AbortSignal.any([signal, AbortSignal.timeout(2_000)])` combines a caller's signal with a deadline, which is how you propagate a request's remaining budget into a downstream call rather than starting a fresh 2-second clock at every layer.

For `pg` specifically, aborting the JavaScript promise does not cancel the server-side query; only `statement_timeout` or `pg_cancel_backend` does. Treat `AbortSignal` as "stop waiting" and `statement_timeout` as "stop working".

## Which errors are retryable

Retrying the wrong error is worse than not retrying: it triples the load during an incident and returns the same failure three round trips later.

| Retryable | Why |
| --- | --- |
| PG `40001` serialization failure | Expected under `SERIALIZABLE`; a retry usually succeeds. |
| PG `40P01` deadlock detected | Normal under concurrency; the victim retries. |
| MySQL `ER_LOCK_DEADLOCK` (1213) | Same. |
| MySQL `ER_LOCK_WAIT_TIMEOUT` (1205) | Contention, not a defect. |
| `ECONNRESET`, `EPIPE`, `ETIMEDOUT` on connect | Transient network or a failover. |
| Mongo `TransientTransactionError` label | Explicitly marked retryable by the server. |

| Never retryable | Why |
| --- | --- |
| PG `23505` / MySQL `ER_DUP_ENTRY` | Deterministic; the retry fails identically. |
| PG `23503`, `23514` — foreign key, check | Same. |
| Syntax errors, `42P01` undefined table | A code or migration bug. |
| Authentication and permission failures | Retrying is a lockout risk. |
| `57014` query canceled by `statement_timeout` | The query is too slow; running it again is too slow again. |
| Anything a `ValidationPipe` would have rejected | Client error. |

`57014` is the one people get wrong. A statement timeout means the work exceeded its budget — retrying spends the budget again, three times, during exactly the incident where the database is already struggling.

## A retry provider

```ts title="src/database/retry.service.ts"
import { Injectable, Logger } from '@nestjs/common'

const RETRYABLE_CODES = new Set([
  '40001',
  '40P01',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT',
])

interface MaybeDriverError {
  code?: string
  driverError?: { code?: string }
}

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  ceilingMs?: number
  label?: string
}

@Injectable()
export class RetryService {
  private readonly logger = new Logger(RetryService.name)

  async run<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const { attempts = 3, baseMs = 50, ceilingMs = 1_000, label = 'db' } = options

    for (let attempt = 1; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const e = err as MaybeDriverError
        // TypeORM wraps the driver error, so the SQLSTATE is often one level down.
        const code = e.code ?? e.driverError?.code
        if (!code || !RETRYABLE_CODES.has(code) || attempt >= attempts) throw err

        // Full jitter: a uniform draw over the whole window. Equal backoff
        // makes every retrying client collide again on the same schedule.
        const ceiling = Math.min(baseMs * 2 ** attempt, ceilingMs)
        const delay = Math.random() * ceiling
        this.logger.warn(`${label}: retrying after ${code}, attempt ${attempt}, waiting ${Math.round(delay)}ms`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
}
```

Three properties that matter:

- **Full jitter, not fixed backoff.** Without it, every client that failed at the same moment retries at the same moment, and the thundering herd repeats at 100 ms, 200 ms, 400 ms.
- **`fn` must be safe to run more than once.** No emails, no charges, no queue publishes inside it. That is the same rule as [Transactions](transactions.md): side effects go after the commit.
- **The retry wraps the whole transaction.** A rolled-back transaction's snapshot is gone, so you cannot retry a single statement inside it.

```ts title="src/checkout/checkout.service.ts"
// The loop is OUTSIDE the transaction, never inside it.
const order = await this.retry.run(
  () => this.dataSource.transaction((tx) => this.orders.create(userId, items, tx)),
  { attempts: 3, label: 'checkout' },
)
```

:::warning `TypeOrmModule`'s `retryAttempts` is a different thing
`retryAttempts` and `retryDelay` in the module options control how many times Nest retries the **initial connection** during bootstrap before failing. They are useful in Docker Compose, where the app starts before the database is listening, and they do nothing at all for a query that fails later. `@nestjs/mongoose` has the same pair with the same meaning.
:::

### Retry budgets

Three attempts per request, multiplied by clients that retry, multiplied by a load balancer that retries, is 27 requests for one user action. During an incident that is the amplification that keeps the database down after the original cause is gone.

Two mitigations worth applying together: cap total retries across a request (not per call), and stop retrying entirely once the failure rate says the dependency is down — which is what a circuit breaker is for.

## Circuit breaking

A breaker turns "every request waits 5 seconds and then fails" into "every request fails in microseconds", which frees the connections, the event loop and the caller's patience.

```ts title="src/database/circuit-breaker.service.ts"
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'

type State = 'closed' | 'open' | 'half-open'

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name)
  private state: State = 'closed'
  private failures = 0
  private openedAt = 0

  private readonly threshold = 5
  private readonly coolDownMs = 10_000

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.coolDownMs) {
        // Fail immediately. No connection borrowed, no query issued.
        throw new ServiceUnavailableException('database circuit is open')
      }
      this.state = 'half-open'
      this.logger.warn('circuit half-open: allowing one probe request')
    }

    try {
      const result = await fn()
      if (this.state !== 'closed') this.logger.log('circuit closed')
      this.state = 'closed'
      this.failures = 0
      return result
    } catch (err) {
      this.failures++
      if (this.state === 'half-open' || this.failures >= this.threshold) {
        this.state = 'open'
        this.openedAt = Date.now()
        this.logger.error(`circuit opened after ${this.failures} failures`)
      }
      throw err
    }
  }
}
```

A provider is the right home for this because it is a singleton: one breaker per process, shared by every caller, which is what makes the failure count meaningful. A breaker constructed per request counts to five and never trips.

Three cautions:

- **One breaker per dependency, not one for everything.** A breaker that opens on a Redis failure and then blocks Postgres has turned a degraded cache into an outage.
- **A breaker across replicas is not shared.** Each process learns independently. That is usually fine and occasionally surprising.
- **Do not put a breaker in front of the primary database if you have no fallback.** Failing fast with a 503 is only better than failing slowly if something upstream benefits. It usually does — the connections are freed — but say so deliberately rather than by accident.

Export the state as a metric. A breaker that opens and closes repeatedly is a signal you want in a graph, not only in a log line.

## Security considerations

**Retries are an amplification vector.** An attacker who can reliably trigger a retryable error gets 3× the database work per request, for free. Cap attempts, apply a per-request budget, and rate-limit endpoints that do expensive work — [Rate limiting and abuse](../nestjs-security/rate-limiting.md).

**Never retry an authentication failure.** Three attempts per request against an account-lockout policy locks the account three times as fast, which turns a login form into a denial-of-service tool against a named user.

**Never retry a non-idempotent write without an idempotency key.** A retry after a timeout can double-charge, double-ship or double-post — the first attempt may well have succeeded before the client stopped waiting. Generate the key on the client, store it with a unique constraint, and return the first result on a repeat.

**An unbounded query is an availability hole.** Any endpoint that can hold a connection for a long time is an amplification primitive: a handful of concurrent requests occupies the whole pool and everything else, including the health probe, starts timing out. `statement_timeout`, `LIMIT`, and a bound on any user-supplied page size.

**Do not leak timeout or breaker detail to clients.** "statement timeout after 5000ms on query SELECT … FROM orders JOIN …" tells an attacker which endpoints are expensive and what the schema looks like. Return 503 with a status word, log the rest.

**Set `Retry-After` deliberately.** It is useful for legitimate clients and it also tells an attacker exactly when to come back. A short, jittered value is fine; the exact remaining cool-down is more than they need.

**Bound the retry delay.** An unbounded exponential backoff inside a request handler holds the request — and its connection, if one was already borrowed — for the whole sleep. Cap the ceiling and release the connection before sleeping.

## Production considerations

- **`statement_timeout` on the connection**, not only per call site. It is the only server-enforced bound.
- **`SET LOCAL`, never `SET`,** when raising it for one query. A session setting outlives the request on a pooled connection.
- **`connectionTimeoutMillis` explicitly.** The `pg` default waits forever, so pool exhaustion presents as hung requests.
- **An interceptor timeout as the outer bound**, larger than the statement timeout, and with the knowledge that it does not cancel the query.
- **Full jitter on every backoff.** Fixed backoff synchronises the herd.
- **Three attempts, then 409 or 503** — not 500, and not a fourth attempt.
- **Never retry `57014`, `23505` or any constraint violation.** Deterministic failures.
- **Check `err.driverError.code` as well as `err.code`** when using TypeORM.
- **Instrument the retry rate and the breaker state.** Rising retries that all succeed are still a signal that contention changed.
- **A retry budget per request**, not per call, so nested retries cannot multiply.
- **One breaker per dependency**, as a singleton provider.
- **Idempotency keys on every non-idempotent write** that a client may retry.
- **Test the timeout path.** `SELECT pg_sleep(10)` against a 5-second `statement_timeout` should produce `57014` and a clean 503, with the connection returned to the pool.

## Common mistakes

- **Relying on `TypeOrmModule`'s `retryAttempts` for query failures.** It only covers the initial connection.
- **Assuming the interceptor's `timeout()` cancels the query.** It stops waiting; the database keeps working and the connection stays busy.
- **No `statement_timeout`.** One missing index holds a connection for minutes.
- **`SET statement_timeout` without `LOCAL`.** The next borrower of that pooled connection inherits it.
- **Retrying inside the transaction.** It is already rolled back; the loop must wrap it.
- **Retrying a unique-constraint violation.** Three round trips for the same 409.
- **Retrying a statement timeout.** The query is slow; it will be slow again.
- **Fixed backoff with no jitter.** Every client collides again on the same schedule.
- **Reading only `err.code` with TypeORM.** The SQLSTATE is on `driverError`.
- **Side effects inside the retried function.** Two emails, two charges.
- **A per-request circuit breaker.** It never accumulates enough failures to trip.
- **One breaker shared across unrelated dependencies.** A cache failure blocks the database.
- **No idempotency key on a retried write.** A timeout that actually succeeded becomes a duplicate.
- **An unbounded backoff sleep while holding a connection.** The pool drains while nothing is running.

## Related topics

- [Retries and timeouts](../databases/retries-and-timeouts.md) — layered timeouts, backoff maths, idempotency keys and circuit breaking outside a framework.
- [Transactions](transactions.md) — why the retry loop wraps the transaction, and side effects after the commit.
- [Connection pooling](connection-pooling.md) — why an unbounded query exhausts the pool and how it presents.
- [PostgreSQL](postgresql.md) — `statement_timeout`, `57014` and the SQLSTATE-to-HTTP filter.
- [MySQL](mysql.md) — `max_execution_time`, `innodb_lock_wait_timeout` and the missing connection-wide bound.
- [Health checks](health-checks.md) — `withTimeout()` on every probe, and the `AbortSignal` it hands you.
- [Interceptors](../nestjs-request-handling/interceptors.md) — where the request-level timeout sits in the lifecycle.
- [Rate limiting and abuse](../nestjs-security/rate-limiting.md) — bounding the traffic that retries amplify.
- [Redis](redis.md) — treating a cache error as a miss instead of retrying it.
- [Observability](../nestjs-production/observability.md) — retry rate, breaker state and query duration as metrics.
