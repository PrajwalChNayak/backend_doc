---
title: Controllers
description: Writing Nest 12 controllers that stay thin — route decorators, parameter decorators, status codes, what Nest does with your return value, and why @Res() is usually a mistake.
status: current
updated: 2026-09-11
---

A controller is a class whose methods are HTTP endpoints. Its entire job is translation: turn a request into plain values, hand them to one service call, and turn the result into a status code and a body. Everything a controller does beyond that — a query, a rule, a retry, a transaction — is a decision that belongs one layer down.

## Why it exists

Nest could have let you register handler functions directly. The class exists so that a handler can have **dependencies** resolved by the container, and so that route metadata lives next to the code it routes to instead of in a separate routing table that drifts.

That is the trade. You get injectable handlers and colocated routes; you give up the ability to read the whole URL space by opening one file. [`nest start` logs every mapped route at boot](installation-and-cli.md), which is the replacement for that file — read it once after adding a controller.

## Basic example

```ts title="src/orders/orders.controller.ts"
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { CreateOrderDto } from './dto/create-order.dto.js'
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
    return this.orders.list(query)
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orders.findById(id)
  }

  @Post()
  create(@Body() body: CreateOrderDto) {
    return this.orders.place(body)
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(@Param('id') id: string) {
    await this.orders.cancel(id)
  }
}
```

Four endpoints, no `req`, no `res`, no `try`/`catch`, no status codes except the one that is not a default. Every method is a function from values to values, which is exactly what makes the class testable without a socket.

## Route decorators

`@Controller(prefix)` sets a path prefix; the method decorator sets the rest. The resulting path is the prefix joined to the method path.

| Decorator | Method | Note |
| --- | --- | --- |
| `@Get(path?)` | GET | |
| `@Post(path?)` | POST | defaults to 201 |
| `@Put(path?)` / `@Patch(path?)` | PUT / PATCH | |
| `@Delete(path?)` | DELETE | |
| `@Head(path?)` / `@Options(path?)` | HEAD / OPTIONS | |
| `@All(path?)` | every method | |
| `@Search(path?)` | SEARCH | |

Each accepts `string | string[]`, so one handler can serve several paths:

```ts
import { Controller, Get } from '@nestjs/common'

@Controller('orders')
export class OrdersController {
  @Get(['archived', 'closed'])
  listClosed() {
    return this.orders.listClosed()
  }
}
```

`@Controller()` also takes an options object with `path`, `host`, `version` and `scope`. Path syntax — wildcards, optional segments, escaping — is path-to-regexp 8 and has a page of its own: [Routing and path syntax](routing-and-path-syntax.md).

## Parameter decorators

Nest reads the request for you. Which decorator you use is the difference between a handler that can be unit-tested and one that cannot.

| Decorator | Gives you | Express equivalent |
| --- | --- | --- |
| `@Param(key?)` | a route parameter, or all of them | `req.params` |
| `@Query(key?)` | a query-string value, or all of them | `req.query` |
| `@Body(key?)` | the parsed body, or one property | `req.body` |
| `@Headers(name?)` | one header, or all of them | `req.headers` |
| `@Ip()` | the client IP | `req.ip` |
| `@HostParam(key?)` | a parameter from the `host` pattern | — |
| `@Session()` | the session object | `req.session` |
| `@RawBody()` | the unparsed body buffer | requires `rawBody: true` on the app |
| `@Req()` / `@Res()` / `@Next()` | the raw Express objects | `req` / `res` / `next` |

`@Param`, `@Query` and `@Body` also accept pipes, which is how a string from the URL becomes a validated number before your method sees it:

```ts
import { Controller, DefaultValuePipe, Get, ParseIntPipe, ParseUUIDPipe, Param, Query } from '@nestjs/common'

@Controller('orders')
export class OrdersController {
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findById(id)
  }

  @Get()
  list(@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    return this.orders.list({ page })
  }
}
```

Everything arriving from a URL is a **string**, always. `ParseIntPipe` is not decoration — without it, `page` is `'1'` and `page + 1` is `'11'`. Pipes are covered in [Pipes](../nestjs-request-handling/pipes.md); validating whole payloads with a DTO is [The ValidationPipe](../nestjs-validation/validation-pipe.md).

:::note
`@Query()` reads Express 5's query parser, whose default is now **`'simple'`** rather than `'extended'`. Nested bracket syntax (`?filter[status]=open`) does not produce a nested object unless you opt back in. See [Request and response](../express/request-and-response.md).
:::

## What Nest does with your return value

Return a value and Nest serializes it and sends it. Return a promise and it awaits it first. Return an RxJS `Observable` and it takes the last emitted value.

| Return | Response |
| --- | --- |
| an object or array | `application/json`, serialized with `JSON.stringify` |
| a string, number or boolean | sent as-is, `text/html` by default |
| `undefined` | empty body with the method's default status |
| a rejected promise / a thrown error | handled by the exception filter chain |

Default status is **201 for `@Post()`** and **200 for everything else**. Override with `@HttpCode()`.

```ts
import { Controller, Header, HttpCode, Post, Redirect } from '@nestjs/common'

@Controller('exports')
export class ExportsController {
  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  start() {
    return { status: 'queued' }
  }

  @Post('legacy')
  @Redirect('/exports', 308)
  legacy() {}
}
```

### Errors are return values too

Throw, and the exception filter chain turns it into a response. You never write `res.status(404).json(...)` in a controller and you never write a `try`/`catch` whose only job is to convert an error to a status.

```ts
import { NotFoundException } from '@nestjs/common'

// In the service, not the controller — the rule is "this order does not exist",
// which is a domain fact, not an HTTP fact the controller discovered.
const order = await this.repository.findById(id)
if (!order) throw new NotFoundException('order not found')
```

Nest 12 adds an `errorCode` option to `HttpExceptionOptions`, which gives clients a stable machine-readable string alongside the human message:

```ts
import { BadRequestException } from '@nestjs/common'

throw new BadRequestException('Password is too weak', { errorCode: 'WEAK_PASSWORD' })
```

Status codes chosen by the message you throw, with the mapping in one filter, is the whole design — see [Exception filters](../nestjs-request-handling/exception-filters.md).

## `@Res()` is usually a mistake

Injecting the raw response object opts the handler **out** of Nest's response pipeline. Your return value is ignored, interceptors that transform the body no longer see it, and the serialization layer does nothing.

```ts
import { Controller, Get, Param, Res } from '@nestjs/common'
import type { Response } from 'express'

@Controller('orders')
export class OrdersController {
  // Opts out: Nest will not send anything, and will hang if you forget to.
  @Get(':id')
  findOne(@Param('id') id: string, @Res() res: Response) {
    res.json(this.orders.findById(id))
  }
}
```

If you genuinely need a response-object feature — setting a cookie, streaming a file — ask for it in passthrough mode so Nest still handles the body:

```ts
import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'

@Controller('session')
export class SessionController {
  @Get()
  read(@Res({ passthrough: true }) res: Response) {
    res.cookie('seen', '1', { httpOnly: true, sameSite: 'lax' })
    return { ok: true }      // still serialized by Nest
  }
}
```

`passthrough: true` is the difference between "I need one method on the response" and "I am taking over". Reach for the second almost never; the platform-specific handler is untestable without a fake response and stops working if you ever move to [the Fastify adapter](../nestjs-advanced/fastify-adapter.md).

## Keeping controllers thin

The rule from [Layered architecture](../express/layered-architecture.md) is unchanged by the framework: **a controller may not contain a business rule or a query.**

```ts
import { BadRequestException, Body, ConflictException, Controller, Param, Post } from '@nestjs/common'

@Controller('orders')
export class OrdersController {
  // Wrong: a rule, a query and a payment call, all in the HTTP layer.
  @Post(':id/refund')
  async refund(@Param('id') id: string, @Body() body: RefundDto) {
    const order = await this.repository.findById(id)
    if (order.status !== 'paid') throw new ConflictException('not refundable')
    if (body.amount > order.total) throw new BadRequestException('amount too large')
    await this.payments.refund(order.paymentId, body.amount)
    return this.repository.update(id, { status: 'refunded' })
  }
}
```

```ts
import { Body, Controller, Param, Post } from '@nestjs/common'

@Controller('orders')
export class OrdersController {
  // Right: one call. The rule is reachable from a queue consumer and a CLI
  // script, and testable without an HTTP request.
  @Post(':id/refund')
  refund(@Param('id') id: string, @Body() body: RefundDto) {
    return this.orders.refund(id, body.amount)
  }
}
```

The test for whether a controller is too fat is not its length. It is: **could a second caller reach this logic?** A background job that needs to refund an order cannot call an HTTP handler.

### One controller, one resource

A controller maps to a resource, not to a screen. `OrdersController` owns `/orders`; it does not grow a `/orders/dashboard-summary` endpoint because one page needed three things at once. When a client needs a composite, that composition is a use case — give it a service method and its own endpoint, or a [GraphQL](../nestjs-advanced/graphql.md) layer.

### Shaping the response

Return a DTO, not a database row. A row leaking out makes your column names a public API and exports every field you forgot about — including `passwordHash`. [Serialization](../nestjs-validation/serialization.md) covers the interceptor-based way to enforce this once rather than per handler.

## Controllers are providers too

A controller is constructed by the container, so it can inject anything its module can see, and it obeys the same scope rules:

```ts
import { Controller, Scope } from '@nestjs/common'

@Controller({ path: 'orders', scope: Scope.REQUEST })
export class OrdersController {}
```

This is rarely what you want — it makes a new controller instance per request and forces every provider it injects to be request-scoped as well. See [Injection scopes](injection-scopes.md) for the cost.

## Common mistakes

- **Querying the database from a handler.** The query cannot join a transaction the service owns, cannot be reused by a worker, and drags the schema into the JSON layer.
- **Using `@Res()` without `passthrough: true`.** You silently opt out of interceptors, serialization and Nest's own error handling, and a forgotten `res.end()` hangs the request.
- **Trusting `@Param()` and `@Query()` values as typed.** They are strings. A parameter annotated `id: number` is still a string at runtime unless a pipe converted it.
- **`try`/`catch` around a service call to produce a status code.** Throw a Nest exception from the service and let the filter chain map it.
- **Returning entities directly.** Column names become your API and `passwordHash` ships to the client. Return a DTO.
- **Porting an Express 4 catch-all or optional-extension path verbatim.** The bare-asterisk wildcard and the trailing-question-mark optional parameter were both removed in path-to-regexp 8 and now throw at bootstrap — see [Routing and path syntax](routing-and-path-syntax.md) for the replacements.
- **Business decisions inside a handler** ("if the user is an admin, use the other service"). That is a rule; it belongs in a service or a guard.
- **A controller per screen.** Endpoints start duplicating each other and no one can tell which is authoritative.
- **Forgetting that `@Post()` defaults to 201.** A create endpoint returning 200 usually means someone added `@HttpCode(200)` to match a client that guessed wrong.

## Related topics

- [Routing and path syntax](routing-and-path-syntax.md) — the path-to-regexp 8 grammar these decorators compile.
- [Providers and services](providers-and-services.md) — where everything a controller must not do lives instead.
- [The request lifecycle](request-lifecycle.md) — what runs before and after a handler.
- [Pipes](../nestjs-request-handling/pipes.md) — turning strings from the URL into validated values.
- [DTOs](../nestjs-request-handling/dtos.md) — the shapes `@Body()` binds to.
- [Exception filters](../nestjs-request-handling/exception-filters.md) — how a thrown error becomes a status code.
- [Custom decorators](../nestjs-request-handling/custom-decorators.md) — building `@CurrentUser()` instead of reaching for `@Req()`.
- [Serialization](../nestjs-validation/serialization.md) — controlling what leaves the controller.
- [Versioning](../nestjs-request-handling/versioning.md) — the `version` option on `@Controller()`.
- [Layered architecture](../express/layered-architecture.md) — the same thin-controller rule without a framework.
