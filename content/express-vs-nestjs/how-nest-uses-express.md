---
title: How Nest uses Express
description: The layering from NestFactory through ExpressAdapter to the real Express 5 application — what each layer owns, how to reach the raw app, where Express middleware still applies, and what using @Res() costs you.
status: current
updated: 2026-09-11
---

A NestJS 12 application is an Express 5 application with a framework wrapped around it. `@nestjs/platform-express@12.0.1` declares `express` 5.2.1, `multer` 2.2.0, `cors` 2.8.6 and `path-to-regexp` 8.4.2 as its own dependencies — those are the versions your routes are actually matched and parsed by. Knowing exactly where the seam is turns a class of confusing behavior ("why is `req.body` undefined", "why did my interceptor stop running") into something you can reason about.

## The layering

```text
your controller method
  │  Nest's pipeline: filters, interceptors, pipes, guards
  ▼
NestApplication            ← useGlobalPipes(), setGlobalPrefix(), enableVersioning()
  │
ExpressAdapter             ← translates Nest's reply()/status()/redirect() onto res
  │  extends AbstractHttpAdapter from @nestjs/core
  ▼
express()                  ← the real Express 5.2.1 application object
  │
http.Server                ← what actually listens
```

Three objects, three jobs:

| Layer | Package | Owns |
| --- | --- | --- |
| `NestApplication` | `@nestjs/core` | the DI container, the module graph, global enhancers, lifecycle hooks |
| `ExpressAdapter` | `@nestjs/platform-express` | registering routes on Express, and translating a handler's return value into `res` calls |
| `express()` | `express` 5.2.1 | routing, middleware, `req` / `res`, the HTTP server |

Nest does not reimplement routing. `@Get('users/:id')` becomes a real `app.get('/users/:id', handler)` on a real Express application, and the handler Nest registers is a wrapper that runs guards, interceptors and pipes before calling your method.

## What `NestFactory.create()` builds

With no adapter argument, `NestFactory.create()` loads `@nestjs/platform-express`, constructs an `ExpressAdapter`, and lets the adapter construct the Express app:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  await app.listen(3000)
}

bootstrap()
```

You can also hand it an adapter you built yourself, wrapping an Express application you already have. This is the hook that makes incremental migration possible:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import express from 'express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const server = express()
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server))
  await app.init()
  server.listen(3000)
}

bootstrap()
```

`ExpressAdapter`'s constructor takes an optional instance; pass one and Nest registers its routes onto yours instead of creating its own. See [Migrating incrementally](migrating-incrementally.md) for what to do with that.

## Typing the application

Type the result as `NestExpressApplication` and the Express-specific methods become visible. Without the type parameter they exist at runtime but not in your editor.

```ts title="src/main.ts"
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.useStaticAssets(join(import.meta.dirname, '..', 'public'))
  app.useBodyParser('json', { limit: '100kb' })

  await app.listen(3000)
}

bootstrap()
```

| Method on `NestExpressApplication` | Wraps |
| --- | --- |
| `app.set(key, value)` | `express().set()` — `trust proxy`, `query parser`, `etag`, `json spaces` |
| `app.enable(key)` / `app.disable(key)` | `express().enable()` / `.disable()` |
| `app.engine(ext, fn)` | `express().engine()` |
| `app.useStaticAssets(path, options?)` | `express.static()` |
| `app.useBodyParser(parser, options?)` | `express.json()` / `urlencoded()` / `text()` / `raw()`, respecting the app's `rawBody` option |
| `app.setBaseViewsDir(path)` / `app.setViewEngine(engine)` | the `views` and `view engine` settings |
| `app.setLocal(key, value)` | `app.locals` |
| `app.enableCors(options?)` | the bundled `cors` 2.8.6 |
| `app.getHttpAdapter()` | the `ExpressAdapter` itself |

`app.set('trust proxy', 1)` matters for exactly the same reason it does in a plain app: `req.ip`, `req.protocol` and anything rate-limiting by address are wrong without it. The [App settings table](../reference/cheat-sheet.md) applies unchanged.

## Reaching the real Express app

Two calls, and the second one is the escape hatch:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  // The ExpressAdapter…
  const adapter = app.getHttpAdapter()

  // …and the express() application it wraps. Typed as Express, because the
  // NestExpressApplication type parameter carries it through.
  const server = adapter.getInstance()
  server.set('query parser', 'extended')

  await app.listen(3000)
}

bootstrap()
```

`getInstance()` returns the actual Express application object — the one with `app.locals`, `app.router`, `app.settings` and every method Express documents. Anything the framework does not surface is reachable there.

:::warning
Registering routes directly on the instance bypasses Nest entirely: no guards, no interceptors, no pipes, no exception filters, and nothing in the [request lifecycle](../nestjs/request-lifecycle.md). That is occasionally what you want (a migration shim, a liveness probe that must answer while the container is still building) and almost never what you want for application routes. Use it deliberately, and comment why.
:::

## Where Express middleware still applies

All of it. Three places to mount it, in increasing order of precision.

### 1. `app.use()` — the whole application

```ts title="src/main.ts"
import compression from 'compression'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.use(helmet())
  app.use(compression())
  app.use(cookieParser(process.env.COOKIE_SECRET))

  await app.listen(3000)
}

bootstrap()
```

`INestApplication.use()` is a thin wrapper around `adapter.use()`, which is `express().use()`. Ordering rules are Express's ordering rules: Helmet before the router so error responses carry the headers, compression before anything writes a body, `cookie-parser` before whatever reads `req.cookies`. The full ordering table is in [Middleware](../express/middleware.md) and it is correct here without amendment.

### 2. `configure(consumer)` — scoped to routes or controllers

```ts title="src/app.module.ts"
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import morgan from 'morgan'
import { UsersController } from './users/users.controller.js'
import { UsersModule } from './users/users.module.js'

@Module({ imports: [UsersModule] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(morgan('combined'))
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes(UsersController)
  }
}
```

`apply()` takes a middleware class or **any plain Express middleware function**, and `forRoutes()` takes a controller class, a path string, or a `{ path, method, version }` object. This is the layer that lets you keep an existing Express middleware and still scope it the Nest way.

### 3. Route-level, through the adapter

Occasionally a middleware has to run for one route before Nest's pipeline — the classic case is capturing a raw body for a signature check. Prefer the application's `rawBody` option for that:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true })
  await app.listen(3000)
}

bootstrap()
```

With `rawBody: true` the untouched `Buffer` is available on the request, and `@Req()` typed as `RawBodyRequest<Request>` exposes it — no adapter access needed. See [File uploads](../nestjs-request-handling/file-uploads.md) and [Middleware](../nestjs-request-handling/middleware.md).

## `@Req()` and `@Res()`

Both give you the Express objects, unchanged. `@Req()` is harmless. `@Res()` is not.

```ts title="src/reports/reports.controller.ts"
import { Controller, Get, Req } from '@nestjs/common'
import type { Request } from 'express'

@Controller('reports')
export class ReportsController {
  @Get('whoami')
  whoami(@Req() request: Request) {
    // Ordinary Express 5 request: null-prototype params, a query getter,
    // and req.host that includes the port.
    return { ip: request.ip, host: request.hostname, path: request.path }
  }
}
```

Reading from `@Req()` costs nothing: you return a value, and Nest still serializes it, still runs your interceptors, and still routes thrown exceptions through your filters.

### What `@Res()` costs you

The moment you inject `@Res()`, Nest assumes **you** are responsible for the response, and steps out of the way:

```ts title="src/downloads/downloads.controller.ts"
import { Controller, Get, Param, Res } from '@nestjs/common'
import type { Response } from 'express'

@Controller('downloads')
export class DownloadsController {
  @Get(':id')
  download(@Param('id') id: string, @Res() response: Response) {
    // Nest will NOT send anything for you. If this method returns without
    // writing to `response`, the request hangs until the client times out.
    response.sendFile(`${id}.pdf`, { root: 'files' })
  }
}
```

What you give up, precisely:

| You lose | Because |
| --- | --- |
| Automatic serialization of the return value | Nest never calls `adapter.reply()`; your return value is discarded |
| `@HttpCode()` and the default 201-on-POST | the status is whatever you set on `res` |
| `@Header()` and `@Redirect()` | same reason |
| Interceptor **post**-handler operators | there is no result stream to map; anything after `next.handle()` sees nothing useful |
| `ClassSerializerInterceptor` and `@SerializeOptions()` | they operate on the returned object |
| A hanging request as a *loud* failure | forgetting to write a response is now silent |

Exception filters still work, because a thrown exception is caught before the response is written. Guards and pipes still run, because they execute before the handler.

### `passthrough: true` is usually what you wanted

If all you need is to set a cookie or a status and still return an object, ask for the response object *without* opting out of the pipeline:

```ts title="src/sessions/sessions.controller.ts"
import { Body, Controller, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { LoginDto } from './dto/login.dto.js'
import { SessionsService } from './sessions.service.js'

@Controller('sessions')
export class SessionsController {
  private readonly sessions: SessionsService

  constructor(sessions: SessionsService) {
    this.sessions = sessions
  }

  @Post()
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const { token, user } = await this.sessions.login(dto)
    response.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'lax' })
    return user // still serialized by Nest, still passes through interceptors
  }
}
```

`ResponseDecoratorOptions.passthrough` defaults to `false`, which is the opt-out behavior above. Setting it to `true` gives you the Express `Response` for side effects while leaving Nest in charge of the body.

:::best-practice
Reach for `@Res({ passthrough: true })` first, and plain `@Res()` only when you genuinely take over the socket — streaming, `res.sendFile()`, server-sent events written by hand, or piping a proxy response. Mixing both styles inside one controller is how a request ends up answered twice.
:::

:::warning
Injecting `@Res()` on a method and also returning a value is the single most common Nest bug of this shape. The return value is ignored, the client gets nothing, and the request hangs. There is no error, no log line, and no failing test unless you assert on the response body.
:::

## What the Express layer decides for you

Because the HTTP layer really is Express 5.2.1, all of Part 1 applies to a Nest application without translation:

| Behavior | Where it is documented |
| --- | --- |
| Route path grammar (path-to-regexp 8) — wildcards, optional groups, escaping | [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md), and the decorator forms in [Routing and path syntax](../nestjs/routing-and-path-syntax.md) |
| `req.body` is `undefined` until a matching parser ran | [Express 4 → 5 for Nest routes](../nestjs-reference/express-4-to-5-for-nest.md) |
| `req.query` is a getter with the `'simple'` parser by default | same |
| `req.host` includes the port; `req.hostname` does not | same |
| `express.static()` hides dotfiles by default, including `/.well-known/` | [Static files](../express/static-files.md) |
| `trust proxy` governs `req.ip`, `req.protocol` and `req.secure` | [Routing](../express/routing.md) |
| Body-parser `limit` applies to the **decompressed** size | [Middleware](../express/middleware.md) |
| Registration order decides which of two overlapping routes wins | [Routing and path syntax](../nestjs/routing-and-path-syntax.md) |

`@nestjs/platform-express@12.0.1` also pins `multer` at **2.2.0** — one patch line behind the 2.3.0 named in Part 1, and still a supported 2.x. You never install multer yourself in a Nest project; the platform package owns that dependency, and adding a second copy is how a project ends up resolving the end-of-life 1.x line.

## Swapping the platform

The adapter is the abstraction, so `@nestjs/platform-fastify@12.0.1` substitutes for `@nestjs/platform-express` without touching a controller. What does not survive is everything in this page that reaches the Express object: `@Res()` typed as an Express `Response`, `app.use(someExpressMiddleware)`, `useStaticAssets` options, and any code that calls `getInstance()`.

That is the practical meaning of "Nest is platform-agnostic": your controllers are, your bootstrap is not. See [The Fastify adapter](../nestjs-advanced/fastify-adapter.md).

## Common mistakes

- **Injecting `@Res()` and returning a value.** The return value is discarded and the request hangs. Use `@Res({ passthrough: true })` unless you are writing the response yourself.
- **Wondering why an interceptor stopped transforming responses** on one route. Check for `@Res()` on that handler — you opted out of the stream it was mapping.
- **Registering application routes on `getInstance()`.** They bypass guards, pipes, interceptors and filters, and nothing warns you.
- **Assuming Nest reimplements routing.** It compiles your decorator paths with the bundled `path-to-regexp@8.4.2`, so every Express 5 path rule throws at bootstrap here too.
- **Installing `express` or `multer` directly.** `@nestjs/platform-express` pins both. A second copy at a different major is a real, hard-to-see failure.
- **Forgetting `app.set('trust proxy', …)` behind a load balancer.** `req.ip` becomes the proxy's address, and IP-based throttling collapses onto one bucket.
- **Not typing the app as `NestExpressApplication`.** `useStaticAssets`, `setViewEngine` and `useBodyParser` vanish from autocomplete and people conclude Nest cannot do them.
- **Treating Express middleware as second-class.** `app.use()` and `consumer.apply()` both take plain `(req, res, next)` functions. Rewriting working middleware as a Nest class buys nothing unless it needs injection.
- **Reaching for `@Res()` just to set a status code.** `@HttpCode(204)` does that without leaving the pipeline.

## Related topics

- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — the decorator forms of every path-to-regexp 8 construct.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the stages `@Res()` opts you out of.
- [Middleware](../nestjs-request-handling/middleware.md) — `configure()`, `MiddlewareConsumer` and Express functions inside Nest.
- [Routing](../express/routing.md) — the Express layer underneath, including `trust proxy`.
- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the grammar Nest inherits.
- [Migrating incrementally](migrating-incrementally.md) — what `new ExpressAdapter(server)` is really for.
- [The Fastify adapter](../nestjs-advanced/fastify-adapter.md) — what changes when the platform is not Express.
- [File uploads](../nestjs-request-handling/file-uploads.md) — multer 2.2.0 through the platform package.
- [Express 4 → 5 for Nest routes](../nestjs-reference/express-4-to-5-for-nest.md) — the Express 5 changes that reach your controllers.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — where the pinned dependency versions come from.
