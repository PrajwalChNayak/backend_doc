---
title: Unit tests
description: Testing a NestJS service in isolation with Test.createTestingModule and .compile(), what compile does and does not do, get versus resolve, beforeEach versus beforeAll, and what a unit test should actually assert.
status: current
updated: 2026-09-11
---

A unit test in Nest is a test of one provider with its collaborators replaced. The mechanism that makes it possible is the container: because every dependency arrives through a token rather than an import, a test can build a tiny module containing the class under test and whatever it should see instead of the real graph. `@nestjs/testing` 12.0.1 is the package that exposes that container to a test file.

## Why the testing module exists

Without dependency injection, isolating a class means intercepting its imports — a loader hook, a module mock, a global stub. All three are runtime-specific, all three are worse under ESM, and none of them lets two tests in the same file see different fakes.

With a container, substitution is just "register a different provider for this token". That is the whole argument for the DI ceremony, and it is worth reading [Dependency injection](../nestjs/dependency-injection.md) before this page — the token model there is the thing every override on this page manipulates.

`Test.createTestingModule(metadata)` takes the same `ModuleMetadata` an `@Module()` decorator takes — `imports`, `controllers`, `providers`, `exports` — and returns a builder. `.compile()` resolves the graph and hands back a `TestingModule`.

## Basic example

The service under test, with one collaborator:

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
    if (!order) throw new NotFoundException(`order ${id} not found`)
    return order
  }

  async total(id: string) {
    const order = await this.findById(id)
    return order.lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0)
  }
}
```

The test builds a two-provider module and points the repository token at an object:

```ts title="src/orders/orders.service.spec.ts"
import { NotFoundException } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { OrdersRepository } from './orders.repository.js'
import { OrdersService } from './orders.service.js'

describe('OrdersService', () => {
  let moduleRef: TestingModule
  let service: OrdersService
  let repository: { findById: (id: string) => Promise<unknown> }

  beforeEach(async () => {
    repository = { findById: async () => null }

    moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: OrdersRepository, useValue: repository },
      ],
    }).compile()

    service = moduleRef.get<OrdersService>(OrdersService)
  })

  afterEach(async () => {
    await moduleRef.close()
  })

  it('throws NotFoundException for an unknown id', async () => {
    await expect(service.findById('nope')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('sums the line totals', async () => {
    repository.findById = async () => ({
      id: 'o1',
      lines: [
        { unitPrice: 250, qty: 2 },
        { unitPrice: 100, qty: 1 },
      ],
    })

    await expect(service.total('o1')).resolves.toBe(600)
  })
})
```

Two things to notice. `{ provide: OrdersRepository, useValue: repository }` registers the fake under the *class* token, so `OrdersService`'s constructor resolves it without knowing anything changed. And the fake is reassigned per test rather than reconfigured with a flag — a mock whose behavior depends on a variable set three tests earlier is how order-dependent suites start.

`.overrideProvider(OrdersRepository).useValue(...)` does the same job and is the right tool when you import a real module and want to swap one node inside it. [Mocking providers](mocking-providers.md) covers the override API in full; the inline provider list above is simpler when the module is yours to write.

## What `compile()` does and does not do

`compile()` scans the metadata, applies overrides, and instantiates every provider. It does **not** run lifecycle hooks.

```ts
import { Injectable, type OnModuleInit } from '@nestjs/common'
import { Test } from '@nestjs/testing'

@Injectable()
class CacheWarmer implements OnModuleInit {
  ready = false
  onModuleInit() {
    this.ready = true
  }
}

const moduleRef = await Test.createTestingModule({ providers: [CacheWarmer] }).compile()

moduleRef.get(CacheWarmer).ready // false — compile() instantiated it, nothing more

await moduleRef.init()           // runs onModuleInit, then onApplicationBootstrap
moduleRef.get(CacheWarmer).ready // true
```

So if the behavior you are testing lives in `onModuleInit` — a warmed cache, a registered handler, a connection opened at boot — you must call `await moduleRef.init()` yourself. `createNestApplication()` followed by `app.init()` does it for you, which is why [end-to-end tests](e2e-tests.md) rarely hit this.

:::warning Hook ordering changed in Nest 12
Within a module, `onModuleInit` now runs **grouped by component hierarchy level**: Nest sorts the levels, then awaits all hooks at one level before starting the next. Modules themselves run deepest-first. The practical consequence is that two providers at the same level start concurrently, and a test that asserted "A initializes before B" under Nest 11 can now see either order.

Assert on the resulting state, not on the call order. If one provider genuinely must initialize after another, express that as a dependency — inject it — rather than relying on the scheduler.
:::

`compile()` also accepts `{ snapshot }` and `{ preview }`. `preview: true` builds the graph without instantiating anything, which is occasionally useful for asserting that a module *can* be resolved without paying for construction.

## `get()` versus `resolve()`

`moduleRef.get(Token)` returns the singleton. It throws for a provider that is request- or transient-scoped, because there is no single instance to return.

```ts
import { Test } from '@nestjs/testing'
import { AuditService } from './audit.service.js'
import { RequestContext } from './request-context.js'

const moduleRef = await Test.createTestingModule({
  providers: [AuditService, RequestContext],
}).compile()

const audit = moduleRef.get<AuditService>(AuditService)          // DEFAULT scope
const context = await moduleRef.resolve<RequestContext>(RequestContext) // REQUEST/TRANSIENT
```

`resolve()` returns a promise and, called twice with no `contextId`, gives you **two different instances** — that is what transient means. Pass the same `contextId` to both calls when a test needs two collaborators to share one request-scoped instance. See [Injection scopes](../nestjs/injection-scopes.md).

`get()` also takes `{ strict: false }` to search the whole application rather than the host module, and `{ each: true }` to return every provider registered under a multi-provider token.

## `beforeEach` versus `beforeAll`

The trade is speed against isolation, and for a unit test the isolation is nearly free.

| | `beforeEach` | `beforeAll` |
| --- | --- | --- |
| Fresh instances per test | yes | no |
| State from test 1 visible in test 2 | no | yes |
| Cost | one container build per test | one per file |
| Right for | services with any mutable field, spies, counters | genuinely stateless helpers, expensive fixtures |

Building a testing module with three providers costs well under a millisecond, so `beforeEach` is the default. Reach for `beforeAll` when the setup is expensive and provably immutable — a compiled schema, a migrated database, a loaded key.

The hybrid that works when setup is slow: `beforeAll` for the module, `beforeEach` for the state.

```ts
import { Test, type TestingModule } from '@nestjs/testing'
import { PricingService } from './pricing.service.js'
import { RateTable } from './rate-table.js'

describe('PricingService', () => {
  let moduleRef: TestingModule
  let service: PricingService
  let rates: RateTable

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [PricingService, RateTable],
    }).compile()

    service = moduleRef.get(PricingService)
    rates = moduleRef.get(RateTable)
  })

  beforeEach(() => {
    rates.reset()
  })

  afterAll(async () => {
    await moduleRef.close()
  })
})
```

`await moduleRef.close()` matters even in a unit test. `close()` runs `onModuleDestroy` and the shutdown hooks, which is what releases timers, intervals and sockets a provider opened. Without it the runner waits on an open handle, someone adds `process.exit(0)`, and every future teardown bug becomes invisible.

## When a plain `new` is better

The testing module is not a tax you have to pay. If the class has no dependencies, or one you can construct in a line, call the constructor:

```ts title="src/pricing/vat.spec.ts"
import { VatCalculator } from './vat.calculator.js'

describe('VatCalculator', () => {
  const calculator = new VatCalculator({ standardRate: 0.2 })

  it('rounds to the nearest cent', () => {
    expect(calculator.gross(1999)).toBe(2399)
  })
})
```

Use `new` when the class is a pure computation, a mapper, a policy object, or a small value type — and there is nothing for the container to contribute. Use `Test.createTestingModule` when the class has real dependencies, when it is decorated with something that only means anything inside the container (`@Inject`, `@Optional`, a custom token), or when you want the graph itself under test.

A class that is easier to `new` than to wire is usually a class that should not have been a provider.

## What a unit test should assert

Assert on the class's own contract: the value it returns, the exception it throws, the message it sends to a collaborator that is genuinely an outbound effect.

**Worth asserting**

- Return values for representative inputs, including boundaries.
- Which exception type comes out, and for which input. `NotFoundException` versus `BadRequestException` is a behavioral difference — it becomes a 404 or a 400.
- That an outbound effect happened *and* was shaped correctly: an email queued to the right address, a job enqueued with the right payload.
- Branch coverage of the business rule — the discount that applies at 10 items and not at 9.

**Not worth asserting**

- That the service called `repository.findById`. That is the test restating its own setup. If `findById` becomes `findOne`, the test breaks and nothing was wrong.
- Anything about SQL, schema, constraints or transactions. A mocked repository cannot see them; that is [Database fixtures](database-fixtures.md) and [Testing with a database](../nestjs-databases/testing-with-a-database.md).
- That the guard ran, the pipe validated, or the filter mapped the error. None of those exist in a testing module with a bare provider list — they are the request pipeline, tested in [Testing guards, pipes and interceptors](testing-the-pipeline.md) and [End-to-end tests](e2e-tests.md).
- HTTP status codes. A service throws `NotFoundException`; whether that becomes a 404 is the framework's job and is asserted once, end to end.

The test to be most suspicious of is the one that mocks every collaborator and then asserts that each was called. It passes forever, breaks on every rename, and its failure never corresponds to a bug.

## Common mistakes

- **Expecting `onModuleInit` to have run after `compile()`.** It has not. Call `await moduleRef.init()`.
- **Asserting on lifecycle hook *order* across providers.** Nest 12 runs them by hierarchy level, concurrently within a level. Assert on state.
- **Forgetting `await moduleRef.close()`.** The suite hangs on an open handle and someone reaches for `process.exit`.
- **`moduleRef.get()` on a request-scoped provider.** It throws. Use `resolve()`.
- **Expecting two `resolve()` calls to return the same instance.** Without a shared `contextId` they do not.
- **Sharing a mock across tests via `beforeAll`.** One test's call count leaks into the next and the failure surfaces in the wrong place.
- **A testing module for a class with no dependencies.** `new` is clearer and faster.
- **Importing `AppModule` into a "unit" test.** You have built a slow, brittle e2e test with no HTTP layer. Import the module you are testing, or list the providers.
- **Asserting which collaborator methods were called.** Brittle, and it verifies the setup rather than the behavior.
- **Only testing the happy path.** The error branches are where the bugs are, and they are the cheapest thing in the world to test at this layer.
- **Importing `reflect-metadata` in every spec file.** `@nestjs/common` and `@nestjs/core` already do it.

## Related topics

- [Dependency injection](../nestjs/dependency-injection.md) — the token model every override depends on.
- [Mocking providers](mocking-providers.md) — `overrideProvider`, `useMocker`, and where mocks stop paying.
- [End-to-end tests](e2e-tests.md) — the same container, plus the HTTP pipeline.
- [Testing guards, pipes and interceptors](testing-the-pipeline.md) — the enhancers a provider-only module does not include.
- [Database fixtures](database-fixtures.md) — what to do instead of mocking the repository.
- [Injection scopes](../nestjs/injection-scopes.md) — why `get()` throws for a request-scoped provider.
- [Providers and services](../nestjs/providers-and-services.md) — what belongs in the class under test.
- [Vitest for ESM projects](vitest-for-esm.md) — the runner an ESM Nest project gets by default.
- [Coverage](coverage.md) — reading the number this suite produces.
- [Testing](../express-libraries/testing.md) — the same layering argument without a container.
