---
title: Environment configuration
description: The operational half of Nest configuration — validating at boot so a bad deploy halts itself, layering per environment, injecting secrets, and keeping NODE_ENV out of business logic.
status: current
updated: 2026-09-11
---

The same container image runs in staging and in production. The only difference between them is the environment it is handed, which makes configuration the one input you cannot test in CI and the most common cause of "it worked in staging". [Configuration](../nestjs/configuration.md) covers the `@nestjs/config` API — `forRoot` options, `registerAs`, typing `ConfigService`. This page is the operational half: making a bad configuration stop the rollout instead of serving traffic.

## Twelve-factor, applied to a Nest service

> Store config in the environment.

Not in `config/production.json` selected by `NODE_ENV`, and not in a `.env` baked into the image. Two practical consequences follow, and they are the reason the rule exists:

- **One artifact runs everywhere.** The same image digest is promoted from staging to production. If configuration lives inside the image, staging and production are different builds and you never tested what you shipped. See [Build and deployment](build-and-deployment.md).
- **Secrets never enter the repository or an image layer.** A committed `config/production.json` is a leaked credential with extra steps, and an image layer is permanent — deleting the file in a later layer does not remove it.

What belongs in the environment: anything that varies by deployment, and anything secret. What does not: application constants — a default page size, a retry count, a cache TTL you have never changed. Putting those in the environment gives you an operational lever nobody will ever pull correctly, and it enlarges the surface where a deploy can go wrong.

## Fail fast, and let the rollout halt itself

This is the single highest-value thing configuration does in production, and it is worth being precise about the mechanism.

`ConfigModule.forRoot({ validationSchema })` validates when the module initializes, which happens inside `NestFactory.create()` — **before** anything binds a port. A missing `DATABASE_URL` therefore throws during bootstrap, the process exits non-zero, the container never becomes ready, the readiness gate never passes, and a rolling deployment stalls with the previous version still serving traffic.

That is exactly the behavior you want, and it is free. The alternative — a process that starts with `DATABASE_URL` undefined, passes its liveness probe, and 500s on the first real request — replaces a halted rollout with an outage.

```ts title="src/config/validation.ts"
import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.url().optional(),

  JWT_SECRET: z.string().min(32),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CORS_ORIGINS: z.string().default(''),

  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
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
      // In a container the platform injects real environment variables.
      // A stray .env in the image must not be able to shadow them.
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      validationSchema: envSchema,
    }),
  ],
})
export class AppModule {}
```

`validationSchema` accepts any [Standard Schema](https://standardschema.dev/) in `@nestjs/config` 12.0.0, so a Zod 4 schema goes in directly with no adapter. Zod is 4.5.4 here and the Zod 4 API is what this handbook uses — `z.url()`, not `z.string().url()`.

Two properties make the failure useful rather than merely loud: every problem is reported at once rather than one per restart, and each one names the variable. A deployer reading that output fixes it in a minute.

### Make the exit code honest

By default `NestFactory` catches a bootstrap error, logs it, and aborts the process. That is a non-zero exit and the orchestrator handles it correctly, but the output is noisier than it needs to be and the abort can produce a core dump under some runtime configurations. Take the error yourself:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { Logger } from '@nestjs/common'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Throw the bootstrap error instead of aborting, so the catch below owns it.
    abortOnError: false,
    // Hold early log lines until the real logger is installed.
    bufferLogs: true,
  })

  const config = app.get(ConfigService)

  app.enableShutdownHooks()
  await app.listen(config.getOrThrow<number>('PORT'))
}

bootstrap().catch((error) => {
  // The port was never bound. One line, non-zero, no traffic served.
  Logger.error(error instanceof Error ? error.message : String(error), 'Bootstrap')
  process.exit(1)
})
```

:::danger
Never add a retry loop around configuration. A pod that keeps retrying an invalid configuration eventually becomes ready with whatever partial state it managed to build, and the rollout proceeds. The crash loop *is* the safety mechanism — it is what keeps the previous version serving while a human reads the error.
:::

## Per-environment configuration versus secrets

They are both environment variables and they have different handling requirements. Separating them in your head is what stops a secret ending up in a ConfigMap.

| | Non-secret config | Secrets |
| --- | --- | --- |
| Examples | `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, pool sizes, feature flags, upstream URLs | `DATABASE_URL` (it contains a password), `JWT_SECRET`, API keys, signing keys |
| Defaults in the schema | yes — make the app runnable out of the box | **never** |
| Safe in a Kubernetes ConfigMap or a plain task definition | yes | no — a Secret or a secret-store reference |
| Safe to log at boot | yes, and you should | no |
| Rotation | rarely | on a schedule, and ideally without a redeploy |
| Visible to anyone with `exec` into the pod | acceptable | assume it is |

:::danger
`process.env.JWT_SECRET ?? 'dev-secret'` in a Nest provider is the highest-severity configuration bug there is. A deployment that forgot the variable then signs production tokens with a value that is in your git history, and anyone with read access to the repository can mint an admin token. Secrets get **no defaults** — a required schema entry and nothing else.

`config.get<string>('JWT_SECRET', 'dev-secret')` is the same bug wearing a `ConfigService` costume. Use `getOrThrow`.
:::

### Layering

Layer configuration by *source*, not by a per-environment file committed to the repository:

| Layer | Where it lives | Wins over |
| --- | --- | --- |
| Schema defaults | `validation.ts` | nothing |
| Image defaults | `ENV` in the Dockerfile (`NODE_ENV=production`) | schema defaults |
| Platform config | ConfigMap, task-definition environment, Render environment group | image defaults |
| Secrets | Kubernetes Secret, Secrets Manager, SSM, Vault | platform config |

Local development is the exception, and the one place `.env` belongs. `envFilePath` in `@nestjs/config` resolves **first definition wins**, which is the opposite of several other tools:

```ts
ConfigModule.forRoot({
  isGlobal: true,
  // .env.local overrides the committed .env, because it comes first.
  envFilePath: ['.env.local', '.env'],
})
```

Commit `.env.example` with the key names and placeholder values. It is your documentation of what the schema requires, and it is the file a new team member copies. `.env` itself goes in `.gitignore` and in `.dockerignore` before the first commit.

Node's own `--env-file` is the no-dependency alternative for local runs; the semantics are in [Environment variables and config](../node/environment-variables-and-config.md).

### Adding a required variable without causing an outage

Tightening the schema and deploying in one step turns the next rollout into an incident in every environment that has not been updated. Three deploys instead of one:

1. Add the variable to the schema as **optional with a default**, and deploy.
2. Set it in every environment.
3. Tighten the schema to required, and deploy.

The same sequence in reverse when removing one: stop reading it, deploy, remove it from the environments, then remove it from the schema.

## Namespaces are an operational boundary

`registerAs` groups related variables into a typed object and coerces them in exactly one place. Operationally the value is different from the type safety: a namespace is the unit you can reason about when something is misconfigured.

```ts title="src/config/database.config.ts"
import { registerAs } from '@nestjs/config'

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  poolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
  statementTimeoutMs: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 5_000),
  ssl: process.env.DATABASE_SSL === 'true',
}))
```

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
    return {
      max: this.config.poolMax,
      ssl: this.config.ssl,
      statement_timeout: this.config.statementTimeoutMs,
    }
  }
}
```

:::warning
`DATABASE_POOL_MAX` looks like a per-service number and is not. The database sees `poolMax × processes-per-container × replicas`. Ten per process across eight replicas is eighty connections from one service, against a Postgres `max_connections` that defaults to 100. Size it against the database, not the app — [Connection pooling](../nestjs-databases/connection-pooling.md) has the arithmetic.
:::

## Log the safe config view at boot

"Which configuration is this pod actually running?" should be answerable from the log aggregator, not by `exec`ing into a container. Emit it once, at bootstrap, with the git SHA.

Build the safe view as an **allow-list**, not by filtering out key names that look secret. A deny-list cannot know about the secret someone adds next month; an allow-list cannot leak it.

```ts title="src/config/describe-config.ts"
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class ConfigDescriber {
  private readonly config: ConfigService

  constructor(config: ConfigService) {
    this.config = config
  }

  /** Only these keys. Never a spread of process.env, never a deny-list. */
  describe() {
    return {
      appEnv: this.config.get<string>('APP_ENV'),
      nodeEnv: this.config.get<string>('NODE_ENV'),
      port: this.config.get<number>('PORT'),
      logLevel: this.config.get<string>('LOG_LEVEL'),
      dbPoolMax: this.config.get<number>('DATABASE_POOL_MAX'),
      redisConfigured: Boolean(this.config.get<string>('REDIS_URL')),
      shutdownTimeoutMs: this.config.get<number>('SHUTDOWN_TIMEOUT_MS'),
      version: process.env.GIT_SHA ?? 'dev',
    }
  }
}
```

:::danger
`logger.log({ config })` with the whole configuration object is the most common way a `DATABASE_URL` — password included — reaches a log aggregator that a far wider group can read than your secret store. The same applies to an exception path that prints the offending value on a validation failure. See [Safe logging](../nestjs-security/safe-logging.md).
:::

## `NODE_ENV` belongs in the config module and nowhere else

`NODE_ENV` has three legitimate uses: choosing the log format, deciding whether stack traces reach the client, and telling libraries — Express 5 included — to enable production optimizations. All three are wiring decisions, made once.

```ts title="Don't: a NODE_ENV branch inside a provider"
import { Injectable } from '@nestjs/common'

@Injectable()
export class BillingService {
  async charge(customerId: string, amountCents: number) {
    if (process.env.NODE_ENV !== 'production') {
      // Staging never exercises the real integration. This path has no test
      // coverage by construction, and the other one has none either.
      return { id: 'fake_charge', status: 'succeeded' }
    }
    return this.gateway.charge({ customer: customerId, amount: amountCents })
  }
}
```

```ts good title="Do: the behavior is a named capability, chosen at wiring time"
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { BillingService } from './billing.service.js'
import { StripeGateway } from './stripe.gateway.js'
import { SandboxGateway } from './sandbox.gateway.js'
import { PAYMENT_GATEWAY } from './payment-gateway.token.js'

@Module({
  providers: [
    BillingService,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.getOrThrow<string>('PAYMENT_GATEWAY') === 'stripe'
          ? new StripeGateway(config.getOrThrow<string>('STRIPE_KEY'))
          : new SandboxGateway(),
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}
```

The second version is testable, the choice is visible in one file, and staging can be pointed at the real gateway's sandbox mode with an environment variable rather than a code change. Nest's DI container exists precisely to make this substitution the easy option — see [Dependency injection](../nestjs/dependency-injection.md).

The rule: **`NODE_ENV` may be read in the configuration module and nowhere else.** Use `APP_ENV` when you need to *label* the environment for logs, metrics and dashboards — and keep `NODE_ENV=production` in staging, so staging exercises the same code paths production does.

## Configuration changes are deployments

They carry the same risk and deserve the same discipline: change one variable at a time, know how to revert it, and record who changed it. A pool size, a timeout, a feature flag and a CORS origin list can each take a service down on their own, with no code change to point at during the incident.

Two habits that pay for themselves:

- **Roll config forward the same way you roll code forward.** If a variable is set by hand in a console, nobody can answer "what changed at 14:02".
- **Make the flag state observable.** Emit each flag as a log field and a metric label, so you can tell which cohort a failing request was in. Default every flag to off, and give it a removal date — a flag that outlives its rollout is a permanent untested branch.

## Common mistakes

- **No validation schema at all.** The app boots with `DATABASE_URL` undefined, passes liveness, and fails on the first real request instead of at deploy time.
- **Defaulting a secret.** `getOrThrow`, never `get(key, fallback)`, for anything that is a credential.
- **Retrying around configuration failure.** The crash loop is the safety mechanism; a retry loop defeats it.
- **Reading `process.env` directly in a provider.** It bypasses defaults, coercion and validation, and it is invisible to a test that overrides `ConfigService`.
- **Trusting `config.get<number>('PORT')` to return a number.** The generic is an assertion, not a conversion. Coerce in the schema or in a `registerAs` factory.
- **Shipping a `.env` in the image.** It shadows the real environment variables and it leaks with the image. Set `ignoreEnvFile` in production.
- **Assuming the last `envFilePath` wins.** The first file that defines a key wins.
- **Logging the resolved configuration object.** `DATABASE_URL` contains a password, and your log store has a much wider audience than your secret store.
- **A deny-list for the safe config view.** It cannot know about the secret added next month. Allow-list the keys.
- **Branching on `NODE_ENV` in business logic.** The production path is the one your tests never run.
- **Inventing `NODE_ENV=staging`.** It disables Express 5's production optimizations and misleads every library comparing against `'production'`. Use `APP_ENV` for the label.
- **Tightening the schema and deploying in one step.** Every environment that has not been updated fails its next rollout.
- **Sizing the pool per process and forgetting the replica count.** Multiply, then compare against `max_connections`.
- **Changing config by hand in a console.** Nothing records what changed, and nothing reverts it.

## Related topics

- [Configuration](../nestjs/configuration.md) — the `@nestjs/config` API, `registerAs` and typing `ConfigService`.
- [Configuration](../production/configuration.md) — the Node-level pattern, `--env-file`, freezing and feature flags.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — the security half of this page.
- [Secrets management](../security/secrets-management.md) — storage, rotation and blast radius.
- [Build and deployment](build-and-deployment.md) — why one image must run in every environment.
- [Docker](docker.md) — `ENV` versus injected variables, and keeping secrets out of layers.
- [Graceful shutdown](graceful-shutdown.md) — where `SHUTDOWN_DRAIN_DELAY_MS` is consumed.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — why `DATABASE_POOL_MAX` is a database-side decision.
- [Dependency injection](../nestjs/dependency-injection.md) — substituting an implementation instead of branching on the environment.
- [Observability](observability.md) — logging the safe config view and the flag state.
- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file` semantics.
- [Deployment checklist](deployment-checklist.md) — the configuration items to verify before shipping.
