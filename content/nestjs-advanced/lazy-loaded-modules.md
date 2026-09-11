---
title: Lazy-loaded modules
description: LazyModuleLoader in Nest 12 — loading a module on first use instead of at boot, what it actually buys you in a serverless cold start, and the limitations that make it useless for anything with a controller.
status: current
updated: 2026-09-11
---

Nest boots by resolving the whole module graph: every module is instantiated, every provider constructed, every controller registered, before the process listens. `LazyModuleLoader` is the escape hatch — it loads a module the first time something asks for it, and returns a `ModuleRef` you resolve providers from. It is genuinely useful in two situations and a waste of complexity in every other.

## When it actually helps

**Serverless cold starts.** In a function-per-request environment you pay the boot cost on every cold invocation, and you pay it for the entire application even though one handler ran. Moving a heavy, rarely used dependency behind a lazy load takes it out of the critical path for every request that does not need it.

**A large optional subsystem.** An admin import tool that pulls in a spreadsheet parser, a PDF renderer or a cloud SDK costs you construction time and resident memory on every instance, to serve a path somebody hits twice a month.

**Genuinely plugin-shaped code.** A tenant-specific integration chosen at runtime, where "which module" is data rather than a compile-time import.

## When it does not

A long-running server that boots once and then serves traffic for a week gains nothing measurable. You have moved work from a moment nobody was waiting on to the first request that needs it — which is now slower, unpredictably, in production. And you have given up the single best property of Nest's startup: **the graph is validated at boot**, so an unresolvable dependency kills the process before it takes traffic. A lazy module's wiring errors surface on a request instead.

:::best-practice
Measure before you reach for this. Log the module's construction cost with a timer around `NestFactory.create()`, or use `nest build` output size as a proxy for what is actually heavy. Lazy loading a module that takes four milliseconds to construct is pure complexity.
:::

## The API

`LazyModuleLoader` lives in `@nestjs/core` and is injectable anywhere.

```ts title="src/reports/reports.service.ts"
import { Injectable } from '@nestjs/common'
import { LazyModuleLoader } from '@nestjs/core'

@Injectable()
export class ReportsService {
  private readonly lazyModuleLoader: LazyModuleLoader

  constructor(lazyModuleLoader: LazyModuleLoader) {
    this.lazyModuleLoader = lazyModuleLoader
  }

  async renderPdf(reportId: string) {
    const { PdfModule } = await import('../pdf/pdf.module.js')
    const { PdfRenderer } = await import('../pdf/pdf.renderer.js')

    const moduleRef = await this.lazyModuleLoader.load(() => PdfModule)

    return moduleRef.get(PdfRenderer).render(reportId)
  }
}
```

Two separate mechanisms are doing work here, and confusing them is the usual mistake:

- **`await import(...)`** is the ES module dynamic import. It is what keeps the module's *code* off the boot path — the file is not read or evaluated until this line runs.
- **`lazyModuleLoader.load(...)`** is Nest's part. It scans the module, resolves its dependencies and constructs its providers, then hands back a `ModuleRef` scoped to that module.

A static `import { PdfModule } from '…'` at the top of the file plus `load(() => PdfModule)` still defers *construction*, but the code is loaded and evaluated at startup anyway. If the point was startup time, you need both halves.

`load()` takes an optional second argument:

```ts
const moduleRef = await this.lazyModuleLoader.load(() => PdfModule, { logger: false })
```

`LazyModuleLoaderLoadOptions` has exactly one field, `logger`. Setting it to `false` silences the per-module instantiation logging, which is worth doing when the load happens on a hot path.

### Resolving providers

The returned `ModuleRef` is scoped to the lazy module's own context:

| Method | Returns | Use for |
| --- | --- | --- |
| `moduleRef.get(Token)` | the instance, synchronously | default-scoped (singleton) providers |
| `await moduleRef.resolve(Token)` | a promise for the instance | request- or transient-scoped providers |

`get()` throws for a scoped provider, and `get(Token, { strict: false })` searches the whole application rather than this module — convenient, and the same graph-hiding trade-off described in [Dependency injection](../nestjs/dependency-injection.md).

### Dynamic modules load too

`load()` accepts a `DynamicModule`, so a configurable module can be lazily registered:

```ts
const { IntegrationModule } = await import('../integrations/integration.module.js')

const moduleRef = await this.lazyModuleLoader.load(() =>
  IntegrationModule.register({ tenantId, apiKey }),
)
```

Be careful here: Nest keys the module cache on the definition, so `register()` with different options produces different module instances, each constructed on first use. A per-tenant lazy module in a long-running process is an unbounded cache — see [Dynamic modules](dynamic-modules.md) for the identity rules and `alwaysTransient`.

### Caching

The first `load()` scans and constructs. Every subsequent `load()` of the same module finds it already in the container and returns the existing `ModuleRef` without rebuilding anything — Nest's own documentation measures roughly 2.4 ms for the first call and 0.3 ms thereafter.

So the cost model is: one slow request per module per process lifetime, then nothing. In a serverless function that is one slow invocation per cold container. In a long-running server it is one slow request ever, which is also why the technique buys you so little there.

## The limitations, which are the point

This is the part that decides whether lazy loading is usable for your case at all.

| Not registered for a lazy-loaded module | Why |
| --- | --- |
| **Controllers** | routes must be registered on the HTTP adapter before the server listens |
| **Gateways** | the same, for WebSocket message handlers |
| **Resolvers** | the GraphQL schema is built at bootstrap |
| **Middleware** | `configure()` runs during initialization |
| `onModuleInit` / `onApplicationBootstrap` | these hooks run once, over the container, during application initialization — a module that appears afterwards has already missed them |

:::danger
**Controllers in a lazy-loaded module do not produce routes.** There is no error, no warning, and no log line. The module loads, its providers construct, its controller is never registered, and every request to those paths returns 404. Teams lose hours to this because everything else about the module works.

If a module has a controller, it cannot be lazy-loaded. That eliminates most feature modules immediately, and it is the single most important thing to know about this API.
:::

The corollary shapes what a lazy module should be: a **provider-only** module. Services, repositories, clients, a heavy SDK wrapper. Something a controller that was registered normally calls into.

The lifecycle-hook limitation has the same practical shape. A provider that opens a connection in `onModuleInit` will not have that hook called, so it will hold an unopened connection until something explicitly initializes it. Give lazy-loaded providers explicit initialization in their constructor or in the method that uses them, and do not rely on a hook to have run.

## A worked example

A rarely used data-export path, kept off the boot path without touching the routes:

```ts title="src/export/export.module.ts"
import { Module } from '@nestjs/common'
import { SpreadsheetWriter } from './spreadsheet.writer.js'
import { ExportBuilder } from './export.builder.js'

// Provider-only. No controller — the route lives in a normally registered module.
@Module({
  providers: [SpreadsheetWriter, ExportBuilder],
  exports: [ExportBuilder],
})
export class ExportModule {}
```

```ts title="src/admin/admin.controller.ts"
import { Controller, Get, Param, StreamableFile } from '@nestjs/common'
import { LazyModuleLoader } from '@nestjs/core'

@Controller('admin')
export class AdminController {
  private readonly lazyModuleLoader: LazyModuleLoader

  constructor(lazyModuleLoader: LazyModuleLoader) {
    this.lazyModuleLoader = lazyModuleLoader
  }

  @Get('exports/:datasetId')
  async download(@Param('datasetId') datasetId: string) {
    const { ExportModule } = await import('../export/export.module.js')
    const moduleRef = await this.lazyModuleLoader.load(() => ExportModule, { logger: false })

    const { ExportBuilder } = await import('../export/export.builder.js')
    const builder = moduleRef.get(ExportBuilder)

    return new StreamableFile(await builder.build(datasetId))
  }
}
```

The route is registered at boot, by a controller in a normal module. The expensive machinery behind it is not constructed until somebody actually downloads an export.

Note the second `await import()`: the controller needs the `ExportBuilder` class as a **token**, and importing it statically would pull the file — and its dependencies — back onto the boot path, defeating the exercise. A `symbol` token exported from a small file with no dependencies is the tidier alternative when this gets awkward.

## Cost model

| | Eager (default) | Lazy |
| --- | --- | --- |
| Boot time | pays for every module | pays only for eager modules |
| First use of the module | free | one scan plus construction |
| Later uses | free | free (cached) |
| Wiring errors surface | at boot, before traffic | on the first request that triggers the load |
| Controllers work | yes | **no** |
| Lifecycle init hooks run | yes | **no** |

The middle row is the honest downside. Eager loading turns a whole class of mistake into a process that will not start; lazy loading turns the same mistake into a 500 on a rarely exercised path, which is the worst place to find it. Cover every lazy load with a test that exercises it — see [End-to-end tests](../nestjs-testing/e2e-tests.md).

## Common mistakes

- **Putting a controller in a lazy-loaded module.** Its routes are never registered and every request 404s, silently.
- **Expecting `onModuleInit` to run.** Init hooks fire once during application initialization, before any lazy load. Initialize explicitly.
- **`load()` with a statically imported module class.** Construction is deferred, but the code still loads at startup. Use `await import()` for the module class too.
- **Statically importing the provider class to use as a token.** Same problem, one level down. Import it dynamically or use a `symbol` token from a dependency-free file.
- **Lazy loading in a long-running server "for performance".** You moved four milliseconds off boot and put unpredictability into a request. Measure first.
- **A per-tenant lazy dynamic module in a long-lived process.** Each distinct options object is a distinct cached module. That is an unbounded cache.
- **Assuming a lazy load is cheap because it was fast the second time.** It is cached per process. Every fresh serverless container pays the first one again.
- **No test covering the lazy path.** Its wiring errors do not appear at boot. The only thing that finds them before a user does is a test that loads the module.
- **`get()` for a request-scoped provider.** It throws. Use `await moduleRef.resolve()`.
- **Leaving the loader's logging on in a hot path.** Pass `{ logger: false }`.

## Related topics

- [Modules](../nestjs/modules.md) — the eager graph this opts out of, and why boot-time validation is worth keeping.
- [Dynamic modules](dynamic-modules.md) — module identity, caching, and `alwaysTransient`.
- [Dependency injection](../nestjs/dependency-injection.md) — `ModuleRef.get()` versus `resolve()`, and what `strict: false` hides.
- [Injection scopes](../nestjs/injection-scopes.md) — why a scoped provider needs `resolve()`.
- [Controllers](../nestjs/controllers.md) — the thing a lazy module cannot have.
- [Performance](../nestjs-production/performance.md) — measuring boot cost before optimizing it.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — bundling, and whether your build even preserves the dynamic import.
- [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) — how `await import()` behaves in each module format.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the only thing that catches a lazy module's wiring errors early.
- [Monorepo and library mode](monorepo-and-libraries.md) — the other way to keep code you do not need out of a build.
