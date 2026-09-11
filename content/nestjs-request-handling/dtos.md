---
title: DTOs
description: Why a NestJS DTO is a class and a security boundary rather than a type, composing them with @nestjs/mapped-types 12.0.0, and keeping request and response DTOs apart.
status: current
updated: 2026-09-11
---

A DTO is the class that describes one payload crossing your API boundary. In Nest it is not documentation and not a convenience — it is the runtime artifact that decides which fields of a request survive into your service, which is why it has to be a class and why getting it wrong is a vulnerability rather than a type error.

## Why a DTO must be a class

TypeScript types are erased at compile time. An `interface CreateUserDto` leaves nothing behind for `ValidationPipe` to inspect, so `ArgumentMetadata.metatype` is `Object` and validation silently does nothing — the request passes, unvalidated, and every test still goes green.

A class survives compilation, carries `class-validator` metadata via `reflect-metadata`, and is what `ValidationPipe` reflects over.

```ts title="src/users/dto/create-user.dto.ts"
import { IsEmail, IsIn, IsString, Length, MaxLength } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  @MaxLength(254)
  email!: string

  @IsString()
  @Length(12, 128)
  password!: string

  @IsString()
  @MaxLength(80)
  displayName!: string

  @IsIn(['en', 'de', 'fr'])
  locale!: string
}
```

```ts title="src/users/users.controller.ts"
import { Body, Controller, Post } from '@nestjs/common'
import { CreateUserDto } from './dto/create-user.dto.js'

@Controller('users')
export class UsersController {
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)
  }
}
```

The decorators are `class-validator` **0.15.1**; the transformation half is `class-transformer` **0.5.1**. Both are optional peer dependencies of `@nestjs/common@12.0.1`, so you install them yourself. The alternative stack — a Zod schema through `StandardSchemaValidationPipe` — is covered in [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md); the class form is what the rest of this page assumes.

:::note
A DTO class is inert without a `ValidationPipe`. Declaring `@IsEmail()` and never registering the pipe produces a DTO that documents a rule nobody enforces. Register it once globally through `APP_PIPE` — see [Pipes](pipes.md).
:::

## A DTO is a security boundary

The important property of a DTO is not the fields it declares. It is the fields it **excludes**.

```ts vulnerable title="DO NOT COPY"
@Post()
create(@Body() body: Record<string, unknown>) {
  return this.users.create(body)   // whatever the client sent
}
```

```bash
curl -X POST localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"email":"a@example.com","password":"hunter2hunter2","role":"admin","emailVerified":true}'
```

If `users.create()` passes that object to an ORM, the caller just granted themselves `admin` and skipped email verification. That is mass assignment, and the DTO is the control that stops it — but only with the right pipe options:

```ts good title="src/main.ts"
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,            // strip properties with no decorator on the DTO
    forbidNonWhitelisted: true, // ...and reject the request instead of silently stripping
    transform: true,            // hand the handler a real DTO instance
  }),
)

await app.listen(3000)
```

| Option | Without it | With it |
| --- | --- | --- |
| `whitelist: true` | every extra property reaches your service | only decorated properties survive |
| `forbidNonWhitelisted: true` | extras are dropped quietly | a 400 naming the unexpected property |
| `transform: true` | the handler gets a plain object | the handler gets a `CreateUserDto` instance |

`whitelist` is the one that matters. Without it, the DTO declares a shape and enforces nothing about what else came along. `forbidNonWhitelisted` turns a silent strip into a loud failure, which is what you want in development and usually in production too — a client sending fields you do not accept has a bug you would rather hear about.

:::danger
An undecorated property on a DTO is invisible to `whitelist`. Adding `internalNotes!: string` with no `class-validator` decorator does not make it accepted — it makes it stripped — but adding `@IsOptional() @IsString() role!: string` to a DTO "for convenience" makes privilege escalation a one-line change that reads like a feature. Review DTO diffs the way you review authorization code.
:::

The full exploit walkthrough is in [Validation as a security control](../nestjs-security/validation-as-a-control.md) and, framework-independently, in [Mass assignment](../security/mass-assignment.md).

### Type the parameter, but do not trust the type

`@Body() dto: CreateUserDto` is two separate things: a compile-time annotation, and — only if a pipe is bound — a runtime guarantee. They can disagree. A parameter typed as a DTO on a route with no validation pipe is a lie the compiler happily endorses.

## Composing DTOs

`@nestjs/mapped-types` is **12.0.0**. It provides four helpers that derive one DTO class from another, carrying the validation and transformation metadata across.

```bash
npm install @nestjs/mapped-types@12
```

| Helper | Signature | Result |
| --- | --- | --- |
| `PartialType` | `PartialType(Dto, { skipNullProperties })` | every property optional |
| `PickType` | `PickType(Dto, ['a', 'b'])` | only the named properties |
| `OmitType` | `OmitType(Dto, ['a'])` | everything but the named properties |
| `IntersectionType` | `IntersectionType(A, B)` | the union of both classes' properties |

```ts title="src/users/dto/update-user.dto.ts"
import { PartialType, OmitType } from '@nestjs/mapped-types'
import { CreateUserDto } from './create-user.dto.js'

// Everything from CreateUserDto except the password, all optional.
export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['password'] as const)) {}
```

```ts title="src/users/dto/change-password.dto.ts"
import { IsString, Length } from 'class-validator'
import { PickType } from '@nestjs/mapped-types'
import { CreateUserDto } from './create-user.dto.js'

export class ChangePasswordDto extends PickType(CreateUserDto, ['password'] as const) {
  @IsString()
  @Length(12, 128)
  currentPassword!: string
}
```

```ts title="src/orders/dto/list-orders.dto.ts"
import { IntersectionType } from '@nestjs/mapped-types'
import { PaginationDto } from '../../common/dto/pagination.dto.js'
import { OrderFilterDto } from './order-filter.dto.js'

export class ListOrdersDto extends IntersectionType(PaginationDto, OrderFilterDto) {}
```

The helpers compose, and the order reads inside-out: `PartialType(OmitType(Dto, [...]))` removes first, then makes the rest optional.

### `skipNullProperties`

`PartialType` defaults to `skipNullProperties: true`, which applies `@IsOptional()` to every property — and `@IsOptional()` skips validation for `null` **and** `undefined`. So `{"email": null}` passes an update DTO by default.

Pass `skipNullProperties: false` and the helper applies a "validate if defined" rule instead: `undefined` is still skipped, but `null` is validated and therefore rejected.

```ts
// PATCH with {"email": null} → 400, because null is not a valid email.
export class UpdateUserDto extends PartialType(CreateUserDto, { skipNullProperties: false }) {}
```

Which you want depends on whether `null` means "clear this field" in your API. Decide once, and write it down — a PATCH that silently accepts `null` and stores it is a data-corruption bug that only shows up later.

:::warning
If your project uses `@nestjs/swagger`, import `PartialType`, `PickType`, `OmitType` and `IntersectionType` from **`@nestjs/swagger`** instead. Those versions carry the OpenAPI metadata across as well; the `@nestjs/mapped-types` versions only carry validation and transformation metadata, so your generated schema loses the derived properties. Do not mix the two in one project.

`@nestjs/swagger@12.0.1` also exports a `DeepPartialType(classRef, { skipNullProperties })` that has no counterpart in `@nestjs/mapped-types` — it makes nested properties optional too.
:::

## Request DTOs and response DTOs are different objects

The single most common DTO mistake is reusing one class for both directions. They have opposite requirements:

| | Request DTO | Response DTO |
| --- | --- | --- |
| Threat | a client sending fields you did not intend to accept | your service returning fields you did not intend to disclose |
| Enforced by | `ValidationPipe` with `whitelist` | a serializer, or an explicit mapping function |
| Contains | only what a client may set | only what a client may see |
| Optionality | mirrors what the client may omit | mirrors what is always present |

A class that is both ends up with `password` (because create needs it) and gets returned (because it is the same class). Keep them apart:

```ts title="src/users/dto/user-response.dto.ts"
export class UserResponseDto {
  id!: string
  email!: string
  displayName!: string
  locale!: string
  createdAt!: string
}
```

```ts title="src/users/users.service.ts"
import { Injectable } from '@nestjs/common'
import { UserResponseDto } from './dto/user-response.dto.js'
import type { UserRow } from './user.row.js'

@Injectable()
export class UsersService {
  // An explicit allow-list. A new column on UserRow cannot leak through this.
  private toResponse(row: UserRow): UserResponseDto {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      locale: row.locale,
      createdAt: row.created_at.toISOString(),
    }
  }
}
```

:::best-practice
Map to the response DTO **explicitly**, field by field, rather than deleting the sensitive fields from the entity. An allow-list cannot leak a column that was added after it was written; a deny-list (`delete user.passwordHash`) leaks every column someone adds later and forgets. The same argument applies to `@Exclude()` versus `@Expose()` in `class-transformer`.
:::

The serializer-based alternatives — `ClassSerializerInterceptor` with `@Exclude()`/`@Expose()`, and Nest 12's `StandardSchemaSerializerInterceptor` with a schema — are covered in [Serialization](../nestjs-validation/serialization.md). A schema-based response contract has the useful property that it *fails* when the handler returns something unexpected, rather than quietly passing it along.

## Where DTOs live

```text
src/users/
  dto/
    create-user.dto.ts
    update-user.dto.ts
    user-response.dto.ts
  users.controller.ts
  users.service.ts
```

One file per DTO, named `<action>-<entity>.dto.ts`, inside the feature module. Two things to avoid: a shared `src/dto/` directory, which turns every DTO into a cross-module dependency and invites reuse that should not happen; and a DTO that imports an ORM entity, which couples your wire format to your schema and makes a column rename a breaking API change. Layout conventions are in [Project structure](../nestjs/project-structure.md).

## Common patterns

### Nested objects need `@ValidateNested()` and `@Type()`

```ts title="src/orders/dto/create-order.dto.ts"
import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator'
import { OrderLineDto } from './order-line.dto.js'

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[]
}
```

Without `@Type()`, `class-transformer` has no idea what class the array elements should become, so `@ValidateNested()` validates plain objects against nothing. Without `@ArrayMaxSize()`, a client decides how much work your server does.

### Query DTOs need `transform: true`

Query strings are always strings. A `@Query() dto: ListOrdersDto` with `@IsInt() page!: number` fails for `?page=2` unless the pipe transforms — and `transform: true` alone is not enough for primitives, which need `@Type(() => Number)` on the property (or `transformOptions: { enableImplicitConversion: true }`, with the caveats in [Transforming payloads](../nestjs-validation/transforming-payloads.md)).

```ts title="src/common/dto/pagination.dto.ts"
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20
}
```

The `@Max(100)` is not cosmetic: it is the difference between a paginated endpoint and an endpoint that will happily be asked for a million rows.

### Versioned DTOs

When a payload changes incompatibly, add a new DTO rather than loosening the old one. `CreateUserV2Dto` beside `CreateUserDto`, each bound to its own handler through [Versioning](versioning.md), keeps both contracts enforceable. A single DTO with everything optional enforces nothing for either version.

## Common mistakes

- **Using an `interface` as a DTO.** Erased at compile time; `ValidationPipe` has nothing to validate and passes everything.
- **A DTO with no `ValidationPipe` bound.** The annotation is decoration; the request is unvalidated.
- **`ValidationPipe` without `whitelist: true`.** Extra properties reach your service and, from there, your ORM. That is mass assignment.
- **Adding a field to a DTO to make a test pass.** A DTO field is a field clients may set. `role` and `isAdmin` on a request DTO are privilege escalation.
- **One class for request and response.** The password field a create needs is a field the response then discloses.
- **Deleting sensitive fields instead of allow-listing safe ones.** The next column someone adds leaks.
- **Importing mapped types from `@nestjs/mapped-types` in a Swagger project.** The OpenAPI schema loses the derived properties; import from `@nestjs/swagger`.
- **Relying on `PartialType`'s default with `null`.** `@IsOptional()` skips `null` too. Use `{ skipNullProperties: false }` if `null` is not a valid value.
- **`@ValidateNested()` without `@Type()`.** The nested objects are never turned into their class and never validated.
- **Unbounded arrays and unbounded page sizes.** `@ArrayMaxSize()` and `@Max()` are load-shedding, not style.
- **A DTO that extends an ORM entity.** Your database schema becomes your public API contract.
- **Numeric query properties without `@Type(() => Number)`.** They arrive as strings and `@IsInt()` rejects every request.

## Related topics

- [Pipes](pipes.md) — what actually runs the DTO's decorators, and where to bind it.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — every option, and the ones that are security-relevant.
- [class-validator and class-transformer](../nestjs-validation/class-validator.md) — the decorator catalogue.
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — `whitelist` and `forbidNonWhitelisted` in depth.
- [Transforming payloads](../nestjs-validation/transforming-payloads.md) — `@Type()`, implicit conversion and their pitfalls.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the schema-first alternative to DTO classes.
- [Serialization](../nestjs-validation/serialization.md) — turning entities into response DTOs safely.
- [Validation as a security control](../nestjs-security/validation-as-a-control.md) — the threat model these classes exist to address.
- [Versioning](versioning.md) — adding a DTO instead of loosening one.
- [Custom decorators](custom-decorators.md) — why a custom parameter typed as a DTO is not validated by default.
- [Project structure](../nestjs/project-structure.md) — where DTO files belong.
- [Mass assignment](../security/mass-assignment.md) — the same attack in plain Express.
