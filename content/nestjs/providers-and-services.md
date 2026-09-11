---
title: Providers and services
description: What a provider is in Nest 12, what belongs in a service versus a repository, and why keeping Request and Response out of the lower layers is both a design rule and a performance one.
status: current
updated: 2026-09-11
---

A **provider** is anything the container can construct and hand to something else: a service, a repository, a factory, a configuration object, a third-party client. A **service** is the most common kind — a class holding business rules, marked `@Injectable()` and listed in a module's `providers` array. The distinction matters because "provider" is a container concept and "service" is an architecture one, and confusing them is how you end up with HTTP status codes inside a pricing calculation.

## Why it exists

The service layer is where a rule can live without knowing how it was triggered. An order can be placed by an HTTP request, by a queue consumer replaying a failed job, by a CLI backfill, or by a test. All four need the same rule; only one of them has a `Request` object.

Nest does not enforce this. It gives you classes and a container, and a controller that opens a database connection compiles and runs perfectly. The discipline is yours, and it is the entire difference between a Nest application and an Express application wearing decorators.

## `@Injectable()` and the providers array

Two things make a class usable by the container, and you need both.

```ts title="src/orders/orders.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { OrdersRepository } from './orders.repository.js'

@Injectable()
export class OrdersService {
  private readonly repository: OrdersRepository

  constructor(repository: OrdersRepository) {
    this.repository = repository
  }

  async findById(id: string) {
    const order = await this.repository.findById(id)
    if (!order) throw new NotFoundException('order not found')
    return order
  }
}
```

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { OrdersRepository } from './orders.repository.js'
import { OrdersService } from './orders.service.js'

@Module({
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
```

`@Injectable()` marks the class as something whose **own** constructor dependencies should be resolved. The `providers` entry registers it under a token — by default, the class itself. A class with `@Injectable()` that no module lists does not exist to the container; a class in `providers` without `@Injectable()` can be constructed only if it has no dependencies, and fails at bootstrap if it has any.

:::note
The constructor above assigns the field explicitly instead of using the `constructor(private readonly repository: OrdersRepository)` shorthand. Nest treats them identically. The longer form is used throughout this section because parameter properties are not erasable TypeScript syntax — see [Native TypeScript support](../node/native-typescript-support.md). Use whichever your project's build supports; nothing in Nest depends on the choice.
:::

## What goes in which class

| Class | Owns | Must never contain |
| --- | --- | --- |
| **Controller** | route paths, reading the request, status codes, response shape | business rules, queries, ORM calls |
| **Service** | business rules, orchestration, transaction boundaries, domain errors | `Request`, `Response`, header names, `res.status` |
| **Repository** | queries, mapping rows to domain objects, database specifics | business rules, HTTP concepts |

Two prohibitions carry the weight.

### No `Request` or `Response` below the controller

In plain Express the rule is "do not pass `req` down". In Nest it has a second, sharper edge: injecting the request token makes the service **request-scoped**, and every provider that depends on it becomes request-scoped too, all the way up the chain.

```ts
// Wrong: the rule is now HTTP-only, and the whole injection chain above
// PricingService is instantiated once per request.
import { Inject, Injectable, Scope } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import type { Request } from 'express'

@Injectable({ scope: Scope.REQUEST })
export class PricingService {
  private readonly request: Request

  constructor(@Inject(REQUEST) request: Request) {
    this.request = request
  }

  quote() {
    return this.calculate(this.request.body.items)
  }
}
```

```ts
// Right: plain values in, plain values out. Callable from a controller, a queue
// consumer, a cron job or a test — and a singleton.
import { Injectable } from '@nestjs/common'

@Injectable()
export class PricingService {
  quote(items: OrderItem[]) {
    return this.calculate(items)
  }
}
```

The architectural mistake and the performance mistake are the same mistake. [Injection scopes](injection-scopes.md) has the numbers.

The same applies to per-request context that is *not* the request object: a tenant id, a correlation id, the current user. Pass them as arguments. If threading them through four layers is genuinely intolerable, the honest tool is `AsyncLocalStorage` rather than a request-scoped provider — see [Runtime and the event loop](../node/runtime-and-event-loop.md).

### No queries in a controller

A query written in a handler cannot be enlisted in a transaction the service owns, cannot be reused by the worker that needs the same read, and pulls the schema into the layer that formats JSON. One file should change when a column is renamed.

## Services throw, they do not choose status codes

A service says *what went wrong*; the filter chain decides what that means over HTTP. Nest's built-in exceptions are a convenient middle ground, because they carry a status without the service touching a response object.

```ts title="src/orders/orders.service.ts"
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'

@Injectable()
export class OrdersService {
  async refund(id: string, amountCents: number) {
    const order = await this.repository.findById(id)
    if (!order) throw new NotFoundException('order not found')
    if (order.status !== 'paid') throw new ConflictException('order is not refundable')
    if (amountCents > order.totalCents) throw new ForbiddenException('amount exceeds order total')
    return this.repository.markRefunded(id, amountCents)
  }
}
```

:::best-practice
`NotFoundException` from `@nestjs/common` is the pragmatic choice for an application service. If the same rules are shared with a non-HTTP entry point — a microservice transport, a CLI — define plain domain errors instead and map them in one [exception filter](../nestjs-request-handling/exception-filters.md). The point is that the mapping exists in exactly one place, not which library the error class comes from.
:::

Nest 12 lets you attach a stable machine-readable code, which clients can branch on without parsing English:

```ts
import { ConflictException } from '@nestjs/common'

throw new ConflictException('order is not refundable', { errorCode: 'ORDER_NOT_REFUNDABLE' })
```

## Providers that are not services

The `providers` array takes more than classes. The four custom-provider forms are the container's configuration surface, and they show up constantly in real applications.

```ts title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import pg from 'pg'

export const DATABASE_POOL = Symbol('DATABASE_POOL')

@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (config: ConfigService) =>
        new pg.Pool({ connectionString: config.getOrThrow<string>('DATABASE_URL') }),
      inject: [ConfigService],
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
```

A factory provider is how a third-party object that Nest knows nothing about — a pool, an S3 client, a Redis connection — becomes injectable and, more importantly, **mockable**. The consumer asks for the token; the test supplies a different value for that token. Full coverage of `useClass`, `useValue`, `useFactory` and `useExisting` is in [Dependency injection](dependency-injection.md).

## Repositories

A repository is a provider whose job is queries. Keeping it separate from the service is what lets the service be unit-tested with a plain object.

```ts title="src/orders/orders.repository.ts"
import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { DATABASE_POOL } from '../database/database.module.js'

@Injectable()
export class OrdersRepository {
  private readonly pool: pg.Pool

  constructor(@Inject(DATABASE_POOL) pool: pg.Pool) {
    this.pool = pool
  }

  async findById(id: string) {
    const { rows } = await this.pool.query('SELECT * FROM orders WHERE id = $1', [id])
    return rows[0] ?? null
  }

  async markRefunded(id: string, amountCents: number) {
    const { rows } = await this.pool.query(
      'UPDATE orders SET status = $1, refunded_cents = $2 WHERE id = $3 RETURNING *',
      ['refunded', amountCents, id],
    )
    return rows[0]
  }
}
```

Parameterized queries, always. String interpolation into SQL is the vulnerability with the highest hit rate in this entire handbook — see [SQL injection](../nestjs-security/sql-injection.md).

Return domain objects rather than raw rows once the shape stabilizes. A `snake_case` row that reaches a controller makes your column names a public API, and renaming a column becomes a breaking change for clients.

## Testing is the payoff

Every seam above exists so a test can cut it. A service test constructs the class directly with fakes and never touches a database, a socket or the container:

```ts title="src/orders/orders.service.spec.ts"
import assert from 'node:assert/strict'
import test from 'node:test'
import { OrdersService } from './orders.service.js'

test('refusing to refund an unpaid order', async () => {
  const repository = {
    findById: async () => ({ id: 'o1', status: 'pending', totalCents: 5000 }),
    markRefunded: async () => { throw new Error('should not be called') },
  }

  const service = new OrdersService(repository as never)

  await assert.rejects(() => service.refund('o1', 100), /not refundable/)
})
```

That test runs in single-digit milliseconds because the rule is a function over its collaborators. The moment `OrdersService` reads a header, the test needs a fake request, then a fake middleware chain, and the speed is gone. [Unit tests](../nestjs-testing/unit-tests.md) and [Mocking providers](../nestjs-testing/mocking-providers.md) cover the `Test.createTestingModule()` route, which you want when the graph is deep enough that hand-construction gets tedious.

## Common patterns

**One service method per use case**, named after the use case (`placeOrder`, `cancelOrder`) rather than after the data (`updateOrder`). Use-case names survive schema changes; CRUD names stop describing what the method does the first time a rule is added.

**The service owns the transaction boundary**, because only it knows what one unit of work is. Repositories take the transaction handle as an argument rather than reaching for a global connection — a repository that always uses the pool cannot be enlisted, which is the usual reason "we have transactions" turns out to be false. See [Transactions](../nestjs-databases/transactions.md).

**Stateless services.** A singleton that accumulates per-request state on `this` is a cross-request data leak waiting for concurrency. Anything that varies per request is an argument or a return value.

**Shared pure logic goes in a plain function**, not an `@Injectable()`. A tax calculation with no dependencies does not need the container; a module-level exported function is easier to test and impossible to misconfigure. Use a provider when the thing has dependencies or needs substituting.

## Common mistakes

- **Injecting the request into a service.** It couples the rule to HTTP *and* makes the whole injection chain request-scoped. Pass values.
- **`@Injectable()` without a `providers` entry.** The decorator alone does not register anything; bootstrap fails with an unresolvable-dependency error naming the consumer, not the missing class.
- **Setting status codes in a service.** Throw a domain or Nest exception; map it once in a filter.
- **Storing per-request state on a singleton's fields.** Two concurrent requests will see each other's data.
- **A service that returns raw database rows.** Column names become your API and every forgotten column ships to the client.
- **Interpolating values into SQL.** Use placeholders. The build's SQL linter fails on the concatenated form, and production fails worse.
- **Anemic layers.** Controller → service → repository with no rule anywhere is three files of ceremony. Collapse it until there is a rule to hold.
- **A `UtilsService`.** If it has no dependencies and no state, it is a module of functions, not a provider.
- **Catching an error in a service only to rethrow it as a different one** without adding information. Let it propagate, or attach `cause`.

## Related topics

- [Dependency injection](dependency-injection.md) — tokens, the four provider forms, and `forwardRef`.
- [Injection scopes](injection-scopes.md) — what request-scoping a provider actually costs.
- [Modules](modules.md) — how `providers` and `exports` decide what each service can reach.
- [Controllers](controllers.md) — the layer that must stay thin for any of this to pay off.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — turning a thrown domain error into a status code.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — putting a pool or an ORM into the container.
- [Transactions](../nestjs-databases/transactions.md) — where the unit-of-work boundary belongs.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — substituting a token in the testing module.
- [Layered architecture](../express/layered-architecture.md) — the same rules without a framework.
- [SQL injection](../nestjs-security/sql-injection.md) — why every query above uses placeholders.
