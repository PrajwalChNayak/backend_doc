---
title: NestJS 11 → 12 migration
description: The complete NestJS 11 to 12 upgrade reference — ESM core packages, Standard Schema validation, lifecycle ordering, route conflict diagnostics, errorCode, structured logging, NATS v3, GraphQL, the new CLI flags and the Node floors.
status: legacy
updated: 2026-09-11
---

NestJS 12 is the current line: `@nestjs/core` and `@nestjs/common` are **12.0.1**, and both now ship as ES modules. Despite that headline, this is one of the gentler Nest majors — a CommonJS application upgrades without rewriting a single import, because Node's `require(esm)` consumes the new packages unchanged and `nest upgrade` deliberately preserves your module format. The work is in the smaller changes: two of them alter behavior silently, and one of them is an API that looks like it does something and does not.

This page and the two beside it are the only places on the site where NestJS 11 idioms appear. Every "before" snippet below is inside a `:::legacy` or `:::deprecated` callout; none of it runs on Nest 12.

:::note
Facts on this page were verified on 2026-09-09 against the published type declarations and JavaScript inside `@nestjs/common@12.0.1`, `@nestjs/core@12.0.1`, `@nestjs/platform-express@12.0.1`, `@nestjs/config@12.0.0`, `@nestjs/microservices@12.0.1`, `@nestjs/apollo@14.0.0`, `@nestjs/cli@12.0.0` and `@nestjs/schematics@12.0.0` — unpacked from the registry and read directly, not taken from release notes.
:::

## Before you start

| Thing | Value |
| --- | --- |
| `@nestjs/core`, `@nestjs/common` | **12.0.1**, `"type": "module"` |
| `@nestjs/platform-express` | 12.0.1 — bundles `express` 5.2.1, `multer` 2.2.0, `cors` 2.8.6, `path-to-regexp` 8.4.2 |
| `@nestjs/cli` | **12.0.0** (`engines.node: ">= 20.11"`) |
| `@nestjs/schematics` | **12.0.0** (`engines.node: ">=22.12.0"`) |
| Node to **run** a Nest 12 app | **v20.19+, v22.12+, or v26+** |
| Node to **use the CLI** | **v22.22.3+, v24.15+, or v26+** |
| Node this handbook targets | **24 LTS** — satisfies both |
| Supporting packages | `reflect-metadata` 0.2.2, `rxjs` 7.8.2, `class-validator` 0.15.1, `class-transformer` 0.5.1, `@standard-schema/spec` 1.1.0 |

The CLI needs a newer Node than the application, because `@nestjs/schematics@12` sits on the Angular devkit. A CI image pinned to Node 20 or 22.12 installs the CLI and then fails inside a schematic with an engine error that names `@angular-devkit/schematics` rather than Nest.

### Four packages that are not on the 12.x line

Writing `@nestjs/throttler@12` or `@nestjs/graphql@12` in a `package.json` produces a resolution error, not a downgrade.

| Package | Actual current version |
| --- | --- |
| `@nestjs/throttler` | **6.5.0** |
| `@nestjs/graphql` | **14.0.0** |
| `@nestjs/apollo` | **14.0.0** |
| `@nestjs/observe` | **0.1.8** — pre-1.0, new, expect churn |

## The upgrade procedure

1. **Get onto Node 24 LTS first,** if you are not there. Node 20 reached end of life on 2026-04-30. Doing the runtime and the framework in one change means debugging two migrations at once.
2. **Upgrade the CLI and the schematics before anything else.** `nest upgrade` is implemented *by the schematics package*, so running it with the old one applies the old migrations.

   ```bash
   npm install -g @nestjs/cli@latest @nestjs/schematics@latest
   nest --version
   ```

3. **Dry-run the upgrade** and read the diff it proposes.

   ```bash
   nest upgrade --dry-run
   ```

4. **Run it for real.**

   ```bash
   nest upgrade
   ```

   It bumps the `@nestjs/*` ranges in `package.json` and applies the version's migration schematics. It does **not** change your module format: a CommonJS project stays CommonJS.

   Useful flags, all verified against `@nestjs/cli@12.0.0`: `-d, --dry-run`, `-s, --skip-install`, `-t, --tag [tag]` to take an npm dist-tag such as `next`, `-c, --collection [name]` for a non-default schematics collection, and `--observe` / `--no-observe` to answer the `@nestjs/observe` setup prompt non-interactively.

5. **Fix the packages `nest upgrade` cannot know about.** `@nestjs/throttler`, `@nestjs/graphql`, `@nestjs/apollo` and any community module are on their own version lines.
6. **Boot the application.** Invalid route paths throw at registration, so the process dies immediately with the offending pattern — see [Express 4 → 5 for Nest routes](express-4-to-5-for-nest.md) if you are also crossing the Express 4 → 5 boundary.
7. **Work through the sections below.** ESM is optional; lifecycle ordering, NATS and the logger are not.
8. **Turn on the route conflict diagnostics in CI** before you ship. They are free and they find dead endpoints.
9. **Tick the checklist** at the end of this page.

## ESM: the core packages moved, your app does not have to

Both `@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` declare `"type": "module"`, and their internal imports carry `.js` extensions. This is the change everyone reads first and it is the one least likely to affect you.

| | Nest 11 | Nest 12 |
| --- | --- | --- |
| `@nestjs/core`, `@nestjs/common` on disk | CommonJS | **ESM** |
| A CommonJS app consuming them | `require()` | `require(esm)` — **no source change** |
| An ESM app consuming them | interop through the CJS build | native ESM, real named exports |
| `nest upgrade` | — | preserves the project's existing format |
| `nest new` default | CommonJS + Jest | prompts, and defaults to **ESM + Vitest** |

`require(esm)` is the Node feature that makes this a non-event: a CommonJS file can `require()` an ES module synchronously as long as the module graph has no top-level `await`, and Nest's packages are built to that constraint. It is also why the runtime floor moved to **v20.19+ / v22.12+ / v26+** — those are the versions where `require(esm)` is available.

So there is no "before and after" for a CommonJS application. This keeps working, unchanged:

```ts title="src/main.ts — CommonJS project, untouched by the upgrade"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  await app.listen(3000)
}

bootstrap()
```

If you *choose* to move to ESM, the five required changes are `"type": "module"`, tsconfig `module: "nodenext"` / `moduleResolution: "nodenext"` / `resolvePackageJsonExports: true`, `.js` extensions on relative imports, and `import.meta.dirname` in place of `__dirname`. That is a separate project with its own page: [The ESM migration](esm-migration.md).

:::best-practice
Do not bundle an ESM migration into the version bump. Upgrade to 12 on CommonJS, ship it, and decide about ESM later against a concrete need — an ESM-only dependency, or wanting Vitest. `require(esm)` and `nest upgrade`'s format preservation exist precisely so these can be two changes.
:::

## Standard Schema validation and serialization

Nest 12 adds first-class support for the [Standard Schema](https://standardschema.dev/) spec, so Zod 4.5.4, Valibot 1.4.2 and ArkType 2.2.3 all work through one built-in pipe instead of a hand-written one. `class-validator` is unchanged and is not deprecated — this is a second option, not a replacement.

The v11 way was your own pipe:

:::legacy NestJS 11 — a hand-rolled Zod pipe was the only option
```ts
import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common'
import type { ZodType } from 'zod'

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  private readonly schema: ZodType

  constructor(schema: ZodType) {
    this.schema = schema
  }

  transform(value: unknown, _metadata: ArgumentMetadata) {
    const result = this.schema.safeParse(value)
    if (!result.success) throw new BadRequestException(result.error.issues)
    return result.data
  }
}
```
:::

In v12 the schema travels on the parameter decorator and a built-in pipe reads it:

```ts title="src/users/users.controller.ts"
import { Body, Controller, Post } from '@nestjs/common'
import { z } from 'zod'
import { UsersService } from './users.service.js'

const CreateUser = z
  .object({ email: z.email(), name: z.string().min(1).max(80) })
  .strict()

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Post()
  create(@Body({ schema: CreateUser }) dto: z.infer<typeof CreateUser>) {
    return this.users.create(dto)
  }
}
```

`schema` is a field on `ParameterDecoratorOptions`, which `@Body()`, `@Query()`, `@Param()`, `@RawBody()`, `@Payload()` and `@MessageBody()` all accept. The same options object also takes `pipes`.

Register the pipe once, globally:

```ts title="src/main.ts"
import { StandardSchemaValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }))
  await app.listen(3000)
}

bootstrap()
```

The verified option shape:

```ts
interface StandardSchemaValidationPipeOptions {
  transform?: boolean                    // default true — return the schema's output
  validateCustomDecorators?: boolean     // default false — skip createParamDecorator params
  validateOptions?: Record<string, unknown>
  errorHttpStatusCode?: ErrorHttpStatusCode   // default HttpStatus.BAD_REQUEST
  exceptionFactory?: (issues: readonly StandardSchemaV1.Issue[]) => any
}
```

### Serializing with a schema

`StandardSchemaSerializerInterceptor` is the response-side counterpart to `ClassSerializerInterceptor`. It takes a `Reflector` plus defaults, and reads a per-handler schema from `@SerializeOptions()`:

```ts title="src/main.ts"
import { StandardSchemaSerializerInterceptor } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.useGlobalInterceptors(new StandardSchemaSerializerInterceptor(app.get(Reflector)))
  await app.listen(3000)
}

bootstrap()
```

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param, SerializeOptions } from '@nestjs/common'
import { z } from 'zod'
import { UsersService } from './users.service.js'

const PublicUser = z.object({ id: z.string(), name: z.string() })

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  @SerializeOptions({ schema: PublicUser })
  findOne(@Param('id') id: string) {
    // Whatever the service returns, only id and name leave the process.
    return this.users.findById(id)
  }
}
```

Both `StandardSchemaSerializerInterceptorOptions` and `@SerializeOptions()` accept `{ schema, validateOptions }`. The full treatment is in [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) and [Serialization](../nestjs-validation/serialization.md).

## `@nestjs/config`: any Standard Schema, and Joi settings moved

`@nestjs/config@12.0.0` accepts **any** Standard Schema as `validationSchema`, which means a Zod schema validates your environment with no adapter:

```ts title="src/app.module.ts"
import { ConfigModule } from '@nestjs/config'
import { Module } from '@nestjs/common'
import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().min(1),
})

@Module({
  imports: [ConfigModule.forRoot({ validationSchema: Env, cache: true })],
})
export class AppModule {}
```

Joi still works — it is a Standard Schema vendor — but **library-specific settings moved one level down**, under `validationOptions.libraryOptions`. A `validationOptions` object holding Joi keys directly is the v11 shape and is silently ignored in v12, which is the worst possible failure mode for a config validator.

:::legacy NestJS 11 — Joi settings sat directly on validationOptions
```ts
ConfigModule.forRoot({
  validationSchema: joiEnvSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
})
```
:::

```ts title="Nest 12 — nested under libraryOptions"
import { ConfigModule } from '@nestjs/config'

ConfigModule.forRoot({
  validationSchema: joiEnvSchema,
  validationOptions: {
    libraryOptions: { allowUnknown: true, abortEarly: false },
  },
})
```

:::tip
For Joi schemas the package already defaults `abortEarly: false` and `allowUnknown: true`, because Joi's own defaults (`true` / `false`) would report only the first failure and reject every unrelated variable in `process.env`. So the block above is usually unnecessary — you only need `libraryOptions` when you want something *other* than those defaults.
:::

See [Configuration](../nestjs/configuration.md).

## Lifecycle hook ordering changed

Nest 12 runs lifecycle hooks **by component hierarchy level** rather than in the order v11 used. `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown` and `onApplicationShutdown` can therefore fire in a different relative order across dependent providers than they did before.

This is the change most likely to break a working application, because nothing errors: code that happened to run in the right order now runs in a different one.

:::legacy NestJS 11 — order that worked by accident
```ts
import { Injectable, OnModuleInit } from '@nestjs/common'
import { MigrationRunner } from './migration-runner.js'

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly migrations: MigrationRunner

  constructor(migrations: MigrationRunner) {
    this.migrations = migrations
  }

  // Assumed MigrationRunner.onModuleInit() had already run.
  async onModuleInit() {
    await this.seed()
  }
}
```
:::

The fix is not to reorder anything — it is to stop depending on hook order at all. Make the dependency explicit:

```ts title="src/database/seed.service.ts"
import { Injectable, OnModuleInit } from '@nestjs/common'
import { MigrationRunner } from './migration-runner.js'

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly migrations: MigrationRunner

  constructor(migrations: MigrationRunner) {
    this.migrations = migrations
  }

  async onModuleInit() {
    // Await the thing you need instead of assuming its hook already ran.
    await this.migrations.ensureUpToDate()
    await this.seed()
  }
}
```

Audit every `onModuleInit` and `onApplicationBootstrap` in the codebase for an assumption about what else has already initialized. Migrations, cache warmers, queue registration and anything that opens a connection are the usual suspects. See [Modules](../nestjs/modules.md) and [Graceful shutdown](../nestjs-production/graceful-shutdown.md).

## Route conflict diagnostics (new, opt-in)

Two new `NestApplicationOptions` fields turn silent route collisions into boot-time output. Both default to off.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    routeConflictPolicy: { duplicate: 'error', shadow: 'warn' },
    routeResolutionStrategy: 'specificity',
  })
  await app.listen(3000)
}

bootstrap()
```

The verified types:

```ts
type RouteConflictPolicyLevel = 'off' | 'warn' | 'error'

interface RouteConflictPolicy {
  duplicate?: RouteConflictPolicyLevel
  shadow?: RouteConflictPolicyLevel
}

type RouteResolutionStrategy = 'declaration' | 'specificity'
```

Each conflict kind defaults to `'off'`; `routeResolutionStrategy` defaults to `'declaration'`.

| Kind | Definition | Verdict |
| --- | --- | --- |
| `duplicate` | an identical **(method, path, host, version)** registration | always a bug — one handler is unreachable. Use `'error'`. |
| `shadow` | two patterns that can match the same request, e.g. `/users/me` and `/users/:id` | often deliberate. Use `'warn'`. |

`'specificity'` registers literal segments ahead of parametric and wildcard ones on order-sensitive adapters such as Express, so `@Get('users/me')` wins over `@Get('users/:id')` regardless of declaration or module-resolution order. It is a **behavior change**, not a diagnostic: enable it with route tests, not in a hotfix.

Full treatment, including how the two options interact: [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

## `errorCode` on `HttpExceptionOptions` — read this before you use it

`errorCode` is a real, new field on `HttpExceptionOptions` and on `HttpException`. This compiles and sets the property:

```ts
import { BadRequestException } from '@nestjs/common'

throw new BadRequestException('Password is too weak', { errorCode: 'WEAK_PASSWORD' })
```

:::warning It does not appear in the response body on its own
Verified by reading the shipped `@nestjs/common@12.0.1` and `@nestjs/core@12.0.1` source, not the documentation.

`HttpException.createBody(arg0, arg1, statusCode, errorCode)` *does* take an `errorCode` fourth argument and copies it into the body when present. But **no built-in subclass passes it**: `BadRequestException` calls `createBody(objectOrError, description, HttpStatus.BAD_REQUEST)` with three arguments, and `BaseExceptionFilter` in `@nestjs/core` contains no reference to `errorCode` at all — the string does not occur anywhere in the package.

So the line above sets `exception.errorCode` and nothing else. The default 400 body is still `{ message, statusCode }`. Setting `errorCode` alone is a **silent no-op**, and a reader will lose an afternoon to it.
:::

There are exactly two ways to surface it. Build the body yourself with the four-argument `createBody`:

```ts title="src/common/exceptions/weak-password.exception.ts"
import { HttpException, HttpStatus } from '@nestjs/common'

export class WeakPasswordException extends HttpException {
  constructor(message = 'Password is too weak') {
    super(
      // createBody(message, error, statusCode, errorCode) — the 4-argument overload
      HttpException.createBody(message, 'Bad Request', HttpStatus.BAD_REQUEST, 'WEAK_PASSWORD'),
      HttpStatus.BAD_REQUEST,
      { errorCode: 'WEAK_PASSWORD' },
    )
  }
}
```

```json title="the response"
{ "message": "Password is too weak", "error": "Bad Request", "statusCode": 400, "errorCode": "WEAK_PASSWORD" }
```

Or write one filter that reads the field off every `HttpException`, which is the better answer if you want machine-readable codes across the whole API:

```ts title="src/common/filters/error-code.filter.ts"
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common'
import type { Response } from 'express'

@Catch(HttpException)
export class ErrorCodeFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    const original = exception.getResponse()
    const body: Record<string, unknown> =
      typeof original === 'string'
        ? { message: original, statusCode: exception.getStatus() }
        : { ...(original as Record<string, unknown>) }

    if (exception.errorCode) body.errorCode = exception.errorCode

    response.status(exception.getStatus()).json(body)
  }
}
```

:::best-practice
Pick one of the two mechanisms and apply it globally. The failure mode of mixing them — some exceptions carrying `errorCode` in the body and others carrying it only on the object — is a client that silently falls back to string-matching `message`. See [Exception filters](../nestjs-request-handling/exception-filters.md).
:::

## `ConsoleLogger`: trailing objects are now structured params

`ConsoleLogger` treats a trailing plain object as **structured metadata** attached to the log entry rather than as a separate message. `structuredParams` defaults to **`true`**, so this is on by default and changes your log output without any configuration change.

:::legacy NestJS 11 — the trailing object was logged as its own message
```ts
import { Logger } from '@nestjs/common'

const logger = new Logger('OrdersService')

// v11: two log lines — the text, then the object.
logger.log('order placed', { orderId: 'o_1', total: 4999 })
```
:::

```ts title="Nest 12 — one entry, with params"
import { Logger } from '@nestjs/common'

export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)

  place(orderId: string, total: number) {
    // One entry; { orderId, total } is metadata on it.
    this.logger.log('order placed', { orderId, total })
  }
}
```

Two options control it, both verified on `ConsoleLoggerOptions`:

| Option | Default | Effect |
| --- | --- | --- |
| `structuredParams` | **`true`** | a trailing plain object becomes params on the entry instead of a separate message |
| `flattenParams` | `false` | in `json` mode, spreads params into the root object instead of nesting under `params`. Requires `structuredParams`. |

```ts title="src/main.ts"
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: true,
      colors: false,
      structuredParams: true,
      flattenParams: true, // params at the root: { message, orderId, total, … }
    }),
  })
  await app.listen(3000)
}

bootstrap()
```

:::warning
If a log-shipping pipeline greps or parses Nest's output, this changes what it sees. Check your log queries against a real v12 line before you roll it out — and if you want the old two-message behavior, set `structuredParams: false` explicitly rather than relying on the default.
:::

Never log secrets, tokens or PII into params — they are now part of a structured record that is far more likely to be indexed. See [Logging without leaking PII](../security/logging-without-leaking-pii.md) and [Safe logging](../nestjs-security/safe-logging.md).

## Microservices: NATS v3

The `nats` package is npm-deprecated with the notice *"Package moved. Use @nats-io/transport-node"*. Nest 12's NATS transport is built against **`@nats-io/transport-node` 3.4.0**.

:::deprecated NestJS 11 — the moved package
```bash
npm install nats
```
:::

```bash
npm uninstall nats
npm install @nats-io/transport-node@3
```

The connection options on `NatsOptions` are unchanged, so `ClientsModule` and `NestFactory.createMicroservice()` need no edit. What *does* change is custom deserializers: they now receive the **full NATS message object** rather than a decoded payload, and you read it with `msg.json()`.

:::legacy NestJS 11 — a custom deserializer received a decoded payload
```ts
import type { ConsumerDeserializer, IncomingRequest } from '@nestjs/microservices'

export class LegacyNatsDeserializer implements ConsumerDeserializer {
  deserialize(value: unknown): IncomingRequest {
    return value as IncomingRequest
  }
}
```
:::

```ts title="src/transport/nats.deserializer.ts"
import type { ConsumerDeserializer, IncomingEvent, IncomingRequest } from '@nestjs/microservices'

interface NatsMessage {
  json<T>(): T
}

export class NatsJsonDeserializer implements ConsumerDeserializer {
  deserialize(message: NatsMessage): IncomingRequest | IncomingEvent {
    // v12: the argument is the NATS message, not its payload.
    return message.json<IncomingRequest>()
  }
}
```

This is exactly what the shipped `NatsRequestJSONDeserializer` does, so if you were not overriding the deserializer there is nothing to change. If you were, the old code receives an object with a `json()` method where it expected `{ pattern, data }` — and the symptom is a handler that never fires rather than an exception. See [Microservices and transports](../nestjs-advanced/microservices.md).

## GraphQL: GraphiQL by default, `graphql-ws` for subscriptions

`@nestjs/graphql` and `@nestjs/apollo` are on **14.0.0**, with `graphql` 17.0.2, `@apollo/server` 5.5.1 and `graphql-ws` 6.2.1.

**GraphiQL is the default IDE.** `ApolloDriverConfig` gains `graphiql?: boolean | GraphiQLOptions`, and `playground` remains as a deprecated boolean alias. When neither is set, GraphiQL is enabled outside production — verified in the driver: it resolves `options.graphiql ?? options.playground ?? process.env.NODE_ENV !== 'production'`.

:::deprecated NestJS 11 — the playground flag and the dead subscription transport
```ts
GraphQLModule.forRoot({
  driver: ApolloDriver,
  playground: true,
  installSubscriptionHandlers: true,
  subscriptions: { 'subscriptions-transport-ws': true },
})
```
`subscriptions-transport-ws` is npm-deprecated — *"no longer maintained"*.
:::

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo'
import { GraphQLModule } from '@nestjs/graphql'

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      graphiql: true,
      subscriptions: { 'graphql-ws': true },
    }),
  ],
})
export class AppModule {}
```

`SubscriptionConfig` in `@nestjs/graphql@14` declares a `'graphql-ws'` key and imports `ServerOptions` from `graphql-ws`. Disable GraphiQL in production with `graphiql: false`. See [GraphQL](../nestjs-advanced/graphql.md).

## `@nestjs/observe` (new, 0.1.8)

A new first-party observability SDK, opt-in through the `instrument` application option on `NestApplicationContextOptions`. The CLI can wire it up for you — `nest new --observe` and `nest upgrade --observe` both exist, and both have `--no-observe` counterparts that skip the prompt.

:::warning
It is version **0.1.8**. That is pre-1.0: the API can change in a minor release, and it has one runtime dependency. Adopt it for a new service where you can absorb churn, not as the observability layer of a system you are trying to stabilize. OpenTelemetry through the same `instrument` hook remains the conservative choice — see [Observability](../nestjs-production/observability.md) and [Observability with @nestjs/observe](../nestjs-libraries/observe.md).
:::

## The CLI

`@nestjs/cli@12.0.0`. Everything below was read from the shipped command definitions.

### New command

```bash
nest deploy
```

Deploys the built application to a hosting target. It claims no options of its own and passes whatever you type straight through, so treat it as a convenience for getting something running rather than a replacement for a pipeline you control.

### New flags on `nest build` and `nest start`

| Flag | What it does |
| --- | --- |
| `--rspackPath [path]` | point the bundled build at an rspack configuration |
| `--emit-declarations` | emit `.d.ts` alongside the JavaScript |
| `--no-type-check` | transpile without running the type checker |
| `--silent` | suppress the CLI's own output |
| `--parallel [concurrency]` | build monorepo projects in parallel, optionally capped (`nest build` only) |

```bash
nest start --watch --no-type-check      # fast inner loop
nest build --all --parallel 4           # monorepo CI
npx tsc --noEmit                        # the type gate you still owe
```

:::danger
`--no-type-check` makes builds fast by not checking anything. It belongs in `start:dev`, never in the command that produces a production artifact. Pair it with a separate `tsc --noEmit` step in CI, or the types stop being enforced anywhere.
:::

### `nest-cli.json`

`compilerOptions.includeLibraryAssets` is new: a list of library project names whose declared assets should also be copied when building an application that depends on them. Without it, a shared monorepo library that ships templates or `.graphql` files contributes nothing to `dist/`.

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "mail/templates/**/*.hbs", "watchAssets": true }],
    "includeLibraryAssets": ["shared-mail"]
  }
}
```

### `nest new` now asks about the module format

`@nestjs/schematics@12.0.0` prompts *"Which module system would you like to use?"* with two choices — **ESM (with Vitest)** and **CJS (with Jest)** — and the schema's default is `esm`. The generated ESM project ships `"type": "module"`, a `nodenext` tsconfig with `resolvePackageJsonExports: true`, `vitest` scripts and **oxlint** in place of ESLint.

Existing applications are unaffected: `nest upgrade` does not change your format, your test runner, or your linter.

## Express 5 route paths

If you are crossing the Express 4 → 5 boundary in the same upgrade — which you are, if you came from Nest 10 — the path grammar changed and invalid patterns now throw at **bootstrap**. That is its own page: [Express 4 → 5 for Nest routes](express-4-to-5-for-nest.md). The short version:

| Before | Nest 12 |
| --- | --- |
| a bare `*` in a route string | `'*splat'`, or `'{*splat}'` to include the mount root |
| a `?` after a `:param` | a brace group: `':file{.:ext}'`, `'books{/:id}'` |
| inline regex or `[a\|b]` alternation | an array of paths |
| an unescaped `(`, `)`, `[`, `]`, `?`, `+`, `!` | escape it with a backslash |

## You are done when

Tick every line before you call the upgrade finished.

- `node -v` is **24 LTS** (or v22.22.3+ / v26+) on your machine, in CI, and in the image.
- `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/testing` all resolve to **12.0.1**; `@nestjs/cli` and `@nestjs/schematics` to **12.0.0**.
- No `package.json` entry asks for `@nestjs/throttler@12`, `@nestjs/graphql@12` or `@nestjs/apollo@12`. Those lines are 6.5.0 and 14.0.0.
- The application boots with no `path-to-regexp` `TypeError`.
- Every `onModuleInit` / `onApplicationBootstrap` that depended on another provider's hook now awaits that provider explicitly.
- `nest build` succeeds and `node dist/main.js` runs the **built output**, not just `nest start`.
- The grep for moved packages is clean:

  ```bash
  grep -rnE "from '(nats|subscriptions-transport-ws)'|require\('(nats|subscriptions-transport-ws)'\)" src/
  ```

- Every Joi `validationOptions` in a `ConfigModule.forRoot()` nests its settings under `libraryOptions`.
- Log assertions, dashboards and alert queries have been checked against a real v12 line, because `structuredParams` defaults to `true`.
- Any custom NATS deserializer calls `msg.json()`.
- GraphQL subscriptions are configured as `subscriptions: { 'graphql-ws': true }`, and `graphiql` is `false` in production.
- No `errorCode` is set on a built-in exception without either the four-argument `createBody` or a filter that reads it.
- `routeConflictPolicy: { duplicate: 'error', shadow: 'warn' }` ran at least once in CI, and every reported duplicate has been removed.
- The module format is unchanged unless you deliberately migrated it — see [The ESM migration](esm-migration.md).
- The test suite passes, and one end-to-end test per HTTP method has run against the built artifact.

## Common mistakes

- **Believing Nest 12 forces an ESM migration.** It does not. `require(esm)` consumes the ESM packages from CommonJS unchanged, and `nest upgrade` preserves your format by design.
- **Running `nest upgrade` before upgrading `@nestjs/schematics`.** The migration logic lives in the schematics package, so you get the previous version's migrations and a false sense of completion.
- **Setting `errorCode` and expecting it in the response.** Nothing in the framework reads it on the way out. Use the four-argument `createBody`, or a filter.
- **Ignoring the lifecycle ordering change** because nothing errored. It does not error; it reorders. Audit every hook that assumed another had already run.
- **Leaving Joi settings directly on `validationOptions`.** They are silently ignored in v12, so a config schema you believe is validating may not be.
- **Shipping the new logger output without checking the pipeline.** `structuredParams` defaults to `true`, which changes the shape of every log line that passes a trailing object.
- **Keeping the `nats` package installed.** It is npm-deprecated and moved. `@nats-io/transport-node` 3.4.0 is the package.
- **Assuming a custom NATS deserializer still receives a payload.** It receives the message object; call `msg.json()`. The failure is a handler that never fires.
- **Turning on `routeResolutionStrategy: 'specificity'` as part of the version bump.** It reorders route registration and can change which handler serves a request. Ship it separately, with route tests.
- **Using `--no-type-check` for the production build.** Fast and unchecked. Keep `tsc --noEmit` somewhere.
- **Writing `@nestjs/graphql@12`.** There is no such version; the line is 14.0.0.
- **Adopting `@nestjs/observe` as production observability infrastructure.** It is 0.1.8.

## Related topics

- [The ESM migration](esm-migration.md) — the optional half of this upgrade, step by step.
- [Express 4 → 5 for Nest routes](express-4-to-5-for-nest.md) — the path, `req` and middleware changes that come with Express 5.
- [Troubleshooting](troubleshooting.md) — the exact error strings this upgrade produces, indexed by symptom.
- [Cheat sheet](cheat-sheet.md) — the Nest 12 API surface on one page, once you are through.
- [Decorator reference](decorator-reference.md) — every decorator, with its package.
- [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) — the decision behind the format, and why staying on CJS is fine.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — the commands and flags in day-to-day use.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — route conflict diagnostics in full.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the new validation stack.
- [Configuration](../nestjs/configuration.md) — `@nestjs/config` 12 and schema validation of the environment.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — where an `errorCode` filter belongs.
- [Microservices and transports](../nestjs-advanced/microservices.md) — NATS v3 in context.
- [GraphQL](../nestjs-advanced/graphql.md) — GraphiQL and `graphql-ws` configuration.
- [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) — the platform-level upgrade underneath.
