---
title: Troubleshooting
description: NestJS 12 failures indexed by the exact error text — dependency resolution, circular imports, missing decorator metadata, silent validation, route path errors, ESM, testing, scopes, shutdown hooks and scheduling.
status: current
updated: 2026-09-11
---

Every entry below is a real symptom with its exact message, the reason it happens, the fix, and a link to the page that explains the mechanism properly. The error strings were read from the shipped `@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` sources, so they match what your terminal prints rather than a paraphrase.

## How to read a Nest error

Three habits solve most of them before you search:

1. **Read the dependency list in parentheses.** Nest prints the constructor's resolved arguments and replaces the failing one with `?`. The position of the `?` is the parameter that could not be resolved.
2. **Read the last line.** Nest 12 appends a "Potential solutions" block and a `Scope [...]` trail showing the module chain it walked.
3. **Note *when* it failed.** Bootstrap errors (paths, modules, providers) kill the process before it listens and cannot be caught by a filter. Request-time errors go through the pipeline.

## Dependency injection

### `Nest can't resolve dependencies of the UsersService (?, ConfigService)`

```text
Nest can't resolve dependencies of the UsersService (?, ConfigService). Please make sure that
the argument UsersRepository at index [0] is available in the UsersModule context.

Potential solutions:
- Is UsersModule a valid NestJS module?
- If UsersRepository is a provider, is it part of the current UsersModule?
- If UsersRepository is exported from a separate @Module, is that module imported within UsersModule?
```

**Cause.** The container walked `UsersService`'s constructor, resolved argument 1 (`ConfigService`), and failed on argument 0. The `?` is always the argument that failed, and the message names both the token and its index.

**Fix.** Exactly one of three things is wrong, in order of likelihood:

1. The provider is not in any module's `providers` array. Importing the file does not register the class — add it.
2. It is a provider of a *different* module, and that module does not `export` it.
3. Its module is exported correctly, but the consuming module does not `import` it.

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { UsersController } from './users.controller.js'
import { UsersRepository } from './users.repository.js'
import { UsersService } from './users.service.js'

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],   // ← the missing line
  exports: [UsersService],
})
export class UsersModule {}
```

More: [Modules](../nestjs/modules.md), [Dependency injection](../nestjs/dependency-injection.md).

### `Nest can't resolve dependencies of the UsersService (?)` — and the argument has no name

```text
Nest can't resolve dependencies of the UsersService (?). Please make sure that the argument
at index [0] is available in the current module.

Potential solutions:
- The dependency at index [0] appears to be undefined at runtime
- This commonly occurs when using 'import type' instead of 'import' for injectable classes
```

**Cause.** The constructor parameter's type metadata is `undefined` or `Object` at runtime. Two causes produce it:

- **`import type` was used for an injected class.** The statement is erased at compile time, so the emitted metadata has nothing to record. Editors offer this "optimization" constantly.
- **`emitDecoratorMetadata` is off, or `reflect-metadata` was never imported.** Then *no* constructor type metadata is emitted for any class, and every injection fails this way.

**Fix.** Use a value import, and check the compiler options:

```ts title="src/users/users.service.ts"
// Wrong: erased, so the container sees undefined.
// import type { UsersRepository } from './users.repository.js'

import { Injectable } from '@nestjs/common'
import { UsersRepository } from './users.repository.js'

@Injectable()
export class UsersService {
  private readonly repository: UsersRepository

  constructor(repository: UsersRepository) {
    this.repository = repository
  }
}
```

```json title="tsconfig.json"
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`@nestjs/core` imports `reflect-metadata` itself, so a missing polyfill is rare — but a test runner compiling with its own config that omits `emitDecoratorMetadata` is not. Check every tsconfig that compiles the application, including the one your runner uses. When a type genuinely cannot be expressed — an interface, a string token — inject explicitly with `@Inject(TOKEN)`.

:::note
The frequently quoted string *"Cannot determine a type for … (Object)"* is not what `@nestjs/core@12.0.1` prints; the symptom of missing metadata there is the message above, with `Object` or nothing in the dependency list. A message beginning `Cannot determine a GraphQL output type for the "…"` does exist, but it comes from `@nestjs/graphql` and means a class is missing `@ObjectType()` — a different problem.
:::

More: [Dependency injection](../nestjs/dependency-injection.md), [Native TypeScript support](../node/native-typescript-support.md).

### `Nest cannot create the module instance. Often, this is because of a circular dependency`

```text
Nest cannot create the module instance. Often, this is because of a circular dependency between
modules. Use forwardRef() to avoid it.

Scope [AppModule -> UsersModule -> OrdersModule]
```

**Cause.** Two modules import each other, so whichever loads first sees `undefined` where the other should be. The `Scope [...]` trail is the cycle.

**Fix.** Break the cycle if you can — extract the shared piece into a third module — and use `forwardRef()` only when you genuinely cannot. It is needed on **both** sides.

```ts title="src/users/users.module.ts"
import { Module, forwardRef } from '@nestjs/common'
import { OrdersModule } from '../orders/orders.module.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [forwardRef(() => OrdersModule)],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

The same applies between **providers**, with `@Inject(forwardRef(() => OtherService))` on the constructor parameter.

A closely related message names the position instead:

```text
Nest cannot create the AppModule instance.
The module at index [1] of the AppModule "imports" array is undefined.
```

That is either the same cycle, or a genuinely bad import — a typo, a barrel file that re-exports in a loop, or a missing `.js` extension in an ESM project.

More: [Modules](../nestjs/modules.md).

### `Nest cannot export a provider/module that is not a part of the currently processed module`

```text
Nest cannot export a provider/module that is not a part of the currently processed module
(OrdersModule). Please verify whether the exported UsersService is available in this particular
context.
```

**Cause.** `exports` lists a token the module neither provides nor imports. Exporting is re-publishing something you already have.

**Fix.** Either add the provider to this module's `providers`, or import the module that owns it and re-export *that module* rather than the provider.

### `UsersService is marked as a scoped provider … use "resolve()" instead`

```text
UsersService is marked as a scoped provider. Request and transient-scoped providers can't be
used in combination with "get()" method. Please, use "resolve()" instead.
```

**Cause.** `ModuleRef.get()` returns a singleton. A request- or transient-scoped provider does not have one.

**Fix.** `await moduleRef.resolve(UsersService)`, which creates an instance bound to a context id. In a test, `await moduleRef.resolve(...)` likewise.

More: [Injection scopes](../nestjs/injection-scopes.md).

### Everything became request-scoped and throughput dropped

**Symptom.** One provider was marked `{ scope: Scope.REQUEST }`, and now unrelated services are constructed per request. Latency rises, memory churn rises, and singleton state — a cache, a counter, a warmed connection — silently resets on every call.

**Cause.** Scope bubbles **up**. Any provider that injects a request-scoped provider becomes request-scoped, and so does the controller above it, transitively to the root of that chain.

**Fix.** Three options, in order of preference:

1. **Do not inject it.** Read the request through a `@Req()` parameter or a custom parameter decorator and pass the value down as an argument. Most "I need the current user in this service" cases are this.
2. **Inject `REQUEST` at the edge only** — in the controller or a guard — and keep services singleton.
3. **Use a durable provider** if you really need per-tenant instances: `{ scope: Scope.REQUEST, durable: true }` plus a `ContextIdStrategy`, which reuses one subtree per tenant instead of per request.

More: [Injection scopes](../nestjs/injection-scopes.md).

### `An invalid controller has been detected. "UsersController" does not have the @Controller() decorator`

**Cause.** The class is in a module's `controllers` array but is not decorated — usually a copy-paste, or a decorator lost during a refactor.

**Fix.** Add `@Controller()`. If the class is a provider rather than a controller, move it to `providers` and give it `@Injectable()`.

## Routing and bootstrap

### `TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError`

**Cause.** A `*` or `:` with no name after it, compiled by `path-to-regexp@8.4.2` — the version `@nestjs/platform-express@12.0.1` bundles. The number is the character offset inside the path string. It is thrown while routes are being **registered**, so the process dies before it listens.

:::legacy Express 4 / NestJS 11 spellings — each of these throws on Nest 12
```ts
import { Controller, Get } from '@nestjs/common'

@Controller()
export class SpaController {
  @Get('*')          // Missing parameter name at 1
  index() {}

  @Get('files/*')    // same
  files() {}
}
```
:::

**Fix.** Name the wildcard, and brace it if it must also match the mount root:

```ts title="src/spa/spa.controller.ts"
import { Controller, Get } from '@nestjs/common'

@Controller()
export class SpaController {
  // '{*splat}' matches '/' too. '*splat' does not.
  @Get('{*splat}')
  index() {
    return { ok: true }
  }
}
```

Grep `forRoutes(`, `exclude(` and `setGlobalPrefix(` as well — middleware and prefix paths go through the same compiler.

More: [Express 4 → 5 for Nest routes](express-4-to-5-for-nest.md), [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

### `TypeError: Unexpected [ at 1, expected END: https://git.new/pathToRegexpError`

**Cause.** A reserved character used literally. `(`, `)`, `[`, `]`, `?`, `+` and `!` are all reserved in path-to-regexp 8.

**Fix.** Escape it with a doubled backslash (`@Get('\\(draft\\)')`), or express the intent properly: an array of paths instead of `[a|b]` alternation, a brace group instead of a trailing `?`, a pipe instead of an inline regex. The same error with `Unexpected ?` means an optional parameter written the Express 4 way.

More: [Express 4 → 5 for Nest routes](express-4-to-5-for-nest.md).

### `Conflicting HTTP routes detected` at boot

```text
Conflicting HTTP routes detected:
  - Duplicate route: GET /users/:id is registered by both UsersController.findOne and
    LegacyUsersController.findOne.
Adjust route declarations or relax the 'routeConflictPolicy' option passed to NestFactory.create()
to allow the application to start.
```

**Cause.** You enabled `routeConflictPolicy: { duplicate: 'error' }` and two handlers claim the same (method, path, host, version). Only the first-registered one can ever run.

**Fix.** Delete the dead one — this diagnostic exists because the loser is unreachable and *which* one loses depends on module resolution order. The `shadow` variant is a warning rather than an error and reads:

```text
Route GET /users/:id (UsersController.findOne) is shadowed by GET /users/me (UsersController.me).
The first-registered route will match all matching requests on order-sensitive adapters.
```

A shadow is often deliberate and correct. Fix the ones that are not by reordering, or by turning on `routeResolutionStrategy: 'specificity'`.

More: [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

### `The middleware doesn't provide the 'use' method (LoggerMiddleware)`

**Cause.** A class passed to `consumer.apply()` implements neither `NestMiddleware` nor a `use()` method — usually because the wrong export was imported, or the class implements `canActivate()` and is actually a guard.

**Fix.** Middleware classes implement `use(req, res, next)`. Plain Express `(req, res, next)` functions are also accepted, unchanged.

More: [Middleware](../nestjs-request-handling/middleware.md).

## Validation and serialization

### `ValidationPipe` accepts everything and never throws

**Symptom.** A request with a missing required field, a wrong type, or twenty unexpected properties reaches the handler with a 200.

**Cause.** One of four, all silent:

| Cause | Check |
| --- | --- |
| The pipe is not registered globally, and not on the route | `useGlobalPipes(new ValidationPipe())` or `{ provide: APP_PIPE, useClass: ValidationPipe }` |
| The DTO is an `interface`, not a `class` | interfaces are erased; there is no metadata to validate |
| The parameter is typed as a primitive or `any` | the pipe skips parameters whose metatype is not a validatable class |
| `emitDecoratorMetadata` is off | no `design:type` metadata, so nothing to validate against |

**Fix.** A class, decorated, with the pipe registered:

```ts title="src/users/dto/create-user.dto.ts"
import { IsEmail, Length } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  email!: string

  @Length(1, 80)
  name!: string
}
```

```ts title="src/main.ts"
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  await app.listen(3000)
}

bootstrap()
```

Verify with a deliberately bad request rather than by reading the code:

```bash
curl -i -X POST http://localhost:3000/users -H 'content-type: application/json' -d '{"email":"nope"}'
```

A 201 here means the pipe is not running. More: [The ValidationPipe](../nestjs-validation/validation-pipe.md), [Validation as a security control](../nestjs-security/validation-as-a-control.md).

### `errorCode` never appears in the response body

**Symptom.** `throw new BadRequestException('Password is too weak', { errorCode: 'WEAK_PASSWORD' })` returns `{"message":"Password is too weak","statusCode":400}`. No `errorCode`.

**Cause.** This is a **silent no-op**, verified in the shipped source. `HttpException.createBody()` accepts `errorCode` as a fourth argument and copies it into the body — but no built-in exception subclass passes it, and `BaseExceptionFilter` in `@nestjs/core` contains no reference to `errorCode` at all. The constructor option sets `exception.errorCode` on the object and nothing reads it on the way out.

**Fix.** Either build the body yourself with the four-argument overload:

```ts title="src/common/exceptions/weak-password.exception.ts"
import { HttpException, HttpStatus } from '@nestjs/common'

export class WeakPasswordException extends HttpException {
  constructor(message = 'Password is too weak') {
    super(
      HttpException.createBody(message, 'Bad Request', HttpStatus.BAD_REQUEST, 'WEAK_PASSWORD'),
      HttpStatus.BAD_REQUEST,
      { errorCode: 'WEAK_PASSWORD' },
    )
  }
}
```

…or register one filter that reads the field off every `HttpException` and adds it. Pick one and apply it everywhere; mixing them produces clients that fall back to string-matching `message`.

More: [NestJS 11 → 12 migration](v11-to-v12-migration.md), [Exception filters](../nestjs-request-handling/exception-filters.md).

## Module format

### `Error [ERR_REQUIRE_ESM]: require() of ES Module …`

**Cause.** A CommonJS file is `require()`ing an ES module on a Node that cannot do it, or through a bundler that rewrote `import` into `require`. Nest 12's core packages are ESM, so this surfaces during the version bump — but it is a Node/bundler problem, not a Nest one.

**Fix, in order:**

1. **Check the Node version.** Running a Nest 12 app needs **v20.19+, v22.12+, or v26+**; those are the versions with `require(esm)`. Below them, requiring the ESM core packages cannot work.
2. **Check the bundler.** A webpack or esbuild config with `mainFields` preferring `main` over `exports`, or `output.libraryTarget: 'commonjs2'`, resolves a CommonJS entry point that `@nestjs/core@12` no longer publishes. Get a plain `nest build` working first.
3. **For a genuinely ESM-only dependency in a CommonJS project,** load it with `await import()` inside an async function — a provider's `onModuleInit` is the natural place.

You do **not** have to migrate to ESM. `require(esm)` is what makes a CommonJS Nest 12 application work unchanged.

More: [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md), [The ESM migration](esm-migration.md).

### `ReferenceError: __dirname is not defined in ES module scope`

**Cause.** `__dirname`, `__filename`, `require()` and `module.exports` do not exist in an ES module. This appears the moment `"type": "module"` lands — including in files you forgot about, such as a seed script or a `jest.config.js`.

**Fix.**

```ts title="src/main.ts"
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  app.useStaticAssets(join(import.meta.dirname, '..', 'public'))
  await app.listen(3000)
}

bootstrap()
```

`import.meta.dirname` and `import.meta.filename` (Node 20.11+) replace the globals; `import.meta.resolve()` replaces `require.resolve()`; `createRequire(import.meta.url)` is the escape hatch for a CommonJS-only dependency.

More: [The ESM migration](esm-migration.md).

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find module … imported from …`

**Cause.** A relative import with no `.js` extension in an ESM project — or a directory import (`./users` expecting `./users/index.js`), which ESM does not support. The build succeeded because the compiler was not applying Node's rules.

**Fix.** Set `module: "nodenext"` **and** `moduleResolution: "nodenext"` in `tsconfig.json`, then run `npx tsc --noEmit`. Every missing extension becomes a compile error naming the exact import. Add `.js` — the extension names the *emitted* file even though the source is `.ts`.

More: [The ESM migration](esm-migration.md).

## Testing

### E2E tests pass a payload that production rejects

**Symptom.** `POST /users` with a malformed body returns 400 in production and 201 in the test suite. Or a global guard, interceptor or filter simply does not run under test.

**Cause.** `main.ts` never executes in tests. `Test.createTestingModule().compile()` builds the module graph; `createNestApplication()` builds the app — neither replays your bootstrap file.

**Fix.** Either re-apply the globals in the test setup, or — better — register them as providers so there is only one source of truth:

```ts title="test/users.e2e-spec.ts"
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('users (e2e)', () => {
  let app

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects an invalid body', async () => {
    await request(app.getHttpServer()).post('/users').send({ email: 'nope' }).expect(400)
  })
})
```

Registering `{ provide: APP_PIPE, useClass: ValidationPipe }` in `AppModule` removes the duplication entirely: the pipe is part of the module graph, so tests get it for free.

More: [End-to-end tests](../nestjs-testing/e2e-tests.md), [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md).

### The test suite hangs after the last test

**Cause.** `app.close()` was never called, so the HTTP server, the database pool, a Redis client or a scheduled job is still holding the event loop open.

**Fix.** `await app.close()` in `afterAll`, and make sure every module that opens a resource closes it in `onModuleDestroy`. If it still hangs, the culprit is almost always a connection pool created outside the container.

More: [Database fixtures](../nestjs-testing/database-fixtures.md).

## Runtime and operations

### Shutdown hooks never fire

**Symptom.** `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown` never run. In-flight requests are cut off, connections are not drained, and the container is killed after the orchestrator's grace period.

**Cause.** Two independent ones, and you often have both:

1. **`app.enableShutdownHooks()` was never called.** Nest does not listen for process signals by default, because attaching listeners has a cost in applications that do not need it.
2. **The signal never reaches Node.** A Dockerfile whose `CMD` is a shell form (`CMD npm run start:prod`) runs Node as a child of `/bin/sh`, which does not forward `SIGTERM`. Node also runs as PID 1 with no init process to reap it.

**Fix, both halves:**

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  await app.listen(3000)
}

bootstrap()
```

```dockerfile title="Dockerfile"
# Exec form: node is PID 1 and receives SIGTERM directly.
CMD ["node", "dist/main.js"]
```

Run the container with an init process (`docker run --init`, or `shareProcessNamespace`/`tini` in your orchestrator) so PID 1 has a reaper. Verify with `docker stop` and check that your shutdown log line appears before the container exits.

More: [Graceful shutdown](../nestjs-production/graceful-shutdown.md), [Docker](../nestjs-production/docker.md).

### `@nestjs/schedule` crons fire once per replica

**Symptom.** A nightly job runs three times, an invoice is emailed three times, or a "process pending rows" task double-processes — and it started when you scaled from one replica to three.

**Cause.** `@nestjs/schedule` (12.0.1) is an in-process scheduler. Every replica constructs the same providers, registers the same cron expressions, and fires them independently. There is no coordination, and none is claimed.

**Fix,** in increasing order of robustness:

1. **A dedicated scheduler deployment** with `replicas: 1` and the HTTP routes disabled. Simple, and the failure mode is "the job does not run" rather than "the job runs twice".
2. **A distributed lock** around the job body — a Redis `SET key value NX PX ttl` acquired at the top and released at the end. Set the TTL longer than the job's worst-case duration.
3. **Move it to a queue.** BullMQ repeatable jobs are scheduled by Redis, so N workers still produce one execution. This is the right answer for anything with side effects.

Whichever you pick, make the job body **idempotent** as well. A lock is a reduction in probability, not a guarantee, and a redeploy in the middle of a run will eventually prove it.

More: [Scheduling](../nestjs-libraries/schedule.md), [Background jobs with BullMQ](../nestjs-libraries/bullmq.md), [Clustering](../nestjs-production/clustering.md).

### A route returns nothing and the request hangs

**Symptom.** No response, no error, no log line. The client times out.

**Cause.** The handler injects `@Res()` and returns a value instead of writing to the response. Injecting `@Res()` without `{ passthrough: true }` tells Nest you are taking over the response, so the return value is discarded.

**Fix.** Use `@Res({ passthrough: true })` when you only need side effects such as setting a cookie, and plain `@Res()` only when you genuinely write the response yourself.

More: [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md).

### An interceptor stopped transforming responses on one route

**Cause.** Same as above. `@Res()` without `passthrough` removes the result stream, so every RxJS operator after `next.handle()` — serialization, envelopes, timeouts — has nothing to operate on.

**Fix.** `@Res({ passthrough: true })`, or drop `@Res()` entirely and use `@HttpCode()` / `@Header()` / `@Redirect()`.

More: [Interceptors](../nestjs-request-handling/interceptors.md).

### Log lines changed shape after upgrading to Nest 12

**Symptom.** `logger.log('order placed', { orderId })` used to produce two entries and now produces one with structured metadata. Log queries and alerts stop matching.

**Cause.** `ConsoleLogger` treats a trailing plain object as structured params, and `structuredParams` defaults to **`true`** in v12.

**Fix.** Update the queries, which is usually what you want, or set `structuredParams: false` explicitly. In `json` mode, `flattenParams: true` spreads the params into the root object instead of nesting them under `params`.

More: [NestJS 11 → 12 migration](v11-to-v12-migration.md), [Logging](../nestjs-libraries/logging.md).

### `req.ip` is the load balancer, and rate limiting affects everyone at once

**Cause.** `trust proxy` is unset, so Express reports the socket's peer address — your proxy — for every request.

**Fix.** `app.set('trust proxy', 1)` on a `NestExpressApplication`, with the **number of proxies** in front of you. Never `true` in production: it lets a client forge `X-Forwarded-For` and defeat every IP-based control.

More: [Routing](../express/routing.md), [Rate limiting and abuse](../nestjs-security/rate-limiting.md).

### Health probes started failing after adding a global prefix

**Cause.** `app.setGlobalPrefix('api')` moves every route, including `/health` and `/metrics`. The orchestrator keeps probing the old path, gets 404, and restarts healthy pods.

**Fix.** `app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] })`.

More: [Health and readiness probes](../nestjs-production/health-and-readiness-probes.md).

### The app works with `nest start` and fails from `dist/`

**Cause.** Almost always one of three: a missing `compilerOptions.assets` entry, so templates and `.graphql` or `.sql` files were never copied; a `tsconfig` path alias with no runtime resolver; or a case-mismatched import that a case-insensitive filesystem forgave locally.

**Fix.** Run `nest build && node dist/main.js` locally before every release, and then the same thing inside the container. `nest start` resolves differently enough that a working dev server proves nothing about the artifact.

More: [Build and deployment](../nestjs-production/build-and-deployment.md), [Installation and the CLI](../nestjs/installation-and-cli.md).

### `nest new` or `nest generate` fails with an engine error naming `@angular-devkit/schematics`

**Cause.** The CLI needs a newer Node than the application. `@nestjs/schematics@12.0.1` declares `engines.node: ">=22.12.0"`, so a CI image on Node 20 or 22.12 installs the CLI successfully and then fails inside the schematic.

**Fix.** Use **Node v22.22.3+, v24.15+, or v26+** wherever you run the CLI. Node 24 LTS satisfies both floors.

More: [Installation and the CLI](../nestjs/installation-and-cli.md).

## Common mistakes

- **Reading the class name in the error instead of the `?`.** The message names the failing class first and the failing *argument* second; only the second one tells you what to add.
- **Adding `forwardRef()` on one side of a cycle.** It is needed on both, and it is a workaround rather than a fix — extract the shared piece if you can.
- **Assuming a silent `ValidationPipe` is a `class-validator` bug.** It is almost always an unregistered pipe or an `interface` DTO.
- **Debugging a hanging route in the service.** Check the controller for `@Res()` first.
- **Treating `ERR_REQUIRE_ESM` as "I must migrate to ESM".** Check the Node version and the bundler; CommonJS applications work unchanged on Nest 12.
- **Testing globals only through `main.ts`.** E2E tests never run it. Use the `APP_*` provider tokens so the graph carries them.
- **Marking a provider request-scoped to reach the request object.** Scope bubbles up and takes the whole chain with it.
- **Scaling a scheduler by scaling the deployment.** Every replica runs every cron.
- **Calling `enableShutdownHooks()` and stopping there.** A shell-form `CMD` swallows the signal before Node ever sees it.

## Related topics

- [Cheat sheet](cheat-sheet.md) — the same material organized by task instead of by symptom.
- [NestJS 11 → 12 migration](v11-to-v12-migration.md) — the upgrade that produces several of these.
- [The ESM migration](esm-migration.md) — the module-format errors in context.
- [Express 4 → 5 for Nest routes](express-4-to-5-for-nest.md) — every invalid route pattern and its replacement.
- [Modules](../nestjs/modules.md) — the graph behind every resolution error.
- [Dependency injection](../nestjs/dependency-injection.md) — tokens, providers and `forwardRef()`.
- [Injection scopes](../nestjs/injection-scopes.md) — scope bubbling and durable providers.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — every option and its failure mode.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — hooks, signals and containers.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — building an app that matches production.
- [Troubleshooting](../reference/troubleshooting.md) — the Express 5 layer's own symptom index.
