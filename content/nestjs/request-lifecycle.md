---
title: The request lifecycle
description: The exact order a Nest 12 request passes through — middleware, guards, interceptors, pipes, handler, interceptors again, exception filters — where each stage can short-circuit, and where async errors surface.
status: current
updated: 2026-09-11
---

Every request through a Nest application walks the same fixed pipeline. Knowing the order is not trivia: it decides where authentication can read a parsed body, why a pipe cannot reject a request before a guard has run, and which stage an error was thrown from when a filter finally sees it. This page is the reference the rest of the NestJS sections point back to.

## The order

```text
incoming request
  │
  ├─ 1. middleware                (Express-level, sees req/res/next)
  ├─ 2. guards                    (may reject: 403)
  ├─ 3. interceptors — pre        (before next.handle())
  ├─ 4. pipes                     (transform + validate the handler's arguments)
  ├─ 5. route handler             (your controller method → service)
  ├─ 6. interceptors — post       (the RxJS operators after next.handle())
  │
  └─ 7. exception filters         (anything thrown in 1–6 that reached this far)
       │
       └─ response
```

| # | Stage | Sees | Can short-circuit by | Typical job |
| --- | --- | --- | --- | --- |
| 1 | **Middleware** | raw `req`, `res`, `next` | responding, or `next(err)` | request id, body parsing, CORS, helmet, logging |
| 2 | **Guards** | `ExecutionContext` | returning `false`, or throwing | authentication, authorization, rate limits |
| 3 | **Interceptors (pre)** | `ExecutionContext`, `CallHandler` | not calling `next.handle()`, or throwing | caching, timing, starting a span |
| 4 | **Pipes** | one argument + its metadata | throwing | parsing, coercion, DTO validation |
| 5 | **Handler** | the resolved arguments | throwing | one service call |
| 6 | **Interceptors (post)** | the result stream | mapping to a different value, or throwing | serialization, envelopes, timeouts |
| 7 | **Exception filters** | the exception + `ArgumentsHost` | always terminal | turning an error into a response |

Within each enhancer stage, registration scope decides order: **global → controller → route handler**. So a global guard runs before a `@UseGuards()` on the controller, which runs before a `@UseGuards()` on the method.

:::note
Interceptors are the only stage that runs **twice**. Everything before `return next.handle()` executes on the way in, at position 3; the RxJS operators you `.pipe()` onto that stream execute on the way out, at position 6, after the handler has resolved.
:::

## Why the order is what it is

Three of the adjacencies do real work, and they are the ones worth internalizing.

**Middleware before guards.** Middleware is Express's stack, running before Nest's routing has resolved which handler will serve the request. That is why middleware cannot know the controller or method it is running for, and why a guard — which receives an `ExecutionContext` carrying both — is the right place for anything that depends on route metadata. It is also why body parsing has to be middleware: a guard that reads `request.body` needs it already parsed.

**Guards before interceptors.** Rejecting an unauthenticated request should not first allocate a cache key, open a tracing span or start a timer. Guards are the cheap, terminal stage.

**Guards before pipes.** This one bites people. A request with a malformed body and a bad token returns **403, not 400** — the guard rejected it before the `ValidationPipe` ever ran. That is deliberate: validating a payload from an unauthenticated caller is work done on behalf of an attacker, and validation errors leak schema details. If you want the opposite behavior for a specific route, you have to validate inside the handler rather than reorder the pipeline.

## Where each stage can stop the request

```ts title="src/common/guards/api-key.guard.ts"
import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest()
    return request.headers['x-api-key'] === process.env.API_KEY
  }
}
```

A guard returning `false` produces a **403 Forbidden** with Nest's default message. That is almost never the response you want for a missing credential, so throw instead — the thrown exception is what the filter chain sees, and it carries your status and message:

```ts
import { UnauthorizedException } from '@nestjs/common'

if (!token) throw new UnauthorizedException('missing bearer token')
```

| Stage | How it stops the request | Resulting response |
| --- | --- | --- |
| Middleware | responds itself, or calls `next(err)` | whatever it wrote, or the filter chain's output |
| Guard | returns `false` | **403 Forbidden**, default body |
| Guard | throws | the thrown exception, via the filters |
| Interceptor (pre) | never calls `next.handle()` | whatever it returns instead — this is how caching works |
| Pipe | throws | typically **400 Bad Request** from `ValidationPipe` |
| Handler | throws | the thrown exception, via the filters |
| Interceptor (post) | throws, or maps the stream to an error | via the filters |

An interceptor that returns a value without calling `next.handle()` skips **pipes and the handler entirely**. That is the mechanism behind a cache interceptor, and the reason a stale cache can make a handler look like it is never called.

## Async errors

Every stage from 2 onward may be `async` or return an `Observable`, and Nest awaits it. A rejected promise anywhere in stages 2–6 is caught by the framework and routed to the exception filters — you never write `try`/`catch` to convert an error into a status code.

Stage 1 is the exception, because middleware is Express's, not Nest's. On Express 5 an `async` middleware that rejects is forwarded to the error handler automatically, so the behavior matches; what does not work is awaiting **after** calling `next()`:

```ts title="src/common/middleware/session.middleware.ts"
import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { SessionStore } from '../../sessions/session.store.js'

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  private readonly sessions: SessionStore

  constructor(sessions: SessionStore) {
    this.sessions = sessions
  }

  async use(request: Request, response: Response, next: NextFunction) {
    const session = await this.sessions.load(request.cookies.sid)   // await first
    Object.assign(request, { session })
    next()                                                          // next() last
  }
}
```

Await first, call `next()` last. A rejection after `next()` has already handed control onward has nowhere to go, and the response may already be sent. The underlying rule is Express's — see [Middleware](../express/middleware.md).

Two more async details worth knowing:

- **A promise returned by a handler is awaited before the post-interceptors run.** Interceptors see the resolved value, not the promise.
- **An error thrown inside a post-interceptor's RxJS operators** still reaches the filters, but the guard, pipe and handler have already run and any side effects they had are already committed. An interceptor is not a transaction boundary.

## Exception filters are the last stage, always

Filters run outside everything else. They catch exceptions thrown by guards, interceptors, pipes and handlers alike, which is why an `@Catch()` filter registered globally is the one place that can guarantee every error leaves as JSON your clients can parse.

```ts title="src/common/filters/all-exceptions.filter.ts"
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR

    response.status(status).json({
      statusCode: status,
      errorCode: exception instanceof HttpException ? exception.errorCode : undefined,
      message: exception instanceof HttpException ? exception.getResponse() : 'Internal server error',
    })
  }
}
```

`errorCode` is a real field on `HttpException` in Nest 12, populated from the `errorCode` option, and it is the clean way to give clients something stable to branch on without parsing the message.

Filter selection runs **narrowest first**: a method-level `@UseFilters()` wins over a controller-level one, which wins over a global filter. Within one level, the most specific `@Catch(SomeError)` that matches handles it.

:::warning
An exception thrown **inside an exception filter** is not caught by another filter. It falls through to the platform's default handler, which on Express means a bare 500 with no body you control. Keep filters free of anything that can throw — no database writes, no network calls to a logging service without a `catch`.
:::

## What runs when nothing matches a route

If no controller claims the path, stage 1 middleware still runs (it is mounted on the Express app), but stages 2–6 do not — there is no handler, so there are no route-scoped guards, pipes or interceptors to resolve. Nest's built-in handler produces a 404, which a global exception filter will see and can reshape.

This is why a global logging **interceptor** misses your 404s while a logging **middleware** catches them. Pick the stage by what you need to observe.

## Request-scoped providers

If anything in the resolved graph is request-scoped, its instantiation happens as part of this pipeline rather than at bootstrap — per request, for the whole chain above the scoped provider. That construction cost lands before the handler runs, on every request, including the ones a guard is about to reject. See [Injection scopes](injection-scopes.md).

## Common mistakes

- **Expecting a 400 for a bad body on a route with a failing guard.** Guards run first; the response is 403. Nothing is misconfigured.
- **Reading route metadata in middleware.** Routing has not resolved yet. Use a guard and `Reflector` with the `ExecutionContext`.
- **Returning `false` from a guard when you meant 401.** `false` is always 403. Throw `UnauthorizedException` instead.
- **Awaiting after `next()` in middleware.** The rejection has nowhere to land and the response may already be sent.
- **Assuming interceptors run once.** The pre half and the post half are the same class, in two different positions.
- **Treating an interceptor as a transaction boundary.** By the time the post half runs, the handler's writes have already happened.
- **Throwing from inside an exception filter.** Nothing catches it; you get the platform default 500.
- **Registering a global enhancer with `new` in `main.ts` when it has dependencies.** `app.useGlobalGuards(new RolesGuard())` bypasses the container — use the `APP_GUARD` token instead, see [Modules](modules.md).
- **Expecting a global interceptor to see 404s.** No handler resolved, so no interceptor ran. Use middleware or a global filter.

## Related topics

- [Middleware](../nestjs-request-handling/middleware.md) — stage 1, and how `MiddlewareConsumer` binds it to routes.
- [Guards](../nestjs-request-handling/guards.md) — stage 2, `CanActivate` and `Reflector`.
- [Interceptors](../nestjs-request-handling/interceptors.md) — stages 3 and 6, and the RxJS model.
- [Pipes](../nestjs-request-handling/pipes.md) — stage 4, transformation and validation.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — stage 7, in depth.
- [Controllers](controllers.md) — stage 5, and what its return value becomes.
- [Injection scopes](injection-scopes.md) — what per-request construction adds to this pipeline.
- [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md) — exercising each stage in isolation.
- [Middleware](../express/middleware.md) — the Express stack stage 1 actually is.
- [Error handling](../express/error-handling.md) — what happens underneath a Nest exception filter.
