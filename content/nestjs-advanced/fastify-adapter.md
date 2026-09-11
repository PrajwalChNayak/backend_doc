---
title: The Fastify adapter
description: Running NestJS 12 on @nestjs/platform-fastify 12.0.1 — what actually changes when you swap adapters, from route path grammar and middleware to plugins, uploads, static assets, hooks and testing.
status: current
updated: 2026-09-11
---

Nest's HTTP layer sits behind an adapter interface, and `@nestjs/platform-fastify` **12.0.1** is the second implementation of it. Controllers, guards, interceptors, pipes, filters and DI are untouched by the swap. What changes is everything that reaches past the abstraction: the request and response objects, the route path grammar, how middleware is installed, and which ecosystem of plugins you draw from.

## Switching

```bash
npm uninstall @nestjs/platform-express
npm install @nestjs/platform-fastify@12.0.1
```

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true, bodyLimit: 1_048_576 }),
  )

  // Fastify binds to 127.0.0.1 by default — inside a container that is unreachable.
  await app.listen(3000, '0.0.0.0')
}

bootstrap()
```

Two details in that snippet do real work:

- **The `NestFastifyApplication` type parameter.** Without it `app` is an `INestApplication` and `app.register()`, `app.useStaticAssets()` and `app.inject()` do not exist on the type. It is a type argument only — it changes nothing at runtime, and forgetting it is the first compile error everyone hits.
- **The explicit host.** Express listens on all interfaces by default; Fastify listens on localhost. In Docker or Kubernetes the pod starts, the probe fails, and nothing in the logs says why.

`FastifyAdapter`'s constructor takes Fastify's own server options — or an existing `FastifyInstance` — plus one Nest-specific flag, `skipMiddie`, covered below. HTTPS and HTTP/2 are configured there too, with `https` and `http2`, rather than through Nest's `httpsOptions`.

## What `@nestjs/platform-fastify@12.0.1` brings with it

Read from the package's own `dependencies`, not assumed:

```json
{ "@fastify/cors": "11.3.0", "@fastify/formbody": "9.0.0", "fast-querystring": "1.1.2",
  "fastify": "5.12.1", "fastify-plugin": "6.0.0", "find-my-way": "9.9.0",
  "light-my-request": "6.6.0", "path-to-regexp": "8.4.2", "reusify": "1.1.0", "tslib": "2.8.1" }
```

`@fastify/static` (`^10.1.2`) and `@fastify/view` (`^10 || ^11 || ^12`) are **optional peer dependencies** — install them only if you serve static files or render templates.

## Route paths are Fastify's, not Express's

This is the difference that breaks a migration, and it is easy to miss because nothing warns you.

The path string in `@Get(...)` is handed to the platform router **unchanged**. On Express that router is `path-to-regexp` 8; on Fastify it is `find-my-way` 9.9.0, a radix tree with an entirely different grammar. `@nestjs/platform-fastify` runs Nest's legacy-path converter only on **middleware** paths, never on route paths.

The practical consequence is that several forms which are invalid under Express 5 are valid here, and the Express 5 replacements for them are not:

| Pattern | Express 5 / path-to-regexp 8 | Fastify / find-my-way 9 |
| --- | --- | --- |
| `:id` | valid | valid |
| `:file.:ext` | invalid — needs brace syntax | valid, two params separated by a dot |
| a trailing optional parameter | needs brace syntax | valid with a trailing question mark, last parameter only |
| a bare star segment | invalid — needs a named splat | valid; the remainder is exposed on the params object under the star key |
| a named splat | valid | **not** a wildcard — matched as a literal segment |
| inline regular expression | invalid — pass an array of paths | valid, in parentheses after the parameter name |

:::danger A path written for one adapter can match the wrong thing on the other
Nothing throws. A named splat that Express 5 treats as a catch-all is, to `find-my-way`, an ordinary static segment with an odd name — so the route registers cleanly and simply never matches. If you are porting an application between adapters, walk the route table and re-derive every non-trivial path from the target router's documentation. The Express 5 rules, and why they are what they are, are in [Routing and path syntax](../nestjs/routing-and-path-syntax.md).
:::

**Route order stops mattering.** The adapter reports itself as order-insensitive, because a radix tree resolves by specificity: static beats parametric-with-static-ending beats regex beats parametric beats wildcard, regardless of declaration order. On Express, a handler declared first wins, which is why Nest 12 offers `routeResolutionStrategy: 'specificity'` — an option that exists for order-sensitive adapters and is redundant here. The `routeConflictPolicy` diagnostics are still worth turning on; a genuine duplicate registration is a bug on either adapter.

## Request and response objects

`@Req()` gives you a `FastifyRequest` and `@Res()` a `FastifyReply`. Neither has the Express API, so any code that reached through the decorators has to be rewritten.

| You wrote (Express) | Fastify |
| --- | --- |
| `res.status(201).json(body)` | `reply.status(201).send(body)` |
| `res.send(body)` | `reply.send(body)` |
| `res.set('X-Foo', 'bar')` | `reply.header('X-Foo', 'bar')` |
| `res.redirect(301, url)` | `reply.redirect(url, 301)` |
| `req.get('content-type')` | `request.headers['content-type']` |
| `req.hostname` | `request.hostname` |
| `req.ip` | `request.ip` |
| the raw Node objects | `request.raw` / `reply.raw` |

The far better answer is not to touch either object. A handler that returns a value works identically on both adapters, and so do `@Body()`, `@Param()`, `@Query()`, `@Headers()`, `@HttpCode()` and `@Header()`.

:::warning `@Res()` turns Nest's response handling off
The moment you inject `@Res()`, Nest stops sending the return value — on both adapters. You own the response, including sending one at all; forget, and the request hangs until the client times out. Interceptors that map the response body stop applying, because there is no body flowing through them.

`@Res({ passthrough: true })` gives you the reply object for setting a header or a cookie while leaving Nest in charge of sending the body. That is almost always the one you want.
:::

Streaming is unchanged: return a `StreamableFile` and the adapter copies its `Content-Type`, `Content-Disposition` and `Content-Length` onto the reply before sending the stream.

## Middleware

Express middleware is a `(req, res, next)` function; Fastify's native extension point is a plugin. The adapter bridges the two by registering `middie`, which is bundled inside `@nestjs/platform-fastify` — you do not install `@fastify/middie` yourself.

So `configure(consumer)` in a `NestModule` works, and so does `app.use()`:

```ts title="src/app.module.ts"
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import { RequestIdMiddleware } from './common/request-id.middleware.js'

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware)
      .exclude({ path: 'healthz', method: RequestMethod.GET })
      .forRoutes('{*splat}')
  }
}
```

Middleware registered before the application initializes is queued and applied once `middie` is in place, so ordering at bootstrap is handled for you. Middleware **paths**, unlike route paths, do go through Nest's legacy-path converter and are then matched with `path-to-regexp` 8 — which is why the two kinds of path in a Fastify Nest application follow different rules, and why `forRoutes('{*splat}')` is written exactly as it is on the Express adapter. See [Middleware](../nestjs-request-handling/middleware.md).

`skipMiddie: true` on the adapter options skips that registration entirely. Use it when you have no middleware at all and want the layer gone; `app.use()` and `configure()` then do nothing.

:::tip Prefer a plugin, a guard or an interceptor
Middleware on Fastify is a compatibility shim over a different execution model. If the work is authentication, use a [guard](../nestjs-request-handling/guards.md); if it is cross-cutting request/response shaping, use an [interceptor](../nestjs-request-handling/interceptors.md); if it is infrastructure, use a Fastify plugin. Reach for middleware when you are porting something that already exists.
:::

## Plugins instead of Express middleware

Every `app.use(someExpressPackage())` line in `main.ts` needs a Fastify equivalent, registered with `app.register()`:

```ts title="src/main.ts"
import fastifyHelmet from '@fastify/helmet'
import fastifyCookie from '@fastify/cookie'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())

  await app.register(fastifyHelmet)
  await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET })

  app.enableCors({ origin: ['https://app.example.com'], credentials: true })

  await app.listen(3000, '0.0.0.0')
}

bootstrap()
```

| Express package | Fastify plugin | Current version |
| --- | --- | --- |
| `helmet` | `@fastify/helmet` | 13.1.1 |
| `cors` | `@fastify/cors` | bundled at 11.3.0 — use `app.enableCors()` |
| `cookie-parser` | `@fastify/cookie` | 11.1.2 |
| `express-rate-limit` | `@fastify/rate-limit` | 11.2.0 |
| `compression` | `@fastify/compress` | 9.2.0 |
| `multer` | `@fastify/multipart` | 10.1.1 |
| `express.static` | `@fastify/static` | 10.1.3 |

`app.enableCors()` on this adapter takes `FastifyCorsOptions`, not the `cors` package's options. The option names overlap heavily but they are not the same type — check the plugin's documentation rather than assuming. The threat model does not change: [CORS](../nestjs-security/cors.md) applies unmodified.

`app.register()` returns a promise. Awaiting it before `listen()` is not optional for plugins that must be in place before the first request.

## File uploads

`FileInterceptor`, `FilesInterceptor` and `@UploadedFile()` live in `@nestjs/platform-express` and are built on **multer**. They do not work on Fastify, and there is no first-party equivalent in `@nestjs/platform-fastify` — the package exports adapters, interfaces and three decorators, and nothing else.

Register `@fastify/multipart` and read the parts yourself:

```ts title="src/uploads/uploads.controller.ts"
import { BadRequestException, Controller, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

@Controller('uploads')
export class UploadsController {
  @Post()
  async upload(@Req() request: FastifyRequest) {
    const part = await request.file()
    if (!part) {
      throw new BadRequestException('No file part in the request')
    }

    // The limits you configured on the plugin are what actually stop a
    // 10 GB upload — the buffer below is already bounded by them.
    const buffer = await part.toBuffer()
    return { filename: part.filename, bytes: buffer.byteLength }
  }
}
```

Everything on [File upload security](../nestjs-security/file-upload-security.md) still applies and matters more here, because you are handling the stream yourself: enforce a size limit on the plugin, sniff the magic bytes rather than trusting `mimetype` or the extension, never use the client-supplied filename as a path, and store outside the web root.

## Static assets and views

```ts title="src/main.ts"
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())

  app.useStaticAssets({
    root: join(import.meta.dirname, '..', 'public'),
    prefix: '/public/',
  })

  await app.listen(3000, '0.0.0.0')
}

bootstrap()
```

`useStaticAssets()` takes `FastifyStaticOptions` and needs `@fastify/static` installed; `setViewEngine()` takes `FastifyViewOptions` — an object carrying the template engine and the templates directory — and needs `@fastify/view`. Both signatures differ from the Express adapter's: `useStaticAssets(path, options)` there, a single options object here, and `setViewEngine()` throws if you pass it a string, which the Express adapter accepts.

## Hooks, schemas and route config

The adapter exposes three decorators that have no Express counterpart, because they configure the underlying router directly:

| Decorator | Wraps | Use |
| --- | --- | --- |
| `@RouteSchema(schema)` | Fastify's `schema` | JSON-Schema validation and response serialization for one route |
| `@RouteConstraints(constraints)` | Fastify's `constraints` | Match on host, version or a custom constraint |
| `@RouteConfig(config)` | Fastify's `config` | Arbitrary per-route data readable from hooks |

```ts title="src/orders/orders.controller.ts"
import { Controller, Get } from '@nestjs/common'
import { RouteSchema } from '@nestjs/platform-fastify'

@Controller('orders')
export class OrdersController {
  @Get()
  @RouteSchema({
    querystring: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    response: {
      200: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } } },
      },
    },
  })
  list() {
    return { items: ['o_1', 'o_2'] }
  }
}
```

:::warning A response schema is a filter, not a check
Fastify's fast JSON serializer emits **only** the properties the response schema declares. That is a performance feature and an accidental safety net — and it is also why a field you added to a DTO can silently disappear from the response. If you use response schemas, they are now part of your API contract and must be updated with it.
:::

The adapter also carries `setOnRequestHook()` and `setOnResponseHook()` for installing a Fastify lifecycle hook from `main.ts`. These run outside Nest's pipeline — before guards on the way in, after the response on the way out — so they are the right place for infrastructure concerns and the wrong place for anything that needs the DI container.

Body parsing is configured with `app.useBodyParser(type, options, parser)`, which respects the application's `rawBody` option. JSON and `application/x-www-form-urlencoded` are registered for you, the latter through the bundled `@fastify/formbody`.

## Testing

`supertest` drives a real socket. Fastify ships `light-my-request`, and the adapter exposes it as `app.inject()` — no port, no socket, faster and deterministic:

```ts title="test/orders.e2e-spec.ts"
import { FastifyAdapter } from '@nestjs/platform-fastify'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { AppModule } from '../src/app.module.js'

export async function bootstrapTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())

  await app.init()
  // Required: Fastify only finishes registering plugins and routes on ready().
  await app.getHttpAdapter().getInstance().ready()

  return app
}

export async function listOrders(app: NestFastifyApplication) {
  const response = await app.inject({ method: 'GET', url: '/orders' })
  return { status: response.statusCode, body: response.json() }
}
```

The `ready()` call is the step people miss. Without it, plugins registered during `init()` have not finished and routes are not yet resolvable, so every injection 404s.

## Is it worth it?

Fastify parses HTTP and serializes JSON faster than Express. That is a real, measurable difference in the framework layer, and it is also the smallest term in most applications' latency: a request that spends 40 ms in the database and 0.4 ms in the router does not get meaningfully faster when the router gets twice as fast. Benchmark numbers quoted in requests per second come from handlers that return a constant.

Where the difference does show up:

- **Very high request rates with trivial handlers** — gateways, proxies, health aggregators, token introspection endpoints.
- **Large JSON responses**, where Fastify's schema-driven serializer genuinely beats `JSON.stringify`.
- **CPU-bound cost per request** at the point where you are adding instances to absorb framework overhead rather than work.

Where it costs you:

- **A smaller, differently shaped plugin ecosystem.** Anything that only exists as Express middleware works through the compatibility layer or not at all.
- **Two path grammars in one codebase**, one for routes and one for middleware.
- **Fewer answers.** Most Nest questions on the internet assume the Express adapter, and so does most of this handbook — [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md) is the map of what is underneath the default.

The honest default: start on Express, profile, and move only if the framework is measurably in your way. The switch is genuinely cheap when your controllers never touched `@Req()` or `@Res()` — which is the strongest argument for not touching them.

## Common mistakes

- **Omitting the `NestFastifyApplication` type parameter.** `register`, `useStaticAssets`, `setViewEngine` and `inject` are not on `INestApplication`.
- **Calling `app.listen(3000)` in a container.** Fastify binds to localhost; pass `'0.0.0.0'` explicitly.
- **Reusing Express 5 path syntax.** Route paths go straight to `find-my-way`, which has a different grammar. A named splat is matched as a literal segment and the route silently never fires.
- **Assuming route order still decides.** It does not on a radix tree — specificity does.
- **Calling Express methods on the reply.** `reply.status().send()`, `reply.header()`; `res.json()` and `res.set()` do not exist.
- **`res.redirect(status, url)` argument order.** Fastify takes the URL first.
- **Using `@Res()` and forgetting to send.** Nest stops sending for you and the request hangs.
- **Expecting `FileInterceptor` to work.** It is multer, it lives in `@nestjs/platform-express`, and there is no Fastify equivalent in the platform package.
- **`app.use(helmet())` and friends.** The Express packages are not Fastify plugins; register the `@fastify/*` equivalents.
- **Not awaiting `app.register()`.** The plugin may not be in place when the first request arrives.
- **Passing a string to `setViewEngine()`.** The Express adapter accepts one; this one throws.
- **Forgetting `.ready()` in tests.** Routes are not registered yet and every `inject()` returns 404.
- **Adding a field to a DTO without updating a `@RouteSchema` response schema.** The serializer drops anything the schema does not declare.
- **Switching adapters for the benchmark numbers.** Measure your own p99 first; it is usually dominated by the database.

## Related topics

- [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md) — what the default adapter is doing, and which Express behaviour leaks through it.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — the path-to-regexp 8 grammar the Express adapter uses, and the conflict diagnostics.
- [Middleware](../nestjs-request-handling/middleware.md) — the `configure()` API the compatibility layer supports.
- [Guards](../nestjs-request-handling/guards.md) and [Interceptors](../nestjs-request-handling/interceptors.md) — the adapter-independent places most middleware belongs.
- [File uploads](../nestjs-request-handling/file-uploads.md) — the multer-based interceptors, and why they are Express-only.
- [File upload security](../nestjs-security/file-upload-security.md) — what you must enforce yourself when you read multipart parts by hand.
- [CORS](../nestjs-security/cors.md) — the threat model behind `enableCors()`, unchanged by the adapter.
- [Security headers](../nestjs-security/security-headers.md) — what `@fastify/helmet` is setting.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the supertest equivalent, and where `inject()` replaces it.
- [Performance](../nestjs-production/performance.md) — measuring before you decide the framework is the bottleneck.
- [WebSockets](websockets.md) — the other place the platform package choice shows through.
