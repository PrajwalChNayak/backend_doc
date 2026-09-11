---
title: Custom decorators
description: createParamDecorator and applyDecorators in NestJS 12, metadata decorators with SetMetadata and Reflector.createDecorator, and why validation skips custom parameters by default.
status: current
updated: 2026-09-11
---

Nest's decorators are ordinary functions that attach metadata, and you can write your own. Three kinds are worth building: a **parameter** decorator that extracts a value from the request, a **metadata** decorator that a guard or interceptor reads back, and a **composite** decorator that bundles several existing ones into one line.

## Why it exists

`request.user` is set by an authentication guard and read by every handler that needs it. Without a decorator that means `@Req() request: Request` in forty signatures, an `any` cast, and a coupling to Express that makes the controller untestable without a fake request object.

A custom decorator moves that knowledge into one file. The controller says what it wants, not where it lives.

## Parameter decorators

```ts title="src/common/decorators/current-user.decorator.ts"
import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'

export interface AuthenticatedUser {
  id: string
  email: string
  roles: string[]
  tenantId: string
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()
    const user = request.user
    if (!user) return undefined
    return data ? user[data] : user
  },
)
```

```ts title="src/orders/orders.controller.ts"
import { Controller, Get } from '@nestjs/common'
import { CurrentUser } from '../common/decorators/current-user.decorator.js'
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator.js'

@Controller('orders')
export class OrdersController {
  @Get()
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.findForUser(user.id)
  }

  @Get('count')
  countMine(@CurrentUser('id') userId: string) {
    return this.orders.countForUser(userId)
  }
}
```

The factory signature is `(data, context) => value`. `data` is whatever the caller passed to the decorator — `'id'` above, `undefined` when it is called bare — and `context` is the same `ExecutionContext` a guard gets, so `getHandler()`, `getClass()` and `getType()` are all available.

:::warning
`request.user` is populated by a guard. A custom decorator that reads it runs **after** guards, so on a route with no authentication guard the value is `undefined` and the handler receives `undefined` rather than an error. Make the decorator return `undefined` honestly (as above) and let the guard be the thing that enforces presence — a decorator that throws when the user is missing hides a missing `@UseGuards()`.
:::

### Other things worth extracting

```ts title="src/common/decorators/request-id.decorator.ts"
import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

export const RequestId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<Request>().get('x-request-id')
})
```

```ts title="src/common/decorators/client-ip.decorator.ts"
import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  // request.ip is only trustworthy when `trust proxy` is configured correctly.
  return context.switchToHttp().getRequest<Request>().ip
})
```

:::danger
`request.ip` and `X-Forwarded-For` are attacker-controlled unless `trust proxy` is set to the exact number of proxies in front of you. A rate limiter or an audit log keyed on a spoofable client IP is worse than one with no IP at all, because it looks like it works. The Express-level configuration is in [Request and response](../express/request-and-response.md); the abuse case is in [Rate limiting and abuse](../security/rate-limiting-and-abuse.md).
:::

### Passing pipes to a custom decorator

The decorator returned by `createParamDecorator()` accepts pipes after the data argument, exactly like `@Param()` and `@Query()` do:

```ts
@Get('count')
countMine(@CurrentUser('id', ParseUUIDPipe) userId: string) {
  return this.orders.countForUser(userId)
}
```

The pipe runs on the value the factory produced, not on the raw request.

### Validation skips custom parameters by default

This is the detail that surprises people, and Nest 12 made it explicit in the type declarations.

| Pipe | Option | Default |
| --- | --- | --- |
| `ValidationPipe` | `validateCustomDecorators` | `false` |
| `StandardSchemaValidationPipe` | `validateCustomDecorators` | `false` |

A global `ValidationPipe` therefore does **nothing** to `@CurrentUser() user: UserDto`. The reason is sound: `ArgumentMetadata.type` is `'custom'` for these parameters and `metatype` is usually absent, so the pipe has nothing to validate against and would either throw or silently strip the value. Skipping is the safe default.

Turn it on deliberately, per pipe, when a custom decorator's output really is client-controlled:

```ts title="src/app.module.ts"
import { Module, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({ whitelist: true, transform: true, validateCustomDecorators: true }),
    },
  ],
})
export class AppModule {}
```

:::best-practice
Leave `validateCustomDecorators` off and make your custom decorators extract values that are already trustworthy — a user object a guard verified, a request id your middleware generated. A decorator that pulls an unvalidated value straight off the request and hands it to a handler is validation you have quietly opted out of. If a decorator must read raw client input, either validate inside the factory or flip the option on and give the parameter a DTO type.
:::

### The v12 parameter options object

Nest 12 also lets the **built-in** parameter decorators take an options object instead of a string, carrying a Standard Schema and explicit pipes:

```ts
// @Body({ schema?: StandardSchemaV1, pipes?: (Type<PipeTransform> | PipeTransform)[] })
```

That is how `StandardSchemaValidationPipe` finds the schema for an argument — it arrives on `ArgumentMetadata.schema`. It applies to `@Body()`, `@Query()` and the other built-ins, not to decorators you create. See [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md).

## Metadata decorators

A metadata decorator attaches a value to a handler or controller; a guard or interceptor reads it back with `Reflector`. The mechanics are on the [Guards](guards.md) page — here is the choice between the two ways of writing one.

```ts title="src/common/decorators/roles.decorator.ts"
import { SetMetadata } from '@nestjs/common'

export const ROLES_KEY = 'roles'
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)
```

```ts title="src/common/decorators/roles.decorator.ts"
import { Reflector } from '@nestjs/core'

// Same thing, typed, with the key generated for you.
export const Roles = Reflector.createDecorator<string[]>()
```

| | `SetMetadata` | `Reflector.createDecorator` |
| --- | --- | --- |
| Key | you choose the string | random `uid(21)` unless you pass `{ key }` |
| Typing of the read | manual generic on `get`/`getAllAndOverride` | inferred from the decorator |
| Value shape | anything | one argument; use `{ key, transform }` to normalize it |
| Readable by other tooling | yes, the key is stable | only with an explicit `key` |

Use `SetMetadata` when the metadata key is part of a contract something else reads — an OpenAPI plugin, a health-check introspector, your own CLI. Use `createDecorator()` for everything internal, because the typed read is worth more than a key you never look at.

`createDecorator({ transform })` is useful for normalizing at declaration time rather than in every guard:

```ts
export const Roles = Reflector.createDecorator<string | string[], string[]>({
  key: 'roles',
  transform: (value) => (Array.isArray(value) ? value : [value]),
})
```

## Composite decorators

`applyDecorators()` returns one decorator that applies several. It works on class, method and property decorators — **not** on parameter decorators.

```ts title="src/common/decorators/admin-route.decorator.ts"
import { UseGuards, applyDecorators } from '@nestjs/common'
import { AuthGuard } from '../guards/auth.guard.js'
import { RolesGuard } from '../guards/roles.guard.js'
import { Roles } from './roles.decorator.js'

export function AdminRoute(...roles: string[]) {
  return applyDecorators(Roles(...roles), UseGuards(AuthGuard, RolesGuard))
}
```

```ts title="src/admin/admin.controller.ts"
import { Controller, Delete, Param, ParseUUIDPipe } from '@nestjs/common'
import { AdminRoute } from '../common/decorators/admin-route.decorator.js'

@Controller('admin/users')
export class AdminController {
  @Delete(':id')
  @AdminRoute('user:delete')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.remove(id)
  }
}
```

The value is not brevity, it is that the guard and the metadata can no longer be applied separately. `@Roles('user:delete')` without `@UseGuards(RolesGuard)` is metadata nobody reads — a route that looks protected and is not. Bundling them makes that mistake unrepresentable.

The same pattern carries OpenAPI decorators along, so the documentation cannot drift from the enforcement:

```ts title="src/common/decorators/authenticated.decorator.ts"
import { UseGuards, applyDecorators } from '@nestjs/common'
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger'
import { AuthGuard } from '../guards/auth.guard.js'

export function Authenticated() {
  return applyDecorators(
    UseGuards(AuthGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' }),
  )
}
```

:::note
`applyDecorators()` applies its arguments in order to the same target, so it cannot express "guard first, then interceptor" across different enhancer kinds — that ordering is fixed by the pipeline, not by decorator order. See [The request lifecycle](../nestjs/request-lifecycle.md).
:::

### Composing parameter decorators

You cannot. `applyDecorators()` takes `ClassDecorator | MethodDecorator | PropertyDecorator`, and a parameter decorator has a different signature. To combine extraction with a pipe, pass the pipe to the parameter decorator itself — `@CurrentUser('id', ParseUUIDPipe)` — or put the logic in the factory.

The escape hatch, when a custom parameter decorator genuinely needs to apply another parameter decorator's behavior, is the second argument to `createParamDecorator()`:

```ts
// createParamDecorator(factory, enhancers?: ParameterDecorator[])
```

Enhancers are parameter decorators applied alongside the generated one. This is a niche tool — `@nestjs/swagger` uses it to register parameter documentation — and if you are reaching for it to solve an ordering problem, you probably want a pipe instead.

## Testing a custom decorator

`createParamDecorator()` returns a decorator, not the factory, so there is nothing to call directly in a unit test. Two workable approaches: export the factory function separately and test it against a fake `ExecutionContext`, or test through the handler with an end-to-end request.

```ts title="src/common/decorators/current-user.decorator.ts"
import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'

// Exported so it can be unit-tested without going through Nest.
export function currentUserFactory(data: string | undefined, context: ExecutionContext) {
  const user = context.switchToHttp().getRequest().user
  if (!user) return undefined
  return data ? user[data] : user
}

export const CurrentUser = createParamDecorator(currentUserFactory)
```

```ts title="test/current-user.decorator.spec.ts"
import assert from 'node:assert/strict'
import test from 'node:test'
import { currentUserFactory } from '../src/common/decorators/current-user.decorator.js'

const context = {
  switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', email: 'a@example.com' } }) }),
} as any

test('extracts a single field', () => {
  assert.equal(currentUserFactory('email', context), 'a@example.com')
})

test('returns undefined when no guard populated the request', () => {
  const anonymous = { switchToHttp: () => ({ getRequest: () => ({}) }) } as any
  assert.equal(currentUserFactory(undefined, anonymous), undefined)
})
```

More on the testing module and fake contexts is in [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md).

## Common mistakes

- **Expecting a global `ValidationPipe` to validate `@CurrentUser() user: UserDto`.** Custom parameters are skipped unless `validateCustomDecorators: true` — and that default is deliberate.
- **Reading raw client input in a decorator factory.** It bypasses the validation you set up everywhere else. Extract trusted values, or validate in the factory.
- **Throwing from a param decorator when `request.user` is missing.** That hides a forgotten `@UseGuards()`; let the guard fail instead.
- **`applyDecorators()` with a parameter decorator.** It only accepts class, method and property decorators.
- **`@Roles()` without the guard that reads it.** Metadata nobody consumes. Bundle them with `applyDecorators()`.
- **Assuming decorator order controls pipeline order.** Guards always run before interceptors regardless of which decorator you wrote first.
- **`Reflector.createDecorator()` with an implicit key, then reading the metadata by string.** The key is a random `uid(21)`. Pass `{ key: 'roles' }` when anything else needs it.
- **`switchToHttp()` inside a decorator used by a microservice handler.** Branch on `context.getType()`.
- **Duplicating the same extraction in both a decorator and a guard.** Compute once in the guard, store on the request, read in the decorator.
- **Typing the parameter as the DTO and assuming a runtime guarantee.** The annotation is erased; only a pipe or the factory itself can enforce the shape.

## Related topics

- [Guards](guards.md) — where metadata decorators are consumed, and `Reflector` precedence.
- [Pipes](pipes.md) — `ArgumentMetadata`, and why `metatype` is absent for custom parameters.
- [Interceptors](interceptors.md) — the other consumer of handler metadata.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the fixed ordering decorators cannot change.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — `validateCustomDecorators` in the context of every other option.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the v12 schema-on-parameter form.
- [DTOs](dtos.md) — the classes a validated parameter should be typed as.
- [Controllers](../nestjs/controllers.md) — the built-in parameter decorators these sit beside.
- [Decorator reference](../nestjs-reference/decorator-reference.md) — every decorator Nest ships, in one table.
- [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md) — fake execution contexts.
- [Request and response](../express/request-and-response.md) — `trust proxy` and why `request.ip` needs it.
