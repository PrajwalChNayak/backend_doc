---
title: Express 4 → 5 for Nest routes
description: What the Express 5 and path-to-regexp 8 upgrade means inside NestJS 12 — every invalid route decorator and its replacement, middleware paths, and the req.body, req.query and req.host changes that reach your controllers.
status: legacy
updated: 2026-09-11
---

`@nestjs/platform-express@12.0.1` bundles `express` 5.2.1 and `path-to-regexp` 8.4.2, so the Express 4 → 5 upgrade is not something that happened next to Nest — it happened *inside* it. Route strings in `@Get()`, `@Controller()` and `forRoutes()` are compiled by the same matcher as a plain Express route, and the patterns Express 4 accepted now throw a `TypeError` while routes are being registered, killing the process at boot. This page is the decorator-shaped version of that upgrade.

:::note
The platform-level change is documented once, in full, in [Express 4 → 5 migration](../reference/express-4-to-5-migration.md), and the path grammar in [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md). This page does not repeat them — it covers what a Nest codebase has to edit, and the handful of places where Nest's defaults differ from bare Express 5.
:::

## The one-screen summary

| Before (Express 4 / Nest 11) | Nest 12 | Note |
| --- | --- | --- |
| `@Get('*')` | `@Get('{*splat}')` | the braces make it match the mount root too |
| `@Get('*')` for "any non-root URL" | `@Get('*splat')` | requires at least one segment |
| `@Get('files/*')` | `@Get('files/*path')` | `req.params.path` is an **array** |
| `@Get(':file.:ext?')` | `@Get(':file{.:ext}')` | the `.` goes **inside** the group |
| `@Get('books/:id?')` | `@Get('books{/:id}')` | the `/` goes **inside** the group |
| `@Get(':foo+')` | `@Get('*foo')` | one or more segments |
| `@Get(':foo*')` | `@Get('{*foo}')` | zero or more segments |
| `@Get('[discussion\|page]/:slug')` | `@Get(['discussion/:slug', 'page/:slug'])` | an array of paths |
| `@Get('product/(\\d+)')` | `@Get('product/:id')` + `ParseIntPipe` | inline regex groups are gone |
| `@Get('users/:user-id')` | `@Get('users/:"user-id"')` | names must be JS identifiers, or quoted |
| `()[]?+!` used literally | escape with `\\` | reserved characters |
| `consumer.apply(fn).forRoutes('*')` | `consumer.apply(fn).forRoutes('{*path}')` | middleware paths use the same matcher |

Every row in the left column throws at bootstrap. None of them 404s quietly, which is the one genuinely good thing about this upgrade: you find out on your machine.

## Finding them

Three greps catch nearly every path that will throw:

```bash
# an asterisk inside a route string
grep -rnE "@(Get|Post|Put|Patch|Delete|All|Options|Head|Search|Controller)\(\s*['\"\`][^'\"\`]*\*" src/

# a '?' immediately after a :param
grep -rnE "@(Get|Post|Put|Patch|Delete|All|Controller)\(\s*['\"\`][^'\"\`]*:[A-Za-z_][A-Za-z0-9_]*\?" src/

# a '(' or '[' anywhere in a path string
grep -rnE "@(Get|Post|Put|Patch|Delete|All|Controller)\(\s*['\"\`][^'\"\`]*[\(\[]" src/
```

Also grep `forRoutes(`, `exclude(` and `setGlobalPrefix(` — middleware and prefix paths go through the same compiler and are easy to forget.

## Catch-all routes

The most common break, and the one whose fix is most often subtly wrong.

:::legacy Express 4 / NestJS 11 — throws at bootstrap on Nest 12
```ts
import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'

@Controller()
export class SpaController {
  @Get('*')
  index(@Res() res: Response) {
    res.sendFile('index.html', { root: 'public' })
  }
}
```

```text
TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError
```
:::

```ts title="src/spa/spa.controller.ts"
import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'

@Controller()
export class SpaController {
  // '{*splat}' matches the mount root as well — this is the true catch-all.
  @Get('{*splat}')
  index(@Res() res: Response) {
    res.sendFile('index.html', { root: 'public' })
  }
}
```

`'*splat'` without braces is also valid, and it does **not** match `/`. For a single-page-app fallback or a 404 handler that is a bug you will not notice for weeks: every URL works except the root.

| Want | Write |
| --- | --- |
| catch-all including the mount root | `'{*splat}'` |
| catch-all excluding the mount root | `'*splat'` |

## Wildcard parameters are arrays

This is a runtime change, not a syntax one, and it does not throw — it hands your handler an array where you expected a string.

:::legacy Express 4 / NestJS 11 — a wildcard captured a slash-joined string
```ts
import { Controller, Get, Param } from '@nestjs/common'

@Controller('files')
export class FilesController {
  @Get('*')
  read(@Param('0') filePath: string) {
    // Express 4: req.params['0'] === 'reports/q3.pdf'
    return this.files.read(filePath)
  }
}
```
:::

```ts title="src/files/files.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'
import { FilesService } from './files.service.js'

@Controller('files')
export class FilesController {
  private readonly files: FilesService

  constructor(files: FilesService) {
    this.files = files
  }

  @Get('*path')
  read(@Param('path') segments: string[]) {
    // Nest 12: segments === ['reports', 'q3.pdf']
    return this.files.read(segments.join('/'))
  }
}
```

Two consequences worth stating separately:

- **`.startsWith()` on the parameter throws.** It is an array. So does anything else that assumed a string.
- **A joined wildcard can contain `..`.** Never hand it to the filesystem without resolving against a root and checking containment — see [Static files](../express/static-files.md) and [File upload security](../nestjs-security/file-upload-security.md).

`req.params` also has a **null prototype** for string paths, so `request.params.hasOwnProperty('id')` throws; use `Object.hasOwn(request.params, 'id')`. And unmatched parameters are **omitted entirely** rather than present as `undefined`, so `'ext' in request.params` and `Object.keys(request.params).length` both behave differently than they did.

## Optional segments and file extensions

There are no `?`, `+` or `*` suffix modifiers any more. Optionality is expressed as a group, and the group contains the separator.

:::legacy Express 4 / NestJS 11 — `?` is a reserved character in path-to-regexp 8
```ts
import { Controller, Get, Param } from '@nestjs/common'

@Controller()
export class AssetsController {
  @Get(':file.:ext?')
  serve(@Param('file') file: string, @Param('ext') ext?: string) {
    return this.assets.resolve(file, ext ?? 'png')
  }

  @Get('books/:id?')
  books(@Param('id') id?: string) {
    return id ? this.books.findOne(id) : this.books.list()
  }
}
```

```text
TypeError: Unexpected ? at 6, expected END: https://git.new/pathToRegexpError
```
:::

```ts title="src/assets/assets.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'
import { AssetsService } from './assets.service.js'

@Controller()
export class AssetsController {
  private readonly assets: AssetsService

  constructor(assets: AssetsService) {
    this.assets = assets
  }

  // Matches /avatar and /avatar.png — the '.' is inside the group.
  @Get(':file{.:ext}')
  serve(@Param('file') file: string, @Param('ext') ext?: string) {
    return this.assets.resolve(file, ext ?? 'png')
  }

  // Matches /books and /books/42 — the '/' is inside the group.
  @Get('books{/:id}')
  books(@Param('id') id?: string) {
    return id === undefined ? this.assets.list() : this.assets.findOne(id)
  }
}
```

Putting the separator outside the group is the classic mistake: `'books/{:id}'` requires the trailing slash and matches `/books/` but not `/books`.

## Arrays instead of inline regex

Regex-in-a-string is gone. Nest's route decorators accept `string | string[]` — and, unlike plain Express, there is **no `RegExp` overload** at all.

:::legacy Express 4 / NestJS 11 — both of these throw
```ts
import { Controller, Get, Param } from '@nestjs/common'

@Controller()
export class ContentController {
  @Get('[discussion|page]/:slug')
  show(@Param('slug') slug: string) {
    return this.content.bySlug(slug)
  }

  @Get('product/(\\d+)')
  product(@Param('0') id: string) {
    return this.products.findOne(Number(id))
  }
}
```

```text
TypeError: Unexpected [ at 0, expected END: https://git.new/pathToRegexpError
```
:::

```ts title="src/content/content.controller.ts"
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common'
import { ContentService } from './content.service.js'

@Controller()
export class ContentController {
  private readonly content: ContentService

  constructor(content: ContentService) {
    this.content = content
  }

  // Alternation becomes an array of paths.
  @Get(['discussion/:slug', 'page/:slug'])
  show(@Param('slug') slug: string) {
    return this.content.bySlug(slug)
  }

  // A numeric constraint becomes a pipe: match loosely, validate the value.
  @Get('product/:id')
  product(@Param('id', ParseIntPipe) id: number) {
    return this.content.product(id)
  }
}
```

Moving a regex constraint into a pipe is usually the better design anyway: a non-numeric id now returns a **400 with a message** instead of a 404 that looks like the product does not exist.

`@Controller({ path: ['v1', 'v2'] })` does the same thing at the prefix level.

## Escaping reserved characters

`(`, `)`, `[`, `]`, `?`, `+` and `!` are reserved. To match one literally, escape it with a backslash — doubled in a TypeScript string literal, because the literal consumes one.

:::legacy Express 4 / NestJS 11 — parentheses were a capture group
```ts
import { Controller, Get } from '@nestjs/common'

@Controller('reports')
export class ReportsController {
  @Get('(draft)')
  draft() {
    return this.reports.draft()
  }
}
```
:::

```ts title="src/reports/reports.controller.ts"
import { Controller, Get } from '@nestjs/common'
import { ReportsService } from './reports.service.js'

@Controller('reports')
export class ReportsController {
  private readonly reports: ReportsService

  constructor(reports: ReportsService) {
    this.reports = reports
  }

  // GET /reports/(draft)
  @Get('\\(draft\\)')
  draft() {
    return this.reports.draft()
  }
}
```

Parameter names must be valid JavaScript identifiers. Anything else has to be quoted: `@Get('users/:"user-id"')`, read back with `@Param('user-id')`.

## Middleware, prefixes and exclusions use the same matcher

The change is easy to miss because these paths are not on a route decorator.

:::legacy Express 4 / NestJS 11 — a bare asterisk in middleware configuration
```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { requestId } from './common/request-id.middleware.js'

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestId).forRoutes('*')
  }
}
```
:::

```ts title="src/app.module.ts"
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import { requestId } from './common/request-id.middleware.js'

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestId)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('{*path}')
  }
}
```

`setGlobalPrefix('api', { exclude: [...] })` takes the same kind of path. Exclude your probes: a liveness check that silently moves to `/api/health` is an outage that looks like a deploy failure.

## `req.body` is `undefined`, not `{}`

Express 5 leaves `req.body` `undefined` when no parser matched, where Express 4 gave you `{}`. Every unguarded destructure throws `TypeError: Cannot read properties of undefined`.

Nest softens this, and it is worth knowing exactly how much. `ExpressAdapter.registerParserMiddleware()` mounts **`express.json()`** and **`express.urlencoded({ extended: true })`** for you at bootstrap, unless you created the application with `{ bodyParser: false }`. So `req.body` is populated for JSON and form bodies without any configuration.

It is still `undefined` in three cases:

| Case | Why |
| --- | --- |
| `NestFactory.create(AppModule, { bodyParser: false })` | you turned the parsers off |
| A `Content-Type` neither parser matches — `text/plain`, `application/xml` | no parser claimed the request |
| A `GET` or `DELETE` with no body | nothing to parse |

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  // Override the defaults with an explicit limit, and add a parser Nest does
  // not mount. `useBodyParser` respects the application's rawBody option.
  app.useBodyParser('json', { limit: '100kb' })
  app.useBodyParser('urlencoded', { extended: true, limit: '100kb' })
  app.useBodyParser('text', { type: 'text/plain', limit: '32kb' })

  await app.listen(3000)
}

bootstrap()
```

:::note
Nest's default for `urlencoded` is **`extended: true`**, which is the *opposite* of bare Express 5's `extended: false`. If you are porting an application that relied on nested bracket syntax (`user[name]=ada`), it keeps working under Nest and stops working under plain Express 5 — which is confusing in exactly the direction that produces a wrong bug report.
:::

The real fix for any of this is not a guard in the handler, it is validation at the edge. A DTO plus a global `ValidationPipe` rejects a missing body with a 400 before your method runs — see [The ValidationPipe](../nestjs-validation/validation-pipe.md) and [DTOs](../nestjs-request-handling/dtos.md).

## `req.query` is a getter, and the default parser changed

`req.query` is no longer writable. Assigning to it, or to a key on it, silently fails or throws.

:::legacy Express 4 / NestJS 11 — mutating req.query was a common normalization trick
```ts
import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

@Injectable()
export class NormalizePaging implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction) {
    // No longer possible: req.query is a getter.
    request.query.page = String(Number(request.query.page) || 1)
    next()
  }
}
```
:::

In Nest the replacement is not another middleware — it is a pipe, which is the stage designed for exactly this:

```ts title="src/orders/dto/list-orders.dto.ts"
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'

export class ListOrdersDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page = 1

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20
}
```

```ts title="src/orders/orders.controller.ts"
import { Controller, Get, Query } from '@nestjs/common'
import { ListOrdersDto } from './dto/list-orders.dto.js'
import { OrdersService } from './orders.service.js'

@Controller('orders')
export class OrdersController {
  private readonly orders: OrdersService

  constructor(orders: OrdersService) {
    this.orders = orders
  }

  @Get()
  list(@Query() query: ListOrdersDto) {
    return this.orders.list(query.page, query.limit)
  }
}
```

The default query parser also changed from `'extended'` to `'simple'`, so `?a[b]=c` no longer produces a nested object. Opt back in through the Express settings if a client really sends that shape:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  app.set('query parser', 'extended')
  await app.listen(3000)
}

bootstrap()
```

Note the asymmetry with the body parser: Nest restores `extended: true` for **urlencoded bodies** but leaves the **query parser** at Express 5's `'simple'` default. Those are two different settings and Nest treats them differently.

## `req.host` now includes the port

Express 4 stripped the port from `req.host`, making it a confusing duplicate of `req.hostname`. Express 5 returns the real `Host` header.

:::legacy Express 4 / NestJS 11 — a host allow-list that silently stops matching
```ts
import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import type { Request } from 'express'

const ALLOWED = new Set(['app.example.com', 'admin.example.com'])

@Injectable()
export class HostGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>()
    // Express 5: 'app.example.com:8443' is not in the set.
    return ALLOWED.has(request.host)
  }
}
```
:::

```ts title="src/common/guards/host.guard.ts"
import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import type { Request } from 'express'

const ALLOWED = new Set(['app.example.com', 'admin.example.com'])

@Injectable()
export class HostGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>()
    // req.hostname never carries the port.
    return ALLOWED.has(request.hostname)
  }
}
```

`@Controller({ host: ':account.example.com' })` and `@HostParam()` use Nest's own host matching and are unaffected, but any hand-written comparison against `req.host` needs to move to `req.hostname`.

## The rest of Express 5, in Nest terms

These do not change how you write Nest code, but they change what the application does.

| Express 5 change | What it means inside Nest |
| --- | --- |
| Rejected promises reach the error handler automatically | An `async` controller method that throws reaches your exception filters. Nest already did this; there is nothing to remove. |
| `express.static()` defaults to `dotfiles: 'ignore'` | `app.useStaticAssets('public')` now returns **404** for `/.well-known/...`. Mount the dot-directory explicitly with `{ dotfiles: 'allow' }`. ACME certificate renewal is the usual casualty. |
| `res.redirect(status, url)` — argument order flipped | Use `@Redirect(url, statusCode)`, which takes them in that order and does not care. Hand-written `res.redirect()` calls under `@Res()` do. |
| `res.status()` accepts 100–999 only | A filter that passes an `undefined` status now throws instead of writing a nonsense status line. Default it before you pass it. |
| `res.clearCookie()` ignores `maxAge` / `expires` | `path`, `domain`, `secure` and `sameSite` must match the cookie that set it. Session logout code is the place to check. |
| `app.listen()` reports errors to the callback | `await app.listen(3000)` rejects, so an `EADDRINUSE` surfaces as an unhandled rejection unless `bootstrap()` catches it. |
| `.js` served as `text/javascript` | Tests asserting `Content-Type` on static assets fail. |
| Debug namespaces moved to `router`, `router:*` | `DEBUG=express:*,router,router:*` |
| Brotli request bodies are accepted | `limit` applies to the **decompressed** size, so keep an explicit one on every parser. |
| `multer` is 2.x | `@nestjs/platform-express@12.0.1` pins **2.2.0**. Never install multer yourself; multer 1.x is end of life and npm-deprecated. |

## The errors you will actually see

Both are thrown while routes are being registered, so the process dies at boot — before it listens, and out of reach of any exception filter.

```text
TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError
```

A `*` or `:` with no name after it. The number is the character offset inside the path string.

```text
TypeError: Unexpected [ at 1, expected END: https://git.new/pathToRegexpError
```

A reserved character used literally. Escape it, or express the intent with a group or an array of paths.

The stack trace points at the decorated method, so the offending controller is named. If it is not — because the path came from `forRoutes()` or `setGlobalPrefix()` — grep those next.

## You are done when

- The application boots with no `pathToRegexpError`.
- No route, `@Controller()` prefix, `forRoutes()`, `exclude()` or `setGlobalPrefix()` string contains a bare `*`, a `?` after a `:param`, or an unescaped `(`, `)`, `[`, `]`, `+` or `!`.
- Every catch-all that must serve the mount root uses `'{*splat}'`, not `'*splat'`.
- Every wildcard parameter is read as an array, and any filesystem path built from one is containment-checked.
- No code compares `req.host` against a bare hostname.
- No middleware assigns to `req.query` or one of its keys.
- Every handler that reads `req.body` directly tolerates `undefined`, or is replaced by a DTO plus a `ValidationPipe`.
- `curl -i /.well-known/acme-challenge/test` returns something other than 404, if you serve static assets and use ACME.
- Every `useBodyParser()` call has an explicit `limit`.
- One route test exists per HTTP method, run against the built artifact.

## Common mistakes

- **Porting `'*'` to `'*splat'` for a catch-all.** That leaves `GET /` unmatched, which is invisible until someone hits the root. Use `'{*splat}'`.
- **Treating a wildcard parameter as a string.** It is an array of segments; string methods throw.
- **Putting the separator outside the optional group.** `'books/{:id}'` matches `/books/` but not `/books`. The slash belongs inside: `'books{/:id}'`.
- **Fixing only the route decorators.** `forRoutes()`, `exclude()` and `setGlobalPrefix()` use the same matcher and are the ones people miss.
- **Expecting a `RegExp` overload on a route decorator.** Nest has none. Match loosely and validate in a pipe.
- **Assuming `req.body` is `{}`.** It is `undefined` when nothing parsed the request, even with Nest's default parsers mounted.
- **Assuming Nest's `urlencoded` default matches Express 5's.** It does not: Nest mounts `extended: true`, Express 5 defaults to `false`.
- **Assuming the query parser follows the body parser.** It does not: queries stay on Express 5's `'simple'` parser.
- **Comparing `req.host` to a bare hostname.** It carries the port now, so the check silently passes nothing — or everything, depending on which way you wrote it.
- **Setting `dotfiles: 'allow'` on the whole static root** to fix `/.well-known/`. That also serves a stray `.env` or `.git`. Mount the dot-directory explicitly.
- **Catching a path error in an exception filter.** It is thrown at registration; the process never reaches a request.

## Related topics

- [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) — the platform-level upgrade, in full, including the codemods.
- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the complete path-to-regexp 8 grammar.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — the decorator forms, plus Nest 12's route conflict diagnostics.
- [NestJS 11 → 12 migration](v11-to-v12-migration.md) — everything else in the framework upgrade.
- [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md) — why these changes reach your controllers at all.
- [Middleware](../nestjs-request-handling/middleware.md) — `forRoutes()`, `exclude()` and Express middleware inside Nest.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — the replacement for hand-guarded `req.body` and `req.query`.
- [Pipes](../nestjs-request-handling/pipes.md) — where a regex path constraint should live instead.
- [Static files](../express/static-files.md) — `dotfiles`, `root`, and serving a dot-directory safely.
- [Troubleshooting](troubleshooting.md) — these error strings indexed by symptom.
