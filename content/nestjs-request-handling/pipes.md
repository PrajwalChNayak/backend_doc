---
title: Pipes
description: The built-in parse pipes in NestJS 12, writing a PipeTransform, ArgumentMetadata, and binding pipes at parameter, handler and global scope.
status: current
updated: 2026-09-11
---

A pipe is a class with one method that receives a single handler argument and returns the value the handler will actually get. It does two jobs that are really one: turn the string a client sent into the type your code expects, and reject it if it cannot. Everything a pipe touches is one argument — it never sees the request as a whole.

## Why it exists

Route parameters, query strings and headers are always strings. `@Param('id') id: number` is a lie that TypeScript cannot catch, because types are erased before the request arrives. A pipe is the runtime half of that annotation.

The second job follows from the first: a conversion that can fail is a validation. `ParseIntPipe` throws a 400 for `?page=banana` for the same reason it returns a `number` for `?page=2`.

Pipes run at position 4, after guards and interceptors and immediately before the handler. That ordering is deliberate — see [The request lifecycle](../nestjs/request-lifecycle.md) — and it is why a request with both a bad token and a malformed body returns 403 rather than 400.

## Built-in pipes

All of these live in `@nestjs/common`.

| Pipe | Turns | Into | Throws |
| --- | --- | --- | --- |
| `ParseIntPipe` | `'42'` | `42` | 400 on a non-integer |
| `ParseFloatPipe` | `'1.5'` | `1.5` | 400 on a non-number |
| `ParseBoolPipe` | `'true'` / `'false'` | `true` / `false` | 400 on anything else |
| `ParseArrayPipe` | `'a,b,c'` or an array body | an array, optionally of DTOs | 400 per invalid item |
| `ParseEnumPipe` | `'ACTIVE'` | the enum member | 400 when not a member |
| `ParseUUIDPipe` | a UUID string | the same string, validated | 400 on a malformed UUID |
| `ParseDatePipe` | a date string | a `Date` | 400 on an unparseable date |
| `DefaultValuePipe` | `undefined` | the default you supplied | never |
| `ParseFilePipe` | an uploaded file | the same file, validated | 400 (configurable) |
| `ValidationPipe` | a plain object | a validated DTO instance | 400 with the error list |
| `StandardSchemaValidationPipe` | a plain value | the schema's output | 400 with the schema issues |

```ts title="src/users/users.controller.ts"
import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common'

@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.users.findOne(id)
  }

  @Get()
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('size', new DefaultValuePipe(20), ParseIntPipe) size: number,
    @Query('archived', new DefaultValuePipe(false), ParseBoolPipe) archived: boolean,
  ) {
    return this.users.findAll({ page, size, archived })
  }
}
```

Pipes listed on one parameter run **left to right**, which is why `DefaultValuePipe` comes first: it substitutes the default before `ParseIntPipe` sees `undefined`.

### Shared options

Most parse pipes accept the same three options, verified against the 12.0.1 declarations:

| Option | Effect |
| --- | --- |
| `optional` | return `null`/`undefined` unchanged instead of throwing (default `false`) |
| `errorHttpStatusCode` | the status to throw instead of 400 |
| `exceptionFactory` | build the exception yourself from the error string |

```ts
@Get(':id')
findOne(
  @Param('id', new ParseIntPipe({
    errorHttpStatusCode: HttpStatus.NOT_FOUND,
    exceptionFactory: () => new NotFoundException('No such user', { errorCode: 'USER_NOT_FOUND' }),
  }))
  id: number,
) {
  return this.users.findOne(id)
}
```

Returning 404 rather than 400 for a non-numeric id is a small but real improvement: `/users/banana` is not a malformed request, it is a request for something that does not exist, and a 400 tells a crawler to keep trying.

`ParseUUIDPipe` accepts `version: '3' | '4' | '5' | '7'`. Pin it — accepting any version means accepting the nil UUID and other shapes your database never generates.

### `ParseArrayPipe`

The pipe that needs the most explanation, because it does two different things.

```ts title="src/users/users.controller.ts"
import { Body, Controller, Get, ParseArrayPipe, Post, Query } from '@nestjs/common'
import { CreateUserDto } from './dto/create-user.dto.js'

@Controller('users')
export class UsersController {
  // A comma-separated query string: /users?ids=1,2,3
  @Get()
  byIds(@Query('ids', new ParseArrayPipe({ items: Number, separator: ',' })) ids: number[]) {
    return this.users.byIds(ids)
  }

  // A JSON array body, each element validated as a DTO.
  @Post('bulk')
  createMany(@Body(new ParseArrayPipe({ items: CreateUserDto })) users: CreateUserDto[]) {
    return this.users.createMany(users)
  }
}
```

`items` is the type each element becomes. With a DTO class it delegates to `ValidationPipe` internally and reports which index failed. `ParseArrayPipeOptions` extends the `ValidationPipe` options, so `whitelist` and `forbidNonWhitelisted` work here too.

:::warning
`ParseArrayPipe` has no maximum length. A `POST /users/bulk` with 100,000 elements is 100,000 validations and 100,000 inserts. Cap the array in the DTO with `@ArrayMaxSize()` (or the schema equivalent) and cap the request body at the proxy.
:::

### `ParseEnumPipe`

```ts
export enum OrderStatus {
  Pending = 'PENDING',
  Shipped = 'SHIPPED',
  Cancelled = 'CANCELLED',
}
```

```ts
@Get()
byStatus(@Query('status', new ParseEnumPipe(OrderStatus)) status: OrderStatus) {
  return this.orders.byStatus(status)
}
```

The enum object is a constructor argument, not a generic: `new ParseEnumPipe(OrderStatus)`. This is the cheapest allow-list in the framework — a value that is not a member never reaches your query builder.

:::note
`enum` is TypeScript syntax that emits code, so a file using one needs a real compile step. That is already true of every Nest project because decorators need `tsc` too; see [Native TypeScript support](../node/native-typescript-support.md) for why `node --experimental-strip-types` alone is not enough.
:::

### `ParseFilePipe`

Covered in [File uploads](file-uploads.md), including the v12 `FileTypeValidator` that checks magic numbers rather than the client's `Content-Type`.

## Writing a pipe

```ts title="src/common/pipes/trim.pipe.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common'

@Injectable()
export class TrimPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${metadata.data ?? 'value'} must be a string`, {
        errorCode: 'NOT_A_STRING',
      })
    }
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      throw new BadRequestException(`${metadata.data ?? 'value'} must not be blank`, {
        errorCode: 'BLANK_VALUE',
      })
    }
    return trimmed
  }
}
```

`transform()` may be `async` — Nest awaits the result — so a pipe can hit a cache or a database. Think before it does: a pipe runs on every request to the route and a slow pipe is a slow route with no obvious cause in a profile.

A pipe that throws anything reaches the [exception filters](exception-filters.md) like any other exception. Throwing `BadRequestException` with an `errorCode` gives clients something stable to branch on.

### `ArgumentMetadata`

The second parameter tells the pipe what it is looking at.

```ts
interface ArgumentMetadata<Metatype = any> {
  readonly type: 'body' | 'query' | 'param' | 'custom'
  readonly metatype?: Type<Metatype>
  readonly data?: string
  readonly schema?: StandardSchemaV1
}
```

| Field | Value for `@Query('page') page: number` |
| --- | --- |
| `type` | `'query'` |
| `metatype` | `Number` |
| `data` | `'page'` |
| `schema` | the Standard Schema, when one was attached to the parameter |

`metatype` is `undefined` when the parameter has no type annotation, when the type is an interface (interfaces are erased), or when a custom param decorator produced the value. That last case is the reason a global `ValidationPipe` silently does nothing on `@CurrentUser() user: UserDto` — see [Custom decorators](custom-decorators.md).

The `schema` field is new in Nest 12 and carries the Standard Schema attached through `@Body({ schema })`; it is what `StandardSchemaValidationPipe` reads.

## Binding pipes

Four scopes, narrowest first.

```ts title="src/users/users.controller.ts"
// Scope 3 — one controller: every handler in the class.
@UsePipes(new ValidationPipe({ whitelist: true }))
@Controller('users')
export class UsersController {
  // Scope 1 — one parameter: the most precise, and the only one that can
  // differ per argument.
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(id)
  }

  // Scope 2 — one handler: applies to every argument of the method.
  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)
  }
}
```

```ts title="src/app.module.ts"
// Scope 4 — global, with dependency injection.
import { Module, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
```

| Binding | Dependency injection | Scope |
| --- | --- | --- |
| `@Param('id', ParseIntPipe)` (class) | yes | one argument |
| `@Param('id', new ParseIntPipe())` (instance) | **no** | one argument |
| `@UsePipes(Class)` | yes | handler or controller |
| `APP_PIPE` provider | yes | every argument of every route |
| `app.useGlobalPipes(new ValidationPipe())` | **no** | every argument of every route |

Parameter-level pipes run **after** the global, controller and handler pipes for that argument. Every pipe that applies to an argument runs; they do not override each other.

:::best-practice
Register `ValidationPipe` once, globally, through `APP_PIPE`, and use parameter-level pipes only for the per-argument parsing that a global pipe cannot express. A `@UsePipes(new ValidationPipe())` repeated on forty controllers is forty places to forget `whitelist: true`.
:::

## Validation belongs on its own page

`ValidationPipe` and `StandardSchemaValidationPipe` are pipes, but they are big enough to be their own topic. What options to set, why `whitelist: true` is the one that matters, how `transform` interacts with `class-transformer`, and how to choose between class-validator and a Zod schema are all in:

- [The ValidationPipe](../nestjs-validation/validation-pipe.md)
- [class-validator and class-transformer](../nestjs-validation/class-validator.md)
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md)
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md)

This page stops at the pipe mechanism.

## Common patterns

### Coercion is not validation

`ParseIntPipe` guarantees an integer. It does not guarantee a *sensible* integer: `?size=999999999` parses fine and then asks your database for a billion rows. Bound the value as well as the type.

```ts title="src/common/pipes/positive-int.pipe.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common'

@Injectable()
export class BoundedIntPipe implements PipeTransform<unknown, number> {
  private readonly min: number
  private readonly max: number

  constructor(min: number, max: number) {
    this.min = min
    this.max = max
  }

  transform(value: unknown, metadata: ArgumentMetadata): number {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < this.min || parsed > this.max) {
      throw new BadRequestException(
        `${metadata.data ?? 'value'} must be an integer between ${this.min} and ${this.max}`,
        { errorCode: 'OUT_OF_RANGE' },
      )
    }
    return parsed
  }
}
```

```ts
@Get()
findAll(@Query('size', new DefaultValuePipe(20), new BoundedIntPipe(1, 100)) size: number) {
  return this.users.findAll({ size })
}
```

A pipe that takes constructor arguments must be bound as an **instance**, which means it gets no injection. If it also needs a provider, make the bounds a class property instead and bind the class.

### A pipe with dependencies

```ts title="src/common/pipes/tenant-exists.pipe.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import type { PipeTransform } from '@nestjs/common'
import { TenantsService } from '../../tenants/tenants.service.js'

@Injectable()
export class TenantExistsPipe implements PipeTransform<string, Promise<string>> {
  private readonly tenants: TenantsService

  constructor(tenants: TenantsService) {
    this.tenants = tenants
  }

  async transform(value: string): Promise<string> {
    if (!(await this.tenants.exists(value))) {
      throw new NotFoundException('Unknown tenant', { errorCode: 'TENANT_NOT_FOUND' })
    }
    return value
  }
}
```

Bind it by class — `@Param('tenant', TenantExistsPipe)` — so Nest resolves `TenantsService` from the container. This is legitimate, but notice what it costs: an extra round-trip on every request, and a lookup the handler will very likely repeat. Prefer a single query in the service when the handler needs the row anyway.

### Pipes do not see the whole request

`@Body()` with no argument gives a pipe the entire parsed body, which is as close as it gets, but a pipe still cannot read a header to decide how to treat the body. Cross-field rules that span `@Body()` and `@Query()` belong in the handler or the service — or in a DTO that carries both, so one `ValidationPipe` run sees everything.

## Common mistakes

- **Trusting `@Param('id') id: number` without a pipe.** It is a string at runtime. `id === 1` is `false`.
- **Putting `ParseIntPipe` after `DefaultValuePipe` in the wrong order.** Pipes run left to right; the default has to be substituted first or the parse pipe sees `undefined`.
- **Assuming a parse pipe bounds the value.** `ParseIntPipe` accepts `999999999`. Add a range check.
- **`new SomePipe()` for a pipe that injects a provider.** Instances bypass the container. Bind the class.
- **Expecting a global `ValidationPipe` to validate a custom param decorator's output.** `metatype` is absent for custom parameters, and `StandardSchemaValidationPipe` skips them entirely unless `validateCustomDecorators: true`.
- **Repeating `@UsePipes(new ValidationPipe())` on every controller.** One `APP_PIPE` provider, one set of options.
- **Doing database work in a pipe on a hot route.** It runs before the handler, on every request, and often duplicates a query the handler makes anyway.
- **Using an interface as a DTO type.** Interfaces are erased; `metatype` is `Object` and validation does nothing. Use a class.
- **`ParseArrayPipe` with no size cap.** An unbounded array is an unbounded amount of work.
- **Letting `ParseUUIDPipe` accept any version.** Pin the version your system actually issues.
- **Returning a different type than the handler's annotation claims.** A pipe's return value is what the handler gets; nothing checks that it matches the annotation.

## Related topics

- [The request lifecycle](../nestjs/request-lifecycle.md) — why pipes run after guards, not before.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — the options that actually matter, in depth.
- [class-validator and class-transformer](../nestjs-validation/class-validator.md) — the decorators behind DTO validation.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the v12 alternative and `StandardSchemaValidationPipe`.
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — stripping fields the DTO did not declare.
- [DTOs](dtos.md) — why the class the pipe validates is a security boundary.
- [Custom decorators](custom-decorators.md) — why a custom param decorator's value skips validation by default.
- [File uploads](file-uploads.md) — `ParseFilePipe`, `MaxFileSizeValidator` and `FileTypeValidator`.
- [Exception filters](exception-filters.md) — what turns a pipe's exception into a response body.
- [Guards](guards.md) — the stage that runs first and can stop the request before any parsing.
- [Testing guards, pipes and interceptors](../nestjs-testing/testing-the-pipeline.md) — unit-testing `transform()`.
- [Validation](../express-libraries/validation.md) — the same problem in plain Express, with Zod and express-validator.
