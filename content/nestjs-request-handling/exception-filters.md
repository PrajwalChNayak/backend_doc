---
title: Exception filters
description: The built-in exception layer in NestJS 12, HttpException and its subclasses, writing a @Catch() filter, and building a stable machine-readable error contract with the v12 errorCode option.
status: current
updated: 2026-09-11
---

Nest wraps every request in an exception layer. Anything thrown by a guard, an interceptor, a pipe or a handler is caught by the framework, matched against your filters, and turned into a response — you never write `try`/`catch` to convert an error into a status code. This page is about controlling what that response says.

## The built-in layer

Without a single filter of your own, Nest already handles two cases.

An `HttpException` becomes its declared status and body:

```bash
curl -i localhost:3000/users/999
# HTTP/1.1 404 Not Found
# {"message":"User not found","error":"Not Found","statusCode":404}
```

Anything else becomes a generic 500 and is logged:

```bash
curl -i localhost:3000/reports
# HTTP/1.1 500 Internal Server Error
# {"statusCode":500,"message":"Internal server error"}
```

That second behavior is the important one: **an unrecognized exception never leaks its message to the client.** The string is exactly `Internal server error`, and the real error goes to the `ExceptionsHandler` logger instead. Any filter you write has to preserve that property.

:::note
`HttpException` extends `IntrinsicException`, and the built-in handler does not log those — a 404 you threw on purpose is not an error in your logs. Unknown exceptions are logged in full. If you replace the default handling with your own global filter, you inherit the responsibility for that distinction.
:::

## `HttpException` and its subclasses

```ts
declare class HttpException {
  constructor(response: string | Record<string, any>, status: number, options?: HttpExceptionOptions)
}
```

`HttpExceptionOptions` in Nest 12, read from the published declarations:

```ts
interface HttpExceptionOptions {
  cause?: unknown
  description?: string
  errorCode?: string
}
```

The subclasses fill in the status for you, and all of them take the same options object as their second argument.

| Exception | Status | Exception | Status |
| --- | --- | --- | --- |
| `BadRequestException` | 400 | `PayloadTooLargeException` | 413 |
| `UnauthorizedException` | 401 | `UnsupportedMediaTypeException` | 415 |
| `ForbiddenException` | 403 | `UnprocessableEntityException` | 422 |
| `NotFoundException` | 404 | `InternalServerErrorException` | 500 |
| `MethodNotAllowedException` | 405 | `NotImplementedException` | 501 |
| `NotAcceptableException` | 406 | `BadGatewayException` | 502 |
| `RequestTimeoutException` | 408 | `ServiceUnavailableException` | 503 |
| `ConflictException` | 409 | `GatewayTimeoutException` | 504 |
| `GoneException` | 410 | `HttpVersionNotSupportedException` | 505 |
| `PreconditionFailedException` | 412 | `MisdirectedException` | 421 |
| `ImATeapotException` | 418 | | |

Use `HttpStatus` from `@nestjs/common` rather than a bare number when you construct `HttpException` directly.

### `cause`

`cause` is the standard `Error` chaining field, and it is how you keep the original failure without putting it in the response.

```ts title="src/billing/billing.service.ts"
import { Injectable, ServiceUnavailableException } from '@nestjs/common'

@Injectable()
export class BillingService {
  async charge(amount: number) {
    try {
      return await this.gateway.charge(amount)
    } catch (cause) {
      throw new ServiceUnavailableException('Payment provider unavailable', {
        errorCode: 'PAYMENT_PROVIDER_DOWN',
        cause,
      })
    }
  }
}
```

The client sees `Payment provider unavailable`. Your logs see the gateway's stack trace, hanging off `exception.cause`. Losing the cause — a bare `throw new ServiceUnavailableException()` in the `catch` — is how a production incident becomes unexplainable.

### `errorCode`

`errorCode` is new in Nest 12 and it is a real field, both on `HttpExceptionOptions` and on the `HttpException` instance:

```ts
throw new BadRequestException('Password is too weak', { errorCode: 'WEAK_PASSWORD' })
```

:::warning
`errorCode` is **not** added to the default response body by the built-in handler. It is stored on the exception (`exception.errorCode`), and it reaches the client only when a filter reads it — or when you build the body yourself with `HttpException.createBody(message, error, statusCode, errorCode)`.

Setting `errorCode` and never writing a filter produces exactly the response you had before, which is the kind of bug that survives code review. The filter below is what makes it visible.
:::

## A stable error contract

Clients should branch on a code you control, not on an HTTP status shared by twenty causes and not on a message that changes when someone fixes a typo. One global filter gives every route the same shape.

```ts title="src/common/filters/http-exception.filter.ts"
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { Request, Response } from 'express'

export interface ErrorBody {
  statusCode: number
  errorCode: string
  message: string | string[]
  requestId?: string
}

@Catch()
export class ErrorContractFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorContract')

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp()
    const response = http.getResponse<Response>()
    const request = http.getRequest<Request>()
    const requestId = request.get('x-request-id')

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const payload = exception.getResponse()

      const body: ErrorBody = {
        statusCode: status,
        errorCode: exception.errorCode ?? defaultCodeFor(status),
        message: typeof payload === 'string' ? payload : messageOf(payload),
        requestId,
      }

      // 5xx is ours, not the caller's — log it even though it is an HttpException.
      if (status >= 500) this.logger.error({ requestId, errorCode: body.errorCode }, exception.stack)

      response.status(status).json(body)
      return
    }

    // Unknown exception: log everything, disclose nothing.
    this.logger.error({ requestId }, exception instanceof Error ? exception.stack : String(exception))

    const fallback: ErrorBody = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId,
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(fallback)
  }
}

function messageOf(payload: object): string | string[] {
  const message = (payload as { message?: unknown }).message
  if (typeof message === 'string' || Array.isArray(message)) return message
  return 'Request failed'
}

function defaultCodeFor(status: number): string {
  return HttpStatus[status] ? String(HttpStatus[status]) : 'HTTP_ERROR'
}
```

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { ErrorContractFilter } from './common/filters/http-exception.filter.js'

@Module({
  providers: [{ provide: APP_FILTER, useClass: ErrorContractFilter }],
})
export class AppModule {}
```

Now every failure, from every stage, looks the same:

```bash
curl -i -X POST localhost:3000/users -d '{"password":"1234"}' -H 'content-type: application/json'
# HTTP/1.1 400 Bad Request
# {"statusCode":400,"errorCode":"WEAK_PASSWORD","message":"Password is too weak","requestId":"…"}
```

Three properties are worth naming, because they are the reason to do this at all:

- **`errorCode` is a closed set.** Keep the codes in one `const` object exported from a shared file, and the client's `switch` cannot go stale silently.
- **The status still means what HTTP says it means.** `errorCode` adds specificity; it does not replace `4xx` versus `5xx`.
- **Unknown errors are indistinguishable from each other.** The 500 branch never touches the exception's message.

:::danger
`exception.getResponse()` on an `HttpException` you did not construct can contain anything the thrower put there — including a database error string with a table name, a file path, or a query. The filter above only forwards `message` when it is a string or an array of strings, and that narrowing is the security control. A filter that spreads `...payload` into the response body re-exports whatever leaked into it.
:::

## Narrower filters

`@Catch()` with no arguments catches everything. With arguments it catches only those types.

```ts title="src/common/filters/duplicate-key.filter.ts"
import { Catch } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'
import { DuplicateKeyError } from '../../database/errors.js'

@Catch(DuplicateKeyError)
export class DuplicateKeyFilter implements ExceptionFilter {
  catch(exception: DuplicateKeyError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    response.status(409).json({
      statusCode: 409,
      errorCode: 'DUPLICATE',
      message: `${exception.field} is already taken`,
    })
  }
}
```

Binding follows the usual three scopes, and filter selection runs **narrowest first**: a method-level `@UseFilters()` wins over a controller-level one, which wins over a global filter. Within one level, the most specific `@Catch(Type)` that matches handles it.

```ts
@UseFilters(DuplicateKeyFilter)
@Controller('users')
export class UsersController {}
```

| Binding | Dependency injection | Scope |
| --- | --- | --- |
| `@UseFilters(Class)` | yes | controller or handler |
| `@UseFilters(new Class())` | **no** | controller or handler |
| `APP_FILTER` provider | yes | every route |
| `app.useGlobalFilters(new Class())` | **no** | every route |

Multiple `APP_FILTER` providers are allowed. They are applied in reverse registration order, so declare the catch-all first and the specific ones after it.

## Catching non-HTTP exceptions

Everything that is not an `HttpException` arrives at your filter as `unknown` — a driver error, a `TypeError`, a rejected promise from a library, a string someone threw. Three rules:

1. **Type-narrow before you touch it.** `exception instanceof Error` is not guaranteed; JavaScript lets you throw anything.
2. **Map the ones you recognize, by type.** A `@Catch(DuplicateKeyError)` filter is clearer than string-matching an error message, and it does not break when the driver reworks its messages.
3. **Give everything else a 500 with a fixed body.** Never `exception.message`.

```ts vulnerable title="DO NOT COPY"
@Catch()
export class LeakyFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(500).json({
      message: exception.message,   // "relation \"users\" does not exist" / a connection string
      stack: exception.stack,       // your directory layout, your dependency versions
    })
  }
}
```

A database error message names your tables and columns. A stack trace names your file paths and the libraries you run. Both are free reconnaissance, and both show up in production because the filter was written while debugging locally.

```ts good title="src/common/filters/errors.filter.ts"
const body = process.env.NODE_ENV === 'production'
  ? { statusCode: 500, errorCode: 'INTERNAL_ERROR', message: 'Internal server error' }
  : { statusCode: 500, errorCode: 'INTERNAL_ERROR', message: 'Internal server error', debug: String(exception) }
```

Gate the detail on the environment, keep the shape identical in both, and make sure the production branch is the default — a missing `NODE_ENV` should give you the safe body, not the verbose one.

## Extending the built-in filter

When you want the default behavior for most things and your own for a few, extend `BaseExceptionFilter` and delegate.

```ts title="src/common/filters/prisma.filter.ts"
import { Catch, ConflictException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'

@Catch(PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    if (exception.code === 'P2002') {
      return super.catch(
        new ConflictException('Already exists', { errorCode: 'DUPLICATE', cause: exception }),
        host,
      )
    }
    return super.catch(exception, host)
  }
}
```

`BaseExceptionFilter` needs the HTTP adapter. Register it as an `APP_FILTER` provider so the container injects `HttpAdapterHost`; a hand-constructed instance in `main.ts` has to be given `app.getHttpAdapter()` explicitly.

A filter that has to work on both Express and Fastify should go through `HttpAdapterHost` rather than calling `response.status().json()` directly:

```ts
import { Injectable } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'

@Injectable()
export class PlatformAgnosticFilter {
  private readonly adapterHost: HttpAdapterHost

  constructor(adapterHost: HttpAdapterHost) {
    this.adapterHost = adapterHost
  }

  reply(host: { getArgByIndex: (i: number) => unknown }, body: unknown, status: number) {
    this.adapterHost.httpAdapter.reply(host.getArgByIndex(1), body, status)
  }
}
```

## Things a filter cannot do

- **It cannot catch an exception thrown inside another filter.** That falls through to the platform's default handler and produces a bare 500 with a body you do not control. Keep filters free of anything that can throw: no database writes, no network call to a logging service without a `catch`.
- **It cannot un-send a response.** If the handler wrote to `@Res()` directly, or a `StreamableFile` failed after headers were flushed, the filter can only end the response. `response.headersSent` is worth checking.
- **It cannot roll back the handler's work.** By the time an exception reaches a filter, whatever the service committed is committed.
- **It does not run for a request that matched no route** in the sense you might expect — Nest's own not-found handler throws a `NotFoundException` that a global filter *does* see, but no controller-scoped filter can, because no controller was selected.

## Common patterns

### Validation errors

`ValidationPipe` throws a `BadRequestException` whose response object has `message` as an **array of strings**. The contract filter above forwards arrays unchanged, which keeps per-field errors intact. If your clients need field names rather than sentences, set `exceptionFactory` on the pipe instead of reshaping in the filter — the pipe is the only place that still knows which property failed. See [The ValidationPipe](../nestjs-validation/validation-pipe.md).

### Errors from middleware

Middleware is Express's stage, not Nest's, but Express 5 forwards a rejected promise to the error stack and Nest's exception layer picks it up. An `async` middleware that throws `UnauthorizedException` therefore produces a normal Nest 401 through your filter. See [Middleware](middleware.md).

### Codes, in one place

```ts title="src/common/errors/codes.ts"
export const ERROR_CODES = {
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  DUPLICATE: 'DUPLICATE',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  PAYMENT_PROVIDER_DOWN: 'PAYMENT_PROVIDER_DOWN',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
```

Publish that type to your clients — through OpenAPI, or a shared package in a monorepo — and the contract stops being folklore. See [OpenAPI with Swagger](../nestjs-libraries/swagger.md).

## Common mistakes

- **Setting `errorCode` and expecting it in the response.** The built-in handler does not add it; a filter has to read `exception.errorCode`.
- **Spreading `exception.getResponse()` into the response body.** Whatever the thrower put there goes to the client.
- **Returning `exception.message` for unknown errors.** Database schemas, file paths and connection strings, straight to the caller.
- **Including a stack trace in a non-production branch that is also the default.** Gate on `NODE_ENV === 'production'` being the safe side.
- **Throwing inside a filter.** Nothing catches it; you get the platform's bare 500.
- **Dropping `cause` when re-throwing.** The original failure disappears from your logs.
- **`app.useGlobalFilters(new BaseExceptionFilterSubclass())`.** No `HttpAdapterHost` injection. Use `APP_FILTER`.
- **A `@Catch()` catch-all at controller level.** It swallows every error in that controller, including ones a narrower global filter was meant to handle.
- **Forgetting that a 5xx `HttpException` is still your bug.** `IntrinsicException` means the built-in handler will not log it; log 5xx yourself.
- **Reshaping `ValidationPipe`'s message array in the filter.** By then the field names are gone. Use the pipe's `exceptionFactory`.
- **Writing `response.json()` after `response.headersSent` is true.** Check first, or you get an unhandled error on top of the original one.
- **Using the same generic `errorCode` for everything.** A single `INTERNAL_ERROR` is fine for 500s and useless for 4xx.

## Related topics

- [The request lifecycle](../nestjs/request-lifecycle.md) — why filters are the last stage and run outside everything else.
- [Guards](guards.md) — throwing rather than returning `false`, so the filter gets a status you chose.
- [Interceptors](interceptors.md) — mapping domain errors before they reach a filter, and why an envelope and a filter must agree.
- [Pipes](pipes.md) — `exceptionFactory` and where a 400 actually originates.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — the shape of a validation failure.
- [Middleware](middleware.md) — errors thrown before Nest's pipeline starts.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — publishing the error contract to clients.
- [Safe logging](../nestjs-security/safe-logging.md) — what belongs in the log line a filter writes.
- [Logging](../nestjs-libraries/logging.md) — `ConsoleLogger` and structured params.
- [Error handling](../express/error-handling.md) — the Express error stack underneath the Nest exception layer.
- [Error handling](../node/error-handling.md) — `cause`, `AggregateError` and the Node fundamentals.
