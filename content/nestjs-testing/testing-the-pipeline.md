---
title: Testing guards, pipes and interceptors
description: Testing NestJS 12 enhancers both ways — canActivate with a faked ExecutionContext, transform with ArgumentMetadata, intercept with a stub CallHandler and assertions on the RxJS stream, exception filters, and when the isolated test beats the through-the-app test.
status: current
updated: 2026-09-11
---

Guards, pipes, interceptors and filters are the four classes Nest calls with framework objects you never construct yourself. That makes them awkward to unit test and trivially easy to test through a route, and the right choice depends on whether the thing you are verifying is the class's logic or its wiring. Both approaches belong in a real suite, and this page shows each with the verified signatures.

## Two approaches, two different questions

| | Isolated unit test | Through the app |
| --- | --- | --- |
| You call | `guard.canActivate(fakeContext)` | `request(server).get('/x')` |
| Speed | microseconds | milliseconds |
| Proves the **logic** is right | yes | partly |
| Proves the class is **attached** to the route | no | yes |
| Proves the metadata key matches the decorator | only if you set it by hand | yes |
| Proves ordering relative to other enhancers | no | yes |
| Covers branches cheaply (every role, every payload) | yes | expensive |
| Fails informatively | yes — one class in the stack | not always — a 403 has several causes |

The split that works: **branches in isolation, wiring through the app.** Write one isolated test per interesting decision the class makes, and one route-level test that proves it runs at all.

## Guards

A guard receives an `ExecutionContext`, which extends `ArgumentsHost`. Nothing in it is hard to fake — `switchToHttp().getRequest()` plus `getHandler()` and `getClass()` cover almost every real guard.

```ts title="src/auth/roles.guard.ts"
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from './roles.decorator.js'

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector: Reflector

  constructor(reflector: Reflector) {
    this.reflector = reflector
  }

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true

    const request = context.switchToHttp().getRequest<{ user?: { roles?: string[] } }>()
    const roles = request.user?.roles ?? []
    return required.some((role) => roles.includes(role))
  }
}
```

A small factory keeps every guard test to three lines:

```ts title="test/helpers/execution-context.ts"
import { type ExecutionContext } from '@nestjs/common'

export interface FakeContextInput {
  request?: Record<string, unknown>
  response?: Record<string, unknown>
  handler?: () => unknown
  controller?: new () => unknown
}

export function fakeExecutionContext(input: FakeContextInput = {}): ExecutionContext {
  const request = input.request ?? {}
  const response = input.response ?? {}
  const handler = input.handler ?? function route() {}
  const controller = input.controller ?? class FakeController {}

  const context = {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => handler,
    getArgs: () => [request, response, () => undefined],
    getArgByIndex: (index: number) => [request, response][index],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => () => undefined,
    }),
    switchToRpc: () => ({ getData: () => request, getContext: () => ({}) }),
    switchToWs: () => ({ getData: () => request, getClient: () => ({}), getPattern: () => '' }),
  }

  return context as unknown as ExecutionContext
}
```

The cast is honest: you are supplying the part of the interface the guard actually touches. Faking `switchToWs` for an HTTP guard is padding, but having it in one shared helper is cheaper than discovering later that a guard calls `getType()`.

```ts title="src/auth/roles.guard.spec.ts"
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from './roles.decorator.js'
import { RolesGuard } from './roles.guard.js'
import { fakeExecutionContext } from '../../test/helpers/execution-context.js'

describe('RolesGuard', () => {
  const reflector = new Reflector()
  const guard = new RolesGuard(reflector)

  function contextWithRoles(required: string[] | undefined, userRoles: string[] | undefined) {
    const handler = function route() {}
    if (required) Reflect.defineMetadata(ROLES_KEY, required, handler)
    return fakeExecutionContext({
      handler,
      request: userRoles ? { user: { roles: userRoles } } : {},
    })
  }

  it('allows a route with no roles metadata', () => {
    expect(guard.canActivate(contextWithRoles(undefined, undefined))).toBe(true)
  })

  it('allows a user holding one of the required roles', () => {
    expect(guard.canActivate(contextWithRoles(['admin', 'auditor'], ['auditor']))).toBe(true)
  })

  it('refuses a user holding none of them', () => {
    expect(guard.canActivate(contextWithRoles(['admin'], ['reader']))).toBe(false)
  })

  it('refuses an unauthenticated request', () => {
    expect(guard.canActivate(contextWithRoles(['admin'], undefined))).toBe(false)
  })
})
```

Note the real `Reflector` and real metadata rather than a stubbed reflector. Stubbing `getAllAndOverride` would hide the single most common guard bug: the guard reads a different metadata key than the decorator writes. Setting the metadata on the fake handler exercises the key for real.

Guards that return a promise or an observable are tested the same way — `await guard.canActivate(ctx)`, or `firstValueFrom(...)`.

:::note There is an internal `ExecutionContextHost`
`@nestjs/core` ships a concrete `ExecutionContext` implementation, but it is exported only from the `@nestjs/core/internal` subpath — the package's own naming says it is not public API. A hand-rolled fake you control cannot break on a minor upgrade, so this handbook uses one.
:::

## Pipes

A pipe's `transform(value, metadata)` takes an `ArgumentMetadata`, whose verified shape in `@nestjs/common@12.0.1` is:

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Paramtype, Type } from '@nestjs/common'

interface ArgumentMetadataShape<Metatype = unknown> {
  readonly type: Paramtype // 'body' | 'query' | 'param' | 'custom'
  readonly metatype?: Type<Metatype>
  readonly data?: string // the decorator's argument, e.g. 'userId' for @Body('userId')
  readonly schema?: StandardSchemaV1 // Nest 12: a Standard Schema attached to the parameter
}
```

`schema` is new in Nest 12 and is what the Standard Schema pipe reads — see [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md).

```ts title="src/common/pipes/parse-positive-int.pipe.ts"
import { type ArgumentMetadata, BadRequestException, Injectable, type PipeTransform } from '@nestjs/common'

@Injectable()
export class ParsePositiveIntPipe implements PipeTransform<string, number> {
  transform(value: string, metadata: ArgumentMetadata): number {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${metadata.data ?? 'value'} must be a positive integer`)
    }
    return parsed
  }
}
```

```ts title="src/common/pipes/parse-positive-int.pipe.spec.ts"
import { type ArgumentMetadata, BadRequestException } from '@nestjs/common'
import { ParsePositiveIntPipe } from './parse-positive-int.pipe.js'

describe('ParsePositiveIntPipe', () => {
  const pipe = new ParsePositiveIntPipe()
  const metadata: ArgumentMetadata = { type: 'param', data: 'page', metatype: Number }

  it('parses a positive integer', () => {
    expect(pipe.transform('12', metadata)).toBe(12)
  })

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects %p', (input) => {
    expect(() => pipe.transform(input, metadata)).toThrow(BadRequestException)
  })

  it('names the parameter in the message', () => {
    expect(() => pipe.transform('0', metadata)).toThrow(/page/)
  })
})
```

A pipe is the best-value isolated test in Nest: it is a pure function of two arguments, so every edge case costs one line. Table-driven is the natural style.

For the built-in `ValidationPipe` the same shape applies, and `metatype` becomes the interesting field — it is the DTO class the pipe validates against:

```ts title="test/create-order.dto.spec.ts"
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common'
import { CreateOrderDto } from '../src/orders/dto/create-order.dto.js'

describe('CreateOrderDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  const metadata: ArgumentMetadata = { type: 'body', metatype: CreateOrderDto }

  it('strips and rejects an unknown property', async () => {
    await expect(
      pipe.transform({ customerId: 'c1', lines: [], isAdmin: true }, metadata),
    ).rejects.toThrow()
  })

  it('coerces the numeric quantity', async () => {
    const result = await pipe.transform(
      { customerId: 'c1', lines: [{ sku: 'ABC', qty: '2' }] },
      metadata,
    )
    expect(result.lines[0].qty).toBe(2)
  })
})
```

That test is fast, exhaustive, and tests the DTO's decorators rather than the route. It is the right place to cover every validation rule; one e2e test then proves the pipe is registered at all. See [class-validator and class-transformer](../nestjs-validation/class-validator.md) and [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md).

## Interceptors

An interceptor gets the context plus a `CallHandler`, whose entire interface is `handle(): Observable<T>`. So the stub is one object, and the assertion is on the returned stream.

```ts title="src/common/interceptors/timing.interceptor.ts"
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common'
import { type Observable, tap } from 'rxjs'

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = Date.now()
    const response = context.switchToHttp().getResponse<{ setHeader: (k: string, v: string) => void }>()

    return next.handle().pipe(
      tap(() => {
        response.setHeader('X-Response-Time-Ms', String(Date.now() - started))
      }),
    )
  }
}
```

```ts title="src/common/interceptors/timing.interceptor.spec.ts"
import { type CallHandler } from '@nestjs/common'
import { firstValueFrom, of } from 'rxjs'
import { TimingInterceptor } from './timing.interceptor.js'
import { fakeExecutionContext } from '../../../test/helpers/execution-context.js'

describe('TimingInterceptor', () => {
  const interceptor = new TimingInterceptor()

  it('sets the timing header and passes the value through', async () => {
    const headers: Record<string, string> = {}
    const context = fakeExecutionContext({
      response: { setHeader: (k: string, v: string) => void (headers[k] = v) },
    })
    const next: CallHandler = { handle: () => of({ id: 'o1' }) }

    const result = await firstValueFrom(interceptor.intercept(context, next))

    expect(result).toEqual({ id: 'o1' })
    expect(headers['X-Response-Time-Ms']).toMatch(/^\d+$/)
  })
})
```

`of(value)` is the whole stub for the handler's response, and `firstValueFrom` turns the returned observable back into a promise. Those two imports cover most interceptor tests.

The stream is the part people get wrong, so assert on it deliberately.

**An interceptor that transforms the value:**

```ts
import { type CallHandler } from '@nestjs/common'
import { firstValueFrom, of } from 'rxjs'
import { EnvelopeInterceptor } from './envelope.interceptor.js'
import { fakeExecutionContext } from '../../../test/helpers/execution-context.js'

it('wraps the payload in a data envelope', async () => {
  const interceptor = new EnvelopeInterceptor()
  const next: CallHandler = { handle: () => of([{ id: 1 }, { id: 2 }]) }

  const result = await firstValueFrom(interceptor.intercept(fakeExecutionContext(), next))

  expect(result).toEqual({ data: [{ id: 1 }, { id: 2 }], count: 2 })
})
```

**An interceptor that maps an error:** the assertion is that the observable *rejects*, and with what.

```ts
import { type CallHandler, ServiceUnavailableException } from '@nestjs/common'
import { firstValueFrom, throwError } from 'rxjs'
import { UpstreamErrorInterceptor } from './upstream-error.interceptor.js'
import { fakeExecutionContext } from '../../../test/helpers/execution-context.js'

it('converts an upstream timeout into a 503', async () => {
  const interceptor = new UpstreamErrorInterceptor()
  const next: CallHandler = {
    handle: () => throwError(() => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
  }

  await expect(
    firstValueFrom(interceptor.intercept(fakeExecutionContext(), next)),
  ).rejects.toBeInstanceOf(ServiceUnavailableException)
})
```

**An interceptor that must not call the handler** — a cache hit, a short circuit — is tested by asserting `handle()` was never invoked:

```ts
import { type CallHandler } from '@nestjs/common'
import { firstValueFrom, of } from 'rxjs'
import { fakeExecutionContext } from '../../../test/helpers/execution-context.js'

it('serves a cache hit without invoking the handler', async () => {
  let handled = 0
  const next: CallHandler = {
    handle: () => {
      handled += 1
      return of('from handler')
    },
  }

  const interceptor = new CacheHitInterceptor({ get: async () => 'from cache' })
  const result = await firstValueFrom(interceptor.intercept(fakeExecutionContext(), next))

  expect(result).toBe('from cache')
  expect(handled).toBe(0)
})
```

`intercept` may also return `Promise<Observable<R>>`, so an interceptor that awaits something before subscribing needs `await interceptor.intercept(...)` before `firstValueFrom`.

:::warning An observable with no subscriber does nothing
If a test calls `interceptor.intercept(context, next)` and never subscribes, the `tap`, the `map` and the `catchError` never run, and an assertion about a side effect fails for the wrong reason. `firstValueFrom`, `lastValueFrom` or an explicit `subscribe` is what makes the pipeline execute.

Use `lastValueFrom` rather than `firstValueFrom` when the handler emits more than once — a streaming response, or an interceptor that emits a progress value before the result.
:::

## Exception filters

A filter's `catch(exception, host)` takes an `ArgumentsHost` — the same object as `ExecutionContext` minus `getClass()` and `getHandler()`, so the same fake works. The awkward part is that a filter writes to the response, so the fake response has to be chainable in the way the real one is.

```ts title="src/common/filters/all-exceptions.filter.ts"
import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const response = http.getResponse<{
      status: (code: number) => { json: (body: unknown) => void }
    }>()
    const request = http.getRequest<{ url?: string }>()

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    if (status >= 500) this.logger.error(`${request.url} failed`, exception as Error)

    response.status(status).json({
      statusCode: status,
      message:
        exception instanceof HttpException ? exception.getResponse() : 'Internal server error',
      path: request.url,
    })
  }
}
```

```ts title="src/common/filters/all-exceptions.filter.spec.ts"
import { BadRequestException } from '@nestjs/common'
import { AllExceptionsFilter } from './all-exceptions.filter.js'
import { fakeExecutionContext } from '../../../test/helpers/execution-context.js'

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter()

  function captureResponse() {
    const captured: { status?: number; body?: unknown } = {}
    const response = {
      status: (code: number) => {
        captured.status = code
        return {
          json: (body: unknown) => {
            captured.body = body
          },
        }
      },
    }
    return { captured, response }
  }

  it('preserves the status of an HttpException', () => {
    const { captured, response } = captureResponse()
    const host = fakeExecutionContext({ request: { url: '/orders' }, response })

    filter.catch(new BadRequestException('bad payload'), host)

    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ statusCode: 400, path: '/orders' })
  })

  it('maps an unknown error to 500 and does not leak its message', () => {
    const { captured, response } = captureResponse()
    const host = fakeExecutionContext({ request: { url: '/orders' }, response })

    filter.catch(new Error('connection reset by peer'), host)

    expect(captured.status).toBe(500)
    expect(JSON.stringify(captured.body)).not.toContain('connection reset')
  })
})
```

That second test is the one worth having. An error handler that echoes `err.message` on a 500 hands attackers your internals, and a test asserting it does not is cheap and permanent.

## The through-the-app test

Everything above proves the class computes the right answer. None of it proves the class runs. That question needs a route.

```ts title="test/roles.e2e-spec.ts"
import { type INestApplication } from '@nestjs/common'
import request from 'supertest'
import { createTestApp } from './helpers/create-test-app.js'
import { bearerFor } from './helpers/auth.js'

describe('Role enforcement (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('401 without credentials', async () => {
    await request(app.getHttpServer()).delete('/api/v1/orders/o1').expect(401)
  })

  it('403 for a reader', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/orders/o1')
      .set('Authorization', await bearerFor(app, { sub: 'u1', roles: ['reader'] }))
      .expect(403)
  })

  it('204 for an admin', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/orders/o1')
      .set('Authorization', await bearerFor(app, { sub: 'u2', roles: ['admin'] }))
      .expect(204)
  })
})
```

Three tests, and between them they prove the guard is attached, the metadata key matches, the decorator is on the right handler, the order relative to the auth guard is right, and the filter maps the thrown exception to 403 rather than 500. No isolated test can prove any of that. The helpers are in [End-to-end tests](e2e-tests.md).

There is one more wiring failure only a route can catch: an enhancer that lives in `main.ts` and therefore does not exist in a testing module at all. That is the whole argument for the shared bootstrap function.

## Choosing

- **Guard** — isolate every decision branch; one route test per protected resource for the 401/403/200 matrix.
- **Pipe** — isolate almost everything; it is a pure function and the cheapest test in the codebase. One route test that a bad payload returns 400.
- **Interceptor** — isolate the stream behavior, including the error and short-circuit paths. One route test if it sets a header or changes the body shape that clients depend on.
- **Exception filter** — isolate the status mapping and the no-leak assertion. One route test per status the API documents.
- **Anything whose bug would be "it never ran"** — only a route test finds that.

## Common mistakes

- **Never subscribing to the interceptor's observable.** `tap`, `map` and `catchError` do not run, and the side-effect assertion fails for the wrong reason.
- **`firstValueFrom` on a stream that emits more than once.** Use `lastValueFrom` when the last value is the one you mean.
- **Forgetting that `intercept` may return a promise.** `await` it before `firstValueFrom`.
- **A `CallHandler` stub that returns a plain value instead of an observable.** `handle()` must return `Observable<T>`; `of(value)` is the stub.
- **Stubbing `Reflector`.** It hides the commonest guard bug — the guard reads a different metadata key than the decorator writes. Use a real `Reflector` and real metadata.
- **Asserting on `canActivate` alone and calling authorization tested.** Nothing proves the guard is attached to the route.
- **Forgetting `getHandler()` / `getClass()` in the fake context.** A guard that reads metadata will throw an unrelated `TypeError`.
- **A fake response object that is not chainable.** `response.status(code).json(body)` needs `status()` to return an object with `json`.
- **Testing a pipe only through HTTP.** Each edge case costs a full request, so most of them never get written.
- **Omitting the "does not leak the message" test on a catch-all filter.** It is the one that catches a real information disclosure.
- **Faking an `ExecutionContext` for an enhancer that reads the raw Express request deeply.** At that point the through-the-app test is both easier and more honest.

## Related topics

- [Guards](../nestjs-request-handling/guards.md) — the `canActivate` contract and the metadata patterns.
- [Pipes](../nestjs-request-handling/pipes.md) — `transform`, `ArgumentMetadata` and the built-in pipes.
- [Interceptors](../nestjs-request-handling/interceptors.md) — the RxJS operators these tests assert on.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — what `catch` is expected to write.
- [The request lifecycle](../nestjs/request-lifecycle.md) — the order a route test verifies and an isolated test cannot.
- [Unit tests](unit-tests.md) — the testing module, for enhancers with real dependencies.
- [Mocking providers](mocking-providers.md) — `overrideGuard` and friends, for when you want the enhancer *out* of the way.
- [End-to-end tests](e2e-tests.md) — `createTestApp`, `bearerFor`, and the wiring tests.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — the pipe most worth an exhaustive isolated suite.
- [Custom decorators](../nestjs-request-handling/custom-decorators.md) — the metadata a guard test has to set by hand.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the matrix the route tests cover.
