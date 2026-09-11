---
title: Injection scopes
description: DEFAULT, REQUEST and TRANSIENT in Nest 12 — what each means, why request scope bubbles up the whole injector chain, and how durable providers limit the damage.
status: current
updated: 2026-09-11
---

By default every provider in Nest is a **singleton**: constructed once at bootstrap and shared by everything that injects it. Two other scopes exist, and the second one — `REQUEST` — is the single most expensive decision available in the framework, because it is contagious. Setting it on one leaf provider can convert half your application into per-request construction, and the only symptom is that throughput quietly drops.

## The three scopes

```ts
import { Injectable, Scope } from '@nestjs/common'

@Injectable()                              // Scope.DEFAULT — a singleton
export class PricingService {}

@Injectable({ scope: Scope.REQUEST })      // one instance per request
export class TenantContext {}

@Injectable({ scope: Scope.TRANSIENT })    // one instance per consumer
export class ScopedLogger {}
```

| Scope | Instances | Constructed | Use for |
| --- | --- | --- | --- |
| `Scope.DEFAULT` | one, application-wide | at bootstrap | everything, unless you have a specific reason |
| `Scope.REQUEST` | one per request pipeline | on each request | genuinely per-request state you cannot pass as an argument |
| `Scope.TRANSIENT` | one per injecting class | when each consumer is constructed | a provider that must not share state between consumers |

Scope can also be set on a custom provider (`{ provide: X, useClass: Y, scope: Scope.REQUEST }`), on a controller (`@Controller({ path: 'orders', scope: Scope.REQUEST })`), and on guards, interceptors, pipes and filters.

## Why DEFAULT is right almost always

A singleton is constructed once, so per-request cost is zero, and it can hold things that are expensive to create and safe to share: a connection pool, a compiled schema, an in-memory cache, an HTTP client with keep-alive.

It is also the reason the boot-time failure mode exists. Every singleton is instantiated during `NestFactory.create()`, so a provider whose constructor or `onModuleInit` throws takes the process down before it listens. That is what you want — the container proves the graph is constructible before accepting traffic.

The one rule a singleton imposes: **no per-request state on `this`**. A field assigned during one request is visible to every concurrent request. If a provider needs a value that varies per request, it takes it as a method argument.

## What REQUEST scope actually costs

The cost is not "one extra object per request". It is that request scope **bubbles up the injector chain**.

When a provider is request-scoped, any provider that injects it must also be constructed per request — it cannot be a singleton holding a reference to something that does not exist yet. That propagates transitively, all the way up to the controller.

```text
TenantContext        Scope.REQUEST   (you set this)
  ↑ injected by
PricingService       becomes REQUEST (you did not)
  ↑ injected by
OrdersService        becomes REQUEST (you did not)
  ↑ injected by
OrdersController     becomes REQUEST (you did not)
```

Now every request constructs four objects instead of zero, and each construction walks its own dependency list. Three consequences, in order of how much they usually hurt:

- **Per-request instantiation of the whole chain.** For a graph of a few dozen providers this is measurable; the framework's own documentation describes request scope as having a performance impact on application behavior.
- **Caches and pools stop being shared.** A "cache" field on a now-request-scoped service is populated and discarded within one request. This is the failure people take longest to notice, because nothing breaks — the hit rate is just always zero.
- **Enhancers become per-request too.** A request-scoped guard or interceptor is instantiated on every request before it can decide anything, which is the worst place to pay the cost because it applies to requests you are about to reject.

:::warning
The contagion is invisible in the source. `OrdersController` has no annotation saying it is request-scoped; it became so because something four levels down was. The only way to see it is to trace the graph, which is why the rule is to avoid the root cause rather than to manage the consequences.
:::

## `@Inject(REQUEST)`

A request-scoped provider can inject the incoming request object itself, using the `REQUEST` token from `@nestjs/core`:

```ts title="src/common/tenant.context.ts"
import { Inject, Injectable, Scope } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import type { Request } from 'express'

@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  readonly tenantId: string

  constructor(@Inject(REQUEST) request: Request) {
    this.tenantId = String(request.headers['x-tenant-id'] ?? '')
  }
}
```

Injecting `REQUEST` **forces** `Scope.REQUEST` — the provider cannot be a singleton, because there is no request at bootstrap. That is why `@Inject(REQUEST)` inside a service is simultaneously an architecture mistake (the rule now needs HTTP to run) and a performance one.

:::note
Under a microservice transport the same token yields the inbound message rather than an HTTP request, and in a hybrid application a provider that assumes `request.headers` will break on the non-HTTP entry point. See [Microservices and transports](../nestjs-advanced/microservices.md).
:::

## The alternatives, in order of preference

**Pass the value as an argument.** Almost always the right answer. The controller already has the request; read the header there and pass a plain string down.

```ts
import { Controller, Get, Headers } from '@nestjs/common'

@Controller('orders')
export class OrdersController {
  @Get()
  list(@Headers('x-tenant-id') tenantId: string) {
    return this.orders.listForTenant(tenantId)
  }
}
```

`listForTenant(tenantId)` is a singleton method, testable with a string, and callable from a queue consumer that has a tenant id but no request.

**Use a custom parameter decorator** when the extraction is non-trivial and repeated — `@CurrentUser()`, `@TenantId()`. The decorator reads the request once, at the edge, and everything below it still sees plain values. See [Custom decorators](../nestjs-request-handling/custom-decorators.md).

**Use `AsyncLocalStorage`** when the value must be available deep in a call chain you do not control — a correlation id that every log line should carry, for instance. It gives you per-request context without making any provider request-scoped. The mechanics are in [Runtime and the event loop](../node/runtime-and-event-loop.md), and the logging application in [Logging](../nestjs-libraries/logging.md).

**Use `Scope.REQUEST`** when none of the above work: typically a per-request database transaction or connection that several providers must share, or a per-tenant client that genuinely cannot be a parameter. Then keep the scoped provider as close to a leaf as possible, and make sure the things that inject it are few.

## TRANSIENT scope

A transient provider gets a **fresh instance for each class that injects it**. It is not per-request — a transient provider injected into a singleton is constructed once, when that singleton is constructed.

The canonical use is a provider that must be configured per consumer, and the canonical companion is the `INQUIRER` token, which tells the provider who injected it:

```ts title="src/common/scoped-logger.service.ts"
import { Inject, Injectable, Scope } from '@nestjs/common'
import { INQUIRER } from '@nestjs/core'

@Injectable({ scope: Scope.TRANSIENT })
export class ScopedLogger {
  private readonly context: string

  constructor(@Inject(INQUIRER) parentClass: object) {
    this.context = parentClass?.constructor?.name ?? 'Application'
  }

  log(message: string) {
    console.log(`[${this.context}] ${message}`)
  }
}
```

Every service that injects `ScopedLogger` gets its own instance, already labelled with the injecting class's name — no `new Logger(OrdersService.name)` boilerplate in each constructor.

Transient scope does **not** bubble the way request scope does: a singleton that injects a transient provider stays a singleton. It costs one extra object per consumer, which is bounded by the size of your graph rather than by traffic.

## Durable providers

Durable providers are the escape hatch for the most common legitimate use of request scope: **multi-tenancy**, where you do not actually need an instance per *request* — you need one per *tenant*, shared across all that tenant's requests.

A durable provider opts into a custom context-id strategy, so Nest can attach a **shared** context id to many requests and reuse one sub-tree of the injector for all of them.

```ts title="src/common/tenant-context-id.strategy.ts"
import { ContextIdFactory, type ContextId, type ContextIdStrategy, type HostComponentInfo } from '@nestjs/core'
import type { Request } from 'express'

const tenants = new Map<string, ContextId>()

export class TenantContextIdStrategy implements ContextIdStrategy<Request> {
  attach(contextId: ContextId, request: Request) {
    const tenantId = String(request.headers['x-tenant-id'] ?? 'public')

    let tenantSubTreeId = tenants.get(tenantId)
    if (!tenantSubTreeId) {
      tenantSubTreeId = ContextIdFactory.create()
      tenants.set(tenantId, tenantSubTreeId)
    }

    // Durable providers reuse the per-tenant id; everything else stays per-request.
    return (info: HostComponentInfo) => (info.isTreeDurable ? tenantSubTreeId : contextId)
  }
}
```

```ts title="src/main.ts"
import { ContextIdFactory, NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { TenantContextIdStrategy } from './common/tenant-context-id.strategy.js'

async function bootstrap() {
  ContextIdFactory.apply(new TenantContextIdStrategy())
  const app = await NestFactory.create(AppModule)
  await app.listen(3000)
}

bootstrap()
```

```ts title="src/tenants/tenant-connection.service.ts"
import { Injectable, Scope } from '@nestjs/common'

@Injectable({ scope: Scope.REQUEST, durable: true })
export class TenantConnection {}
```

`durable` is only meaningful together with `scope: Scope.REQUEST` — it is declared on `ScopeOptions` with exactly that restriction, and it is available on `useClass` and `useFactory` providers as well as on `@Injectable()`.

:::warning
The map above grows without bound if tenant ids are attacker-controlled. Validate the tenant before it reaches the strategy, or bound the map with an eviction policy. A `Map` keyed on an unvalidated header is a memory-exhaustion primitive — see [Rate limiting and abuse](../nestjs-security/rate-limiting.md).
:::

## Finding out what is actually scoped

Two habits catch the contagion early:

- **Grep for `Scope.REQUEST` and `@Inject(REQUEST)` before every release.** The list should be short and every entry should have a comment explaining why.
- **Watch for caches that never hit.** A provider with an internal `Map` that always misses is usually a singleton that silently became request-scoped.

If you would rather see the graph than reason about it, `@nestjs/devtools-integration` (12.0.0) renders the resolved provider graph for a running application.

## Common mistakes

- **`@Inject(REQUEST)` in a service to avoid passing an argument.** It couples the rule to HTTP and converts the whole chain above it to request scope. Pass the value.
- **Not realizing the scope propagated.** Nothing in `OrdersController` says it is request-scoped. Trace the graph, or grep the leaves.
- **Caching inside a provider that became request-scoped.** The cache is allocated and thrown away within one request; the hit rate is zero and nothing errors.
- **Request-scoping a guard or an interceptor.** You pay the construction cost on every request, including the ones you are about to reject.
- **Expecting `TRANSIENT` to mean per-request.** It is per-consumer. A transient provider injected into a singleton is constructed exactly once.
- **`durable: true` without a context-id strategy.** The flag alone does nothing; `ContextIdFactory.apply()` is what makes the sub-tree shared.
- **`durable: true` on a `Scope.DEFAULT` provider.** It only applies in combination with `Scope.REQUEST`.
- **An unbounded tenant map in the context-id strategy.** Unvalidated header values become permanent map keys.
- **Per-request state on a singleton.** The opposite failure, and the more dangerous one: concurrent requests see each other's data.

## Related topics

- [Dependency injection](dependency-injection.md) — tokens and provider forms, all of which accept a scope.
- [Providers and services](providers-and-services.md) — why keeping the request out of a service is the same rule as this page.
- [The request lifecycle](request-lifecycle.md) — where per-request construction happens in the pipeline.
- [Custom decorators](../nestjs-request-handling/custom-decorators.md) — `@CurrentUser()` instead of an injected request.
- [Guards](../nestjs-request-handling/guards.md) — the enhancer most often, and most expensively, request-scoped.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — per-tenant and per-request connections done deliberately.
- [Transactions](../nestjs-databases/transactions.md) — the legitimate case for a shared per-request object.
- [Runtime and the event loop](../node/runtime-and-event-loop.md) — `AsyncLocalStorage`, the scope-free alternative.
- [Performance](../nestjs-production/performance.md) — measuring the cost rather than guessing at it.
