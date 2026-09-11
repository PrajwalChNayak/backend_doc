---
title: Migrating incrementally
description: Mounting NestJS 12 inside a running Express 5 application, moving routes one at a time, sharing session and authentication, reusing Express middleware, and deciding when to stop migrating.
status: current
updated: 2026-09-11
---

You do not have to rewrite an Express application to adopt Nest. `ExpressAdapter` accepts an Express app you already built, so one process can serve legacy Express routes and Nest controllers at the same time, from the same server, sharing the same session store and the same database pool. This page is the strategy: how to mount it, how to move routes safely, what to share, and — the part most migration guides skip — how to recognize that you are finished even though half the routes never moved.

## The strategy in one paragraph

Stand Nest up next to the existing application rather than in front of it. Give it a URL prefix so the two route trees cannot collide. Move one route at a time, starting with the ones that already have a clean service layer, and delete the Express version in the same commit. Share session, authentication and the data layer from day one, so a migrated route behaves identically to the one it replaced. Stop when the remaining Express routes stop costing you anything.

## Mounting Nest inside an existing Express app

`new ExpressAdapter(server)` tells Nest to register its routes on **your** Express application instead of creating one.

```ts title="src/main.ts"
import http from 'node:http'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import { createLegacyApp } from '../legacy/app.js'

async function bootstrap() {
  // 1. The existing Express application, unchanged.
  const server = createLegacyApp()

  // 2. Nest registers its controllers onto that same app.
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server))
  app.setGlobalPrefix('api/v2')
  await app.init()

  // 3. One HTTP server, both route trees.
  http.createServer(server).listen(Number(process.env.PORT ?? 3000))
}

bootstrap()
```

Note `app.init()` rather than `app.listen()`. `init()` builds the container, registers routes and runs the lifecycle hooks but does not bind a socket; you keep control of the server, which is what lets the legacy application's own `listen` configuration — keep-alive timeouts, TLS, graceful shutdown — stay exactly as it was.

### Why the global prefix is not optional

`app.init()` registers two things beyond your controllers: an exception handler and a **not-found handler**. Without a prefix, that not-found handler is mounted at the end of the Express stack and answers every unmatched request with a Nest `404`. Anything you mount on `server` *after* `init()` is unreachable.

With a prefix, the behavior changes in exactly the way you need. Nest mounts its 404 as a router scoped to the prefix, and requests whose path does not begin with that prefix fall straight through to the rest of the stack.

| Setup | What happens to a request Nest does not handle |
| --- | --- |
| No `setGlobalPrefix()` | Nest's 404 catches it. Routes added to `server` after `init()` never run. |
| `setGlobalPrefix('api/v2')` | Only `/api/v2/...` reaches Nest's 404. Everything else continues down the Express stack. |

So: **give Nest a prefix, and the mounting order stops being a trap.** If you cannot introduce a prefix — the URLs are a public contract — register every legacy route on `server` *before* calling `NestFactory.create()`, and accept that new Express routes have to be added above that line.

:::warning
Verify this on day one with a route that only the legacy app serves. `curl -i http://localhost:3000/legacy/health` returning a Nest-shaped `{"message":"Cannot GET /legacy/health","statusCode":404}` is the symptom of a missing prefix or a mounting-order mistake, and it is much easier to diagnose on an empty Nest app than after twenty controllers.
:::

## Choosing the first route

Do not start with the most important endpoint, and do not start with the worst one. Start with the one that teaches you the most for the least risk:

| Good first candidate | Why |
| --- | --- |
| A read-only `GET` with a clean service function behind it | The service moves unchanged; only the HTTP shell is new. |
| An endpoint with an existing integration test | You get a behavioral diff for free. |
| Something already using validation | Proves the DTO and pipe story before anything writes to the database. |
| Low traffic, internal consumers | A wrong response shape is a ticket, not an incident. |

| Bad first candidate | Why |
| --- | --- |
| The login endpoint | Session and cookie semantics are the hardest thing to get identical. |
| A file upload | multer configuration, limits and streaming all at once. |
| Anything with a raw-body signature check | Needs `rawBody: true` and parser ordering you have not learned yet. |
| The busiest write path | If the shapes differ by one field you find out in production. |

## Moving a route

The shape of the work is always the same: the Express handler's *body* becomes a service method (if it is not one already), and a controller replaces the routing and response handling.

Before — the Express version:

```js title="legacy/users/users.router.js"
import { Router } from 'express'
import { usersService } from './users.service.js'

export const usersRouter = Router()

usersRouter.get('/:id', async (req, res) => {
  const user = await usersService.findById(req.params.id)
  if (!user) return res.status(404).json({ error: 'user not found' })
  res.json(user)
})
```

After — the Nest version, wrapping the *same* service:

```ts title="src/users/users.controller.ts"
import { Controller, Get, NotFoundException, Param } from '@nestjs/common'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.users.findById(id)
    if (!user) throw new NotFoundException('user not found')
    return user
  }
}
```

Four rules that keep the diff honest:

1. **Move the HTTP shell, not the logic.** If you are rewriting business rules in the same commit, you no longer know which change broke the behavior.
2. **Wrap the existing module rather than rewriting it.** A legacy singleton becomes a provider through a factory — see the next section.
3. **Delete the Express route in the same commit.** Two implementations of one endpoint is the state you cannot roll back from cleanly.
4. **Keep the response body byte-identical** unless you are deliberately versioning. Nest's default error body is `{ message, statusCode }`, which is probably not what your legacy error middleware produced.

### Wrapping a legacy module as a provider

You do not need to convert a legacy CommonJS-era module into an `@Injectable()` class to inject it. A factory provider adapts anything:

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'
import { usersService as legacyUsers } from '../../legacy/users/users.service.js'

@Module({
  controllers: [UsersController],
  providers: [{ provide: UsersService, useFactory: () => legacyUsers }],
})
export class UsersModule {}
```

The controller injects `UsersService` and does not know it received the legacy object. When you later rewrite the service properly, you change one line in this module and nothing else. That is the seam the whole migration hangs on — see [Dependency injection](../nestjs/dependency-injection.md) for the provider forms.

### Matching the error shape

Nest's built-in exceptions produce `{ message, statusCode }`. If your Express error middleware produced something else, clients will notice the day you migrate a route that can fail. Fix it once, globally, with a filter that emits the legacy shape:

```ts title="src/common/filters/legacy-error.filter.ts"
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'

@Catch()
export class LegacyErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
    const message =
      exception instanceof HttpException ? exception.message : 'Internal Server Error'

    // The shape the legacy Express error middleware produced.
    response.status(status).json({ error: message })
  }
}
```

Register it globally in `main.ts` with `app.useGlobalFilters(new LegacyErrorFilter())`, and every migrated route answers the way its predecessor did. Delete it when the last consumer has moved to the new shape — not before. See [Exception filters](../nestjs-request-handling/exception-filters.md).

## Sharing session and authentication

This is where migrations actually fail, so do it before you move a single authenticated route.

Because both halves are one Express application, session middleware mounted on the shared `server` populates `req.session` for Nest controllers too. Mount it on the legacy app, before `NestFactory.create()`:

```js title="legacy/app.js"
import express from 'express'
import session from 'express-session'
import { RedisStore } from 'connect-redis'
import { redis } from './redis.js'

export function createLegacyApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '100kb' }))
  app.use(
    session({
      store: new RedisStore({ client: redis }),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86_400_000 },
    }),
  )
  return app
}
```

A Nest controller then reads it with the `@Session()` parameter decorator, which is just `req.session`:

```ts title="src/account/account.controller.ts"
import { Controller, Get, Session, UnauthorizedException } from '@nestjs/common'
import { AccountService } from './account.service.js'

@Controller('account')
export class AccountController {
  private readonly account: AccountService

  constructor(account: AccountService) {
    this.account = account
  }

  @Get()
  me(@Session() session: Record<string, unknown>) {
    const userId = session.userId
    if (typeof userId !== 'string') throw new UnauthorizedException()
    return this.account.profile(userId)
  }
}
```

Reading the session directly is fine for two or three routes. Past that, put it behind a guard so authorization is declarative and testable:

```ts title="src/common/guards/session.guard.ts"
import { CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'

@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { session?: { userId?: string } }>()
    if (!request.session?.userId) throw new UnauthorizedException()
    return true
  }
}
```

Three rules for the shared-auth phase:

- **One session store, one secret, one cookie name.** Two `express-session` instances on the same app is a bug that looks like random logouts.
- **Mount session middleware before Nest initializes,** so it is upstream of every route in both trees.
- **Do not migrate login and session-reading in the same change.** Move the readers first, while the legacy login is still writing the session; move login last, when nothing else is changing.

The same applies to a JWT setup: the legacy verification middleware keeps running and keeps attaching `req.user`, and a Nest guard reads it. Converting to `@nestjs/passport` or `@nestjs/jwt` is a separate, later migration — see [Authentication](../nestjs-libraries/authentication.md).

## Reusing Express middleware inside Nest

Nest runs on Express, so none of your middleware needs rewriting. Choose the narrowest mount point that works.

| You want it to run for | Use |
| --- | --- |
| Every request in the process, legacy and Nest | `app.use(fn)` on the legacy Express app, before `NestFactory.create()` |
| Every Nest route only | `app.use(fn)` on the `INestApplication`, in `main.ts` |
| Specific Nest controllers or paths | `consumer.apply(fn).forRoutes(...)` in a module's `configure()` |

```ts title="src/app.module.ts"
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { requestId } from '../legacy/middleware/request-id.js'
import { tenantResolver } from '../legacy/middleware/tenant.js'
import { OrdersController } from './orders/orders.controller.js'
import { OrdersModule } from './orders/orders.module.js'

@Module({ imports: [OrdersModule] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestId).forRoutes('*path')
    consumer.apply(tenantResolver).forRoutes(OrdersController)
  }
}
```

`apply()` accepts a plain `(req, res, next)` function, so the legacy middleware is used verbatim. Rewrite it as a Nest class only when it needs an injected dependency — that is the one thing a plain function cannot do.

:::note
`forRoutes('*path')` uses path-to-regexp 8 syntax, because middleware paths go through the same matcher as route paths. The bare `'*'` that Express 4 accepted throws at bootstrap. See [Routing and path syntax](../nestjs/routing-and-path-syntax.md).
:::

## Sharing the data layer

Share the connection, not the code that uses it. One pool per process is the rule that matters — two pools means twice the connections against the same `max_connections` limit, and the failure shows up as intermittent timeouts under load rather than as an error.

```ts title="src/database/database.module.ts"
import { Global, Module } from '@nestjs/common'
import { pool } from '../../legacy/db.js'

export const PG_POOL = 'PG_POOL'

@Global()
@Module({
  providers: [{ provide: PG_POOL, useValue: pool }],
  exports: [PG_POOL],
})
export class DatabaseModule {}
```

The legacy application keeps importing `pool` directly; Nest providers inject `PG_POOL`. Both hand out the same object, so a transaction started in one half is visible to the other. Replacing the pool with a properly managed provider — or an ORM module — is a later step, and this token is what makes it a one-file change. See [Connections and DI](../nestjs-databases/connections-and-di.md).

:::warning
Graceful shutdown now has two owners. Whichever half closes the pool must be the last thing to run, and Nest's shutdown hooks only fire if you called `app.enableShutdownHooks()`. Decide explicitly which side drains the process, and delete the other one's signal handlers — see [Graceful shutdown](../nestjs-production/graceful-shutdown.md).
:::

## Testing during the migration

Keep the existing suite running against the whole process, not against one half.

- **End-to-end tests keep pointing at the same base URL** and should not care which framework answered. If a test has to change when a route moves, it was asserting on an implementation detail — fix the test first, then migrate.
- **Add a Nest e2e suite** with `Test.createTestingModule()` for the migrated routes, but do not delete the old integration tests until the route has been in production for a release.
- **Assert on the error body** in at least one test per migrated route. Error shape drift is the defect this migration produces most often, and it is invisible to a happy-path test.
- **Run both suites in the same CI job.** Two green pipelines that never run together will disagree about which routes exist.

See [End-to-end tests](../nestjs-testing/e2e-tests.md).

## How to know when to stop

The goal is not "no Express routes left". It is "no Express routes that cost anything". Stop migrating a route when all of these are true:

- It has **no business logic** worth isolating — a redirect, a static file, a health probe, a webhook that writes one row.
- It is **not changing**. A route nobody has edited in a year is not paying interest.
- It does **not share cross-cutting concerns** with the Nest half. If it needs the same authorization rules, tenant scoping or audit logging, it is cheaper inside.
- Its tests pass and nobody is confused by it.

Conversely, keep going while any of these is true:

- A rule is implemented **twice**, once in each half. Duplicated business logic is the real cost of a stalled migration.
- A new feature spans both halves, so every change is two changes.
- New joiners have to learn two layouts to do one task.
- The legacy half blocks something you want globally — versioning, OpenAPI generation, a global validation pipe.

:::best-practice
Write the stopping condition down when you start, and re-read it every few months. A migration with no defined end becomes a permanent tax: two conventions, two test setups, two code-review standards. "We will migrate the rest eventually" has a much worse expected cost than "these eleven routes stay in Express, and here is why".
:::

When you do finish, the last steps are mechanical: drop `new ExpressAdapter(server)` for a plain `NestFactory.create(AppModule)`, move any remaining shared middleware to `app.use()` in `main.ts`, remove the global prefix if the URLs allow it, and delete the legacy error filter once every consumer accepts the standard body.

## Common mistakes

- **Mounting Nest without a global prefix.** Its not-found handler sits at the end of the Express stack and swallows everything registered after `init()`.
- **Calling `app.listen()` on the Nest application.** You want `app.init()` plus your own `http.createServer(server).listen()`, or you get two servers and one of them is not the one you configured.
- **Migrating a route without deleting the Express version.** Two live implementations, one of which is unreachable, and no way to tell which answered in production.
- **Rewriting business logic while moving the HTTP shell.** When behavior changes you cannot tell which half of the commit did it.
- **Two session middlewares, or two secrets.** Users are logged out at random, and the pattern only appears under load balancing.
- **Two database pools.** Connection exhaustion that looks like a slow database.
- **Letting Nest's default error body ship silently.** `{ message, statusCode }` is not what your legacy middleware produced, and clients parse error bodies.
- **Porting middleware paths verbatim.** `forRoutes('*')` throws at bootstrap under path-to-regexp 8; it is `'*path'` or `'{*path}'` now.
- **Rewriting middleware as Nest classes for its own sake.** Only worth it when the middleware needs an injected dependency.
- **Leaving both halves' shutdown handlers installed.** The process either exits before draining or never exits at all.
- **Treating "finish the migration" as the success condition.** The success condition is that changes are cheap. Some routes are already cheap where they are.

## Related topics

- [How Nest uses Express](how-nest-uses-express.md) — what `ExpressAdapter` does with the app you pass it.
- [The comparison](comparison.md) — whether this migration is worth starting.
- [When plain Express is better](when-plain-express-is-better.md) — the routes you should deliberately leave behind.
- [Dependency injection](../nestjs/dependency-injection.md) — factory providers, tokens, and the wrapping seam.
- [Middleware](../nestjs-request-handling/middleware.md) — `configure()` and `MiddlewareConsumer` in detail.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — matching a legacy error shape.
- [Guards](../nestjs-request-handling/guards.md) — turning shared session checks into declarative authorization.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — one pool, injected properly.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — deciding which half owns the signals.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the suite that has to stay green across the seam.
- [Routing and path syntax](../nestjs/routing-and-path-syntax.md) — the path grammar both halves now share.
