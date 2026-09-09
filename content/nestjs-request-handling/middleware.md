---
title: Middleware
description: Functional and class middleware in NestJS 12, binding them with MiddlewareConsumer, and why middleware runs before guards and never sees the ExecutionContext.
status: current
updated: 2026-09-09
---

Middleware in Nest is Express middleware: a `(req, res, next)` function that runs before the route handler is even selected. It is the only stage of the Nest pipeline that is not Nest-aware — it gets the raw platform request and nothing else. That limitation is the whole reason guards, interceptors and pipes exist.

## Why it exists

Nest keeps middleware because the Express ecosystem is full of useful `(req, res, next)` functions — `helmet()`, `cookie-parser`, a raw-body capture for webhook signatures — and rewriting them as guards would be pointless. Middleware is the adapter layer for that ecosystem, plus the right place for work that must happen before routing.

Everything that needs to know *which handler is about to run* belongs one stage later. See [The request lifecycle](../nestjs/request-lifecycle.md) for the full order.

## Where it sits

Nest runs enhancers in a fixed order. Middleware is first:

| Stage | Sees the request | Sees the target handler | Can short-circuit |
| --- | --- | --- | --- |
| **Middleware** | yes (raw `req`/`res`) | **no** | yes, by responding or `next(err)` |
| **Guards** | yes, via `ExecutionContext` | yes | yes, by returning `false` or throwing |
| **Interceptors (before)** | yes, via `ExecutionContext` | yes | yes, by returning its own observable |
| **Pipes** | the bound argument only | yes | yes, by throwing |
| **Handler** | yes | — | — |

The consequence that trips people up: **middleware runs before guards, always.** A middleware cannot read metadata set with `@SetMetadata()` or `Reflector.createDecorator()`, cannot call `context.getHandler()`, and cannot know whether the route it is running for is public or protected — because at that point Nest has not chosen a handler.

:::warning
If you find yourself wanting `ExecutionContext` inside middleware, you want a [guard](guards.md) or an [interceptor](interceptors.md). There is no supported way to get one; `use()` receives only the platform `req`, `res` and `next`.
:::

## Basic example

A functional middleware is a plain function. It is the right default when the middleware has no dependencies.

```ts title="src/common/middleware/request-id.middleware.ts"
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id')
  const id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID()

  req.headers['x-request-id'] = id
  res.setHeader('X-Request-Id', id)
  next()
}
```

A class middleware implements `NestMiddleware` and participates in dependency injection, so it can take providers in its constructor.

```ts title="src/common/middleware/logger.middleware.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LoggerMiddleware.name)

  use(req: Request, res: Response, next: NextFunction) {
    const startedAt = process.hrtime.bigint()

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      this.logger.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`)
    })

    next()
  }
}
```

:::note
`private readonly logger = new Logger(...)` is a class field, not a constructor parameter property. Nest examples across this handbook avoid parameter properties (`constructor(private readonly x: X) {}`) because Node's type-stripping cannot compile them, and the site lints every snippet by stripping it. Injected dependencies are declared as a field and assigned in the constructor body — DI behaves identically either way.
:::

## Binding middleware

Middleware is not registered by a decorator. The module implements `NestModule` and configures it:

```ts title="src/app.module.ts"
import { Module, RequestMethod } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { LoggerMiddleware } from './common/middleware/logger.middleware.js'
import { requestId } from './common/middleware/request-id.middleware.js'
import { UsersController } from './users/users.controller.js'

@Module({ controllers: [UsersController] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestId, LoggerMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.GET },
        { path: 'metrics', method: RequestMethod.GET },
      )
      .forRoutes('{*splat}')
  }
}
```

`apply()` takes one or more middleware — classes or functions — and returns a proxy with `exclude()` and `forRoutes()`. The order inside `apply()` is the order they run in.

### What `forRoutes()` accepts

| Argument | Meaning |
| --- | --- |
| `'users'` | the path `/users` only, every method |
| `'users/{*splat}'` | `/users` and everything under it |
| `'{*splat}'` | every path, including `/` |
| `{ path: 'users', method: RequestMethod.POST }` | one path and one method |
| `{ path: 'users', method: RequestMethod.ALL, version: '2' }` | scoped to an API version as well |
| `UsersController` | every route the controller declares |

Passing the controller class is usually the clearest option, because the middleware follows the controller when its path prefix changes.

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { TenantContextMiddleware } from '../common/middleware/tenant-context.middleware.js'
import { UsersController } from './users.controller.js'

@Module({ controllers: [UsersController] })
export class UsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes(UsersController)
  }
}
```

### Path syntax is Express 5 path syntax

`@nestjs/platform-express@12.0.1` bundles `express@5.2.1` and `path-to-regexp@8.4.2`, and `forRoutes()` paths are handed straight to `app.use(path, fn)`. Every Express 5 rule applies — read [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) once and it covers routes, middleware paths and `exclude()` paths alike.

The two that bite immediately:

| Do not write | Write |
| --- | --- |
| `'*'` | `'{*splat}'` (matches `/` too) or `'*splat'` (does not) |
| `':file.:ext?'` | `':file{.:ext}'` |

:::note
`exclude()` paths go through Nest's `LegacyRouteConverter`, which rewrites a few old wildcard forms — `'/users/*'` becomes `'/users/{*path}'` — and logs a warning telling you what it did. Do not lean on it. It only covers `exclude()`, it does not cover route decorators, and it is an escape hatch for migrations, not a syntax.
:::

### `exclude()` matches paths, not controllers

`exclude()` takes strings and `RouteInfo` objects only — you cannot exclude a controller class. It also matches against the **full request path including the global prefix**, so with `app.setGlobalPrefix('api')` the excluded path is still written without the prefix (`'health'`); Nest prepends the prefix for you when it builds the matcher.

An `exclude()` on a functional middleware wraps it in a class that checks the exclusion list per request and calls `next()` when it matches. The middleware still runs as an Express layer — it just becomes a no-op — so exclusion is not a performance optimization.

## Global middleware with `app.use()`

Middleware that has no dependencies and must run for absolutely everything can be registered on the application instance instead. This is the only way to install middleware that runs *before* Nest's own routing layer, which matters for security headers and for raw-body capture.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.use(helmet())
app.enableCors({ origin: ['https://app.example.com'], credentials: true })

await app.listen(3000)
```

`app.use()` is a thin wrapper around the underlying adapter's `use()`. Two consequences:

- **No dependency injection.** The function is registered as-is; it cannot take providers. If you need a provider, use a class middleware and `configure()`.
- **No `exclude()`.** It runs for every request that reaches the server.

:::tip
Do not install `cors` yourself. `@nestjs/platform-express@12.0.1` bundles `cors@2.8.6` and exposes it as `app.enableCors()` / the `cors` option on `NestFactory.create()`. Configuration and the ways it goes wrong are in [CORS](../nestjs-security/cors.md).
:::

## Common patterns

### Third-party Express middleware

Anything with an Express 5-compatible `(req, res, next)` signature works unchanged. Body parsing is already installed by Nest, so do not add `express.json()` on top of it — configure it through `NestFactory.create(AppModule, { bodyParser: false })` and register your own only when you genuinely need different behavior.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)
app.use(cookieParser())
await app.listen(3000)
```

### Capturing a raw body for webhook signatures

Signature verification needs the exact bytes, and by the time `@Body()` gives you an object the bytes are gone. Nest supports this without custom middleware:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule, { rawBody: true })
await app.listen(3000)
```

```ts title="src/webhooks/webhooks.controller.ts"
import { Controller, Post, RawBody, Headers } from '@nestjs/common'

@Controller('webhooks')
export class WebhooksController {
  @Post('stripe')
  handle(@RawBody() raw: Buffer, @Headers('stripe-signature') signature: string) {
    verifySignature(raw, signature)
    return { received: true }
  }
}
```

Verify the signature over `raw` before you parse or trust anything in it.

### Per-request context without middleware

A middleware that stashes something on `req` and a service that reads it back off `req` is a common shape, and it works, but it types badly and couples your services to Express. Two better options: request-scoped providers (see [Injection scopes](../nestjs/injection-scopes.md)) or `AsyncLocalStorage` from `node:async_hooks`, populated in middleware and read anywhere.

```ts title="src/common/context/request-context.ts"
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
  requestId: string
  tenantId?: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()
```

```ts title="src/common/middleware/context.middleware.ts"
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { requestContext } from '../context/request-context.js'

export function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  requestContext.run({ requestId: req.get('x-request-id') ?? randomUUID() }, () => next())
}
```

Middleware is the correct stage for this precisely because it runs first: everything downstream, including guards, is inside the `run()` callback.

### Errors from middleware

Express 5 forwards a rejected promise returned by a handler or middleware to the error stack automatically, and Nest's exception layer picks it up from there. An `async` middleware that throws a `ForbiddenException` produces a normal Nest 403 response.

```ts title="src/common/middleware/api-key.middleware.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { KeysService } from '../../keys/keys.service.js'

@Injectable()
export class ApiKeyMiddleware implements NestMiddleware {
  private readonly keys: KeysService

  constructor(keys: KeysService) {
    this.keys = keys
  }

  async use(req: Request, _res: Response, next: NextFunction) {
    const presented = req.get('x-api-key')
    if (!presented || !(await this.keys.isValid(presented))) {
      throw new UnauthorizedException('Invalid API key', { errorCode: 'INVALID_API_KEY' })
    }
    next()
  }
}
```

That said, an API-key check is a better fit for a guard, where it can read metadata and be tested with the rest of the pipeline. Use middleware for it only when the check must happen before routing — for example when you want unknown paths rejected too.

## Common mistakes

- **Expecting middleware to see the handler.** It runs before routing. No `ExecutionContext`, no `Reflector`, no `@SetMetadata()`. Use a guard.
- **Writing `forRoutes('*')`.** Invalid under path-to-regexp 8. Use `'{*splat}'` for "everything including `/`", or `'*splat'` when you do not want the root.
- **Using a parameter property in a middleware class.** `constructor(private readonly x: X) {}` is fine for `tsc`, but it breaks Node type-stripping and the site's snippet linter. Declare the field and assign it.
- **Registering `express.json()` yourself.** Nest already installs body parsing. Two parsers on the same route means the second sees an already-consumed stream.
- **Assuming `exclude()` skips the middleware entirely.** Nest wraps the middleware and calls `next()` when the path matches; the layer is still in the stack.
- **Excluding by controller class.** `exclude()` takes strings and `RouteInfo` only. `forRoutes()` is the one that takes a class.
- **Putting authorization in middleware.** It has no idea what resource is being requested and no access to route metadata. See [Guards](guards.md).
- **Using `app.use()` for anything that needs a provider.** No DI. Use a class middleware and `configure()`.
- **Ordering `configure()` calls by accident.** Middleware runs in the order modules are resolved and, within one `apply()`, in argument order. If order matters, put them in one `apply()` call.
- **Reading `req.url` inside a mounted middleware for logging.** Log `req.originalUrl`; the mount prefix has been stripped from `req.url`.

## Related topics

- [Guards](guards.md) — the next stage, and the first one that can see the handler.
- [Interceptors](interceptors.md) — wrap the handler on both sides, with an `ExecutionContext`.
- [Exception filters](exception-filters.md) — where an exception thrown in middleware ends up.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the full ordering of every stage.
- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the Express 5 rules that govern `forRoutes()` and `exclude()`.
- [Middleware](../express/middleware.md) — the underlying Express model, `next('route')` and `next('router')`.
- [Injection scopes](../nestjs/injection-scopes.md) — request-scoped providers instead of stashing state on `req`.
- [CORS](../nestjs-security/cors.md) — configuring the bundled `cors@2.8.6`.
- [Security headers](../nestjs-security/security-headers.md) — where `helmet()` belongs in the stack.
