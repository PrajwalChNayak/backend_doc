---
title: Project structure
description: What nest new generates, how to grow it into a feature-first layout, and which layering rules from plain Express still apply inside a Nest codebase.
status: current
updated: 2026-09-09
---

`nest new` gives you a working four-file application and no opinion about what happens next. The default layout is fine for a tutorial and wrong for anything with more than one feature, so the useful question is not "what did the CLI generate" but "what does this tree look like at forty endpoints".

## What the CLI generates

```text
my-api/
  src/
    app.controller.ts        a demo controller
    app.controller.spec.ts
    app.module.ts            the root module
    app.service.ts           a demo service
    main.ts                  bootstrap
  test/
    app.e2e-spec.ts
    jest-e2e.json            (or a vitest config in a new ESM project)
  nest-cli.json
  package.json
  tsconfig.json
  tsconfig.build.json
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  await app.listen(process.env.PORT ?? 3000)
}

bootstrap()
```

`main.ts` is the only file that knows a server exists. Everything else describes a graph of modules, and `NestFactory.create()` turns that graph into an Express application. That separation is what lets the same `AppModule` be started as an HTTP server, as a microservice, or as a bare application context in a CLI script.

Delete `app.controller.ts`, `app.service.ts` and their specs the moment you add a real feature. They are scaffolding, and leaving them means every reader has to work out that `AppService.getHello()` is not part of the system.

## Feature-first, not layer-first

Group by the thing that changes together. A change to orders touches the orders controller, the orders service, the orders DTOs and the orders module — put them in one directory.

```text
src/
  main.ts
  app.module.ts               imports the feature modules, nothing else
  common/                     cross-feature code with no feature of its own
    decorators/
    filters/
    guards/
    interceptors/
    pipes/
  config/
    configuration.ts          registerAs() namespaces
    validation.ts             the boot-time schema
  orders/
    orders.module.ts
    orders.controller.ts
    orders.service.ts
    orders.repository.ts
    dto/
      create-order.dto.ts
      order-response.dto.ts
  users/
    users.module.ts
    users.controller.ts
    users.service.ts
```

The alternative — `src/controllers/`, `src/services/`, `src/repositories/` — puts every feature's pieces in different folders. One change edits three directories, each directory eventually holds forty files, and nothing tells you which of those forty belong together. The same argument, made without a framework, is in [Layered architecture](../express/layered-architecture.md).

`src/common/` earns its place only for code with **no** feature. A `@CurrentUser()` decorator, a global exception filter, a `TransformInterceptor` — those belong there. A guard that reads an orders-specific claim belongs in `orders/`.

## The layering rules still apply

Nest gives you classes and a container. It does not stop you writing a controller that opens a database connection. The rules from Part 1 carry over unchanged, and they are the difference between a Nest app and a Nest-shaped Express app.

| Layer | Owns | Must never contain |
| --- | --- | --- |
| **Controller** | route paths, reading the request, choosing the status code, shaping the response | business rules, queries, ORM calls |
| **Service** | business rules, orchestration, transaction boundaries, domain errors | `Request`, `Response`, HTTP status codes |
| **Repository** | queries, mapping rows to objects | business rules, HTTP concepts |

**No `Request` or `Response` in a service.** In Express the rule is "do not pass `req` down". In Nest it has an extra edge: injecting `@Inject(REQUEST)` into a service makes that service **request-scoped**, which forces every provider that depends on it to be instantiated per request. The architectural mistake and the performance mistake are the same mistake — see [Injection scopes](injection-scopes.md).

```ts
// Wrong: the rule is now HTTP-only, and the whole injection chain above it
// becomes request-scoped.
@Injectable({ scope: Scope.REQUEST })
export class PricingService {
  private readonly request: Request

  constructor(@Inject(REQUEST) request: Request) {
    this.request = request
  }

  quote() {
    return this.calculate(this.request.body.items)
  }
}
```

```ts
// Right: plain values in, plain values out. Callable from a controller, a queue
// consumer, a cron job or a test.
@Injectable()
export class PricingService {
  quote(items: OrderItem[]) {
    return this.calculate(items)
  }
}
```

**No queries in a controller.** A query in a controller cannot be enlisted in a transaction the service owns, cannot be reused by the queue consumer, and drags the schema into the layer that formats JSON.

## The root module

`app.module.ts` should be a table of contents: configuration, infrastructure, then features.

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { OrdersModule } from './orders/orders.module.js'
import { UsersModule } from './users/users.module.js'
import configuration from './config/configuration.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    UsersModule,
    OrdersModule,
  ],
})
export class AppModule {}
```

No `controllers`, no `providers`. A provider declared on the root module is reachable from nowhere except the root module — it is not global — and a controller there is a route with no feature. If you find yourself adding either, the thing you are adding wants a module of its own.

## File naming

The CLI's convention is `<name>.<type>.ts`, and it is worth keeping even when you hand-write files, because it makes the tree greppable and it is what every other Nest codebase does.

| File | Class |
| --- | --- |
| `orders.module.ts` | `OrdersModule` |
| `orders.controller.ts` | `OrdersController` |
| `orders.service.ts` | `OrdersService` |
| `create-order.dto.ts` | `CreateOrderDto` |
| `roles.guard.ts` | `RolesGuard` |
| `http-exception.filter.ts` | `HttpExceptionFilter` |

Filenames are kebab-case; classes are PascalCase; one exported class per file.

## Barrel files and circular imports

A barrel — `src/orders/index.ts` re-exporting everything — looks tidy and is the single most common cause of "Nest can't resolve dependencies of X" in a large codebase. Importing a module through a barrel pulls in every file the barrel names, so two features that each import the other's barrel form a cycle even when the actual classes do not.

:::best-practice
Import concrete files, not barrels: `import { OrdersService } from '../orders/orders.service.js'`. Reserve barrels for published libraries, where the export surface is the point.
:::

If you do hit a cycle, `forwardRef()` will paper over it — see [Dependency injection](dependency-injection.md) — but a cycle almost always means a rule is in the wrong module. Move the rule before reaching for the workaround.

## Path aliases

`tsconfig.json` `paths` (`@app/*`, `@common/*`) work at compile time and mean nothing to Node at runtime, because Node resolves the emitted JavaScript. In a CommonJS project the CLI's webpack build can rewrite them; in an ESM project they need a runtime resolver, which is one more moving part in production.

Relative imports are ugly and they always work. If you want aliases anyway, prefer Node's own [subpath imports](../node/esm-vs-commonjs.md) (`#config/*` declared in `package.json`), which the runtime understands without help.

## Where tests live

Unit tests sit beside the file they test (`orders.service.spec.ts`); end-to-end tests live in `test/`. The reason is not taste: a unit test imports one class and mocks its dependencies, so it belongs next to that class, while an e2e test boots the whole application and belongs to the application rather than to any feature.

```text
src/orders/orders.service.ts
src/orders/orders.service.spec.ts     unit — fake repository, no HTTP
test/orders.e2e-spec.ts               boots AppModule, drives it with supertest
```

See [Unit tests](../nestjs-testing/unit-tests.md) and [End-to-end tests](../nestjs-testing/e2e-tests.md).

## Common mistakes

- **Keeping `app.controller.ts` and `app.service.ts`.** Scaffolding that survives to production makes every reader stop and check whether `getHello()` matters.
- **Grouping by layer.** `controllers/`, `services/`, `repositories/` scales to about three features before every change spans three directories.
- **Putting providers on `AppModule`.** They are not global, they are just hard to find. Give them a module.
- **Injecting `REQUEST` into a service** to avoid passing an argument. It silently converts the injection chain to request scope and couples the rule to HTTP.
- **Barrel files inside the application.** They create import cycles that surface as unresolvable-dependency errors far from the cause.
- **`tsconfig` path aliases without a runtime story.** They compile, then fail with `ERR_MODULE_NOT_FOUND` in the container.
- **A `common/` directory that becomes a junk drawer.** If something in there is imported by exactly one feature, it belongs to that feature.
- **Business rules in the controller** because "it is only three lines". The second caller — a worker, a cron job, a second endpoint — cannot reach them.

## Related topics

- [Modules](modules.md) — how the directories above become a dependency graph.
- [Controllers](controllers.md) — the layer that must stay thin.
- [Providers and services](providers-and-services.md) — where the rules live.
- [Injection scopes](injection-scopes.md) — why `REQUEST` in a service is a performance decision.
- [Configuration](configuration.md) — what belongs in `src/config/`.
- [Layered architecture](../express/layered-architecture.md) — the same rules without a framework.
- [Setup and project structure](../express/setup-and-project-structure.md) — the plain-Express counterpart.
- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — subpath imports, and why relative paths need `.js`.
- [Unit tests](../nestjs-testing/unit-tests.md) — the tests that live beside the code.
