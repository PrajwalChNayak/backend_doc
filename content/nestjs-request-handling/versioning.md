---
title: Versioning
description: app.enableVersioning() in NestJS 12 with URI, header, media-type and custom strategies, per-controller versions, VERSION_NEUTRAL, and an honest look at what versioning costs.
status: current
updated: 2026-09-11
---

Nest can route the same path to different handlers based on a version the client asks for. Four strategies ship in the box, they are configured in one call, and the decorators are trivial. The hard part is not the mechanism — it is deciding whether you need it at all, because every version you publish is a version you maintain.

## Enabling it

```ts title="src/main.ts"
import { VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: '1',
})

await app.listen(3000)
```

`enableVersioning()` called with no arguments defaults to `{ type: VersioningType.URI }`. `defaultVersion` is shared by all four strategies and applies to any controller or handler that declares no version of its own — without it, an unversioned handler is unreachable once versioning is on.

## The four strategies

| Type | Client sends | Options | Cacheable by URL |
| --- | --- | --- | --- |
| `VersioningType.URI` | `/v1/users` | `prefix?: string \| false` (default `'v'`) | yes |
| `VersioningType.HEADER` | a request header | `header: string` | only with `Vary` |
| `VersioningType.MEDIA_TYPE` | `Accept: application/json;v=1` | `key: string` (e.g. `'v='`) | only with `Vary` |
| `VersioningType.CUSTOM` | anything you can read off the request | `extractor: (request) => string \| string[]` | depends |

```ts
// URI — the version becomes a path segment, after the global prefix.
app.enableVersioning({ type: VersioningType.URI })                       // /v1/users
app.enableVersioning({ type: VersioningType.URI, prefix: 'api-v' })      // /api-v1/users
app.enableVersioning({ type: VersioningType.URI, prefix: false })        // /1/users

// HEADER — the version arrives in a header you name.
app.enableVersioning({ type: VersioningType.HEADER, header: 'X-API-Version' })

// MEDIA_TYPE — parsed out of the Accept header.
app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: 'v=' })     // Accept: application/json;v=2

// CUSTOM — return one version, or an ordered list from HIGHEST to LOWEST.
app.enableVersioning({
  type: VersioningType.CUSTOM,
  extractor: (request) => {
    const header = (request as { headers: Record<string, string | undefined> }).headers['x-api-version']
    return header ? [header] : ['2', '1']
  },
})
```

`CUSTOM`'s `extractor` returning an array is the interesting case: Nest tries each version in order, so `['2', '1']` means "give me v2 if this route has one, otherwise fall back to v1". The declaration order is **highest to lowest** — reversing it silently pins every client to your oldest handler.

**URI is the right default.** It is visible in logs and in a proxy's access log, it caches without `Vary`, it is trivial to curl, and a client can bookmark it. Header and media-type versioning are cleaner in theory — the resource identifier does not change — and in practice they make every debugging session harder and every CDN configuration more fragile.

:::warning
With `HEADER` or `MEDIA_TYPE` versioning, two versions of a resource share one URL. Any cache in front of your API will serve one version's response to a client asking for the other unless you set `Vary` on the version header. That includes browser caches, your CDN, and any reverse proxy with a default cache config.
:::

## Declaring versions

`@Version()` is a method decorator. Controller-level versions go through the `@Controller()` options object.

```ts title="src/users/users.controller.ts"
import { Controller, Get, Version } from '@nestjs/common'

@Controller({ path: 'users', version: '1' })
export class UsersControllerV1 {
  @Get()
  findAll() {
    return this.users.findAllLegacyShape()
  }
}
```

```ts title="src/users/users.v2.controller.ts"
import { Controller, Get } from '@nestjs/common'

@Controller({ path: 'users', version: '2' })
export class UsersControllerV2 {
  @Get()
  findAll() {
    return this.users.findAll()
  }
}
```

Both controllers are registered in the module as normal. Nest routes `/v1/users` to the first and `/v2/users` to the second.

A single handler can serve several versions, and a method-level `@Version()` overrides the controller's:

```ts
@Controller({ path: 'users', version: ['1', '2'] })
export class UsersController {
  @Get()
  findAll() {
    return this.users.findAll()          // served for v1 and v2
  }

  @Get('export')
  @Version('2')
  exportAll() {
    return this.users.exportAll()        // v2 only
  }
}
```

Versions are **strings**, always. `version: 1` is a type error, and `'1.0'` and `'1'` are different versions as far as the router is concerned.

### `VERSION_NEUTRAL`

Some routes have no business being versioned — a health probe, a metrics endpoint, an OAuth callback whose URL is registered with a third party.

```ts title="src/health/health.controller.ts"
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' }
  }
}
```

A version-neutral route matches regardless of what version the client asked for, and under URI versioning it is registered **without** a version segment — so it stays at `/health`, not `/v1/health`. That is exactly what you want for a Kubernetes probe whose path is configured in a manifest you would rather not edit every time you cut a version.

`VERSION_NEUTRAL` is a `unique symbol` exported from `@nestjs/common`, and it can appear inside an array alongside strings.

## How it interacts with everything else

| Feature | Interaction |
| --- | --- |
| `app.setGlobalPrefix('api')` | the version goes **after** the prefix: `/api/v1/users` |
| `MiddlewareConsumer.forRoutes()` | `RouteInfo` accepts `version`, so middleware can be scoped to one version |
| `@nestjs/swagger` | each version needs its own document; `SwaggerModule` is set up per version |
| Route conflict diagnostics | version is part of the identity of a route, so `/v1/users` and `/v2/users` are not duplicates |
| Microservice handlers | versioning is HTTP-only; `VersionOptions` does not apply to non-HTTP transports |

Nest 12's opt-in route conflict diagnostics are worth turning on the moment you have two versions, because a copied controller with an un-updated `version` is the classic way to shadow a route:

```ts
type RouteConflictPolicyLevel = 'off' | 'warn' | 'error'      // each kind defaults to 'off'
interface RouteConflictPolicy { duplicate?: RouteConflictPolicyLevel; shadow?: RouteConflictPolicyLevel }
```

`duplicate` is an identical (method, path, host, version) registration; `shadow` is two patterns that can match the same request. See [Routing and path syntax](../nestjs/routing-and-path-syntax.md).

## When versioning is worth the cost

It is worth being blunt here, because the decorator is so cheap that teams adopt versioning long before they need it.

**What a second version actually costs.** Two controllers, two sets of DTOs, two OpenAPI documents, two sets of end-to-end tests, and — the expensive part — a service layer that has to satisfy both shapes. Every bug fix has to be assessed against both. Every new field has to be decided for both. That cost is permanent until you delete the old version, and deleting it requires knowing who still calls it.

**Versioning is not required for most changes.** These are all backward-compatible and need no new version:

- adding a new optional request field
- adding a new field to a response (clients that ignore unknown fields — which is all of them, if you wrote the client)
- adding a new endpoint
- relaxing a validation rule
- fixing a bug where the documented behavior and the actual behavior disagreed

These are the ones that genuinely break clients:

- removing or renaming a response field
- changing a field's type or its units
- making an optional request field required
- changing the meaning of a status code
- changing pagination, sort order, or default limits

:::best-practice
Version the API when you have **external** clients you cannot deploy, and a change on the second list. A first-party single-page app that ships with the backend does not need URI versioning — it needs a deploy order. A public API with third-party integrations needs versioning from day one, because you will never be able to coordinate a cutover.
:::

**Prefer additive change and a sunset plan.** Adding `displayNameV2` is ugly; it is also cheaper than a whole parallel API surface, and it is reversible. When you do cut a version, decide up front how it ends: a deprecation header on the old version's responses, a date, and telemetry that tells you who is still calling it. A version with no retirement plan is a version forever.

**One versioning axis, not three.** Picking `VersioningType.URI` and also accepting a header "for convenience" doubles your test matrix and creates a class of bug where the two disagree. Pick one strategy, globally.

## Common patterns

### Sharing the service layer, not the controller

```ts title="src/users/users.controller.v2.ts"
import { Controller, Get } from '@nestjs/common'
import { UsersService } from './users.service.js'
import { UserV2ResponseDto } from './dto/user-v2-response.dto.js'

@Controller({ path: 'users', version: '2' })
export class UsersControllerV2 {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get()
  async findAll(): Promise<UserV2ResponseDto[]> {
    const rows = await this.users.findAll()
    return rows.map((row) => ({ id: row.id, name: row.displayName, locale: row.locale }))
  }
}
```

Keep the version difference in the controller and the DTOs, and keep the service version-agnostic. The moment a service method takes a `version` argument, every future change has to reason about every version at once — which is the cost you were trying to contain.

### Marking a version deprecated

```ts title="src/common/interceptors/deprecation.interceptor.ts"
import { Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'
import type { Response } from 'express'

@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>()
    response.setHeader('Deprecation', 'true')
    response.setHeader('Sunset', 'Wed, 30 Sep 2026 00:00:00 GMT')
    response.setHeader('Link', '</v2/users>; rel="successor-version"')
    return next.handle()
  }
}
```

Bind it to the v1 controller with `@UseInterceptors()`. The headers are machine-readable, they show up in any client's logs, and combined with a per-version request counter they tell you when it is actually safe to delete the controller. See [Interceptors](interceptors.md) and [Observability](../nestjs-production/observability.md).

### Documenting each version

`@nestjs/swagger` builds one document per call, so a versioned API gets one Swagger setup per version, each with its own path. Details are in [OpenAPI with Swagger](../nestjs-libraries/swagger.md).

## Common mistakes

- **Turning on versioning without `defaultVersion`.** Every controller that declares no version becomes unroutable, and the symptom is a blanket 404.
- **Numeric versions.** `version: 1` does not type-check; versions are strings.
- **Expecting `/v1/health` to work for a `VERSION_NEUTRAL` controller.** Under URI versioning it is registered without the segment, at `/health`.
- **Header or media-type versioning with no `Vary`.** A cache serves v1's body to a v2 client.
- **A `CUSTOM` extractor returning versions lowest-first.** The array is ordered highest to lowest; reversing it pins clients to the oldest handler.
- **Two versioning strategies at once.** Double the test matrix, and a new class of disagreement bug.
- **Versioning a first-party API you deploy together with its only client.** All of the cost, none of the benefit.
- **Passing a version into the service layer.** The version difference belongs in the controller and the DTOs.
- **Copying a controller for v2 and forgetting to change `version`.** Two handlers claim the same route; turn on `routeConflictPolicy` so this fails at bootstrap instead of at runtime.
- **Publishing a version with no retirement plan.** Add `Deprecation`/`Sunset` headers and a per-version request metric on the day you create the successor.
- **Assuming `@Version()` works on a controller class.** It is a method decorator; use `@Controller({ version })`.

## Related topics

- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — how versioned routes are registered, and the conflict diagnostics.
- [Controllers](../nestjs/controllers.md) — the `@Controller()` options object that carries `version`.
- [DTOs](dtos.md) — adding a DTO per version instead of loosening one.
- [Interceptors](interceptors.md) — deprecation headers, and why a response envelope is itself a breaking change.
- [Middleware](middleware.md) — `forRoutes()` with a `version` in the `RouteInfo`.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — one document per version.
- [Observability](../nestjs-production/observability.md) — per-version request counts, which is how you know when to delete v1.
- [The request lifecycle](../nestjs/request-lifecycle.md) — where version matching happens relative to guards and pipes.
- [Deployment checklist](../nestjs-production/deployment-checklist.md) — coordinating a version cutover with a deploy.
- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the Express 5 rules the version segment is built on.
