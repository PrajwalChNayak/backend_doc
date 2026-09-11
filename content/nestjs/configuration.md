---
title: Configuration
description: Using @nestjs/config 12.0.0 — ConfigModule.forRoot, typed ConfigService.get, namespaced config with registerAs, and boot-time validation with a Standard Schema or Joi v18.
status: current
updated: 2026-09-11
---

`@nestjs/config` is **12.0.0**, and the headline change in this line is that `validationSchema` now accepts any [Standard Schema](https://standardschema.dev/) — a Zod 4, Valibot or ArkType schema works directly, with no adapter. The job of the module has not changed: read the environment once, validate it at boot, and hand the rest of the application typed values instead of `process.env` lookups scattered across forty files.

## Why it exists

`process.env.DATABASE_URL` works. It is also a `string | undefined` that can be misspelled with no error, that reads as `undefined` in a worker that loaded a different `.env`, and that fails on the first request rather than at startup.

A config module fixes three specific things:

- **Fail fast.** A missing or malformed variable kills the process at boot, before the orchestrator routes traffic to it. A config error at 09:00 on deploy is an incident; the same error at 03:00 under load is an outage.
- **One source of truth.** Everything reads `ConfigService`, so "what does this service need in its environment" is answerable by reading one file.
- **A substitution seam.** `ConfigService` is a provider, so a test overrides it like any other token — no `process.env` mutation, no cross-test leakage.

## Setup

```bash
npm install @nestjs/config
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import configuration from './config/configuration.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      load: [configuration],
    }),
  ],
})
export class AppModule {}
```

| Option | Effect |
| --- | --- |
| `isGlobal` | registers the module globally so features do not each import it |
| `cache` | caches `process.env` reads in memory — measurably faster, and correct because the environment does not change at runtime |
| `envFilePath` | one path or an ordered list; **the first file that defines a key wins** |
| `load` | factory functions returning nested config objects |
| `expandVariables` | enables `dotenv-expand`, so `URL=${HOST}:${PORT}` resolves |
| `ignoreEnvFile` | skip `.env` entirely — what you want in a container that gets real environment variables |
| `validationSchema` | a Standard Schema validated at boot |
| `validationOptions` | options passed to that schema's validation |
| `validate` | a plain function alternative to a schema |
| `validatePredefined` | whether variables already in `process.env` at import time are validated (default `true`) |
| `skipProcessEnv` | make `ConfigService.get` ignore `process.env` and read only loaded config (default `false`) |

`isGlobal: true` is the one genuinely justified `@Global()` in most applications — configuration really is needed everywhere, and the alternative is `ConfigModule` in every feature's `imports`. Everything narrower should be a normal shared module; see [Modules](modules.md).

:::note
`envFilePath` order is "first definition wins", which is the opposite of what several other tools do. `['.env.local', '.env']` means a developer's local overrides beat the committed defaults — which is what you want, but check the direction before you debug for an hour.
:::

In production, prefer real environment variables to a `.env` file, and set `ignoreEnvFile: true` so a stray file in the image cannot shadow them. Node's own `--env-file` flag is the no-dependency alternative for local development — see [Environment variables and config](../node/environment-variables-and-config.md).

## Reading values

Inject `ConfigService` and ask for a key. The generic is what stops the value being `any`.

```ts title="src/mail/mail.service.ts"
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class MailService {
  private readonly apiKey: string
  private readonly fromAddress: string

  constructor(config: ConfigService) {
    this.apiKey = config.getOrThrow<string>('MAIL_API_KEY')
    this.fromAddress = config.get<string>('MAIL_FROM', 'noreply@example.com')
  }
}
```

| Call | Returns when missing |
| --- | --- |
| `config.get<T>('KEY')` | `undefined` |
| `config.get<T>('KEY', fallback)` | `fallback` |
| `config.getOrThrow<T>('KEY')` | throws |

Read configuration in the **constructor**, not on every call. A value read once at construction is a value that cannot be missing later, and a typo in the key becomes a bootstrap failure rather than an `undefined` that propagates into a header.

`getOrThrow` is the right default for anything without a sensible fallback. `get` with a default is for things that genuinely have one.

:::warning
`ConfigService.get` returns whatever was in the environment, and everything in `process.env` is a **string**. `config.get<number>('PORT')` compiles and gives you `'3000'`. The generic is an assertion, not a conversion — coerce in the validation schema or in a `registerAs` factory, which is exactly what the next two sections are for.
:::

## Namespaced configuration with `registerAs`

Flat `SCREAMING_SNAKE_CASE` keys stop scaling at about twenty variables. `registerAs` groups them into a typed object under a namespace, and that is also where coercion belongs.

```ts title="src/config/database.config.ts"
import { registerAs } from '@nestjs/config'

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  poolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
  statementTimeoutMs: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 5000),
  ssl: process.env.DATABASE_SSL === 'true',
}))
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import databaseConfig from './config/database.config.js'
import httpConfig from './config/http.config.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [databaseConfig, httpConfig],
    }),
  ],
})
export class AppModule {}
```

Now the values are booleans and numbers, coerced in exactly one place, and reachable two ways.

**Dot notation through `ConfigService`:**

```ts
const poolMax = config.get<number>('database.poolMax')
```

**Injected as a typed object**, which is the better option because it removes the string key entirely:

```ts title="src/database/database.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import databaseConfig from '../config/database.config.js'

@Injectable()
export class DatabaseService {
  private readonly config: ConfigType<typeof databaseConfig>

  constructor(@Inject(databaseConfig.KEY) config: ConfigType<typeof databaseConfig>) {
    this.config = config
  }

  poolOptions() {
    return { max: this.config.poolMax, ssl: this.config.ssl }
  }
}
```

`registerAs` returns the factory augmented with a `KEY` token, and `ConfigType<typeof factory>` is the inferred shape of what it returns. Rename a field and every consumer is a compile error rather than a runtime `undefined`.

For a module that needs the namespace as a dependency, `databaseConfig.asProvider()` gives you a ready-made `{ imports, useFactory, inject }` triple to spread into a `registerAsync()` call.

## Validating at boot

This is the part that earns the dependency. A schema turns "the app started and then failed strangely" into "the app refused to start, and told you which variable".

### Standard Schema (Zod 4)

New in v12: `validationSchema` takes any Standard Schema, so a Zod 4 schema goes in directly.

```ts title="src/config/validation.ts"
import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  MAIL_API_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { envSchema } from './config/validation.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envSchema,
    }),
  ],
})
export class AppModule {}
```

Three things this buys you beyond "it is not missing":

- **Coercion at the boundary.** `z.coerce.number()` means `PORT` is a real number everywhere downstream, not the string `'3000'`.
- **Defaults in one place**, rather than repeated as the second argument to every `config.get()` call.
- **A single readable failure.** Nest formats every issue with its path, so you see all four missing variables at once instead of fixing them one deploy at a time.

Zod is **4.6.2** here and the Zod 4 API is what this handbook uses — `z.url()`, not `z.string().url()`. Valibot (1.4.2) and ArkType (2.2.3) work the same way, since the interface is the Standard Schema one and not a library-specific adapter. The same schemas are used for request validation in [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md).

### Joi v18

Joi (**18.2.8**) implements Standard Schema too, so it also goes straight into `validationSchema`. What changed is where its library-specific settings live: they now nest under **`validationOptions.libraryOptions`**.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import Joi from 'joi'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        PORT: Joi.number().port().default(3000),
        DATABASE_URL: Joi.string().uri().required(),
      }),
      validationOptions: {
        libraryOptions: {
          allowUnknown: true,
          abortEarly: false,
        },
      },
    }),
  ],
})
export class AppModule {}
```

:::warning
`allowUnknown`, `abortEarly`, `stripUnknown` and `convert` placed **directly** on `validationOptions` is the pre-v12 shape. It is silently ignored now — Joi falls back to its own defaults of `allowUnknown: false` and `abortEarly: true`, which rejects the dozens of unrelated variables that are always present in `process.env` and reports only the first failure. This site's checker fails the build on the un-nested form, so the nesting above is not optional here.
:::

For Joi schemas specifically, `@nestjs/config` already applies `abortEarly: false` and `allowUnknown: true` as defaults, so the block above is only needed when you want to change them. Spell it out anyway — the explicit form documents the intent and survives someone later adding `convert: false`.

### The `validate` function

If you want neither, `validate` takes a plain function. It receives the raw config object and must return the validated one; throwing prevents bootstrap. Any edits it makes are reflected in `process.env`.

```ts
import { ConfigModule } from '@nestjs/config'

ConfigModule.forRoot({
  validate: (raw: Record<string, unknown>) => {
    if (!raw.DATABASE_URL) throw new Error('DATABASE_URL is required')
    return raw
  },
})
```

Use this for a one-off cross-field rule ("if `REDIS_URL` is set, `REDIS_TLS` must be too") that a schema expresses awkwardly. For everything else, a schema is less code and gives better errors.

## Typing `ConfigService`

`ConfigService` takes two type parameters, and the second one is the interesting one. When the environment has been validated, `ConfigService<Env, true>` makes `get()` return `T` rather than `T | undefined`:

```ts title="src/http/server.service.ts"
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { z } from 'zod'
import type { envSchema } from '../config/validation.js'

type Env = z.infer<typeof envSchema>

@Injectable()
export class ServerService {
  private readonly port: number

  constructor(config: ConfigService<Env, true>) {
    this.port = config.get('PORT', { infer: true })
  }
}
```

The `{ infer: true }` option is what makes the return type follow the key rather than defaulting to `any`. Combined with `z.infer`, a renamed variable becomes a compile error in every consumer.

## Configuration in `main.ts`

`main.ts` runs before any provider is injected into it, so reach into the container:

```ts title="src/main.ts"
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  app.setGlobalPrefix('api', { exclude: ['health'] })
  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap()
```

`app.get()` resolves a singleton from the root injector. Reading `process.env.PORT` here instead would bypass every default and every coercion the schema applied.

## Secrets

Validation proves a secret is *present*. It does nothing about where it came from or where it goes.

- **Never commit a `.env` with real values.** Commit `.env.example` with the key names and empty values; that file is also your documentation of what the schema requires.
- **Prefer injected environment variables or a secret manager** to files baked into an image. A `.env` in a container image is readable by anyone who can pull it.
- **Do not log the config object.** `logger.info({ config })` at startup is the most common way secrets reach a log aggregator that a much wider group can read.
- **Redact in error paths too.** A validation failure that prints the offending value prints the secret.

The full treatment is in [Secrets and config validation](../nestjs-security/secrets-and-config.md) and [Secrets management](../security/secrets-management.md).

## Common mistakes

- **Placing Joi options directly on `validationOptions`.** They belong under `validationOptions.libraryOptions` in v12. The un-nested form is ignored, Joi reverts to `allowUnknown: false`, and boot fails on variables that were never yours.
- **Trusting `config.get<number>('PORT')` to return a number.** The generic is an assertion. Coerce in the schema or in a `registerAs` factory.
- **Reading config on every request instead of in the constructor.** A typo then becomes an intermittent `undefined` rather than a boot failure.
- **Using `process.env` directly somewhere in the app.** It bypasses defaults, coercion and validation, and it is invisible to tests that override `ConfigService`.
- **Shipping a `.env` file in the production image.** It shadows the real environment variables and leaks with the image.
- **Assuming the last `envFilePath` wins.** The first file that defines a key wins.
- **No schema at all.** Without one the application starts happily with `DATABASE_URL` undefined and fails on the first request instead of at deploy time.
- **Logging the resolved configuration at startup.** Secrets go straight to the log aggregator.
- **`isGlobal: true` used as a precedent** for making other modules global. Configuration is the exception, not the pattern.

## Related topics

- [Modules](modules.md) — why `isGlobal` is justified here and almost nowhere else.
- [Dependency injection](dependency-injection.md) — `databaseConfig.KEY` is an ordinary provider token.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the same schema interface, applied to request payloads.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — the security half of this page.
- [Environment configuration](../nestjs-production/configuration.md) — per-environment layering and deployment concerns.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — feeding a validated config into a pool factory.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — the other half of "fail fast, stop cleanly".
- [Environment variables and config](../node/environment-variables-and-config.md) — `node --env-file` and the platform mechanics.
- [Secrets management](../security/secrets-management.md) — rotation, storage and blast radius.
