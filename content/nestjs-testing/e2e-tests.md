---
title: End-to-end tests
description: Driving a NestJS 12 application over HTTP with supertest 7.2.2 — createNestApplication, app.init, app.close, and the critical gap that main.ts never runs in a test, so global pipes, filters and prefixes are missing unless you share a bootstrap function.
status: current
updated: 2026-09-11
---

An end-to-end test sends a real HTTP request through the real router, the real guards, the real pipes, the real interceptors and the real exception filters. That is the layer where most Nest bugs actually live — a pipe that was never registered, a guard on the wrong controller, a serializer that leaks a column — and none of them is visible to a test that calls a service method directly.

## The shape of an e2e test

`supertest` 7.2.2 is the only addition. It binds an ephemeral port per request, so tests never collide and you never manage a port.

:::tabs
@tab npm
```bash
npm install --save-dev supertest@7 @types/supertest@7
```
@tab pnpm
```bash
pnpm add -D supertest@7 @types/supertest@7
```
@tab yarn
```bash
yarn add -D supertest@7 @types/supertest@7
```
:::

```ts title="test/orders.e2e-spec.ts"
import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { App } from 'supertest/types'
import { AppModule } from '../src/app.module.js'

describe('Orders (e2e)', () => {
  let app: INestApplication<App>

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects an unknown order with 404', async () => {
    await request(app.getHttpServer()).get('/orders/does-not-exist').expect(404)
  })

  it('creates and reads back an order', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .send({ customerId: 'c1', lines: [{ sku: 'ABC', qty: 2 }] })
      .expect('Content-Type', /json/)
      .expect(201)

    const read = await request(app.getHttpServer()).get(`/orders/${created.body.id}`).expect(200)
    expect(read.body.customerId).toBe('c1')
  })
})
```

Four calls carry the whole mechanism:

| Call | What it does | What breaks without it |
| --- | --- | --- |
| `Test.createTestingModule({ imports: [AppModule] })` | builds the real module graph | nothing to serve |
| `.createNestApplication()` | wraps the graph in an `INestApplication` with an HTTP adapter | `getHttpServer()` has nothing to return |
| `await app.init()` | runs `onModuleInit` and `onApplicationBootstrap`, and registers the routes on the adapter | every request 404s |
| `await app.close()` | runs `onModuleDestroy` and the shutdown hooks | the runner hangs on an open handle |

`app.init()` is not optional and it is not implied by `createNestApplication()`. Neither is it implied by `compile()` — that builds instances and stops. `app.getHttpServer()` returns the underlying Express 5 server, which is what `supertest` drives.

`INestApplication<App>` with `App` imported from `supertest/types` is what the CLI's own scaffold generates; it types `getHttpServer()` as something supertest accepts. Plain `INestApplication` works too, with a cast.

## The critical gap: `main.ts` never runs

This is the single most common way a Nest e2e suite ends up testing a configuration that does not exist in production.

`NestFactory.create()` is never called in a test. Anything you did to the application object in `main.ts` — a global pipe, a global filter, a global interceptor, a route prefix, versioning, CORS, cookie parsing, a body limit — simply is not there.

```ts title="src/main.ts — the version that breaks e2e tests"
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)
app.setGlobalPrefix('api')
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
await app.listen(process.env.PORT ?? 3000)
```

Against that application, an e2e test written the obvious way is wrong twice over. Every request needs `/api/...` in production and `/...` in the test, and **no validation runs at all** — so a test asserting that a bad payload returns 400 fails, and worse, a test asserting that a *good* payload succeeds passes while proving nothing about the whitelist that production depends on.

### The fix: one bootstrap function, called from both

Extract everything that configures the application into a function, and call it from `main.ts` and from every e2e setup.

```ts title="src/bootstrap.ts"
import { ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js'

/** Everything that turns a module graph into *this* application. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api')
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  app.useGlobalInterceptors(new RequestIdInterceptor())
  app.useGlobalFilters(new AllExceptionsFilter())
  app.enableShutdownHooks()
  return app
}
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { configureApp } from './bootstrap.js'

const app = await NestFactory.create(AppModule)
configureApp(app)
await app.listen(process.env.PORT ?? 3000)
```

```ts title="test/helpers/create-test-app.ts"
import { type INestApplication } from '@nestjs/common'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import { AppModule } from '../../src/app.module.js'
import { configureApp } from '../../src/bootstrap.js'

export async function createTestApp(
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<INestApplication> {
  const base = Test.createTestingModule({ imports: [AppModule] })
  const moduleRef = await (customize ? customize(base) : base).compile()

  const app = configureApp(moduleRef.createNestApplication())
  await app.init()
  return app
}
```

```ts title="test/orders.e2e-spec.ts"
import { type INestApplication } from '@nestjs/common'
import request from 'supertest'
import { createTestApp } from './helpers/create-test-app.js'
import { PaymentsGateway } from '../src/payments/payments.gateway.js'

describe('Orders (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(PaymentsGateway).useValue({ charge: async () => ({ id: 'ch_1' }) }),
    )
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects an unknown field with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send({ customerId: 'c1', lines: [], isAdmin: true })
      .expect(400)
  })
})
```

Now the prefix, the version, the pipe, the interceptor and the filter are identical in both, and the day someone adds a global to `bootstrap.ts` the tests inherit it for free.

`configureApp` should take `INestApplication` and return it, not build it. Keeping `NestFactory.create` out of the function is what lets the test supply an application made from an overridden module.

:::best-practice Register enhancers as providers where you can
`{ provide: APP_PIPE, useClass: ValidationPipe }` in a module is part of the module graph, so a testing module gets it automatically with no shared bootstrap function at all. `app.useGlobalPipes(...)` is not. Prefer the token form for anything that does not need constructor arguments you can only compute at boot — and keep `configureApp` for the rest.
:::

## What you can and cannot override at this layer

Everything from [Mocking providers](mocking-providers.md) still applies, because the graph is the same graph. The thing to be deliberate about is *what* you replace.

| Dependency | In an e2e test |
| --- | --- |
| Database | **real**, pointed at a disposable instance — see [Database fixtures](database-fixtures.md) |
| Cache / Redis | real if cheap, otherwise an in-memory implementation of the same token |
| Payment provider, SMS, email | mocked — you do not own them and must not call them |
| Clock | frozen, if any assertion depends on time |
| Your own guards and pipes | **real** — they are most of the point |

An e2e suite that overrides its guards, its pipes and its database is a slow unit test.

## Authentication

Three approaches, in descending order of how much they prove.

**1. Mint a real token.** The strongest, and usually the simplest, because the application already has the signing service in its container.

```ts title="test/helpers/auth.ts"
import { type INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'

export async function bearerFor(
  app: INestApplication,
  claims: { sub: string; roles: string[] },
): Promise<string> {
  const jwt = app.get(JwtService)
  const token = await jwt.signAsync(claims)
  return `Bearer ${token}`
}
```

```ts
it('refuses a reader on a write route', async () => {
  const auth = await bearerFor(app, { sub: 'u1', roles: ['reader'] })

  await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set('Authorization', auth)
    .send({ customerId: 'c1', lines: [] })
    .expect(403)
})
```

The real guard runs, the real roles metadata is read, and the test fails if either is wrong.

**2. Log in through the API.** Slower, and it tests the login route as a side effect — which is worth doing once, in the auth suite, rather than in every file.

```ts
const login = await request(app.getHttpServer())
  .post('/api/v1/auth/login')
  .send({ email: 'user@example.invalid', password: 'correct-horse' })
  .expect(200)

const auth = `Bearer ${login.body.accessToken}`
```

For cookie-based sessions, `request.agent(server)` keeps the cookie jar across requests:

```ts
const agent = request.agent(app.getHttpServer())
await agent.post('/api/v1/auth/login').send({ email: 'a@example.invalid', password: 'pw' }).expect(200)
await agent.get('/api/v1/me').expect(200) // the session cookie is sent automatically
```

**3. Stub the guard.** `overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })`. Fast, and it proves nothing about authentication or authorization. Acceptable for a suite whose subject is a controller's behavior once authenticated — never for the suite as a whole.

Whichever you use, test the **matrix**, not just the happy path: anonymous gets 401, the wrong user gets 403 or 404, the right user gets 200. That is the only reliable defense against broken object-level authorization, and it is invisible to type checkers and code review. See [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

## Isolation between requests

A single `INestApplication` is shared by every test in the file, so anything stateful survives across requests.

**Database state.** Truncate or roll back between tests, never between files only. The patterns are in [Database fixtures](database-fixtures.md).

**In-memory caches.** A `CacheModule` store lives in the application and will happily serve a value written by the previous test. Either clear it in `beforeEach` or assert on it deliberately:

```ts
import { CACHE_MANAGER } from '@nestjs/cache-manager'

beforeEach(async () => {
  await app.get(CACHE_MANAGER).clear()
})
```

**Rate limiters.** A throttler counts requests per key. Twenty tests hitting the same route from the same synthetic IP will start returning 429 partway through the file, and the failure looks like a flaky test. Either raise the limit in test configuration, vary the key, or reset the storage between tests — and keep one test that deliberately exceeds the limit. See [Rate limiting with Throttler](../nestjs-libraries/throttler.md).

**Module-level state and singletons.** A provider that memoizes on first call keeps that value for the whole file. If the memoized thing is configuration, that is fine; if it is data, rebuild the application per `describe` block.

**Time.** Freeze the clock rather than sleeping. A test that waits on a real timer is slow and still flaky.

**Parallelism.** Test runners execute files in parallel by default. Two files with their own application talking to the same database will interleave. Give each worker its own schema or database, or serialize the suite — both options are in [Database fixtures](database-fixtures.md).

## What to assert

The contract, and nothing else: status, headers, and body shape.

```ts
it('does not leak internals on a 500', async () => {
  const res = await request(app.getHttpServer()).get('/api/v1/orders/boom').expect(500)

  expect(res.body.message).toBe('Internal server error')
  expect(res.body.stack).toBeUndefined()
  expect(JSON.stringify(res.body)).not.toContain('SELECT')
})

it('does not serialize the password hash', async () => {
  const res = await request(app.getHttpServer()).get('/api/v1/users/u1').expect(200)

  expect(res.body.passwordHash).toBeUndefined()
  expect(res.body.email).toBe('u1@example.invalid')
})
```

Absence assertions are the ones that survive refactors and catch real leaks. A test that a field is *missing* fails the day a serializer changes; a test that a field is present rarely tells you anything you did not already know.

Other paths worth one test each: a validation failure per DTO, a duplicate returning 409, a body over the size limit returning 413, the rate limiter returning 429, and every protected route with no credentials.

:::warning Await the chain
`request(app.getHttpServer()).get('/x').expect(200)` without `await` or `return` runs its assertion after the test has ended. The test passes, the failure is swallowed, and the suite is decorative. Always `await`.
:::

## Common mistakes

- **Forgetting `await app.init()`.** Routes are never registered and every request 404s.
- **Forgetting `await app.close()`.** The runner hangs; someone adds `process.exit(0)` and hides every future teardown bug.
- **Registering global pipes and filters only in `main.ts`.** The suite tests a configuration production does not have — in both directions.
- **Forgetting the global prefix or version in the request path.** Every test 404s and the cause looks like a routing bug.
- **Not awaiting the supertest chain.** Silent passes.
- **Overriding the database in an e2e test.** You removed the only layer that can catch a bad query, a missing column or an absent constraint.
- **`canActivate: () => true` across the whole suite.** Nothing proves the guards are attached.
- **Testing only the authenticated happy path.** The 401/403 matrix is where broken object-level authorization hides.
- **A shared application with no per-test reset.** Cached values, throttler counters and database rows leak between tests.
- **Hitting the real payment or email provider.** Slow, flaky, and occasionally expensive.
- **`describe` blocks that depend on each other's order.** They pass locally and fail in CI, where files run in parallel.
- **Asserting on the exact error message string from a third-party library.** It changes on a patch release.

## Related topics

- [Unit tests](unit-tests.md) — the same testing module without the HTTP layer.
- [Mocking providers](mocking-providers.md) — the override API used through `createTestApp`.
- [Testing guards, pipes and interceptors](testing-the-pipeline.md) — testing an enhancer directly instead of through a route.
- [Database fixtures](database-fixtures.md) — per-test isolation for the shared application.
- [Testing with a database](../nestjs-databases/testing-with-a-database.md) — the connection override and the migration bootstrap.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the order the pipeline an e2e test exercises actually runs in.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — the global that most often goes missing in tests.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — what turns a thrown exception into the status you assert.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the matrix an e2e suite should cover exhaustively.
- [Versioning](../nestjs-request-handling/versioning.md) — the other thing `configureApp` has to replay.
- [Testing](../express-libraries/testing.md) — the same supertest patterns without Nest.
