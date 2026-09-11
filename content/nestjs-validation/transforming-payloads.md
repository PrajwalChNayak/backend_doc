---
title: Transforming payloads
description: What transform, enableImplicitConversion, @Type() and @Transform() really do in NestJS 12, how query and param strings become numbers, and how the Standard Schema pipe's transform differs.
status: current
updated: 2026-09-11
---

Validation answers "is this acceptable". Transformation answers "what does my handler actually receive". The two run in the same pipe, in that order, and most of the confusion about `ValidationPipe` comes from assuming one option controls both.

NestJS 12 has two transformation stories, matching the two validation stacks: `class-transformer` 0.5.1 driven by `transform` and `transformOptions`, and the schema's own output under `StandardSchemaValidationPipe`.

## What `transform: true` actually does

With `transform: false` — the default — the pipe validates a temporary instance and then hands your handler the **original plain object**. Every `@Type()` conversion, every getter, every `@Transform()` is discarded.

With `transform: true`, the pipe returns the instance it built:

```ts title="src/main.ts"
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  }),
)
```

Concretely, `transform: true` gives you three things:

1. **A real instance.** `body instanceof CreateUserDto` is true, so methods and getters on the DTO work.
2. **Applied conversions.** `@Type(() => Number)` and `@Transform()` survive into the handler.
3. **Primitive conversion on named path and query parameters** — a narrower feature than it sounds, covered below.

It does **not** strip unknown keys. That is `whitelist`. The two are independent options that people routinely conflate, and `transform: true, whitelist: false` is a validated object with every extra key still attached.

:::note The `transform: false` path is subtler than "returns the input"
When validation succeeds and `transform` is off, the pipe returns the original value — unless you passed more than one validator option, in which case it returns a `classToPlain()` of the validated instance instead. That is an implementation detail you should never have to reason about, and the way to never reason about it is to set `transform: true` and move on.
:::

## Primitive conversion for path and query parameters

Everything in a URL is a string. `@Param('id') id: number` is `'42'` at runtime, not `42`, and `typeof id === 'string'` no matter what the annotation says.

`transform: true` fixes this, but only under three conditions, all of which come from the pipe's own `transformPrimitive` step:

- the parameter names a property — `@Param('id')` or `@Query('page')`, **not** bare `@Param()` or `@Query()`;
- the parameter type is `param` or `query` — never `body`;
- the reflected metatype is `Number`, `Boolean` or `String`.

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param, Query } from '@nestjs/common'

@Controller('users')
export class UsersController {
  // id is a real number: metadata.data is 'id', type is 'param', metatype is Number
  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.users.findOne(id)
  }

  // page is a real number for the same three reasons
  @Get()
  list(@Query('page') page: number) {
    return this.users.list({ page })
  }
}
```

The conversion rules are exactly as narrow as they look. `Number` is `+value`, so a non-numeric string becomes `NaN` and is handed to your handler — `transform` converts, it does not validate. `Boolean` is `value === true || value === 'true'`, so every other string is `false`. Both return `undefined` unchanged rather than producing `NaN` or `false` for an absent optional parameter.

A **bare** `@Query() query: ListUsersQueryDto` gets none of this, because `metadata.data` is empty — the pipe leaves top-level query and param objects alone and validates the DTO instead. That is where `@Type()` comes in.

:::best-practice
For a single parameter that must be a valid number, prefer `ParseIntPipe` over `transform`. `@Param('id', ParseIntPipe)` returns a 400 for `abc`; `@Param('id') id: number` with `transform: true` returns `NaN` and lets your query run with it.
:::

## Converting fields inside a DTO with `@Type()`

`@Type()` is `class-transformer`'s explicit, per-property conversion. It is the right tool for a query DTO, because query values arrive as strings but the DTO declares numbers.

```ts title="src/users/dto/list-users-query.dto.ts"
import { Transform, Type } from 'class-transformer'
import { IsBoolean, IsInt, IsOptional, Max, MaxLength, Min } from 'class-validator'

export class ListUsersQueryDto {
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
  perPage: number = 20

  @IsOptional()
  @MaxLength(200)
  q?: string

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  includeArchived: boolean = false
}
```

```ts title="src/users/users.controller.ts"
@Get()
list(@Query() query: ListUsersQueryDto) {
  // page and perPage are numbers; includeArchived is a real boolean.
  return this.users.list(query)
}
```

Note that `@Type()` runs before validation, so `@IsInt()` checks the converted value. `?page=abc` becomes `NaN`, and `@IsInt()` rejects it with a 400 — which is the behavior you want and the reason `@Type()` plus a constraint beats `@Type()` alone.

`@Type()` has a second, unrelated job: telling `class-transformer` which class a nested object is, so `@ValidateNested()` has something to descend into. That use is covered on [class-validator and class-transformer](class-validator.md), and it is not optional.

## Custom conversions with `@Transform()`

`@Transform()` takes a function and replaces the property's value with its result.

```ts title="src/users/dto/create-user.dto.ts"
import { Transform } from 'class-transformer'
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateUserDto {
  // Normalize before validating: the constraint sees the trimmed, lowercased value.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName: string
}
```

Two rules keep `@Transform()` out of trouble.

**Guard the type.** The callback receives whatever the client sent. `value.trim()` on a number throws a `TypeError` inside the pipe, which surfaces as a 500 — an unhandled crash on a route whose whole job was to reject bad input. Check the type first, let the value through unchanged, and let the constraint produce the 400.

**Normalize, do not repair.** Trimming whitespace and lowercasing an email are normalizations: the client's intent is unambiguous and you are removing noise. Turning `"12"` into `12` in a JSON body is a repair, and it hides a client bug that will surface later as something harder to diagnose. Coerce at the boundary where the type was genuinely lost — the URL — and nowhere else.

## `transformOptions` and `enableImplicitConversion`

`transformOptions` is a `ClassTransformOptions` object passed straight to `class-transformer`.

| Option | Default | Effect |
| --- | --- | --- |
| `enableImplicitConversion` | `false` | Converts every property using its reflected design-time type. See the warning below. |
| `excludeExtraneousValues` | `false` | Keeps only properties marked `@Expose()`. An allowlist, mostly used for responses. |
| `exposeDefaultValues` | `false` | Applies a class field's default when the input omits it. |
| `strategy` | `'exposeAll'` | `'excludeAll'` inverts the default so only `@Expose()` properties survive. |
| `groups` | — | Only transforms properties tagged with these groups. |
| `excludePrefixes` | — | Drops properties starting with the given prefixes, e.g. `['_']`. |
| `ignoreDecorators` | `false` | Ignores every `@Expose()`/`@Exclude()`. |
| `enableCircularCheck` | `false` | Guards against a cycle in the object graph. |
| `exposeUnsetFields` | `true` | Whether `undefined` fields appear in a class-to-plain conversion. |

### Why `enableImplicitConversion` is a trap

It looks like the option that makes query DTOs work without `@Type()` everywhere. It is, and that is the problem: it converts **every** property, globally, using `String()`, `Number()` or `Boolean()` on the reflected type — before any constraint runs.

:::danger Implicit conversion disarms your type constraints
```ts vulnerable title="DO NOT COPY — with enableImplicitConversion on"
export class CreateInvoiceDto {
  // The client sends {"reference": 4001}. Implicit conversion calls
  // String(4001) => "4001", and @IsString() then passes.
  @IsString()
  reference: string

  // The client sends {"paid": "false"}. Implicit conversion calls
  // Boolean("false") => true, and @IsBoolean() passes on `true`.
  @IsBoolean()
  paid: boolean

  // The client sends {"amount": ""}. Number("") => 0, so @IsNumber()
  // passes and the invoice is created for zero.
  @IsNumber()
  amount: number
}
```

Every one of those is a 200 where you expected a 400.
:::

`@IsString()`, `@IsBoolean()` and `@IsNumber()` are type assertions, and implicit conversion satisfies the assertion by changing the value first. The constraint you added specifically to catch a wrong type can no longer catch it.

```ts good title="src/main.ts"
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // Convert explicitly, per property, with @Type() — where you can see it.
    transformOptions: { enableImplicitConversion: false },
  }),
)
```

Three more things to know before you turn it on anyway:

- It reads `design:type` from `reflect-metadata`, so it needs `emitDecoratorMetadata`. Lose that in a build change and the option silently stops doing anything — including on the query DTOs that were relying on it.
- It cannot be scoped. There is no per-property opt-out; it is on for the whole pipe.
- A union-typed property has no single reflected type, so what it converts to is not something you can reason about from the DTO.

:::warning `Boolean('false')` is `true`
This is not a class-transformer quirk, it is JavaScript: every non-empty string is truthy. Any implicit boolean conversion of a query flag inverts the meaning of `?archived=false`. Convert booleans explicitly — `@Transform(({ value }) => value === 'true')` — in both stacks.
:::

## The dedicated parse pipes

For a single value, a purpose-built pipe is clearer than DTO-wide transformation and, unlike `transform`, it **rejects** bad input instead of producing `NaN`.

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
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findOne(id)
  }

  @Get(':id/invoices')
  invoices(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('paid', new DefaultValuePipe(false), ParseBoolPipe) paid: boolean,
  ) {
    return this.invoices.list(id, { page, paid })
  }
}
```

`@nestjs/common` 12.0.1 ships `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseArrayPipe`, `ParseUUIDPipe`, `ParseEnumPipe`, `ParseDatePipe` and `DefaultValuePipe`. Order matters: `DefaultValuePipe` must come first, so the parser receives the substituted value rather than `undefined`.

`ParseBoolPipe` accepts only `'true'` and `'false'` and throws otherwise — which is precisely the behavior `Boolean()` does not give you.

## Transformation in the Standard Schema stack

`StandardSchemaValidationPipe` has one transformation option, and it means something different.

```ts
interface StandardSchemaValidationPipeOptions {
  transform?: boolean   // default true
  // …
}
```

With `transform: true` (the default), the pipe returns **the schema's output value** — the result of `~standard.validate()`. Everything the schema does to the value is what your handler receives:

```ts title="src/users/schemas/list-users.schema.ts"
import { z } from 'zod'

export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export type ListUsers = z.infer<typeof listUsersSchema>
```

`z.infer` gives you the **output** type, so `page` is `number` and `includeArchived` is `boolean` in the handler even though both arrived as strings. The schema and the type describe the same transformation, which is the structural advantage over `@Type()`: there is no way for the annotation and the conversion to disagree.

Note the explicit `z.enum(['true','false']).transform(…)` rather than `z.coerce.boolean()`. Zod's boolean coercion is `Boolean(value)`, so it has the same `'false'` problem as `class-transformer`.

### The differences that matter

| | `ValidationPipe` `transform` | `StandardSchemaValidationPipe` `transform` |
| --- | --- | --- |
| Default | `false` | `true` |
| `true` returns | An instance of the DTO class, built by `plainToInstance` | The schema's output value, a plain object |
| `false` returns | The original input (with a `classToPlain` edge case) | The original input, always |
| Conversion is declared | Per property, with `@Type()` / `@Transform()` | Inside the schema, with `z.coerce` / `.transform()` / `.default()` |
| Named-parameter coercion | Built in for `@Param('x')` / `@Query('x')` | None — the schema does it |
| Config location | On the pipe, globally | In the schema, per route |

:::warning `transform: false` on the schema pipe discards the schema's work
It does not skip the transformation — the schema still runs, and the pipe throws the result away and returns the input. Defaults, coercions and `.transform()` all silently stop reaching the handler. The option exists for the case where you want validation as a gate and the raw value downstream; it is almost never what you want.
:::

### `@Param()` and `@Query()` with a schema

There is no primitive-conversion special case on this pipe, and no need for one: coerce in the schema and it applies to every parameter uniformly.

```ts title="src/users/users.controller.ts"
import { Controller, Get, Query } from '@nestjs/common'
import { listUsersSchema } from './schemas/list-users.schema.js'
import type { ListUsers } from './schemas/list-users.schema.js'

@Controller('users')
export class UsersController {
  @Get()
  list(@Query({ schema: listUsersSchema }) query: ListUsers) {
    return this.users.list(query)
  }
}
```

Use `z.coerce` on query, params and headers. Do not use it inside a JSON body schema, for the same reason you should not implicitly convert there: the client already had real types, and `{"quantity":"12"}` is a client bug worth reporting rather than repairing.

## Security considerations

**Transformation is not validation, and it runs first.** Converting `"abc"` to `NaN` or `"false"` to `true` produces a value your constraints may then accept. Anywhere you convert, constrain the converted value — `@Type(() => Number)` with `@IsInt()`, never `@Type(() => Number)` alone.

**`enableImplicitConversion: true` defeats type constraints.** `@IsString()`, `@IsNumber()` and `@IsBoolean()` exist to reject a wrong-typed value; implicit conversion changes the value so the check passes. Leave it off, and convert explicitly where you can see it in review.

**A `@Transform()` callback runs on attacker-controlled input, inside the pipe.** An unguarded `value.trim()`, `value.split()` or `JSON.parse(value)` turns a malformed request into a 500 and, with a verbose error filter, into a stack trace. Guard the type and return the value unchanged so the constraint can produce a clean 400.

**`transform: true` does not strip unknown keys.** It builds an instance; unknown properties are still copied onto it unless `whitelist: true` removed them. See [Whitelisting and unknown properties](unknown-properties.md).

**Transformation costs CPU proportional to input size.** A deeply nested `plainToInstance` over a large array is work an attacker chooses for you. Bound arrays with `@ArrayMaxSize()` or `.max()`, and cap the body on the parser — the pipe runs after the payload is already in memory.

**Do not transform secrets into a shape that leaks.** A `@Transform()` that decodes a token or expands an identifier puts that value on the DTO instance, which is what a `ValidationError` carries and what an error logger serializes. Set `validationError: { value: false }` on the pipe. See [Safe logging](../nestjs-security/safe-logging.md).

## Production considerations

**`transform: true` costs an object construction per request.** It is worth it for the correctness it buys, but on a hot route with a large nested DTO it is measurable. Measure before assuming — see [Performance](../nestjs-production/performance.md).

**Keep one pipe configuration.** Three different `new ValidationPipe({...})` calls mean three different coercion behaviors, and a reader cannot tell which applies to the route in front of them.

**Decide coercion policy once: URL yes, body no.** Write it down. It is the rule that keeps "why did this accept a string" out of your incident reviews.

**Verify decorator-metadata emission after any build change.** `@Type()` and implicit conversion both depend on it. Losing it does not fail the build; it changes what your API accepts. Switching to SWC or esbuild is exactly when this happens.

**Prefer a parse pipe on a single parameter.** It is one import, it rejects instead of producing `NaN`, and it does not require the reader to know the global pipe's configuration.

## Common mistakes

- **Expecting `transform: true` to strip unknown keys.** Stripping is `whitelist`; `transform` is construction.
- **Leaving `transform` at its `false` default** and wondering why `@Type()` and `@Transform()` have no effect in the handler.
- **`@Param('id') id: number` with no constraint.** `abc` arrives as `NaN` and the handler runs with it. Use `ParseIntPipe`.
- **Expecting primitive conversion on a bare `@Query()` or `@Body()`.** It only applies to a *named* param or query parameter with a `Number`, `Boolean` or `String` metatype.
- **Turning on `enableImplicitConversion` to avoid writing `@Type()`.** It makes `@IsString()`, `@IsNumber()` and `@IsBoolean()` unable to reject a wrong type.
- **Relying on any implicit boolean conversion.** `Boolean('false')` is `true`, in `class-transformer` and in `z.coerce.boolean()` alike.
- **An unguarded `@Transform()` callback.** A non-string input throws inside the pipe and becomes a 500.
- **Coercing inside a JSON body schema or DTO.** It repairs client bugs into silence.
- **Putting `DefaultValuePipe` after `ParseIntPipe`.** The parser sees `undefined` and throws.
- **Assuming the schema pipe's `transform: false` means "no transformation".** It runs the schema and discards the result.
- **Writing a hand-typed interface for a schema with `.transform()` in it.** `z.infer` gives the output type; a hand-written one will describe the input.

## Related topics

- [The ValidationPipe](validation-pipe.md) — every option on the pipe, including `transformOptions`.
- [class-validator and class-transformer](class-validator.md) — `@Type()` for nested classes, and why it pairs with `@ValidateNested()`.
- [Standard Schema with Zod](standard-schema-with-zod.md) — the schema stack and its `transform` semantics.
- [Whitelisting and unknown properties](unknown-properties.md) — the option `transform` is constantly confused with.
- [Serialization](serialization.md) — `class-transformer` running in the other direction, on responses.
- [Choosing an approach](choosing-an-approach.md) — which stack's transformation model fits your project.
- [Pipes](../nestjs-request-handling/pipes.md) — the parse pipes and how to write your own.
- [Custom decorators](../nestjs-request-handling/custom-decorators.md) — why `validateCustomDecorators` exists.
- [Validation](../express-libraries/validation.md) — `z.coerce` and its edge cases, outside Nest.
