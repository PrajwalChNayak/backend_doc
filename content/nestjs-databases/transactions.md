---
title: Transactions
description: Making a transaction span several Nest services — passing the EntityManager or Prisma tx client explicitly versus AsyncLocalStorage, why REQUEST scope is the wrong tool, and never wrapping an outbound HTTP call.
status: current
updated: 2026-09-11
---

Transactions in Nest are hard for one structural reason: the container hands every service a repository bound to the **pool**, and a transaction lives on a single **connection**. Two services injected side by side get two different connections, so a "transaction" that calls across them commits half its work and rolls back the other half — with no error. Everything on this page is about closing that gap. The database-level material — isolation levels, lost updates, `FOR UPDATE`, deadlock retries — is in [Transactions](../databases/transactions.md) and still applies unchanged.

## The problem, concretely

```ts vulnerable title="DO NOT COPY — this is not atomic"
@Injectable()
export class CheckoutService {
  private readonly dataSource: DataSource
  private readonly stock: StockService
  private readonly orders: OrdersService

  constructor(dataSource: DataSource, stock: StockService, orders: OrdersService) {
    this.dataSource = dataSource
    this.stock = stock
    this.orders = orders
  }

  async checkout(userId: number, items: readonly CartLine[]) {
    return this.dataSource.transaction(async () => {
      // Both of these use their OWN injected repository, which is bound to
      // the pool — not to the transaction this callback opened.
      await this.stock.reserve(items)
      return this.orders.create(userId, items)
    })
  }
}
```

The `transaction()` callback opens a transaction on one checked-out connection and never gives it to anyone. `StockService.reserve` runs on a *different* connection and auto-commits. `OrdersService.create` runs on a third. Throw from `orders.create` and the stock reservation stays. Worse, the reservation can deadlock against the empty transaction the callback is holding.

Nothing about this fails loudly. It passes review, it passes a test that only asserts the happy path, and it produces a support ticket six weeks later about inventory that does not match orders.

There are exactly two mechanisms that fix it. Pick one for the whole codebase.

## Option 1 — pass the unit of work explicitly

Every method that participates takes the transaction as a parameter. Repositories never reach for the injected handle when one is supplied.

```ts title="src/stock/stock.service.ts"
import { Injectable, ConflictException } from '@nestjs/common'
import { InjectEntityManager } from '@nestjs/typeorm'
import { EntityManager } from 'typeorm'
import { StockLevel } from './stock-level.entity.js'

@Injectable()
export class StockService {
  private readonly em: EntityManager

  constructor(@InjectEntityManager() em: EntityManager) {
    this.em = em
  }

  /** `tx` is the transaction's manager when there is one, the pool otherwise. */
  async reserve(items: readonly { sku: string; qty: number }[], tx: EntityManager = this.em) {
    for (const item of items) {
      // A conditional UPDATE: the database does the arithmetic and the check,
      // so two concurrent reservations cannot both succeed on the last unit.
      const result = await tx
        .createQueryBuilder()
        .update(StockLevel)
        .set({ available: () => 'available - :qty' })
        .where('sku = :sku AND available >= :qty', { sku: item.sku, qty: item.qty })
        .execute()

      if (result.affected === 0) throw new ConflictException(`out of stock: ${item.sku}`)
    }
  }
}
```

```ts title="src/checkout/checkout.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { OrdersService } from '../orders/orders.service.js'
import { StockService } from '../stock/stock.service.js'

@Injectable()
export class CheckoutService {
  private readonly dataSource: DataSource
  private readonly stock: StockService
  private readonly orders: OrdersService

  constructor(dataSource: DataSource, stock: StockService, orders: OrdersService) {
    this.dataSource = dataSource
    this.stock = stock
    this.orders = orders
  }

  async checkout(userId: number, items: readonly { sku: string; qty: number }[]) {
    const order = await this.dataSource.transaction(async (tx) => {
      await this.stock.reserve(items, tx)
      return this.orders.create(userId, items, tx)
    })

    // Side effects AFTER the commit. See below.
    return order
  }
}
```

The default parameter — `tx: EntityManager = this.em` — is what makes this tolerable. A service method still works when called outside a transaction, so you are not forced to thread a manager through read paths that do not need one.

**What is good about this:** the transaction boundary is visible in every signature. A reviewer can see, without running anything, whether a call participates. A method that forgot the parameter is a type error the moment the caller passes one.

**What is bad:** it is viral. Adding a transaction to an operation touches every method beneath it, and a repository with fifteen methods grows fifteen optional parameters. On a large codebase that friction is real and people route around it.

:::best-practice
Take the friction as a signal. If passing `tx` through six layers feels absurd, the operation probably should not span six layers. Two services that must commit together are frequently one unit of work that got split for the wrong reason.
:::

Prisma is the same shape with a different type. The interactive `$transaction` callback gives you a client scoped to the transaction:

```ts title="src/checkout/checkout.service.ts"
import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../database/prisma.service.js'

export type Tx = Prisma.TransactionClient

@Injectable()
export class CheckoutService {
  private readonly prisma: PrismaService

  constructor(prisma: PrismaService) {
    this.prisma = prisma
  }

  checkout(userId: number, items: readonly { sku: string; qty: number }[]) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.reserve(tx, items)
        return tx.order.create({ data: { userId, status: 'pending' } })
      },
      { maxWait: 5_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }

  private async reserve(tx: Tx, items: readonly { sku: string; qty: number }[]) {
    for (const item of items) {
      const updated = await tx.stockLevel.updateMany({
        where: { sku: item.sku, available: { gte: item.qty } },
        data: { available: { decrement: item.qty } },
      })
      if (updated.count === 0) throw new Error(`out of stock: ${item.sku}`)
    }
  }
}
```

`maxWait` (how long to wait for a connection, default 2000 ms) and `timeout` (how long the transaction may run, default 5000 ms) are both short on purpose. A transaction that needs more than a few seconds is doing something that does not belong in a transaction.

Prisma also has an **array form** for independent operations that must be atomic:

```ts
const [order, receipt] = await this.prisma.$transaction([
  this.prisma.order.create({ data: { userId, status: 'pending' } }),
  this.prisma.auditLog.create({ data: { userId, action: 'checkout' } }),
])
```

One round trip, one transaction, no callback. It cannot express "use the id from the first statement in the second", which is exactly when you need the interactive form.

:::warning Calling `this.prisma` inside a `$transaction` callback
`prisma.order.create()` instead of `tx.order.create()` inside the callback runs on a different connection, outside the transaction. It will not roll back, and it can deadlock against the rows the transaction holds. This is the single most common Prisma transaction bug, and the type system does not catch it because both objects have the same shape.
:::

## Option 2 — AsyncLocalStorage

`node:async_hooks` gives you a store that follows the async call chain without being passed. One place opens the transaction and puts the manager in the store; repositories read it.

```ts title="src/database/transaction.context.ts"
import { AsyncLocalStorage } from 'node:async_hooks'
import type { EntityManager } from 'typeorm'

export const transactionStorage = new AsyncLocalStorage<EntityManager>()
```

```ts title="src/database/transaction.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager } from 'typeorm'
import { transactionStorage } from './transaction.context.js'

/** TypeORM accepts these as the first argument to `transaction()`. */
export type Isolation = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'

@Injectable()
export class TransactionService {
  private readonly dataSource: DataSource

  constructor(@InjectDataSource() dataSource: DataSource) {
    this.dataSource = dataSource
  }

  /** The manager for the current transaction, or the pool-backed one. */
  get manager(): EntityManager {
    return transactionStorage.getStore() ?? this.dataSource.manager
  }

  run<T>(fn: () => Promise<T>, isolation?: Isolation): Promise<T> {
    // Already inside a transaction: join it rather than nesting a second one.
    const existing = transactionStorage.getStore()
    if (existing) return fn()

    const body = (tx: EntityManager) => transactionStorage.run(tx, fn)
    return isolation
      ? this.dataSource.transaction(isolation, body)
      : this.dataSource.transaction(body)
  }
}
```

```ts title="src/stock/stock.repository.ts"
import { Injectable } from '@nestjs/common'
import { TransactionService } from '../database/transaction.service.js'
import { StockLevel } from './stock-level.entity.js'

@Injectable()
export class StockRepository {
  private readonly tx: TransactionService

  constructor(tx: TransactionService) {
    this.tx = tx
  }

  decrement(sku: string, qty: number) {
    // Reads the ambient manager. No parameter, and correct inside or outside
    // a transaction — as long as every repository goes through `this.tx`.
    return this.tx.manager
      .createQueryBuilder()
      .update(StockLevel)
      .set({ available: () => 'available - :qty' })
      .where('sku = :sku AND available >= :qty', { sku, qty })
      .execute()
  }
}
```

```ts title="src/checkout/checkout.service.ts"
async checkout(userId: number, items: readonly CartLine[]) {
  return this.transactions.run(async () => {
    await this.stock.reserve(items)
    return this.orders.create(userId, items)
  })
}
```

**What is good:** signatures stay clean, existing services need no changes, and adding a transaction around an operation is one line at the top.

**What is bad, and you must know all of it:**

- **The dependency is invisible.** Reading `stock.reserve()` tells you nothing about whether it is transactional. Correctness now depends on a convention nobody can see.
- **One repository that bypasses `this.tx.manager`** — a direct `@InjectRepository` because it was quicker — silently runs outside the transaction. This is the exact bug Option 1 makes impossible, reintroduced as a discipline problem.
- **The context is lost across some boundaries.** `setTimeout`, an `EventEmitter` listener registered outside the store, a `queueMicrotask` scheduled before `run()`, a worker thread, and anything that goes through a native callback that does not preserve async context. A `process.nextTick` inside the store is fine; a listener invoked from outside it is not.
- **Retries need care.** The retry loop must be *outside* `run()`, because a rolled-back transaction's manager is dead. Retrying inside the store re-uses a broken manager.
- **`AsyncLocalStorage` has a measurable cost** under very high throughput. It is small and usually irrelevant, but it is not zero.

The honest summary: **Option 1 for a codebase where transactions are rare and important. Option 2 for a codebase where almost every write is transactional** and threading a parameter through every layer would be its own source of bugs. Decide once, write it in the repository's contributing guide, and enforce it in review. Half a codebase passing managers and half relying on ambient state is how you get a transaction that commits three statements and leaves the fourth outside.

## Why REQUEST scope is the wrong tool

The idea is seductive: make the transaction a `Scope.REQUEST` provider, let Nest build one per request, and inject it everywhere. It does not work, for four independent reasons.

```ts vulnerable title="DO NOT COPY — a transaction per request"
{
  provide: 'TX_MANAGER',
  scope: Scope.REQUEST,
  inject: [getDataSourceToken()],
  useFactory: async (dataSource: DataSource) => {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    return runner.manager
  },
}
```

1. **The lifetime is wrong.** A request is not a unit of work. The transaction opens before validation and stays open while you serialize the response, so a connection and its locks are held for the entire request instead of the few milliseconds the writes take. A slow client makes your database slow.
2. **Nobody commits it.** There is no hook that means "the response succeeded". An interceptor can approximate it, but it has to commit after the handler and roll back on a thrown exception — and it fires for every request including the read-only ones, so now every `GET` opens a transaction.
3. **Scope propagates.** Everything that injects a request-scoped provider becomes request-scoped, and so does everything that injects *those*. The chain reaches controllers, then guards. Nest then instantiates that whole subtree per request, which is a real throughput cost and a subtle behaviour change: a provider you assumed was a singleton now has per-request state.
4. **It is unusable outside HTTP.** A BullMQ processor, a `@Cron` job, a microservice handler and a CLI command have no request context. `REQUEST` injection throws or resolves to `undefined` there, so every transactional operation needs a second, non-request-scoped path — and you are back to Option 1 anyway, for half the code.

[Injection scopes](../nestjs/injection-scopes.md) covers the propagation rules in detail. Read it before making anything request-scoped for any reason.

`AsyncLocalStorage` is what people actually want when they reach for `REQUEST` scope: ambient per-operation context with no effect on provider lifetimes and no dependency on there being an HTTP request at all.

## QueryRunner, when the callback is not enough

`dataSource.transaction()` covers almost everything. Use a `QueryRunner` directly when the transaction's lifetime genuinely cannot be a single function — a saga, a batch that commits every thousand rows, a stream you are consuming.

```ts title="src/imports/import.service.ts"
import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { Row } from './row.entity.js'

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name)
  private readonly dataSource: DataSource

  constructor(@InjectDataSource() dataSource: DataSource) {
    this.dataSource = dataSource
  }

  async importBatched(rows: readonly Partial<Row>[], batchSize = 1_000) {
    const runner = this.dataSource.createQueryRunner()
    await runner.connect()
    let inBatch = 0
    await runner.startTransaction()

    try {
      for (const row of rows) {
        await runner.manager.insert(Row, row)
        if (++inBatch >= batchSize) {
          await runner.commitTransaction()
          await runner.startTransaction()
          inBatch = 0
        }
      }
      await runner.commitTransaction()
    } catch (err) {
      // isTransactionActive guards the case where the failure WAS the commit.
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      throw err
    } finally {
      // Without this the connection is never returned to the pool.
      await runner.release()
    }
  }
}
```

Three things that are non-negotiable with a `QueryRunner`:

- **`release()` in a `finally`.** A runner holds a pooled connection. Forgetting it leaks one connection per call, and the symptom is that every endpoint eventually hangs — see [Connection pooling](connection-pooling.md).
- **Everything goes through `runner.manager`.** An injected repository in the same method runs on a different connection.
- **Check `isTransactionActive` before rolling back.** If the commit itself failed, there is no transaction to roll back and the rollback throws, replacing your real error with a confusing one.

`runner.manager.withRepository(repo)` re-binds an existing custom repository to the runner's connection, which is how you reuse repository methods inside a runner-managed transaction without duplicating them.

## Never hold a transaction across an outbound call

:::danger This is how a dependency's latency becomes your outage
```ts vulnerable title="DO NOT COPY"
await this.dataSource.transaction(async (tx) => {
  const order = await tx.findOneOrFail(Order, {
    where: { id: orderId },
    lock: { mode: 'pessimistic_write' },
  })

  // 200ms on a good day. 30 seconds when the provider is having an incident.
  const charge = await this.payments.charge(order.totalCents)

  await tx.update(Order, orderId, { status: 'paid', chargeId: charge.id })
})
```
:::

Every consequence follows from the transaction being open for the whole HTTP call:

- **A pooled connection is held** for hundreds of milliseconds instead of single digits. At 50 requests per second with a 300 ms provider you need 15 connections for this endpoint alone.
- **Row locks are held** for the same period, so every other request touching that order queues behind it.
- **The provider has a slow day** and your pool is exhausted, your database is full of `idle in transaction` sessions, and the whole service is down — including endpoints that have nothing to do with payments.
- **Postgres cannot vacuum** past the oldest open transaction, so long transactions cause table bloat.
- **It is not even correct.** If the commit fails after the charge succeeded, you have taken money and recorded nothing. A transaction cannot make an external call atomic; nothing can.

The fix is two short transactions with a durable state in between:

```ts good title="src/payments/payments.service.ts"
@Injectable()
export class PaymentsService {
  async payOrder(orderId: number, idempotencyKey: string) {
    // 1. Short transaction: claim the order with a conditional update, so two
    //    concurrent requests cannot both proceed.
    const claimed = await this.dataSource.transaction(async (tx) => {
      const result = await tx
        .createQueryBuilder()
        .update(Order)
        .set({ status: 'charging', idempotencyKey })
        .where('id = :id AND status = :status', { id: orderId, status: 'pending' })
        .returning(['id', 'totalCents'])
        .execute()
      return result.raw[0] ?? null
    })
    if (!claimed) throw new ConflictException('order is not payable')

    // 2. No transaction open. The external call can take as long as it likes,
    //    and the idempotency key makes a retry safe.
    const charge = await this.payments.charge(claimed.totalCents, { idempotencyKey })

    // 3. Short transaction: record the outcome.
    await this.dataSource.transaction(async (tx) => {
      await tx.update(Order, orderId, { status: 'paid', chargeId: charge.id })
    })
  }
}
```

The `'charging'` state is what makes this recoverable. A crash between steps 2 and 3 leaves an order in `charging`, and a reconciliation job can ask the provider about the stored idempotency key and finish the work. That is a real system; the single big transaction only looked like one.

The same rule covers everything slow: a queue publish, an S3 upload, a `@nestjs/axios` call, a `Logger` write to a blocking stream, and — most often — a loop that awaits once per item over a large array.

## Side effects belong after the commit

A Nest codebase has three tempting places to fire an event from inside a transaction, and all three are wrong.

```ts vulnerable title="DO NOT COPY — events for things that never happened"
await this.dataSource.transaction(async (tx) => {
  const order = await this.orders.create(userId, items, tx)
  // If the transaction rolls back after this line, the email is already sent
  // and the job is already queued for an order that does not exist.
  this.events.emit('order.created', order)
  await this.queue.add('send-receipt', { orderId: order.id })
})
```

`@nestjs/event-emitter` listeners run synchronously by default, and a BullMQ `add()` writes to Redis, which has no idea your SQL transaction exists. Move both after the commit:

```ts good
const order = await this.dataSource.transaction((tx) => this.orders.create(userId, items, tx))
this.events.emit('order.created', order)
await this.queue.add('send-receipt', { orderId: order.id })
```

If the event *must* be atomic with the write — a payment notification you cannot afford to lose — use the **outbox pattern**: insert the event as a row inside the same transaction, and have a separate poller publish it and mark it sent. Then the event and the data commit or roll back together, and delivery is a separate, retryable concern.

## Retries belong outside the transaction

A serialization failure (`40001`) or a deadlock (`40P01`, `ER_LOCK_DEADLOCK`) is a normal outcome under concurrency, not a bug. The whole transaction must restart, because its snapshot is gone.

```ts title="src/database/retryable.service.ts"
import { ConflictException, Injectable, Logger } from '@nestjs/common'

const RETRYABLE = new Set(['40001', '40P01', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])

@Injectable()
export class RetryableService {
  private readonly logger = new Logger(RetryableService.name)

  async run<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const code = (err as { code?: string; driverError?: { code?: string } })?.code
          ?? (err as { driverError?: { code?: string } })?.driverError?.code
        if (!code || !RETRYABLE.has(code) || attempt >= attempts) throw err

        this.logger.warn(`retrying after ${code} (attempt ${attempt})`)
        // Full jitter: random over the whole window, so concurrent retries
        // spread out instead of colliding again on the same schedule.
        const ceiling = Math.min(50 * 2 ** attempt, 1_000)
        await new Promise((r) => setTimeout(r, Math.random() * ceiling))
      }
    }
  }
}
```

```ts
// The loop wraps the transaction, never the other way round.
const order = await this.retry.run(() =>
  this.dataSource.transaction((tx) => this.orders.create(userId, items, tx)),
)
```

TypeORM wraps driver errors, so the SQLSTATE is often on `err.driverError.code` rather than `err.code` — check both. Never retry a constraint violation (`23505`, `ER_DUP_ENTRY`): it is deterministic, and you will burn three round trips to return the same 409. And `fn` must be safe to run more than once, which is another reason side effects go after the commit.

`TypeOrmModule`'s `retryAttempts` does **not** help here. It only retries the *initial* connection at bootstrap. See [Retries and timeouts](retries-and-timeouts.md).

## Security considerations

**Parameterise inside transactions too.** `BEGIN` changes nothing about injection risk and makes the blast radius larger: an injected statement inside a transaction can read rows the surrounding transaction locked and modify several tables before the commit. The query builder's `:name` parameters, never concatenation — [SQL injection](../nestjs-security/sql-injection.md).

**Do the authorization check inside the transaction, on locked rows.** Checking ownership in a guard and acting in a later statement is a time-of-check/time-of-use race: the row can change between the two. Fold the check into the locking read:

```ts good
const account = await tx.findOne(Account, {
  where: { id: accountId, ownerId: user.id },
  lock: { mode: 'pessimistic_write' },
})
if (!account) throw new NotFoundException()
```

A `@Guard` that loaded the row earlier proves something about the past. The `WHERE` clause proves it about the row you are about to write.

**Money and quota changes must be atomic in SQL, not in JavaScript.** Read-compute-write on a balance is not just a lost-update bug, it is a way to spend the same funds twice by issuing concurrent requests. Use a conditional `UPDATE … SET x = x - :n WHERE x >= :n` and check the affected count, or take a row lock.

**Enforce the invariant in the database as well.** A `CHECK (balance >= 0)` constraint holds on the code path someone adds next year without reading this page. Application logic only protects the paths you thought of.

**Long transactions are a denial-of-service vector.** An endpoint that opens a transaction and then waits on user-controlled input holds a connection and its locks. Set `idle_in_transaction_session_timeout` (Postgres) and `innodb_lock_wait_timeout` (MySQL) so an abandoned transaction cannot hold locks indefinitely, and set Prisma's `timeout` explicitly.

**Do not leak lock or deadlock errors to clients.** A deadlock message names tables, indexes and the competing query — a free schema disclosure. Map it to 409 in an exception filter and log the detail. [PostgreSQL](postgresql.md) has the filter.

**A rolled-back transaction must not leave an audit gap.** If you record the audit row inside the transaction, a rollback erases the evidence of the attempt. Log the attempt outside the transaction, and the outcome inside it.

## Production considerations

- **Decide between explicit `tx` and `AsyncLocalStorage` once**, write it down, and enforce it in review. Mixed conventions produce transactions that are not.
- **Keep transactions in the service layer.** Not the controller — the boundary would then include validation and serialization time. Not the repository — two individually-atomic methods are not atomic together, which is the whole requirement.
- **Milliseconds, not seconds.** Watch the age of the oldest transaction; in Postgres, `now() - xact_start` from `pg_stat_activity`.
- **Set `idle_in_transaction_session_timeout`.** One abandoned transaction otherwise blocks vacuum and holds locks forever.
- **Alert on `idle in transaction` counts.** A rising number is a leaked transaction and it precedes an outage.
- **No outbound calls inside a transaction.** Add it to the review checklist; it is the single highest-impact rule here.
- **Fire events and enqueue jobs after the commit,** or use an outbox table.
- **Cap retries at three** and return 409, not 500, when they are exhausted.
- **Instrument the retry rate.** A rising deadlock rate means lock ordering changed or contention grew, even though every individual retry succeeded.
- **Test the rollback path.** Most transaction bugs live on the error path, which is the path that never runs in development. Throw inside the callback and assert the row is absent — [Testing with a database](testing-with-a-database.md).
- **Verify the isolation level per environment.** It is a server setting and it differs between a laptop, CI and production; Postgres defaults to read committed and MySQL InnoDB to repeatable read.
- **Release every `QueryRunner` in a `finally`.** It is the only place a Nest app leaks pooled connections by hand.

## Common mistakes

- **`dataSource.transaction()` with services that use their own injected repositories.** Nothing inside is actually in the transaction, and no error is raised.
- **`this.prisma.x` instead of `tx.x` inside a `$transaction` callback.** Runs outside the transaction; can deadlock against it.
- **A repository that reaches for `@InjectRepository` while the codebase uses `AsyncLocalStorage`.** Silently outside the transaction.
- **Making the transaction a `Scope.REQUEST` provider.** Wrong lifetime, nobody commits it, scope propagates to controllers, and it does not exist in jobs.
- **An HTTP call, S3 upload or queue publish inside a transaction.** Someone else's latency becomes your outage.
- **Emitting an event or adding a BullMQ job before the commit.** Notifications for things that never happened.
- **Retrying inside the transaction.** It is already rolled back and its manager is dead; the loop must wrap it.
- **Retrying a unique-constraint violation.** Deterministic — three attempts, same 409.
- **Reading `err.code` only.** TypeORM puts the driver's SQLSTATE on `err.driverError.code`.
- **Forgetting `runner.release()`.** One leaked pooled connection per call.
- **Rolling back without checking `isTransactionActive`.** The rollback throws and hides the real error.
- **Opening the transaction in the controller.** It stays open through validation and response serialization.
- **Read, compute in JavaScript, write back.** A lost update; use a conditional `UPDATE` or a row lock.
- **Relying on `TypeOrmModule`'s `retryAttempts` for deadlocks.** It only covers the initial connection.

## Related topics

- [Transactions](../databases/transactions.md) — isolation levels, lost updates, `FOR UPDATE`, `SKIP LOCKED` and the deadlock table.
- [Injection scopes](../nestjs/injection-scopes.md) — how `Scope.REQUEST` propagates, and why it is not a transaction mechanism.
- [Connections and DI](connections-and-di.md) — why the connection is a singleton and the unit of work is a parameter.
- [TypeORM](../nestjs-orms/typeorm.md) — entities, the query builder and `withRepository` inside Nest.
- [Prisma](../nestjs-orms/prisma.md) — `PrismaService`, the driver adapter and the generated client.
- [Connection pooling](connection-pooling.md) — why a leaked `QueryRunner` takes down every endpoint.
- [Retries and timeouts](retries-and-timeouts.md) — backoff, jitter, which errors are retryable and circuit breaking.
- [Testing with a database](testing-with-a-database.md) — per-test rollback isolation, and testing the rollback path.
- [SQL injection](../nestjs-security/sql-injection.md) — parameterisation in the query builder and in raw queries.
- [Events](../nestjs-libraries/event-emitter.md) — why a listener inside a transaction is a problem.
- [Background jobs with BullMQ](../nestjs-libraries/bullmq.md) — enqueueing after the commit, and the outbox alternative.
