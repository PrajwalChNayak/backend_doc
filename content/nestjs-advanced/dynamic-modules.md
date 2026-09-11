---
title: Dynamic modules
description: Writing configurable modules in Nest 12 — the register/forRoot/forFeature convention, hand-rolled DynamicModule factories, the Async variants with useFactory/useClass/useExisting, and ConfigurableModuleBuilder end to end.
status: current
updated: 2026-09-11
---

A `@Module()` decorator is static: whatever you write in it is what the container gets. A **dynamic module** is a static method that returns that metadata instead, so the caller can pass configuration in. Every first-party package you have imported — `ConfigModule.forRoot()`, `TypeOrmModule.forFeature()`, `ClientsModule.register()` — is exactly this, and writing your own is how a shared module stops needing environment variables of its own.

## Why it exists

A module that reads `process.env` directly cannot be reused. It is coupled to one deployment's variable names, it cannot be configured differently in a test, and the only way to see what it needs is to read every file in it.

A dynamic module inverts that. The consumer states the configuration at the import site, the module receives it as an injectable value, and the dependency is visible in one place:

```ts
imports: [MetricsModule.forRoot({ prefix: 'orders', flushMs: 10_000 })]
```

That line is documentation, a type-checked contract, and the substitution point a test uses — for the same reasons a provider token is, in [Dependency injection](../nestjs/dependency-injection.md).

## The naming convention

The names are not enforced by anything. They are a convention every Nest package follows, and breaking it makes your module surprising:

| Method | Meaning | Called |
| --- | --- | --- |
| `forRoot(options)` | configure the module once for the whole application | once, in `AppModule` |
| `forFeature(options)` | register a narrow slice for one feature | once per feature module |
| `register(options)` | configure a fresh instance per import — no global state | anywhere, repeatedly |
| `…Async(options)` | any of the above, where options come from the container | in place of the sync form |

`forRoot` versus `register` is the distinction people get wrong. `forRoot` implies "there is one of these, and this call owns it" — a connection pool, a global logger. `register` implies "this import gets its own" — an HTTP client with a base URL, a cache with a prefix. If calling it twice with different options would be a bug, it is `forRoot`.

## `DynamicModule` by hand

The returned object is ordinary module metadata plus a required `module` key pointing at the class:

```ts title="src/metrics/metrics.module.ts"
import { Module, type DynamicModule } from '@nestjs/common'
import { METRICS_OPTIONS } from './metrics.tokens.js'
import { MetricsService } from './metrics.service.js'
import type { MetricsOptions } from './metrics.options.js'

@Module({})
export class MetricsModule {
  static forRoot(options: MetricsOptions): DynamicModule {
    return {
      module: MetricsModule,
      global: true,
      providers: [
        { provide: METRICS_OPTIONS, useValue: options },
        MetricsService,
      ],
      exports: [MetricsService],
    }
  }
}
```

```ts title="src/metrics/metrics.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import { METRICS_OPTIONS } from './metrics.tokens.js'
import type { MetricsOptions } from './metrics.options.js'

@Injectable()
export class MetricsService {
  private readonly options: MetricsOptions

  constructor(@Inject(METRICS_OPTIONS) options: MetricsOptions) {
    this.options = options
  }

  increment(name: string) {
    this.sink.add(`${this.options.prefix}.${name}`)
  }
}
```

The pattern is always the same three moves: turn the options into a provider, register the classes that consume that token, export what the consumer needs. `@Module({})` on the class stays empty — it exists so Nest recognizes the class as a module at all.

| `DynamicModule` key | Notes |
| --- | --- |
| `module` | required; the class itself |
| `imports`, `providers`, `controllers`, `exports` | identical to `@Module()` |
| `global` | makes this *returned* module global, without `@Global()` on the class |

:::note
`global: true` on a dynamic module has the same cost as `@Global()`: the provider stops appearing in anybody's `imports` array, so the module graph no longer describes the application. [Modules](../nestjs/modules.md) makes the case for using it two or three times at most.
:::

## The async variant

The sync form only works when the options are known at import time — literals, or something you can compute from `process.env` on the spot. The moment the options depend on another provider (`ConfigService`, a secrets client, a feature-flag service), you need the container to build them.

The convention is three shapes, matching the provider forms:

```ts title="src/metrics/metrics.module.ts"
import { Module, type DynamicModule, type Provider } from '@nestjs/common'
import { METRICS_OPTIONS } from './metrics.tokens.js'
import { MetricsService } from './metrics.service.js'
import type { MetricsAsyncOptions, MetricsOptionsFactory } from './metrics.options.js'

@Module({})
export class MetricsModule {
  static forRootAsync(options: MetricsAsyncOptions): DynamicModule {
    return {
      module: MetricsModule,
      imports: options.imports ?? [],
      providers: [...MetricsModule.createOptionsProviders(options), MetricsService],
      exports: [MetricsService],
    }
  }

  private static createOptionsProviders(options: MetricsAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: METRICS_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ]
    }

    const factoryClass = options.useExisting ?? options.useClass
    if (!factoryClass) {
      throw new Error('MetricsModule.forRootAsync needs useFactory, useClass or useExisting')
    }

    const factoryProvider: Provider = {
      provide: METRICS_OPTIONS,
      useFactory: (factory: MetricsOptionsFactory) => factory.createMetricsOptions(),
      inject: [factoryClass],
    }

    // useExisting reuses a provider that already exists; useClass has to register it.
    return options.useClass
      ? [factoryProvider, { provide: options.useClass, useClass: options.useClass }]
      : [factoryProvider]
  }
}
```

```ts title="src/metrics/metrics.options.ts"
import type { ModuleMetadata, Type } from '@nestjs/common'

export interface MetricsOptions {
  prefix: string
  flushMs: number
}

export interface MetricsOptionsFactory {
  createMetricsOptions(): Promise<MetricsOptions> | MetricsOptions
}

export interface MetricsAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: any[]) => Promise<MetricsOptions> | MetricsOptions
  inject?: any[]
  useClass?: Type<MetricsOptionsFactory>
  useExisting?: Type<MetricsOptionsFactory>
}
```

Used from a feature module:

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MetricsModule } from './metrics/metrics.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MetricsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        prefix: config.getOrThrow<string>('METRICS_PREFIX'),
        flushMs: config.get<number>('METRICS_FLUSH_MS') ?? 10_000,
      }),
    }),
  ],
})
export class AppModule {}
```

| Form | Use when |
| --- | --- |
| `useFactory` + `inject` | the common case — a short function over other providers |
| `useClass` | the options logic is big enough to test on its own, and nothing else owns it |
| `useExisting` | a provider that **already exists** can produce the options; this reuses that instance rather than constructing a second one |

The `useClass` / `useExisting` difference is the same one as everywhere else in the container: `useClass` registers and constructs; `useExisting` is an alias. Choosing `useClass` for something already provided elsewhere gives you two instances with two sets of state.

:::warning
`imports` on the async options object is not decoration. The factory's `inject` tokens are resolved in the **dynamic module's own context**, so a `ConfigService` that is not global must be reachable from there — which means passing `imports: [ConfigModule]`. This is the single most common "Nest can't resolve dependencies of the METRICS_OPTIONS (?)" error, and the fix is one line in the wrong file's sibling.
:::

## `ConfigurableModuleBuilder`

That boilerplate is identical in every module that has it, which is why `@nestjs/common` generates it. `ConfigurableModuleBuilder` produces the base class, the token and the types in one call.

```ts title="src/http-client/http-client.module-definition.ts"
import { ConfigurableModuleBuilder } from '@nestjs/common'

export interface HttpClientOptions {
  baseUrl: string
  timeoutMs?: number
  retries?: number
}

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<HttpClientOptions>({ moduleName: 'HttpClient' })
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: false }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal,
  }))
  .build()
```

```ts title="src/http-client/http-client.module.ts"
import { Module } from '@nestjs/common'
import { ConfigurableModuleClass } from './http-client.module-definition.js'
import { HttpClientService } from './http-client.service.js'

@Module({
  providers: [HttpClientService],
  exports: [HttpClientService],
})
export class HttpClientModule extends ConfigurableModuleClass {}
```

```ts title="src/http-client/http-client.service.ts"
import { Inject, Injectable } from '@nestjs/common'
import { MODULE_OPTIONS_TOKEN, type HttpClientOptions } from './http-client.module-definition.js'

@Injectable()
export class HttpClientService {
  private readonly options: HttpClientOptions

  constructor(@Inject(MODULE_OPTIONS_TOKEN) options: HttpClientOptions) {
    this.options = options
  }

  get(path: string) {
    return fetch(new URL(path, this.options.baseUrl), {
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    })
  }
}
```

Extending `ConfigurableModuleClass` gives `HttpClientModule` both `forRoot()` and `forRootAsync()` — the async variant with `useFactory`, `useClass`, `useExisting`, `inject` and `imports` already wired:

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { HttpClientModule } from './http-client/http-client.module.js'

@Module({
  imports: [
    HttpClientModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      isGlobal: true,
      useFactory: (config: ConfigService) => ({
        baseUrl: config.getOrThrow<string>('BILLING_URL'),
        timeoutMs: 3000,
      }),
    }),
  ],
})
export class AppModule {}
```

### What each piece of the builder does

| Builder API | Effect |
| --- | --- |
| `new ConfigurableModuleBuilder<T>()` | `T` is the options interface |
| `{ moduleName: 'HttpClient' }` | token becomes `HTTP_CLIENT_MODULE_OPTIONS` instead of a generated UUID |
| `{ optionsInjectionToken }` | set the token explicitly instead |
| `{ alwaysTransient: true }` | every call produces a distinct module, even with identical options |
| `.setClassMethodName('forRoot')` | names the generated methods `forRoot` / `forRootAsync` (default: `register` / `registerAsync`) |
| `.setFactoryMethodName('create')` | the method a `useClass`/`useExisting` factory must implement (default `create`) |
| `.setExtras(defaults, transform)` | extra options that modify the `DynamicModule` rather than being injected |
| `.build()` | returns `ConfigurableModuleClass`, `MODULE_OPTIONS_TOKEN`, `OPTIONS_TYPE`, `ASYNC_OPTIONS_TYPE` |

`setExtras` is the mechanism behind `isGlobal: true` on every first-party module. Extras are **not** part of the injected options object; they are handed to the transform function, which returns a modified module definition. That is exactly the right split: `isGlobal` is a fact about the module graph, not a setting your service should be able to read.

:::note
`OPTIONS_TYPE` and `ASYNC_OPTIONS_TYPE` are exported as values but are only ever used in type position, as `typeof OPTIONS_TYPE`. That is the trick that lets the generated compound type — your options plus the extras — be referenced without writing it out.
:::

### Overriding a generated method

When you need to do something the builder cannot express, override the method and delegate:

```ts title="src/http-client/http-client.module.ts"
import { Module, type DynamicModule } from '@nestjs/common'
import { ConfigurableModuleClass, OPTIONS_TYPE } from './http-client.module-definition.js'
import { HttpClientService } from './http-client.service.js'
import { HttpClientHealthIndicator } from './http-client.health.js'

@Module({
  providers: [HttpClientService],
  exports: [HttpClientService],
})
export class HttpClientModule extends ConfigurableModuleClass {
  static forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    const base = super.forRoot(options)

    return {
      ...base,
      providers: [...(base.providers ?? []), HttpClientHealthIndicator],
      exports: [...(base.exports ?? []), HttpClientHealthIndicator],
    }
  }
}
```

Spreading the base definition rather than rebuilding it is what keeps the async variant, the options provider and the token wiring intact.

## Module caching and identity

Nest caches a module by its definition. Two imports of `HttpClientModule.forRoot({ baseUrl: 'https://a' })` with **identical** options resolve to one instance; two calls with different options produce two.

That is usually what you want, and occasionally it is not:

- If your options object contains a function or a class instance, structural identity is unreliable and you may get a module instance you did not expect.
- If a module must be distinct per import regardless of options — a per-feature namespace, say — set `alwaysTransient: true` in the builder options.

The symptom of getting this wrong is one configuration silently winning for every consumer. When two imports of the same module must behave differently, verify it with a test rather than by reading the code.

## `forFeature`

`forFeature` is the second method on a module whose `forRoot` already ran. It registers something narrow — entities, a queue, a schema — and returns a module that provides feature-scoped tokens while relying on the root call for the connection.

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { OutboxModule } from '../outbox/outbox.module.js'
import { OrdersService } from './orders.service.js'

@Module({
  imports: [OutboxModule.forFeature({ topic: 'orders' })],
  providers: [OrdersService],
})
export class OrdersModule {}
```

The rule that keeps this coherent: **`forRoot` owns resources, `forFeature` owns names.** A `forFeature` that opens a connection is a `forRoot` wearing the wrong label, and you will discover that when a second feature imports it and you have two pools.

## Testing a configurable module

The payoff is that configuration is a provider, so a test overrides it like any other:

```ts title="src/http-client/http-client.service.spec.ts"
import assert from 'node:assert/strict'
import test from 'node:test'
import { Test } from '@nestjs/testing'
import { HttpClientModule } from './http-client.module.js'
import { HttpClientService } from './http-client.service.js'
import { MODULE_OPTIONS_TOKEN } from './http-client.module-definition.js'

test('the client uses the configured base url', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [HttpClientModule.forRoot({ baseUrl: 'https://example.test' })],
  })
    .overrideProvider(MODULE_OPTIONS_TOKEN)
    .useValue({ baseUrl: 'https://stub.test', timeoutMs: 50 })
    .compile()

  const client = moduleRef.get(HttpClientService)

  assert.ok(client)
})
```

Exporting `MODULE_OPTIONS_TOKEN` from your module-definition file is what makes this possible. A module that hides its token can only be configured, never substituted.

## Common mistakes

- **`@Module()` metadata and a static factory both declaring providers.** The decorator's metadata is merged with the returned definition; listing the same provider twice is confusing at best. Keep the class decorator empty except for what is always true.
- **Forgetting `imports` on the async options.** The factory's `inject` tokens resolve in the dynamic module's context. This is the usual cause of an unresolvable `MODULE_OPTIONS` token.
- **`useClass` where `useExisting` was meant.** You get a second instance of a class something else already owns, with its own state.
- **Reading `process.env` inside the module.** That is the coupling a dynamic module exists to remove. Take the value as an option.
- **Naming it `forRoot` when it is `register`.** `forRoot` promises a single owner. Two calls with different options then look like a bug and are not — or are, and nobody notices.
- **A `forFeature` that opens a connection.** Two features importing it means two pools. Resources belong in `forRoot`.
- **Assuming two imports with different options share an instance.** They do not — Nest keys the cache on the definition. Assuming they do gives you duplicate state you did not plan for.
- **Putting `isGlobal` in the injected options.** It is a fact about the graph, not a setting. It belongs in `setExtras`.
- **Not exporting `MODULE_OPTIONS_TOKEN`.** Consumers cannot substitute the configuration in a test.
- **Hand-rolling the async boilerplate for a module that has nothing special about it.** `ConfigurableModuleBuilder` writes it, correctly, in five lines.

## Related topics

- [Modules](../nestjs/modules.md) — the static metadata a `DynamicModule` returns at runtime.
- [Dependency injection](../nestjs/dependency-injection.md) — `useFactory` / `useClass` / `useExisting`, and why an alias is not a copy.
- [Configuration](../nestjs/configuration.md) — `ConfigModule.forRoot()`, the dynamic module you will import first.
- [Injection scopes](../nestjs/injection-scopes.md) — when a module's single instance stops being single.
- [Lazy-loaded modules](lazy-loaded-modules.md) — resolving a dynamic module on demand rather than at boot.
- [Microservices and transports](microservices.md) — `ClientsModule.register()` / `registerAsync()` as a worked example.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — overriding `MODULE_OPTIONS_TOKEN` and friends.
- [Project structure](../nestjs/project-structure.md) — where a module-definition file belongs.
- [Monorepo and library mode](monorepo-and-libraries.md) — packaging a configurable module as a shared library.
- [Environment configuration](../nestjs-production/configuration.md) — where the values passed to `forRootAsync()` come from.
