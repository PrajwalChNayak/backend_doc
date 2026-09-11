---
title: Interceptors
description: NestInterceptor and CallHandler in NestJS 12 — the RxJS operators that shape responses, add timing, caching and timeouts, and how StreamableFile leaves the pipeline.
status: current
updated: 2026-09-11
---

An interceptor is the only stage of the Nest pipeline that runs on both sides of the handler. Everything before `return next.handle()` executes on the way in; the RxJS operators you attach to that stream execute on the way out, after the handler has resolved. That gives you one class that can time a request, wrap its response, retry it, cancel it, or replace it entirely without ever calling the handler.

## Why it exists

Guards answer yes or no. Pipes transform one argument. Filters only see failures. Nothing else in the pipeline can observe a successful response — and response shaping, timing, caching and serialization all need exactly that.

The mechanism is RxJS. `next.handle()` returns an `Observable` of whatever the handler produced (a promise is awaited first, so you see the resolved value), and your `intercept()` returns an `Observable` that Nest subscribes to. See [The request lifecycle](../nestjs/request-lifecycle.md) for positions 3 and 6.

## Basic example

```ts title="src/common/interceptors/timing.interceptor.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { tap } from 'rxjs/operators'

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimingInterceptor.name)

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = process.hrtime.bigint()
    const handler = `${context.getClass().name}.${context.getHandler().name}`

    return next.handle().pipe(
      tap({
        next: () => this.log(handler, startedAt, 'ok'),
        error: () => this.log(handler, startedAt, 'error'),
      }),
    )
  }

  private log(handler: string, startedAt: bigint, outcome: string) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    this.logger.log(`${handler} ${outcome} ${ms.toFixed(1)}ms`)
  }
}
```

The `tap({ next, error })` form matters: a bare `tap(fn)` only fires on success, so a failing handler would never be timed. An interceptor that only measures the happy path hides exactly the requests you care about.

## The contract

```ts
interface NestInterceptor<T = any, R = any> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<R> | Promise<Observable<R>>
}

interface CallHandler<T = any> {
  handle(): Observable<T>
}
```

Three rules follow from those signatures:

- **`intercept()` may be `async`.** Returning `Promise<Observable<T>>` is supported, which lets you `await` a cache lookup before deciding whether to call the handler.
- **The handler does not run until the returned observable is subscribed to.** `next.handle()` is lazy. Not calling it — or never subscribing to it — skips pipes and the handler entirely.
- **You may call `next.handle()` exactly once per request.** Subscribing twice invokes the handler twice.

`ExecutionContext` is the same object a guard gets, with `getClass()`, `getHandler()` and `switchToHttp()`. See [Guards](guards.md) for the full surface.

## Binding interceptors

```ts
import { Controller, Get, UseInterceptors } from '@nestjs/common'
import { TimingInterceptor } from '../common/interceptors/timing.interceptor.js'

@Controller('reports')
@UseInterceptors(TimingInterceptor)
export class ReportsController {
  @Get()
  findAll() {
    return this.reports.findAll()
  }
}
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { TimingInterceptor } from './common/interceptors/timing.interceptor.js'

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: TimingInterceptor }],
})
export class AppModule {}
```

| Binding | Dependency injection | Scope |
| --- | --- | --- |
| `@UseInterceptors(Class)` | yes | controller or handler |
| `@UseInterceptors(new Class())` | **no** | controller or handler |
| `APP_INTERCEPTOR` provider | yes | every route |
| `app.useGlobalInterceptors(new Class())` | **no** | every route |

Ordering is the part people get wrong. Registration scope decides the **entry** order — global, then controller, then handler — and because interceptors nest, the **exit** order is the reverse. A global logging interceptor therefore wraps the response that a handler-level envelope interceptor produced, not the other way around.

:::note
A global interceptor never runs for a request that matched no route. There is no handler, so there is nothing to wrap, and the 404 comes from the platform. Use middleware or a global [exception filter](exception-filters.md) to observe those.
:::

## Response shaping

The most common interceptor wraps every successful response in an envelope.

```ts title="src/common/interceptors/envelope.interceptor.ts"
import { Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { StreamableFile } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import type { Request } from 'express'

export interface Envelope<T> {
  data: T
  meta: { requestId: string }
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>()
    const requestId = request.get('x-request-id') ?? 'unknown'

    return next.handle().pipe(
      map((data) => (data instanceof StreamableFile ? data : { data, meta: { requestId } })),
    )
  }
}
```

Two details that are easy to miss:

- **Skip `StreamableFile` and any raw stream.** Wrapping one in an object turns a file download into JSON containing a serialized stream object. The built-in `ClassSerializerInterceptor` makes the same exclusion for the same reason.
- **An envelope is a breaking API change.** Adding one globally changes every response body at once. Version it (see [Versioning](versioning.md)) rather than shipping it to existing clients.

:::warning
An envelope applies to successful responses only. Errors are produced by [exception filters](exception-filters.md), which run outside the interceptor chain, so `{ data, meta }` on success and `{ statusCode, message }` on failure is the default result. If you want one shape, the filter has to produce the envelope too — keep the two definitions in one file so they cannot drift.
:::

## Logging

A logging interceptor sees the handler, the resolved response and the elapsed time, which middleware cannot. What it must not see is the payload.

```ts title="src/common/interceptors/audit.interceptor.ts"
import { Injectable, Logger } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { tap } from 'rxjs/operators'
import type { Request } from 'express'

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit')

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>()

    // Field names and identifiers only. Never the body, never headers wholesale.
    const fields = {
      method: request.method,
      route: request.route?.path ?? request.path,
      userId: request.user?.id,
      requestId: request.get('x-request-id'),
    }

    return next.handle().pipe(
      tap({
        next: () => this.logger.log({ ...fields, outcome: 'ok' }),
        error: (error: unknown) => this.logger.warn({ ...fields, outcome: 'error', name: (error as Error)?.name }),
      }),
    )
  }
}
```

Nest 12's `ConsoleLogger` treats a trailing plain object as structured params, and `structuredParams` defaults to `true`, so the object above survives into JSON output rather than being stringified. `flattenParams` (default `false`) spreads those params into the root of the JSON object instead of nesting them under `params`.

What to leave out is covered in [Safe logging](../nestjs-security/safe-logging.md) and [Logging without leaking PII](../security/logging-without-leaking-pii.md). The short version: request bodies contain passwords and tokens, and an interceptor is the easiest place to accidentally log all of them.

## Caching: returning without calling the handler

Because `next.handle()` is lazy, an interceptor that returns its own observable never invokes pipes or the handler. That is the whole mechanism behind a cache.

```ts title="src/common/interceptors/cache.interceptor.ts"
import { Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { of } from 'rxjs'
import { tap } from 'rxjs/operators'
import type { Request } from 'express'
import { CacheStore } from '../cache/cache.store.js'

@Injectable()
export class ReadThroughCacheInterceptor implements NestInterceptor {
  private readonly store: CacheStore

  constructor(store: CacheStore) {
    this.store = store
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>()
    if (request.method !== 'GET') return next.handle()

    // The key must include everything that changes the answer — the tenant and
    // the user among them, or one caller reads another caller's response.
    const key = `${request.user?.tenantId ?? 'anon'}:${request.user?.id ?? 'anon'}:${request.originalUrl}`

    const hit = await this.store.get(key)
    if (hit !== undefined) return of(hit)

    return next.handle().pipe(tap((value) => void this.store.set(key, value, 30)))
  }
}
```

:::danger
A cache key that omits the identity of the caller is a data-leak primitive: user A's response is served to user B for as long as the entry lives. Include the tenant, the user (or the authorization scope), the API version and every query parameter that affects the result — and never cache a response produced for an authenticated caller under a key an anonymous caller can generate.
:::

`@nestjs/cache-manager` **12.0.0** ships a maintained implementation of this with store backends and per-route TTL metadata; prefer it over a hand-rolled version. See [Caching](../nestjs-libraries/cache-manager.md).

## Timeouts

```ts title="src/common/interceptors/timeout.interceptor.ts"
import { Injectable, RequestTimeoutException } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { TimeoutError, throwError } from 'rxjs'
import type { Observable } from 'rxjs'
import { catchError, timeout } from 'rxjs/operators'

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(5000),
      catchError((error: unknown) => {
        if (error instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException('Handler timed out', {
            errorCode: 'HANDLER_TIMEOUT',
            cause: error,
          }))
        }
        return throwError(() => error)
      }),
    )
  }
}
```

Two honest limits:

- **Unsubscribing does not cancel the work.** When the timeout fires, RxJS unsubscribes from the handler's observable, but the promise the handler returned keeps running — the database query still completes, the row still gets written. To actually cancel, pass an `AbortSignal` down to the client that supports one.
- **The response may already be committed.** If the handler wrote to the response object directly, the timeout exception arrives after headers are sent and the filter can only end the response.

`catchError` re-throwing with `throwError(() => error)` rather than `throw` inside the callback is deliberate: it keeps the error inside the stream so downstream operators and Nest's filter chain see it normally.

## Transforming and suppressing errors

An interceptor can map a domain error onto an HTTP one, which keeps `@nestjs/common` imports out of your service layer.

```ts title="src/common/interceptors/domain-errors.interceptor.ts"
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { throwError } from 'rxjs'
import type { Observable } from 'rxjs'
import { catchError } from 'rxjs/operators'
import { DuplicateEntity, EntityNotFound } from '../../domain/errors.js'

@Injectable()
export class DomainErrorsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof EntityNotFound) {
          return throwError(() => new NotFoundException(error.message, { errorCode: 'NOT_FOUND', cause: error }))
        }
        if (error instanceof DuplicateEntity) {
          return throwError(() => new ConflictException(error.message, { errorCode: 'DUPLICATE', cause: error }))
        }
        return throwError(() => error)
      }),
    )
  }
}
```

An [exception filter](exception-filters.md) can do the same job. Pick the interceptor when the mapping is per-module and the filter when it is global — a `@Catch(EntityNotFound)` filter registered globally is less code than an interceptor on every controller.

Suppressing an error entirely — `catchError(() => of(null))` — turns a failure into a 200 with a null body. Do that only where you have decided the degraded response is correct, and log the suppressed error. It is a very effective way to hide an outage from your own monitoring.

## Streaming a file out of the pipeline

`StreamableFile` is the supported way for a handler to return a stream without touching the raw response object.

```ts title="src/reports/reports.controller.ts"
import { createReadStream } from 'node:fs'
import { Controller, Get, StreamableFile } from '@nestjs/common'

@Controller('reports')
export class ReportsController {
  @Get('latest.pdf')
  download(): StreamableFile {
    return new StreamableFile(createReadStream('/var/lib/app/reports/latest.pdf'), {
      type: 'application/pdf',
      disposition: 'attachment; filename="latest.pdf"',
      length: 128_000,
    })
  }
}
```

| Option | Header it sets | Default |
| --- | --- | --- |
| `type` | `Content-Type` | `application/octet-stream` |
| `disposition` | `Content-Disposition` | not set |
| `length` | `Content-Length` | not set |

Set `disposition` to `attachment` for anything a user uploaded — it is what stops an uploaded HTML or SVG file from executing in your origin. `setErrorHandler()` and `setErrorLogger()` let you control what happens when the stream fails mid-response, which is the one case an exception filter cannot help with because the headers are already gone.

An interceptor that maps responses must let `StreamableFile` through untouched, as the envelope example above does.

## Serialization interceptors

Nest ships two, and they are the reason you rarely need to hand-write response mapping.

| Interceptor | Driven by | Use when |
| --- | --- | --- |
| `ClassSerializerInterceptor` | `class-transformer` decorators (`@Exclude()`, `@Expose()`) on the entity | your DTOs are classes with decorators |
| `StandardSchemaSerializerInterceptor` | a Standard Schema passed to the constructor or `@SerializeOptions({ schema })` | your contracts are Zod / Valibot / ArkType schemas |

`StandardSchemaSerializerInterceptor` is new in Nest 12. Verified constructor and options:

```ts
// new StandardSchemaSerializerInterceptor(reflector, { schema?, validateOptions? })
// @SerializeOptions({ schema, validateOptions })
```

It validates and transforms the response through the schema's `~standard.validate()` method and throws the issues if the response does not match — which turns "we leaked a password hash" into a failing test rather than an incident. Objects that are `null` or a `StreamableFile` are passed through unserialized.

Both are covered properly in [Serialization](../nestjs-validation/serialization.md); that page is where the `@Exclude()` versus allow-list argument belongs, and this one just tells you which stage they run in.

:::best-practice
Make the response schema an allow-list, not a deny-list. `@Exclude()` on the fields you remembered is one new column away from leaking; a schema that enumerates what goes out cannot leak a field nobody added to it.
:::

## Common patterns

### Server-sent events and long-lived streams

A handler returning an `Observable` of `MessageEvent` values keeps emitting, so an interceptor's `map` runs per emission, not once. Interceptors that assume a single value — an envelope, a cache write — will do the wrong thing on an SSE route. Exclude those routes explicitly. See [Server-sent events](../nestjs-advanced/server-sent-events.md).

### Starting a trace span

The pre half of an interceptor is the natural place to open a span and the post half to close it, because both halves share a closure. Note that a request rejected by a guard never reaches the interceptor, so guard rejections are invisible to span-based tracing — instrument those in middleware or accept the gap. [Observability](../nestjs-production/observability.md) covers the trade-off.

### Not a transaction boundary

By the time the post half runs, the handler's writes have already committed. `catchError` cannot roll them back. A transaction has to start and end inside the service — see [Transactions](../nestjs-databases/transactions.md).

## Common mistakes

- **Using bare `tap(fn)` for timing or logging.** It fires on success only; failures go unrecorded. Use `tap({ next, error })`.
- **Subscribing to `next.handle()` twice.** The handler runs twice, with two sets of side effects.
- **Wrapping `StreamableFile` in an envelope.** A file download becomes JSON containing a serialized stream.
- **A cache key without the caller's identity.** One user's response is served to another.
- **Expecting an interceptor to see 404s.** No handler resolved, so no interceptor ran.
- **Assuming exit order matches entry order.** Interceptors nest; the global one exits last.
- **Treating a timeout as cancellation.** The handler keeps running after the unsubscribe. Thread an `AbortSignal` if you need real cancellation.
- **Swallowing errors with `catchError(() => of(null))`.** A 200 with a null body, and nothing in your monitoring.
- **Adding a global envelope to a live API.** Every response body changes at once. Version it.
- **Logging `request.body` from an interceptor.** Passwords, tokens and PII, in your log store, forever.
- **`@UseInterceptors(new CacheInterceptor())` for an interceptor with dependencies.** Instances bypass the container.
- **Putting a transaction in an interceptor.** The writes are already committed when the post half runs.

## Related topics

- [The request lifecycle](../nestjs/request-lifecycle.md) — positions 3 and 6, and why interceptors are the only stage that runs twice.
- [Guards](guards.md) — the stage before, and the `ExecutionContext` they share.
- [Exception filters](exception-filters.md) — what handles the errors an interceptor re-throws, and why it runs outside the chain.
- [Pipes](pipes.md) — the stage an interceptor skips when it does not call `next.handle()`.
- [Serialization](../nestjs-validation/serialization.md) — `ClassSerializerInterceptor` and `StandardSchemaSerializerInterceptor` in depth.
- [Custom decorators](custom-decorators.md) — bundling `@UseInterceptors()` with its metadata into one decorator.
- [Caching](../nestjs-libraries/cache-manager.md) — the maintained version of the cache interceptor above.
- [Logging](../nestjs-libraries/logging.md) — `ConsoleLogger`, `structuredParams` and nestjs-pino.
- [Safe logging](../nestjs-security/safe-logging.md) — what an audit interceptor must not record.
- [Server-sent events](../nestjs-advanced/server-sent-events.md) — where per-emission interception matters.
- [Observability](../nestjs-production/observability.md) — spans, and the guard-rejection blind spot.
- [Streams and buffers](../node/streams-and-buffers.md) — what `StreamableFile` is holding.
