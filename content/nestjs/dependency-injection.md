---
title: Dependency injection
description: How Nest 12's container resolves constructor parameters — provider tokens, useClass, useValue, useFactory and useExisting, @Inject, optional providers, and breaking circular dependencies with forwardRef.
status: current
updated: 2026-09-11
---

Dependency injection is the one feature everything else in Nest is built on. Guards, interceptors, pipes and filters can be classes with their own dependencies because a container exists to resolve them; `@nestjs/config`, `@nestjs/typeorm` and `@nestjs/jwt` are each "a module that provides a token"; and testing works because a token can be pointed at something else. Understanding tokens and provider forms is therefore not advanced material — it is the thing that makes the error messages readable.

## Why it exists

The alternative is a composition root: one file that constructs everything in order and passes it down. That is a perfectly good design, and [the plain-Express chapter](../express/layered-architecture.md) uses it.

What a container buys you over it is **transitivity**. In a manual composition root, adding a dependency to a leaf service means editing the factory call for that service, and the factory call for everything that constructs it, and so on up. Nest resolves the whole graph from constructor types, so adding a dependency three levels down changes exactly one constructor.

What you give up is a greppable wiring file. The wiring is now distributed across `@Module()` decorators, and the compiler cannot tell you that a token is unresolvable — bootstrap does, which is early but not as early as a type error.

## Constructor injection

Nest reads the constructor's parameter types and resolves each one. That is the whole mechanism for the common case.

```ts title="src/orders/orders.service.ts"
import { Injectable } from '@nestjs/common'
import { OrdersRepository } from './orders.repository.js'
import { PaymentsService } from '../payments/payments.service.js'

@Injectable()
export class OrdersService {
  private readonly repository: OrdersRepository
  private readonly payments: PaymentsService

  constructor(repository: OrdersRepository, payments: PaymentsService) {
    this.repository = repository
    this.payments = payments
  }
}
```

The parameter *type* is the token here, which is why this only works for classes. TypeScript erases interfaces, so `constructor(repo: IOrdersRepository)` has nothing to resolve at runtime — the metadata the container reads would say `Object`. When you want to depend on an abstraction, use an abstract class or an explicit token with `@Inject()`.

:::note
This reflection depends on `emitDecoratorMetadata` and `reflect-metadata` (0.2.2), which is why Nest projects always have a real `tsc` build step and cannot run under Node's type stripping. See [Native TypeScript support](../node/native-typescript-support.md).
:::

## Tokens

Every provider is registered under a **token**. The token is what the container looks up; the class is just the default token for a class provider.

| Token kind | Written as | Use it when |
| --- | --- | --- |
| Class | `OrdersService` | the common case — one implementation, resolved by type |
| `string` | `'DATABASE_POOL'` | quick, greppable, and collides silently across packages |
| `symbol` | `Symbol('DATABASE_POOL')` | the safe version of the above — cannot collide |
| Abstract class | `abstract class Mailer {}` | you want an interface *and* type-based resolution |

Symbols are the right default for non-class tokens. Export the symbol from the module that provides it, so every consumer imports the same one:

```ts title="src/database/database.tokens.ts"
export const DATABASE_POOL = Symbol('DATABASE_POOL')
export const CLOCK = Symbol('CLOCK')
```

```ts title="src/orders/orders.repository.ts"
import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { DATABASE_POOL } from '../database/database.tokens.js'

@Injectable()
export class OrdersRepository {
  private readonly pool: pg.Pool

  constructor(@Inject(DATABASE_POOL) pool: pg.Pool) {
    this.pool = pool
  }
}
```

`@Inject(token)` overrides type-based resolution for that parameter. It is required for every non-class token, and harmless (if noisy) on class tokens.

### The abstract-class trick

If you want the interface-shaped design without `@Inject()` everywhere, declare the abstraction as an abstract class. It survives compilation as a value, so it can be a token, while still being purely a contract:

```ts title="src/mail/mailer.ts"
export abstract class Mailer {
  abstract send(to: string, subject: string, body: string): Promise<void>
}
```

```ts title="src/mail/mail.module.ts"
import { Module } from '@nestjs/common'
import { Mailer } from './mailer.js'
import { SesMailer } from './ses-mailer.js'

@Module({
  providers: [{ provide: Mailer, useClass: SesMailer }],
  exports: [Mailer],
})
export class MailModule {}
```

Consumers write `constructor(mailer: Mailer)` and get `SesMailer`. A test provides `{ provide: Mailer, useValue: fakeMailer }` and changes nothing else.

## The four provider forms

```ts
import type { Provider } from '@nestjs/common'

const providers: Provider[] = [
  OrdersService,                                            // shorthand for useClass
  { provide: Mailer, useClass: SesMailer },                 // pick an implementation
  { provide: CLOCK, useValue: { now: () => new Date() } },  // a ready-made value
  {                                                          // build it, with dependencies
    provide: DATABASE_POOL,
    useFactory: (config: ConfigService) =>
      new pg.Pool({ connectionString: config.getOrThrow<string>('DATABASE_URL') }),
    inject: [ConfigService],
  },
  { provide: 'LEGACY_MAILER', useExisting: Mailer },        // a second name for the same instance
]
```

| Form | Produces | Notes |
| --- | --- | --- |
| `useClass` | a new instance, constructed by the container | accepts `scope` and `durable` |
| `useValue` | exactly the value given | not constructed; the container never touches it |
| `useFactory` | whatever the function returns | may be `async`; `inject` lists its own dependencies |
| `useExisting` | an **alias** to another token | no second instance — both names resolve to one object |

Two details that surprise people:

- `useExisting` is an alias, not a copy. `useClass` with the same class in two modules gives you **two** instances; `useExisting` gives you one under two names.
- A `useFactory` may be `async`, and Nest awaits it before the application finishes bootstrapping. That is the clean way to make "the app does not start until the database answers" true.

```ts title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import pg from 'pg'
import { DATABASE_POOL } from './database.tokens.js'

@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: async (config: ConfigService) => {
        const pool = new pg.Pool({ connectionString: config.getOrThrow<string>('DATABASE_URL') })
        await pool.query('SELECT 1')   // fail fast at boot, not on the first request
        return pool
      },
      inject: [ConfigService],
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
```

`inject` accepts tokens in the same order as the factory's parameters. Getting that order wrong is a runtime type confusion the compiler cannot see, so keep factories short.

## Optional providers

`@Optional()` makes a dependency resolve to `undefined` instead of failing bootstrap when no provider supplies the token.

```ts
import { Inject, Injectable, Optional } from '@nestjs/common'
import { METRICS } from './metrics.tokens.js'

@Injectable()
export class OrdersService {
  private readonly metrics?: MetricsClient

  constructor(@Optional() @Inject(METRICS) metrics?: MetricsClient) {
    this.metrics = metrics
  }

  record(name: string) {
    this.metrics?.increment(name)
  }
}
```

Use it for genuinely optional infrastructure — metrics, tracing, a feature flag client that may not be configured in every environment. Do **not** use it to silence a resolution error: an optional dependency that is actually required turns a clear bootstrap failure into a `TypeError: Cannot read properties of undefined` on a random request.

## Injecting into things that are not services

The container constructs guards, interceptors, pipes, filters and controllers too, so all of them can take constructor dependencies. The only requirement is that the class is constructed by Nest rather than by you.

```text
@UseGuards(RolesGuard)          // the container constructs it — dependencies injected
@UseGuards(new RolesGuard())    // you constructed it — nothing is injected
```

For application-wide enhancers this is why the `APP_GUARD` / `APP_PIPE` / `APP_INTERCEPTOR` / `APP_FILTER` tokens exist. Registering through them keeps the container in charge; `app.useGlobalGuards(new RolesGuard())` in `main.ts` does not.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { RolesGuard } from './common/guards/roles.guard.js'

@Module({
  providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
})
export class AppModule {}
```

## Circular dependencies

Two classes that inject each other cannot both be constructed first. `forwardRef()` defers one side's token lookup until after the other exists, and it must be applied on **both** sides.

```ts title="src/orders/orders.service.ts"
import { Inject, Injectable, forwardRef } from '@nestjs/common'
import { PaymentsService } from '../payments/payments.service.js'

@Injectable()
export class OrdersService {
  private readonly payments: PaymentsService

  constructor(@Inject(forwardRef(() => PaymentsService)) payments: PaymentsService) {
    this.payments = payments
  }
}
```

The module-level equivalent, for two modules that import each other, is `imports: [forwardRef(() => PaymentsModule)]` on both — see [Modules](modules.md).

:::warning
`forwardRef()` compiles and boots, and it leaves you with two classes that cannot be understood, tested or deployed independently ever again. Treat it as a diagnosis. A cycle between two features usually means a rule is in the wrong class, or a third concept wants to exist: a `CheckoutService` that depends on both, or an event one emits and the other consumes.
:::

When you must keep the cycle, the lower-friction alternative is `ModuleRef`, which resolves lazily at call time rather than at construction time:

```ts
import { Injectable, type OnModuleInit } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { PaymentsService } from '../payments/payments.service.js'

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly moduleRef: ModuleRef
  private payments: PaymentsService | undefined

  constructor(moduleRef: ModuleRef) {
    this.moduleRef = moduleRef
  }

  onModuleInit() {
    this.payments = this.moduleRef.get(PaymentsService, { strict: false })
  }
}
```

`ModuleRef.get()` fetches a singleton, `ModuleRef.resolve()` returns a promise for a scoped instance, and `ModuleRef.create()` instantiates a class the container does not own. `strict: false` searches the whole application rather than the host module — convenient and a good way to hide a missing `imports` entry, so prefer strict lookups where you can.

## Why DI matters for testing

This is the payoff, and it is worth being concrete about. A token is a seam: anything that asks for `DATABASE_POOL` can be handed something else, and nothing else in the graph changes.

```ts title="src/orders/orders.service.spec.ts"
import assert from 'node:assert/strict'
import test from 'node:test'
import { Test } from '@nestjs/testing'
import { OrdersRepository } from './orders.repository.js'
import { OrdersService } from './orders.service.js'

test('a missing order is a 404', async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [OrdersService, OrdersRepository],
  })
    .overrideProvider(OrdersRepository)
    .useValue({ findById: async () => null })
    .compile()

  const service = moduleRef.get(OrdersService)

  await assert.rejects(() => service.findById('missing'), /not found/)
})
```

Three properties make this work, and all three come from the container:

- **Substitution is total.** `overrideProvider` replaces the token everywhere in the graph, including inside providers you did not name.
- **The code under test is unchanged.** No conditional "if testing, use the fake" branch, no module mocking, no import interception.
- **The seam is the same one production uses.** You are not testing a special code path; you are running the real wiring with one node swapped.

Compare that with a service that does `import { pool } from '../db.js'` at module scope: the only way to substitute it is a module-level mock, which is loader-specific, ESM-hostile, and breaks as soon as two tests want different fakes. [Mocking providers](../nestjs-testing/mocking-providers.md) goes through the override API in full; [Unit tests](../nestjs-testing/unit-tests.md) covers when to skip the testing module and just call `new`.

## Reading the error

The message you will see most often:

```text
Nest can't resolve dependencies of the OrdersService (OrdersRepository, ?).
Please make sure that the argument PaymentsService at index [1] is available in the OrdersModule context.

Potential solutions:
- Is OrdersModule a valid NestJS module?
- If PaymentsService is a provider, is it part of the current OrdersModule?
- If PaymentsService is exported from a separate @Module, is that module imported within OrdersModule?
```

The `?` marks the parameter that failed, and the index is its position. Work through three questions in order: is the class in some module's `providers`, is it in that module's `exports`, and is that module in the consumer's `imports`. When the `?` is at index 0 and the constructor looks fine, suspect a circular import — often via a barrel file.

`Cannot read properties of undefined` at the *first* use of an injected field, rather than at bootstrap, means the opposite problem: something resolved to `undefined`, which is either an `@Optional()` dependency that is not actually optional or a `forwardRef` cycle resolving in the wrong order.

## Common mistakes

- **Injecting an interface.** TypeScript erases it; there is no token. Use an abstract class or `@Inject()` with a symbol.
- **A string token defined in two places.** `'CONFIG'` in two packages is one token. Use symbols and export them from a single file.
- **`@Optional()` to make a bootstrap error go away.** You moved the failure from startup to a request, and made it read like a null-pointer bug.
- **`useClass` for something that should be `useExisting`.** You get two instances, two caches, two connection pools.
- **Mismatched `inject` order.** The array is positional. A two-argument factory with the tokens swapped fails at runtime with a confusing type error, or worse, does not fail.
- **`new SomeGuard()` when the guard has dependencies.** Nothing is injected into an instance you constructed yourself.
- **`forwardRef()` as the permanent answer to a cycle.** Move the rule instead.
- **`strict: false` on every `ModuleRef.get()`.** It hides missing `imports` entries and makes the module graph stop describing the application.
- **Reaching for `ModuleRef` as a service locator.** If a class resolves five tokens by hand at call time, its dependencies are invisible and nothing can substitute them cleanly.

## Related topics

- [Providers and services](providers-and-services.md) — what the injected classes should contain.
- [Modules](modules.md) — the `imports`/`exports` boundary every resolution is checked against.
- [Injection scopes](injection-scopes.md) — `DEFAULT`, `REQUEST`, `TRANSIENT` and what each costs.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — `overrideProvider` and friends, in depth.
- [Unit tests](../nestjs-testing/unit-tests.md) — when a plain `new` beats the testing module.
- [Dynamic modules](../nestjs-advanced/dynamic-modules.md) — `forRoot()` and `registerAsync()` as provider factories.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — pools and ORM clients as tokens.
- [Guards](../nestjs-request-handling/guards.md) — the most common injectable non-service.
- [Native TypeScript support](../node/native-typescript-support.md) — why the metadata this relies on needs `tsc`.
- [Layered architecture](../express/layered-architecture.md) — the manual composition root a container replaces.
