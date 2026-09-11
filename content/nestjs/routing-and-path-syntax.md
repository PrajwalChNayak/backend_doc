---
title: Routing and path syntax
description: How Nest 12 compiles route decorators with path-to-regexp 8 on Express 5 — wildcards, optional segments, arrays of paths, escaping, route ordering, and the new route-conflict diagnostics.
status: current
updated: 2026-09-11
---

`@nestjs/platform-express@12.0.1` bundles `express@5.2.1` and `path-to-regexp@8.4.2`, so the string inside `@Get()` is compiled by exactly the same matcher as a plain Express 5 route. Every path rule from Part 1 applies here unchanged — and the patterns that Express 4 accepted now throw a `TypeError` at bootstrap rather than failing at request time. Nest 12 also ships opt-in diagnostics that tell you when two routes collide, which is the first framework-level answer to a class of bug that used to be silent.

## The underlying grammar

The mechanics of path-to-regexp 8 — parameter names, wildcards, optional groups, escaping, what `req.params` contains — are covered once in [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md). Read that page for the grammar. This page covers the decorator forms and what Nest adds on top.

The short version:

| Construct | Meaning | Nest example | Matches |
| --- | --- | --- | --- |
| `:name` | one segment, captured | `@Get('books/:id')` | `/books/42` |
| `*name` | one or more segments, captured as an **array** | `@Get('files/*path')` | `/files/a/b.txt` |
| `{ … }` | an optional group | `@Get('books{/:id}')` | `/books` and `/books/42` |
| `\` | escape the next character | `@Get('reports/\\(draft\\)')` | `/reports/(draft)` |

`(`, `)`, `[`, `]`, `?`, `+` and `!` are **reserved**. Used literally they throw; escape them with a backslash (doubled in a TypeScript string literal).

## The decorator forms

### Catch-all routes

```ts title="src/spa/spa.controller.ts"
import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'

@Controller()
export class SpaController {
  // Matches /anything and /a/b/c, but NOT the root path.
  @Get('*splat')
  deep(@Res() res: Response) {
    res.sendFile('index.html', { root: 'public' })
  }
}
```

```ts
import { Controller, Get } from '@nestjs/common'

@Controller()
export class FallbackController {
  // Matches the root path as well — this is the true catch-all.
  @Get('{*splat}')
  anything() {
    return this.pages.render()
  }
}
```

The braces are the whole difference, and getting it wrong is a subtle bug: with the unbraced form, every URL works except `/`. For a single-page-app fallback or a 404 handler you want `'{*splat}'`.

`req.params.splat` is an **array** of segments, not a slash-joined string. Read it with `@Param('splat')` and join it yourself when you need a path — and never hand the joined value to the filesystem without resolving it against a root and checking containment.

```ts
import { Controller, Get, Param } from '@nestjs/common'

@Controller('files')
export class FilesController {
  @Get('*path')
  read(@Param('path') segments: string[]) {
    return this.files.read(segments.join('/'))
  }
}
```

### Optional segments and file extensions

There are no `?`, `+` or `*` suffix modifiers any more. Optionality is a group.

```ts title="src/books/books.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'

@Controller()
export class BooksController {
  // Matches /books and /books/42
  @Get('books{/:id}')
  list(@Param('id') id?: string) {
    return id === undefined ? this.books.list() : this.books.findOne(id)
  }

  // Matches /avatar and /avatar.png
  @Get(':file{.:ext}')
  serve(@Param('file') file: string, @Param('ext') ext?: string) {
    return this.assets.resolve(file, ext ?? 'png')
  }
}
```

The group is the whole optional unit — the `.` and the `:ext` together. An unmatched parameter is **omitted** from `req.params` entirely rather than present as `undefined`, so `'ext' in request.params` and `Object.keys()` behave differently than they did on Express 4.

### Several paths for one handler

Regex-in-a-string is gone. Every route decorator accepts `string | string[]`, so pass an array:

```ts
import { Controller, Get, Param } from '@nestjs/common'

@Controller()
export class ContentController {
  @Get(['discussion/:slug', 'page/:slug'])
  show(@Param('slug') slug: string) {
    return this.content.bySlug(slug)
  }
}
```

This is checked at bootstrap, reads better than an alternation, and is what `@Controller({ path: ['v1', 'v2'] })` does at the prefix level too.

:::note
Nest's route decorators take `string | string[]` only — there is no `RegExp` overload the way plain Express has one. When the grammar genuinely cannot express a pattern, match loosely with a parameter and validate the value in a pipe. That is usually the better design anyway, because a rejected value gets a clear 400 instead of a 404.
:::

### Escaping reserved characters

```ts
import { Controller, Get } from '@nestjs/common'

@Controller('reports')
export class ReportsController {
  // Literal parentheses in a path: GET /reports/(draft)
  @Get('\\(draft\\)')
  draft() {
    return this.reports.draft()
  }
}
```

The backslash is doubled because the TypeScript string literal consumes one. path-to-regexp sees a single backslash.

## Express 4 → Nest 12

Every pattern in the "before" column throws at bootstrap on Nest 12. The process dies with a stack trace pointing at the decorated method and a message ending in `https://git.new/pathToRegexpError`.

:::legacy
These are the Express 4 / NestJS 11 spellings. They are shown here only so you can recognize them in a codebase you are upgrading — none of them boot on Nest 12.

| Before (Nest 11 / Express 4) | Why it breaks |
| --- | --- |
| `@Get('*')` | a `*` with no name; `Missing parameter name at 1` |
| `@Get('files/*')` | same |
| `@Get(':file.:ext?')` | `?` is a reserved character |
| `@Get('books/:id?')` | same |
| `@Get('[discussion\|page]/:slug')` | `[` and `]` are reserved; inline alternation is gone |
| `@Get('product/(\\d+)')` | inline regex groups are gone |
| `@Get('users/:user-id')` | `-` is not valid in an unquoted parameter name |
:::

| After (Nest 12) | Note |
| --- | --- |
| `@Get('{*splat}')` | also matches the mount root |
| `@Get('*splat')` | requires at least one segment |
| `@Get('files/*path')` | `path` is an array of segments |
| `@Get(':file{.:ext}')` | the `.` goes inside the group |
| `@Get('books{/:id}')` | the `/` goes inside the group |
| `@Get(['discussion/:slug', 'page/:slug'])` | an array of paths |
| match loosely, validate in a pipe | e.g. `@Get('product/:id')` with `ParseIntPipe` |
| `@Get('users/:"user-id"')` | quoted parameter name |

:::tip
Upgrading? Three greps find nearly every path that will throw: an asterisk inside a route string, a `?` immediately after a `:param`, and a `(` or `[` anywhere in a path.
:::

The full upgrade context — including the middleware and `req`/`res` changes that come with Express 5 — is in [Express 4 → 5 for Nest routes](../nestjs-reference/express-4-to-5-for-nest.md).

## `@Controller()` prefixes

The controller prefix is joined to each method's path. There is no leading slash on either part by convention; Nest inserts the separator.

```text
@Controller('orders')        prefix   /orders
  @Get()                     GET      /orders
  @Get(':id')                GET      /orders/:id
  @Post(':id/refund')        POST     /orders/:id/refund
```

The prefix participates in path-to-regexp exactly like the rest, so it can carry parameters and it obeys the same reserved-character rules:

```ts
import { Controller, Get, Param } from '@nestjs/common'

@Controller('tenants/:tenantId/orders')
export class TenantOrdersController {
  @Get(':id')
  findOne(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.orders.findOne(tenantId, id)
  }
}
```

Three ways to add a prefix to many controllers at once, in increasing order of reach:

| Mechanism | Scope | Notes |
| --- | --- | --- |
| `@Controller({ path: […] })` | one controller | accepts an array of prefixes |
| `RouterModule.register([…])` from `@nestjs/core` | a module's controllers | declarative, supports nested `children` |
| `app.setGlobalPrefix('api')` | every route | takes an `exclude` list for health probes |

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] })
  await app.listen(3000)
}

bootstrap()
```

Exclude your probes. A liveness check that moves to `/api/health` because someone added a global prefix is an outage that looks like a deploy failure.

## Route ordering

Express matches in **registration order**, first match wins, and Nest registers routes in the order modules are resolved and methods are declared. That makes ordering a real concern:

```ts
import { Controller, Get } from '@nestjs/common'

@Controller('users')
export class UsersController {
  @Get('me')          // declared first — wins for GET /users/me
  me() {}

  @Get(':id')         // would otherwise swallow /users/me with id === 'me'
  findOne() {}
}
```

Put literal paths before parametric ones, and parametric before wildcards. Within one controller that is just declaration order. **Across** controllers it depends on module resolution order, which is not something you should be reasoning about — and that is exactly the problem Nest 12's two new options address.

## Route conflict diagnostics (v12, opt-in)

Two new `NestApplicationOptions` fields turn silent route collisions into boot-time output. Both default to off, so existing applications are unaffected until you ask.

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    routeConflictPolicy: { duplicate: 'error', shadow: 'warn' },
    routeResolutionStrategy: 'specificity',
  })
  await app.listen(3000)
}

bootstrap()
```

### The verified types

```ts
type RouteConflictPolicyLevel = 'off' | 'warn' | 'error'

interface RouteConflictPolicy {
  duplicate?: RouteConflictPolicyLevel
  shadow?: RouteConflictPolicyLevel
}

type RouteResolutionStrategy = 'declaration' | 'specificity'
```

Each conflict kind defaults to `'off'`. `routeResolutionStrategy` defaults to `'declaration'`.

### `duplicate` versus `shadow`

These are two genuinely different problems, which is why they have separate levels.

| Kind | Definition | Example | What it means |
| --- | --- | --- | --- |
| `duplicate` | an identical **(method, path, host, version)** registration | `@Get('users/:id')` declared in two controllers | one of them is dead code — the second registration can never be reached |
| `shadow` | two patterns that **can match the same request** | `@Get('users/me')` and `@Get('users/:id')` | whichever is registered first wins; the other may be unreachable for some inputs |

A `duplicate` is always a bug. Two handlers claiming exactly the same method, path, host and version means one of them will never run, and which one depends on module resolution order — so a refactor that reorders imports silently changes behavior. `duplicate: 'error'` is the setting to reach for; it fails the boot instead of shipping a dead endpoint.

A `shadow` is a *design* that may or may not be correct. `/users/me` before `/users/:id` is exactly right; `/users/:id` before `/users/me` means `GET /users/me` is handled as a lookup for a user whose id is the string `me`. Because the correct case is common and deliberate, `shadow: 'warn'` is the sensible level — you want to see the list at boot and check it, not fail on it.

### `routeResolutionStrategy: 'specificity'`

By default (`'declaration'`) routes are registered on the Express adapter in the order you declared them, which is what makes the ordering rule above matter.

`'specificity'` registers literal segments ahead of parametric and wildcard ones on order-sensitive adapters such as Express. With it enabled, `@Get('users/me')` wins over `@Get('users/:id')` regardless of which was declared first or which module loaded first.

The two options work together: with specificity sorting active, Nest drops shadow conflicts that the sort has already resolved, so `shadow: 'warn'` reports only the overlaps that specificity could **not** fix. Turning both on gives you "fix the fixable automatically, warn about the rest".

:::best-practice
Turn these on in development and CI first, read what they report, and only then decide the production levels. `routeConflictPolicy: { duplicate: 'error', shadow: 'warn' }` is a good long-term default — duplicates are always wrong, shadows usually are not.
:::

:::warning
`routeResolutionStrategy: 'specificity'` changes the order your routes are registered in, which can change which handler serves a request in an application that was relying on declaration order. That is the point, but it means it is a behavior change, not a diagnostic. Enable it deliberately, with route tests, rather than as part of a version bump.
:::

## Host-based routing and versions

`@Controller()` also takes `host` and `version`, and both participate in what counts as a duplicate:

```ts
import { Controller, Get, HostParam } from '@nestjs/common'

@Controller({ host: ':account.example.com', path: 'orders' })
export class TenantOrdersController {
  @Get()
  list(@HostParam('account') account: string) {
    return this.orders.listForAccount(account)
  }
}
```

`host` accepts a string, a `RegExp`, or an array of either, and `@HostParam()` reads parameters captured from it. Versioning has its own page: [Versioning](../nestjs-request-handling/versioning.md).

## The errors you will actually see

path-to-regexp throws while the route is being registered, so the process dies at boot rather than serving a broken route.

```text
TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError
```

A `*` or `:` with no name after it. The number is the character offset inside the path string.

```text
TypeError: Unexpected [ at 1, expected END: https://git.new/pathToRegexpError
```

A reserved character used literally. Escape it, or express the intent with a group or an array of paths.

Both are startup errors. They cannot be caught by an exception filter, and a bad path takes the process down before it listens — which is the behavior you want, because you find it on your machine rather than in traffic.

## Common mistakes

- **Using the unbraced wildcard as a catch-all.** `'*splat'` does not match the mount root, so `GET /` falls through while every other URL works. Use `'{*splat}'`.
- **Treating a wildcard parameter as a string.** It is an array of segments; `.startsWith()` on it throws.
- **Porting Express 4 path syntax verbatim.** The bare asterisk, the trailing `?` on a parameter and inline regex all throw at bootstrap now.
- **Declaring `:id` before a literal sibling.** `/users/:id` above `/users/me` makes `me` a user id. Reorder, or turn on `routeResolutionStrategy: 'specificity'`.
- **Assuming cross-controller ordering is stable.** It follows module resolution order. Use specificity sorting or make the paths unambiguous.
- **Leaving the conflict policy off because "we would have noticed".** Duplicates are invisible by construction — the shadowed handler simply never runs.
- **Turning on `specificity` in a hotfix.** It reorders registration and can change which handler serves a request. Ship it with route tests.
- **A global prefix without `exclude`.** Health and metrics endpoints move, and the orchestrator starts restarting healthy pods.
- **Building a filesystem path from a wildcard parameter.** It can contain `..`. Resolve against a root and verify containment — see [Static files](../express/static-files.md).
- **Expecting a `RegExp` overload on a route decorator.** There is none. Match loosely and validate in a pipe.

## Related topics

- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the path-to-regexp 8 grammar in full, with `req.params` semantics.
- [Controllers](controllers.md) — the decorators these paths live on.
- [The request lifecycle](request-lifecycle.md) — what runs once a route matches.
- [Pipes](../nestjs-request-handling/pipes.md) — validating a loosely matched parameter instead of encoding the rule in the path.
- [Versioning](../nestjs-request-handling/versioning.md) — the `version` half of a route's identity.
- [Express 4 → 5 for Nest routes](../nestjs-reference/express-4-to-5-for-nest.md) — the whole upgrade, not just paths.
- [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md) — what the adapter does with these registrations.
- [Installation and the CLI](installation-and-cli.md) — where the pinned `path-to-regexp` version comes from.
- [Static files](../express/static-files.md) — safe handling of wildcard paths that reach the filesystem.
- [Troubleshooting](../nestjs-reference/troubleshooting.md) — boot errors by symptom.
