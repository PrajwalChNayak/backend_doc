---
title: Mocking providers
description: The @nestjs/testing override API in NestJS 12 — overrideProvider with useValue, useClass and useFactory, overrideGuard, overrideInterceptor, overridePipe, overrideFilter, overrideModule, integration tokens like getRepositoryToken, useMocker, and when a mock stops being worth anything.
status: current
updated: 2026-09-11
---

`TestingModuleBuilder` gives you one lever: point a token at something else. Every override on this page is that same operation with a different name, and the names exist because guards, pipes, interceptors and filters are registered in metadata rather than in a provider array. Knowing which token an integration package uses is usually the whole difficulty.

## The full override surface

Read from `@nestjs/testing@12.0.1`'s own declarations. This is the complete list — there is no `overrideMiddleware`.

| Builder method | Replaces | Returns |
| --- | --- | --- |
| `.overrideProvider(tokenOrClass)` | any provider, anywhere in the graph | `OverrideBy` |
| `.overrideGuard(GuardClass)` | a guard referenced by `@UseGuards()` | `OverrideBy` |
| `.overrideInterceptor(InterceptorClass)` | an interceptor referenced by `@UseInterceptors()` | `OverrideBy` |
| `.overridePipe(PipeClass)` | a pipe referenced by `@UsePipes()` | `OverrideBy` |
| `.overrideFilter(FilterClass)` | a filter referenced by `@UseFilters()` | `OverrideBy` |
| `.overrideModule(ModuleClass)` | a whole imported module | `OverrideModule` |
| `.useMocker(fn)` | every token that fails to resolve | the builder |
| `.setLogger(loggerService)` | the logger the module writes through | the builder |

`OverrideBy` has exactly three methods, and each returns the builder so calls chain:

```ts
import { Test } from '@nestjs/testing'
import { Clock } from './clock.js'
import { FakeClock } from './fake-clock.js'
import { MailerService } from './mailer.service.js'
import { CONFIG } from './config.tokens.js'
import { AppModule } from './app.module.js'

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(MailerService)
  .useValue({ send: async () => undefined })
  .overrideProvider(Clock)
  .useClass(FakeClock)
  .overrideProvider(CONFIG)
  .useFactory({ factory: () => ({ region: 'test' }) })
  .compile()
```

`OverrideModule` has one: `.useModule(SomeOtherModule)`.

## `useValue`, `useClass`, `useFactory`

| Form | Nest does | Choose it when |
| --- | --- | --- |
| `.useValue(obj)` | registers the object as-is; nothing is constructed | the fake is a literal — the common case |
| `.useClass(Fake)` | constructs `Fake` through the container, injecting **its** dependencies | the fake is substantial enough to deserve a class, or needs its own providers |
| `.useFactory({ factory, inject })` | calls the factory, awaiting a promise | the fake needs a value from the container, or is expensive to build |

`.useValue()` is the one you will use ninety percent of the time, and its object is not type-checked against the real provider — which is both why partial mocks are easy and why a renamed method fails at runtime rather than at compile time. The fix is a typed helper, below.

`.useClass()` is the form people forget. A fake with dependencies of its own works:

```ts title="test/doubles/recording-mailer.ts"
import { Injectable } from '@nestjs/common'
import { Clock } from '../../src/clock.js'

export interface SentMail {
  to: string
  subject: string
  at: Date
}

@Injectable()
export class RecordingMailer {
  readonly sent: SentMail[] = []
  private readonly clock: Clock

  constructor(clock: Clock) {
    this.clock = clock
  }

  async send(to: string, subject: string): Promise<void> {
    this.sent.push({ to, subject, at: this.clock.now() })
  }
}
```

```ts title="test/signup.spec.ts"
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module.js'
import { MailerService } from '../src/mailer/mailer.service.js'
import { RecordingMailer } from './doubles/recording-mailer.js'

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(MailerService)
  .useClass(RecordingMailer)
  .compile()

// The token is MailerService; the instance is a RecordingMailer.
const mailer = moduleRef.get<RecordingMailer>(MailerService)
```

`.useFactory()` takes an **options object**, not a bare function — `{ factory, inject? }`. `inject` lists tokens positionally, exactly like a normal `useFactory` provider:

```ts
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { Pool } from 'pg'
import { PG_POOL } from '../src/database/database.tokens.js'
import { AppModule } from '../src/app.module.js'

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(PG_POOL)
  .useFactory({
    factory: (config: ConfigService) =>
      new Pool({ connectionString: config.getOrThrow<string>('TEST_DATABASE_URL'), max: 2 }),
    inject: [ConfigService],
  })
  .compile()
```

## Overriding guards, interceptors, pipes and filters

An enhancer attached with `@UseGuards(AuthGuard)` is not in any `providers` array — it is metadata on the controller. `overrideProvider` will not find it, which is why the four dedicated methods exist.

```ts title="test/orders.controller.spec.ts"
import { Test } from '@nestjs/testing'
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard.js'
import { RolesGuard } from '../src/auth/roles.guard.js'
import { AuditInterceptor } from '../src/common/audit.interceptor.js'
import { OrdersModule } from '../src/orders/orders.module.js'

const moduleRef = await Test.createTestingModule({ imports: [OrdersModule] })
  .overrideGuard(JwtAuthGuard)
  .useValue({ canActivate: () => true })
  .overrideGuard(RolesGuard)
  .useValue({ canActivate: () => true })
  .overrideInterceptor(AuditInterceptor)
  .useValue({ intercept: (_context: unknown, next: { handle: () => unknown }) => next.handle() })
  .compile()
```

A guard stub must return `boolean | Promise<boolean> | Observable<boolean>`; an interceptor stub must return the observable from `next.handle()` or one derived from it. Returning `undefined` from a stubbed `intercept` produces a hang or an unhelpful `Cannot read properties of undefined`, because Nest subscribes to what you returned.

:::warning A blanket `canActivate: () => true` deletes your authorization tests
It is the right move for a controller test that is about the controller. It is the wrong move for the suite as a whole, because nothing then proves that the guard is attached to the route, that it reads the right roles, or that an anonymous request is refused.

Keep at least one path where the real guard runs — see the authentication section of [End-to-end tests](e2e-tests.md), and the authorization matrix in [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).
:::

Enhancers registered globally through the `APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR` and `APP_FILTER` tokens are ordinary providers, so `overrideProvider(APP_GUARD)` works on them — another reason to prefer those tokens over `app.useGlobalGuards()` in `main.ts`. [Dependency injection](../nestjs/dependency-injection.md) explains the distinction.

## Integration tokens

Most overrides that people struggle with are not overrides at all — they are a token they cannot name. Each integration package exports a helper that computes it.

| Provider | Token helper | Import from |
| --- | --- | --- |
| TypeORM repository | `getRepositoryToken(Entity)` | `@nestjs/typeorm` |
| TypeORM data source | `getDataSourceToken()` or `getDataSourceToken('name')` | `@nestjs/typeorm` |
| TypeORM entity manager | `getEntityManagerToken()` | `@nestjs/typeorm` |
| Mongoose model | `getModelToken(User.name)` | `@nestjs/mongoose` |
| Mongoose connection | `getConnectionToken()` | `@nestjs/mongoose` |
| BullMQ queue | `getQueueToken('emails')` | `@nestjs/bullmq` |
| Anything you defined | the symbol or class itself | your own tokens file |

```ts title="test/users.service.spec.ts"
import { getRepositoryToken } from '@nestjs/typeorm'
import { Test } from '@nestjs/testing'
import { User } from '../src/users/user.entity.js'
import { UsersService } from '../src/users/users.service.js'

describe('UsersService', () => {
  it('returns null for an unknown email', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: { findOne: async () => null } },
      ],
    }).compile()

    const users = moduleRef.get<UsersService>(UsersService)
    await expect(users.findByEmail('nobody@example.invalid')).resolves.toBeNull()
  })
})
```

```ts title="test/notifications.service.spec.ts"
import { getQueueToken } from '@nestjs/bullmq'
import { getModelToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { NotificationsService } from '../src/notifications/notifications.service.js'
import { Device } from '../src/notifications/device.schema.js'

describe('NotificationsService', () => {
  it('enqueues one push job per registered device', async () => {
    const added: { name: string; data: unknown }[] = []

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getModelToken(Device.name),
          useValue: { find: () => ({ lean: async () => [{ token: 'a' }, { token: 'b' }] }) },
        },
        {
          provide: getQueueToken('push'),
          useValue: {
            add: async (name: string, data: unknown) => {
              added.push({ name, data })
            },
          },
        },
      ],
    }).compile()

    await moduleRef.get<NotificationsService>(NotificationsService).broadcast('u1', 'hello')

    expect(added).toHaveLength(2)
    expect(added[0].name).toBe('send-push')
  })
})
```

Note what that second test asserts: the *number and shape* of the enqueued jobs, which is a real outbound contract, rather than "the queue's `add` method was called". The first survives a refactor; the second does not.

`ConfigService` is worth a special mention, because overriding the whole thing is usually wrong. `{ provide: ConfigService, useValue: { get: () => 'x' } }` makes every key return the same value and hides a missing key. Prefer supplying real configuration:

```ts
import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { PaymentsModule } from '../src/payments/payments.module.js'

const moduleRef = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({
      ignoreEnvFile: true,
      load: [() => ({ STRIPE_KEY: 'sk_test_fake', PAYMENTS_TIMEOUT_MS: 500 })],
    }),
    PaymentsModule,
  ],
}).compile()
```

## Partial mocks, typed

A `useValue` object is typed `any`, so nothing stops you from mocking a method that no longer exists. A one-line helper buys the compiler back:

```ts title="test/doubles/partial.ts"
export type Partially<T> = Partial<Record<keyof T, unknown>>

export function partialMock<T>(impl: Partially<T>): T {
  return impl as T
}
```

```ts title="test/orders.service.spec.ts"
import { Test } from '@nestjs/testing'
import { OrdersRepository } from '../src/orders/orders.repository.js'
import { OrdersService } from '../src/orders/orders.service.js'
import { partialMock } from './doubles/partial.js'

const repository = partialMock<OrdersRepository>({
  findById: async () => ({ id: 'o1', lines: [] }),
  // `findByCustomer` is deliberately absent — calling it should blow up loudly.
})

const moduleRef = await Test.createTestingModule({
  providers: [OrdersService, { provide: OrdersRepository, useValue: repository }],
}).compile()
```

Leaving the unused methods out is deliberate. A mock that implements everything with `async () => undefined` turns "the service called a method you did not think about" into a silent `undefined`, which surfaces three layers away. An absent method throws `is not a function` at the call site, which is the error you want.

## `useMocker` for the long tail

When a module has twenty providers and the test cares about two, `useMocker` supplies the rest. It is called **only for tokens the container fails to resolve**, and returning a falsy value re-throws the original resolution error — so it is an escape hatch, not a global auto-mock.

```ts title="test/reporting.service.spec.ts"
import { type InjectionToken } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ReportingService } from '../src/reporting/reporting.service.js'

const moduleRef = await Test.createTestingModule({
  providers: [ReportingService],
})
  .useMocker((token?: InjectionToken) => {
    if (token === ReportingService) return undefined // let the real one resolve
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined // do not look like a promise
          return () => {
            throw new Error(`unstubbed call to ${String(token)}.${String(prop)}`)
          }
        },
      },
    )
  })
  .compile()
```

A throwing proxy is the honest default: the test fails with the name of the collaborator it forgot to stub, instead of passing on `undefined`. A mocker that returns benign empty objects makes every test pass and none of them mean anything.

## `overrideModule`

When an imported module does something you cannot do in a test — opens a connection at import time, registers a global, talks to a cloud SDK — replace the module rather than each of its providers:

```ts
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module.js'
import { StorageModule } from '../src/storage/storage.module.js'
import { InMemoryStorageModule } from './doubles/in-memory-storage.module.js'

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideModule(StorageModule)
  .useModule(InMemoryStorageModule)
  .compile()
```

The replacement must export the same tokens, or consumers stop resolving. That constraint is a feature: it forces the fake module to honor the real one's public surface.

## The honest limit of mocking

A test that mocks everything asserts nothing. This is not a style preference; it is a statement about what the test can possibly fail on.

| Failure | Caught by a mocked collaborator? |
| --- | --- |
| The service computes the wrong total | yes |
| The service throws the wrong exception type | yes |
| The SQL references a dropped column | no |
| A unique constraint rejects the duplicate | no |
| The transaction did not roll back | no |
| The ORM emitted eleven queries instead of one | no |
| The guard is not attached to the route | no |
| The validation pipe was never registered | no |
| The serializer leaked `passwordHash` | no |

Every "no" in that table is a bug that reaches production, and every one of them needs either a real database ([Database fixtures](database-fixtures.md), [Testing with a database](../nestjs-databases/testing-with-a-database.md)) or a real pipeline ([End-to-end tests](e2e-tests.md)).

The rule that holds up: **mock what you do not own and cannot run.** The payment provider, the SMS gateway, the third-party API with a rate limit, the clock, the random source. Everything inside your own process — your repositories, your services, your database — should run.

A useful smell test. If you deleted the body of the method under test and replaced it with the literal value the test expects, would the test still fail? If the answer is no, the test is asserting its own setup.

## Common mistakes

- **`overrideProvider` on a guard attached with `@UseGuards()`.** It is metadata, not a provider. Use `overrideGuard`.
- **`.useFactory(() => fake)`.** The argument is `{ factory, inject? }`, not a bare function.
- **An interceptor stub that does not return `next.handle()`.** Nest subscribes to the return value; `undefined` hangs or throws.
- **`canActivate: () => true` everywhere.** No test then proves the guard is wired, reads the right metadata, or refuses anonymous requests.
- **Overriding `ConfigService` wholesale.** Every key returns one value and a missing key never fails. Load real test configuration instead.
- **Guessing an integration token.** `'UserRepository'` is not `getRepositoryToken(User)`. Import the helper.
- **A mock that implements every method with `async () => undefined`.** Forgotten calls become silent `undefined` three layers away.
- **A `useMocker` that returns benign objects.** Everything passes; nothing is verified. Throw instead.
- **Asserting that a collaborator method was called.** Assert the shape of what was sent, or nothing.
- **Mocking the repository and calling it a test of the query.** The query is never executed.
- **`overrideModule` with a replacement that exports different tokens.** Consumers stop resolving, and the error points at the consumer.
- **Reconfiguring one shared mock across tests instead of rebuilding it.** Order-dependent failures that reproduce only in CI.

## Related topics

- [Unit tests](unit-tests.md) — the testing module these overrides are applied to.
- [Dependency injection](../nestjs/dependency-injection.md) — tokens, provider forms, and why `APP_GUARD` beats `useGlobalGuards`.
- [End-to-end tests](e2e-tests.md) — where the real guards and pipes have to run.
- [Testing guards, pipes and interceptors](testing-the-pipeline.md) — testing the enhancer itself rather than stubbing it.
- [Database fixtures](database-fixtures.md) — the alternative to mocking the data layer.
- [Testing with a database](../nestjs-databases/testing-with-a-database.md) — what a mocked repository cannot see.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — the connection tokens you override.
- [Guards](../nestjs-request-handling/guards.md) — what you are stubbing when you call `overrideGuard`.
- [Interceptors](../nestjs-request-handling/interceptors.md) — the `CallHandler` contract a stub has to honor.
- [Configuration](../nestjs/configuration.md) — loading test configuration instead of faking `ConfigService`.
