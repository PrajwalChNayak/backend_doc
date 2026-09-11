---
title: Guards
description: CanActivate, ExecutionContext and Reflector in NestJS 12 — binding guards at three scopes, returning false versus throwing, and why a guard cannot do object-level authorization.
status: current
updated: 2026-09-11
---

A guard is a class with one method that answers a single yes/no question before the handler runs: may this request proceed? It is the first stage of the pipeline that knows which controller and which method are about to be invoked, which is what makes it the right home for authentication and role checks — and what makes it useless for anything that depends on the resource itself.

## Why it exists

[Middleware](middleware.md) runs before Nest has resolved a route, so it cannot read route metadata. Guards run after resolution and receive an `ExecutionContext` carrying both `getClass()` and `getHandler()`. That is the entire difference, and it is the reason `@Roles('admin')` on a controller method can be enforced at all.

Guards are also the cheapest terminal stage. Rejecting a request in a guard happens before interceptors allocate anything, before pipes parse a body, and before a single line of your service runs. See [The request lifecycle](../nestjs/request-lifecycle.md) for where that sits relative to everything else.

## Basic example

```ts title="src/common/guards/api-key.guard.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { KeysService } from '../../keys/keys.service.js'

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly keys: KeysService

  constructor(keys: KeysService) {
    this.keys = keys
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const presented = request.get('x-api-key')

    if (!presented || !(await this.keys.isValid(presented))) {
      throw new UnauthorizedException('Invalid API key', { errorCode: 'INVALID_API_KEY' })
    }
    return true
  }
}
```

`canActivate()` may return `boolean`, `Promise<boolean>` or `Observable<boolean>`. Nest awaits or subscribes as needed, so an async guard needs no special registration.

## The `ExecutionContext`

`ExecutionContext` extends `ArgumentsHost` with two methods that only exist because routing has already happened.

| Method | Returns | Used for |
| --- | --- | --- |
| `context.getHandler()` | the method that will be called | metadata set by a method decorator |
| `context.getClass()` | the controller class | metadata set by a class decorator |
| `context.switchToHttp().getRequest()` | the Express `Request` | headers, cookies, `request.params` |
| `context.switchToHttp().getResponse()` | the Express `Response` | setting a header before rejection |
| `context.getType()` | `'http'`, `'ws'` or `'rpc'` | writing one guard for HTTP and microservices |

`getRequest()` and `getResponse()` are generic, so type them: `getRequest<Request>()`. Untyped, everything downstream is `any` and a typo in a header name becomes a silent `undefined`.

:::note
A guard shared between HTTP controllers and microservice handlers must branch on `context.getType()` before calling `switchToHttp()` — the HTTP host is not populated for an RPC context, and you will read `undefined` rather than get an error.
:::

## Binding guards

Three scopes, and they run global first, then controller, then handler.

```ts title="src/users/users.controller.ts"
import { Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../common/guards/auth.guard.js'
import { AdminGuard } from '../common/guards/admin.guard.js'

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  @Get()
  findAll() {
    return this.users.findAll()
  }

  @Post()
  @UseGuards(AdminGuard)
  create() {
    return this.users.create()
  }
}
```

`@UseGuards()` takes classes or instances. **Pass the class** whenever the guard has dependencies — Nest instantiates it through the container and injects them. An instance you construct yourself (`@UseGuards(new AdminGuard())`) gets no injection.

For a guard that must apply to everything, register it as a provider under the `APP_GUARD` token rather than with `app.useGlobalGuards()`:

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthGuard } from './common/guards/auth.guard.js'
import { RolesGuard } from './common/guards/roles.guard.js'

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
```

| Binding | Dependency injection | Scope |
| --- | --- | --- |
| `@UseGuards(GuardClass)` | yes | that controller or handler |
| `@UseGuards(new GuardClass())` | **no** | that controller or handler |
| `APP_GUARD` provider | yes | every route in the application |
| `app.useGlobalGuards(new GuardClass())` | **no** | every route in the application |

Multiple `APP_GUARD` providers are allowed and run in declaration order. That ordering matters: an authentication guard that populates `request.user` has to be registered before the authorization guard that reads it.

## Metadata and the `Reflector`

A guard on its own is static. What makes `@Roles('admin')` work is metadata attached to the handler and read back through `Reflector`.

```ts title="src/common/decorators/roles.decorator.ts"
import { SetMetadata } from '@nestjs/common'

export const ROLES_KEY = 'roles'
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)
```

```ts title="src/common/guards/roles.guard.ts"
import { ForbiddenException, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from '../decorators/roles.decorator.js'

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector: Reflector

  constructor(reflector: Reflector) {
    this.reflector = reflector
  }

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    if (!required || required.length === 0) return true

    const { user } = context.switchToHttp().getRequest()
    if (!user) throw new ForbiddenException('Not authenticated', { errorCode: 'NOT_AUTHENTICATED' })

    const granted = required.some((role) => user.roles?.includes(role))
    if (!granted) {
      throw new ForbiddenException('Insufficient role', { errorCode: 'INSUFFICIENT_ROLE' })
    }
    return true
  }
}
```

The array order in `getAllAndOverride()` is the precedence order: **the first target with a defined value wins**. `[getHandler(), getClass()]` means a method-level `@Roles()` overrides a controller-level one, which is almost always what you want.

| Reflector method | Behavior |
| --- | --- |
| `get(key, target)` | one target, no merging |
| `getAll(key, targets)` | an array of each target's value |
| `getAllAndOverride(key, targets)` | the first defined value |
| `getAllAndMerge(key, targets)` | arrays concatenated, objects merged |

Use `getAllAndMerge()` when roles should accumulate down the hierarchy (controller roles *plus* method roles) and `getAllAndOverride()` when the more specific declaration replaces the broader one. Picking the wrong one is a silent privilege bug in either direction.

### A typed alternative to `SetMetadata`

`Reflector.createDecorator()` builds the decorator and the key together, so the value you read back is typed without a manual generic.

```ts title="src/common/decorators/roles.decorator.ts"
import { Reflector } from '@nestjs/core'

export const Roles = Reflector.createDecorator<string[]>()
```

```ts
const required = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()])
```

The trade-off: `createDecorator()` generates a random key unless you pass `{ key: 'roles' }`, so anything outside your codebase that reads the raw metadata key — an OpenAPI plugin, a custom introspection tool — needs the explicit key. Use `SetMetadata` when the key is part of a contract, `createDecorator()` otherwise.

## Returning `false` versus throwing

This is the single most consequential choice on the page.

| What the guard does | Response |
| --- | --- |
| returns `true` | the request continues |
| returns `false` | **403 Forbidden**, Nest's default body, no message of yours |
| throws `UnauthorizedException` | 401 with your message and `errorCode` |
| throws `ForbiddenException` | 403 with your message and `errorCode` |
| throws anything else | whatever your [exception filters](exception-filters.md) make of it |

`false` always produces 403, never 401. A missing or expired token is a **401**, and the only way to say so is to throw. Returning `false` also gives the client nothing to act on — no message, no machine-readable code — so the practical rule is: return `true` or throw, and treat `return false` as a code smell.

:::warning
A guard that returns `false` when it meant "not authenticated" produces a 403 that tells a client with a merely expired token to stop retrying instead of refreshing. Throw `UnauthorizedException` and the refresh flow works.
:::

The one legitimate use of `false` is a guard whose whole job is a boolean policy with no useful message — a feature flag, a maintenance-mode switch — and even then an explicit exception reads better in logs.

## Guards are the wrong place for object-level authorization

A guard runs **before the resource is loaded**. It sees the JWT, the route, and the raw `request.params` — not the row. That makes it structurally incapable of answering "does this user own invoice 4711?".

```ts vulnerable title="DO NOT COPY — this guard authorizes nothing"
@Injectable()
export class InvoiceOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    // There is no invoice here. Only a string the caller chose.
    return typeof request.params.id === 'string'
  }
}
```

To do better, the guard would have to fetch the invoice itself — and then the handler fetches it again, the two queries can disagree under concurrent writes, and the guard has quietly become a data-access layer with no transaction around it.

The correct shape is to authorize **inside the service, against the loaded entity**, in the same query or the same transaction as the read:

```ts good title="src/invoices/invoices.service.ts"
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'

@Injectable()
export class InvoicesService {
  async findOneFor(userId: string, invoiceId: string) {
    const invoice = await this.repo.findById(invoiceId)
    if (!invoice) throw new NotFoundException('Invoice not found', { errorCode: 'INVOICE_NOT_FOUND' })
    if (invoice.ownerId !== userId) {
      // 404, not 403: a 403 confirms the invoice exists.
      throw new NotFoundException('Invoice not found', { errorCode: 'INVOICE_NOT_FOUND' })
    }
    return invoice
  }
}
```

Better still, push the ownership predicate into the query (`WHERE id = $1 AND owner_id = $2`) so there is no window between the read and the check at all.

So the division of labor is: **guards decide what a user may attempt; services decide what a user may touch.** The full exploit narrative, including why the response should be 404 rather than 403, is in [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

## Common patterns

### Opting a route out of a global guard

With an `APP_GUARD` authentication guard, the login and health routes need an escape hatch. Metadata plus `Reflector` is the whole mechanism.

```ts title="src/common/decorators/public.decorator.ts"
import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)
```

```ts title="src/common/guards/auth.guard.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js'
import { TokenService } from '../../auth/token.service.js'

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector: Reflector
  private readonly tokens: TokenService

  constructor(reflector: Reflector, tokens: TokenService) {
    this.reflector = reflector
    this.tokens = tokens
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest()
    const header: string | undefined = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (!token) {
      throw new UnauthorizedException('Missing bearer token', { errorCode: 'MISSING_TOKEN' })
    }

    try {
      request.user = await this.tokens.verify(token)
    } catch (cause) {
      throw new UnauthorizedException('Invalid token', { errorCode: 'INVALID_TOKEN', cause })
    }
    return true
  }
}
```

:::danger
`@Public()` is opt-out security, and every opt-out is one forgotten decorator away from an open endpoint. Audit it: grep for the decorator in CI and fail the build when it appears on a route that is not on an approved list. The failure mode is silent — the endpoint works perfectly, for everyone.
:::

### Composing several guards

`@UseGuards(A, B, C)` runs them in order and stops at the first rejection. Each guard stays a single question; composition does the rest.

```ts
@UseGuards(AuthGuard, TenantGuard, RolesGuard)
@Roles('billing:admin')
@Controller('billing')
export class BillingController {}
```

If you want a single decorator for a recurring combination, build it with `applyDecorators()` — see [Custom decorators](custom-decorators.md).

### Getting a value out of a guard

A guard's return value is a boolean; it cannot hand data to the handler. The supported channel is a property on the request object, read back with a custom param decorator:

```ts title="src/common/decorators/current-user.decorator.ts"
import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'

export const CurrentUser = createParamDecorator((data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest().user
})
```

That keeps `request.user` an implementation detail of two files instead of leaking into every controller signature.

### Rate limiting is a guard

`@nestjs/throttler` (**6.5.0** — not on the 12.x line) implements rate limiting as a guard precisely because a guard is the cheap stage that can read per-route metadata. See [Rate limiting with Throttler](../nestjs-libraries/throttler.md).

## Testing a guard

A guard is a plain class with one method, so the unit test is a fake `ExecutionContext`:

```ts title="test/roles.guard.spec.ts"
import assert from 'node:assert/strict'
import test from 'node:test'
import { Reflector } from '@nestjs/core'
import { RolesGuard } from '../src/common/guards/roles.guard.js'

function contextFor(user: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as any
}

test('rejects a user without the required role', () => {
  const reflector = new Reflector()
  reflector.getAllAndOverride = () => ['admin']

  const guard = new RolesGuard(reflector)
  assert.throws(() => guard.canActivate(contextFor({ roles: ['viewer'] })))
})
```

Fuller patterns, including `Test.createTestingModule()` with the real container, are in [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md).

## Common mistakes

- **Returning `false` when you meant 401.** `false` is always 403 with a default body. Throw `UnauthorizedException`.
- **Using a guard for object ownership.** It runs before the resource is loaded and only knows the token and the raw path parameter. Authorize in the service against the loaded row.
- **`@UseGuards(new RolesGuard())` for a guard that injects `Reflector`.** Instances bypass the container; the dependency is `undefined` at request time.
- **`app.useGlobalGuards(new AuthGuard(...))` for a guard with dependencies.** Same problem. Use an `APP_GUARD` provider.
- **Reading `request.user` in a guard that runs before the authentication guard.** Multiple `APP_GUARD` providers run in declaration order — put authentication first.
- **`getAllAndMerge()` where you meant `getAllAndOverride()`.** A method-level `@Roles('viewer')` then *adds to* the controller's `@Roles('admin')` instead of narrowing it.
- **Expecting a guard to run for an unmatched route.** No handler resolves, so no guard runs; the 404 comes from the platform. Use middleware or a global filter to observe those.
- **Forgetting `@Injectable()` on the guard class.** Without it the container has no metadata to resolve the constructor.
- **Putting expensive work in a guard.** It runs on every request to the route, including ones a later guard rejects. Keep the token verification, skip the database round-trip where a cache will do.
- **Relying on `@Public()` without an audit.** One missing decorator is an open endpoint, and nothing fails.
- **Calling `switchToHttp()` in a guard reused by a microservice handler.** Branch on `context.getType()` first.

## Related topics

- [The request lifecycle](../nestjs/request-lifecycle.md) — where guards sit, and why they run before pipes.
- [Middleware](middleware.md) — the stage before, and why it cannot read route metadata.
- [Interceptors](interceptors.md) — the stage after, for anything that needs to wrap the response.
- [Exception filters](exception-filters.md) — what turns a thrown `ForbiddenException` into a response.
- [Custom decorators](custom-decorators.md) — `applyDecorators()` for guard + metadata combinations, and `createParamDecorator()` for `@CurrentUser()`.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — why object-level checks belong in the service, with the exploit.
- [Authorization](../nestjs-libraries/authorization.md) — CASL and policy-based access control on top of guards.
- [Authentication](../nestjs-libraries/authentication.md) — Passport strategies and JWT verification inside a guard.
- [Rate limiting with Throttler](../nestjs-libraries/throttler.md) — the first-party guard-based rate limiter.
- [Modules](../nestjs/modules.md) — registering `APP_GUARD` providers.
- [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md) — exercising a guard in isolation.
- [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md) — the framework-independent version of the same problem.
