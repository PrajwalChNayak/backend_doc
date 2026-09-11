---
title: Modules
description: How @Module organizes a Nest application into an encapsulated graph — imports, controllers, providers and exports, shared modules, global modules and the cycles to avoid.
status: current
updated: 2026-09-11
---

A module is a class with a `@Module()` decorator that declares four things: which other modules it needs, which controllers it owns, which providers it can construct, and which of those providers other modules are allowed to see. That last one is the part people skip, and it is the whole point — Nest's container is **encapsulated**, so a provider you did not export does not exist outside its own module.

## Why it exists

ES modules already tell you what a file imports. What they cannot tell you is what the *runtime* graph looks like: which instance of `PrismaService` the orders service got, whether the payments code is allowed to reach it, and what has to be constructed before the server starts listening.

`@Module()` answers those. It gives the container a boundary it can enforce, which buys you three things:

- **A visible dependency graph.** `imports` on one feature lists exactly which other features it is coupled to. Grep for `OrdersModule` and you have the complete list of its consumers.
- **Enforced privacy.** A repository that is not in `exports` cannot be injected from another feature, so "just query it from here" is a compile-and-boot-time failure rather than a code review argument.
- **One substitution point.** Swapping an implementation for a test, or for a different environment, is a change to one module's `providers` array rather than to every consumer.

## The four keys

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { PaymentsModule } from '../payments/payments.module.js'
import { OrdersController } from './orders.controller.js'
import { OrdersRepository } from './orders.repository.js'
import { OrdersService } from './orders.service.js'

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
```

| Key | Holds | Meaning |
| --- | --- | --- |
| `imports` | modules (or dynamic modules) | "I may inject anything these modules **export**" |
| `controllers` | controller classes | "instantiate these and register their routes" |
| `providers` | providers | "these are constructible here, and private by default" |
| `exports` | a subset of `providers`, or a re-exported module | "other modules that import me may inject these" |

`OrdersRepository` is in `providers` but not in `exports`. `OrdersService` can inject it; `PaymentsService` cannot, no matter what it imports. That is the encapsulation boundary, and it is worth using deliberately rather than exporting everything out of habit.

## How resolution actually works

When Nest resolves a constructor parameter it looks in exactly two places, in this order:

1. The **providers of the module that owns the class** doing the injecting.
2. The **exports of every module in that module's `imports` array**.

It does not search globally, and it does not follow your ES import statements. This is why the most common Nest error is not a missing file:

```text
Nest can't resolve dependencies of the OrdersService (?).
Please make sure that the argument PaymentsService at index [0] is available in the OrdersModule context.
```

Read it as three questions. Is `PaymentsService` in some module's `providers`? Is it in that module's `exports`? Is that module in `OrdersModule`'s `imports`? One of the three is `no`.

:::warning
Adding the `import { PaymentsService } from '…'` line at the top of the file changes nothing for the container. The TypeScript import makes the class name resolvable; the `imports`/`exports` pair makes the *instance* resolvable. They are two separate wiring systems that happen to share a word.
:::

### One instance per token, per graph

A module imported by ten other modules is instantiated **once**. Nest caches module instances by their definition, so `PaymentsService` is a single object shared by every consumer — that is what makes a connection pool or an in-memory cache safe to hold in a provider. Scope changes this, and only scope; see [Injection scopes](injection-scopes.md).

The corollary: do not list the same class in two modules' `providers` arrays to "make it available in both". That creates two independent instances with two independent caches, two pools and two counters. Export it from one module and import that module.

## Shared modules

A shared module is just a module whose `exports` are the point. It is how you publish infrastructure — a database connection, an HTTP client, a clock — to the features that need it.

```ts title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import { DatabaseService } from './database.service.js'

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
```

Every feature that needs the database lists `DatabaseModule` in its own `imports`. That line is not boilerplate — it is the documentation of which features touch the database, and it is the thing you grep when you want to know the blast radius of a schema change.

### Re-exporting

A module may export a module it imported, which lets one module act as a facade over several:

```ts title="src/core/core.module.ts"
import { Module } from '@nestjs/common'
import { ClockModule } from './clock.module.js'
import { DatabaseModule } from '../database/database.module.js'

@Module({
  imports: [DatabaseModule, ClockModule],
  exports: [DatabaseModule, ClockModule],
})
export class CoreModule {}
```

A feature that imports `CoreModule` can now inject anything `DatabaseModule` or `ClockModule` exports. Useful once, dangerous as a habit: a facade that re-exports eight modules makes every feature look like it depends on everything, which destroys the one property the `imports` array was giving you.

## Global modules

`@Global()` puts a module's exports into the root injector, so every module can inject them without importing anything.

```ts title="src/config/config.module.ts"
import { Global, Module } from '@nestjs/common'
import { AppConfigService } from './app-config.service.js'

@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
```

The module still has to be imported **once**, by the root module, to be registered at all. After that its exports are visible everywhere.

:::warning
Use this for at most two or three things in an entire application — configuration, and possibly a logger. Every global provider is a dependency that no longer appears in any `imports` array, which means the module graph stops describing the application. You have traded explicitness for four saved lines per file, and you only find out what a feature really depends on by reading every constructor in it.
:::

`ConfigModule.forRoot({ isGlobal: true })` is the one you will genuinely reach for; see [Configuration](configuration.md). Anything narrower than "literally every feature needs this" should be a normal shared module.

## Dynamic modules

A module that needs configuration exposes a static method returning a `DynamicModule` — the `forRoot()` / `forFeature()` / `registerAsync()` pattern you see on every first-party package.

```ts title="src/orders/orders.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Order } from './order.entity.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    TypeOrmModule.forFeature([Order]),
  ],
})
export class OrdersModule {}
```

The convention is worth knowing even before you write one: `forRoot()` configures a module once for the whole application, `forFeature()` registers a narrow slice of it per feature, and the `Async` variants take `useFactory`/`inject` so configuration can itself come from the container. Writing your own is covered in [Dynamic modules](../nestjs-advanced/dynamic-modules.md).

## Circular module references

Two modules that import each other are a cycle, and Nest cannot resolve one without help. `forwardRef()` on **both sides** breaks it:

```ts title="src/orders/orders.module.ts"
import { Module, forwardRef } from '@nestjs/common'
import { PaymentsModule } from '../payments/payments.module.js'
import { OrdersService } from './orders.service.js'

@Module({
  imports: [forwardRef(() => PaymentsModule)],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

That is the mechanic. The advice is to not need it: a cycle between two features almost always means a rule sits in the wrong module, or that a third concept is trying to exist. Orders needing payments and payments needing orders usually resolves into a `CheckoutModule` that imports both, or an event that one emits and the other listens for — see [Events](../nestjs-libraries/event-emitter.md).

:::best-practice
Treat `forwardRef()` as a diagnosis, not a fix. It compiles, boots, and leaves you with two features that can never be understood, tested or deployed separately again.
:::

## The root module

`AppModule` should read like a table of contents: configuration first, then infrastructure, then features. No `controllers`, no `providers` of its own.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DatabaseModule } from './database/database.module.js'
import { OrdersModule } from './orders/orders.module.js'
import { UsersModule } from './users/users.module.js'
import configuration from './config/configuration.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    DatabaseModule,
    UsersModule,
    OrdersModule,
  ],
})
export class AppModule {}
```

A provider declared directly on `AppModule` is not global — it is merely hard to find, injectable only from `AppModule` itself and from modules that import `AppModule` (which nothing should). If you are tempted to put one there, it wants a module.

The two exceptions are the application-wide enhancer tokens, which are deliberately registered at the root because they apply to every request:

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { AuthGuard } from './common/guards/auth.guard.js'

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
```

Registering them this way rather than with `app.useGlobalGuards()` in `main.ts` means the guard is constructed by the container and can inject its own dependencies. `@nestjs/core` also exports `APP_PIPE` and `APP_INTERCEPTOR` for the same purpose.

## Module lifecycle hooks

A module class — or any provider — can implement lifecycle interfaces to run work at boot and shutdown.

| Interface | Method | Runs |
| --- | --- | --- |
| `OnModuleInit` | `onModuleInit()` | after the host module's dependencies are resolved |
| `OnApplicationBootstrap` | `onApplicationBootstrap()` | after every module has initialized and the app is about to listen |
| `OnModuleDestroy` | `onModuleDestroy()` | when shutdown begins |
| `BeforeApplicationShutdown` | `beforeApplicationShutdown(signal?)` | after `onModuleDestroy`, before connections close |
| `OnApplicationShutdown` | `onApplicationShutdown(signal?)` | last |

```ts title="src/database/database.service.ts"
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import pg from 'pg'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

  async onModuleInit() {
    await this.pool.query('SELECT 1')
  }

  async onModuleDestroy() {
    await this.pool.end()
  }
}
```

:::warning
**Nest 12 changed the ordering.** Lifecycle hooks now run by component hierarchy level rather than in the v11 order, so `onModuleInit` and `onApplicationBootstrap` can fire in a different sequence across dependent providers than they used to. Code that relied on "my hook runs after the hook of the service I inject" needs re-checking during the upgrade — see [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md).
:::

Shutdown hooks only fire if you opt in with `app.enableShutdownHooks()`; see [Graceful shutdown](../nestjs-production/graceful-shutdown.md).

## Common mistakes

- **Exporting everything.** `exports: [OrdersService, OrdersRepository, OrdersMapper]` throws the boundary away. Export the one class that is the feature's public API.
- **Declaring the same provider in two modules.** You get two instances, two caches and two pools, and the bug shows up as "the cache never hits" weeks later. Export from one, import the other.
- **Expecting a TypeScript import to wire the container.** `import { X }` makes the name available; `imports`/`exports` makes the instance available.
- **Reaching for `@Global()` to silence a resolution error.** The error was telling you about a missing edge in the graph. Adding the edge takes one line.
- **Providers on `AppModule`.** Not global, just unfindable. Give them a module.
- **`forwardRef()` as the fix for a cycle.** It is the symptom's painkiller. Move the rule, or introduce the module that owns both sides.
- **Barrel files inside the app.** `index.ts` re-exports pull in every file the barrel names and manufacture cycles that surface as unresolvable-dependency errors far from the cause.
- **Assuming v11 lifecycle-hook order.** Nest 12 orders hooks by hierarchy level. Do not depend on a hook in one provider running before a hook in another unless you enforce it yourself.
- **A `SharedModule` that holds unrelated things.** It becomes a second root module that every feature imports, and the graph stops meaning anything.

## Related topics

- [Controllers](controllers.md) — the classes a module lists in `controllers`.
- [Providers and services](providers-and-services.md) — what goes in `providers`, and what belongs in each class.
- [Dependency injection](dependency-injection.md) — tokens, custom providers and how resolution is configured.
- [Injection scopes](injection-scopes.md) — when "one instance per module graph" stops being true.
- [Configuration](configuration.md) — the canonical justified use of `@Global()`.
- [Dynamic modules](../nestjs-advanced/dynamic-modules.md) — writing your own `forRoot()`.
- [Lazy-loaded modules](../nestjs-advanced/lazy-loaded-modules.md) — modules resolved on demand rather than at boot.
- [Project structure](project-structure.md) — the directory layout these modules sit in.
- [Routers and modularity](../express/routers-and-modularity.md) — the plain-Express equivalent of splitting an app up.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — making the shutdown hooks above actually fire.
