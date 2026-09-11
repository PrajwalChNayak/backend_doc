---
title: Standard Schema with Zod
description: The schema-first validation stack new in NestJS 12 — StandardSchemaValidationPipe with Zod 4, Valibot or ArkType, attached per parameter and typed with z.infer.
status: current
updated: 2026-09-11
---

NestJS 12 added a second validation stack. `StandardSchemaValidationPipe` takes a schema from the parameter decorator instead of a DTO class, validates against it, and hands your handler the schema's output. It works with any library that implements the [Standard Schema](https://github.com/standard-schema/standard-schema) spec — Zod 4.5.4, Valibot 1.4.2 and ArkType 2.2.3 all do.

This is the schema-first alternative to [the ValidationPipe](validation-pipe.md). It does not replace it; both ship in `@nestjs/common` 12.0.1 and both can be registered at once. [Choosing an approach](choosing-an-approach.md) is the page that argues about which one you should use.

## Why it exists

The classic stack needs a class, decorator metadata, `experimentalDecorators`, `emitDecoratorMetadata`, and two pre-1.0 peer dependencies. That is a lot of machinery to say "this body has an email and a display name".

A Standard Schema is a plain value. There is no metadata emit, no reflection, no class to construct — the schema carries its own validator under a `~standard` property, and Nest calls it. The type you program against is *derived from* the schema, so the two cannot drift apart.

`@standard-schema/spec` 1.1.0 is the shared interface. It is a types-only package: the schema libraries implement it, and Nest consumes it.

## Installation

Only the schema library is an actual runtime dependency. `@standard-schema/spec` ships types, and `@nestjs/common` already declares it.

:::tabs
@tab npm
```bash
npm install zod@4
```
@tab pnpm
```bash
pnpm add zod@4
```
@tab yarn
```bash
yarn add zod@4
```
:::

Nothing in this stack needs `reflect-metadata`, `class-validator`, `class-transformer`, or `emitDecoratorMetadata`. Nest's own decorators still need `experimentalDecorators` and a real compile step, so the tsconfig is unchanged from any other Nest project — you just stop depending on metadata emit for *validation*.

## Basic example

The schema is an ordinary module-level value.

```ts title="src/users/schemas/create-user.schema.ts"
import { z } from 'zod'

export const createUserSchema = z.strictObject({
  email: z.email(),
  displayName: z.string().min(1).max(80),
  age: z.int().min(13).max(150).optional(),
})

// The type is derived, not declared. It cannot disagree with what runs.
export type CreateUser = z.infer<typeof createUserSchema>
```

Attach it to the parameter with the `schema` option on `@Body()`:

```ts title="src/users/users.controller.ts"
import { Body, Controller, Post } from '@nestjs/common'
import { createUserSchema } from './schemas/create-user.schema.js'
import type { CreateUser } from './schemas/create-user.schema.js'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Post()
  create(@Body({ schema: createUserSchema }) body: CreateUser) {
    return this.users.create(body)
  }
}
```

Then register the pipe once, globally:

```ts title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { StandardSchemaValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.useGlobalPipes(new StandardSchemaValidationPipe())

await app.listen(3000)
```

```bash
curl -sS -X POST localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"email":"not-an-email","displayName":"","role":"admin"}'
```

```json title="400 Bad Request"
{
  "message": [
    "email: Invalid email address",
    "displayName: Too small: expected string to have >=1 characters",
    "role: Unrecognized key: \"role\""
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

The `path: message` prefix is the pipe's own default formatting — it joins each issue's `path` with `.` and prefixes the message. There is no field-keyed object in the default body; if you want one, write an `exceptionFactory`.

:::best-practice
Register the pipe globally and attach a schema per parameter. A parameter with no `schema` is passed straight through untouched, so "forgot the schema" is silent — the same opt-in-security problem a per-route `ValidationPipe` has. Decide on it once and enforce it in review, or keep the global `ValidationPipe` alongside as a backstop for class DTOs.
:::

### Registering it as a provider

As with any Nest pipe, `APP_PIPE` puts it in the container so tests that build from `AppModule` get it too:

```ts title="src/app.module.ts"
import { Module, StandardSchemaValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () => new StandardSchemaValidationPipe(),
    },
  ],
})
export class AppModule {}
```

A pipe bound only in `main.ts` does not exist in an end-to-end test that instantiates the module graph directly. That is how a suite ends up asserting 201 on payloads production rejects.

## The options

```ts
interface StandardSchemaValidationPipeOptions {
  transform?: boolean                  // default true
  validateCustomDecorators?: boolean   // default false
  validateOptions?: Record<string, unknown>
  errorHttpStatusCode?: ErrorHttpStatusCode   // default 400
  exceptionFactory?: (issues: readonly StandardSchemaV1.Issue[]) => any
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `transform` | `true` | Returns the schema's **output** value. With `false`, the input is returned unchanged after a successful validation. |
| `validateCustomDecorators` | `false` | Also validates parameters produced by `createParamDecorator`. Off, those are skipped. |
| `validateOptions` | — | Forwarded as the second argument to the schema's `~standard.validate()`. |
| `errorHttpStatusCode` | `400` | Status used by the default exception. Ignored when you supply `exceptionFactory`. |
| `exceptionFactory` | — | Receives the issue array and returns the exception to throw. |

That is the whole surface. There is no `whitelist`, no `forbidNonWhitelisted`, no `groups`, no `skipMissingProperties` — those are `ValidationPipe` concepts, and their equivalents live in the schema itself (`z.strictObject()`, `.optional()`, a second schema).

:::warning `transform: false` is not "don't transform"
It means *discard* the transform. The pipe still runs the schema, still applies coercions and defaults, and then throws that result away and gives your handler the original input. A schema with `.default()`, `.transform()` or `z.coerce` silently stops having any effect on what the handler sees. Leave it at `true` unless you have a specific reason.
:::

## Error handling with `exceptionFactory`

The default body is a `message` array of strings. A machine client wants a path and a code.

```ts title="src/common/schema-exception.factory.ts"
import { BadRequestException } from '@nestjs/common'
import type { StandardSchemaV1 } from '@standard-schema/spec'

function pathOf(issue: StandardSchemaV1.Issue): string {
  if (!issue.path?.length) return ''
  return issue.path
    .map((segment) => (typeof segment === 'object' && segment !== null ? segment.key : segment))
    .map(String)
    .join('.')
}

export function schemaExceptionFactory(issues: readonly StandardSchemaV1.Issue[]) {
  return new BadRequestException(
    {
      error: 'validation_failed',
      issues: issues.map((issue) => ({ path: pathOf(issue), message: issue.message })),
    },
    { errorCode: 'VALIDATION_FAILED' },
  )
}
```

```ts title="src/main.ts"
app.useGlobalPipes(
  new StandardSchemaValidationPipe({ exceptionFactory: schemaExceptionFactory }),
)
```

The `pathOf` helper is not defensive programming for its own sake. The spec allows a path segment to be either a `PropertyKey` or a `{ key }` object, and the pipe's built-in formatter calls `String()` on the segment — so a library that reports object segments produces `[object Object]` in the default message. Zod reports plain keys and looks fine; read your library's output before you trust the default.

:::note Zod has a formatter that takes the raw issues
`z.prettifyError()` accepts a Standard Schema failure result, so `z.prettifyError({ issues })` turns the pipe's argument straight into a human-readable string. It is excellent in a log line and wrong in an API response, which wants structure rather than prose.
:::

An `exceptionFactory` overrides `errorHttpStatusCode` completely — the factory decides the status, because it returns the exception. Returning a `422` there and leaving `errorHttpStatusCode: 400` set is not a conflict; the option is simply unused.

## Query strings and route parameters

`@Query()` and `@Param()` take the same `schema` option. Everything arriving there is a string, so this is where coercion earns its keep:

```ts title="src/users/schemas/list-users.schema.ts"
import { z } from 'zod'

export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).optional(),
})

export type ListUsers = z.infer<typeof listUsersSchema>

export const userIdSchema = z.strictObject({ id: z.uuid() })
```

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param, Query } from '@nestjs/common'
import { listUsersSchema, userIdSchema } from './schemas/list-users.schema.js'
import type { ListUsers } from './schemas/list-users.schema.js'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get()
  list(@Query({ schema: listUsersSchema }) query: ListUsers) {
    return this.users.list(query)
  }

  @Get(':id')
  findOne(@Param({ schema: userIdSchema }) params: { id: string }) {
    return this.users.findOne(params.id)
  }
}
```

Two things make this nicer than the class stack here. The defaults are applied by the schema, so `page` is a real `number` with a real value, not `undefined` waiting for a `??` in the handler. And `z.object()` rather than `z.strictObject()` on a query schema tolerates the `utm_*` parameters that marketing will add without telling you.

Coercion belongs on query and params only. In a JSON body the client already has real types, and `{"quantity":"12"}` should be a 400 rather than a silently repaired `12`. The Zod 4 API — `z.email()`, `z.coerce`, the `strictObject`/`looseObject` split, `z.treeifyError` — is covered in full on [Validation](../express-libraries/validation.md); everything there applies unchanged inside Nest.

## Any Standard Schema library

"Standard Schema" is not a Zod feature. The pipe reads `schema['~standard'].validate(value, options)` and nothing else, so any conforming library drops in with no adapter.

### Valibot

```ts title="src/users/schemas/create-user.valibot.ts"
import * as v from 'valibot'

export const createUserSchema = v.strictObject({
  email: v.pipe(v.string(), v.email()),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  age: v.optional(v.pipe(v.number(), v.integer(), v.minValue(13), v.maxValue(150))),
})

export type CreateUser = v.InferOutput<typeof createUserSchema>
```

Valibot's selling point is bundle size: every validation is a separately imported function, so a build only pays for the ones used. That matters far less on a server than in a browser, which is worth knowing before you pick it for an API.

### ArkType

```ts title="src/users/schemas/create-user.arktype.ts"
import { type } from 'arktype'

export const createUserSchema = type({
  email: 'string.email',
  displayName: 'string <= 80',
  'age?': 'number.integer >= 13',
}).onUndeclaredKey('reject')

export type CreateUser = typeof createUserSchema.infer
```

ArkType writes constraints as TypeScript-like strings and infers the static type from them. `.onUndeclaredKey('reject')` is its `strictObject`.

The controller code is identical in all three cases — `@Body({ schema: createUserSchema })`. That is the whole point of the spec: the pipe does not know or care which library produced the schema.

:::tip Pick one and stay there
Mixing schema libraries inside one service gets you three error-issue shapes to normalize in one `exceptionFactory`, three sets of coercion semantics, and three dependencies to audit. The interoperability is there so the *framework* does not have to choose, not so that you avoid choosing.
:::

## Running both stacks together

They coexist, and the reason is mechanical rather than lucky.

```ts title="src/main.ts"
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  new StandardSchemaValidationPipe(),
)
```

`StandardSchemaValidationPipe` returns the value untouched when the parameter has no `schema` in its metadata. `ValidationPipe` returns the value untouched when the parameter's metatype is `String`, `Boolean`, `Number`, `Array`, `Object`, `Buffer` or `Date` — and a `z.infer` type alias erases to `Object`, so a schema-validated parameter is skipped by it. Each pipe ignores the other's parameters.

Global pipes run in registration order, so put `ValidationPipe` first if a route ever has both a class metatype and a schema; the schema then validates the constructed instance.

This is the practical migration path: leave existing DTO classes alone, write new modules schema-first, and delete the old stack when nothing imports it.

## Security considerations

**The pipe strips prototype-pollution keys before validating.** `stripProtoKeys()` walks the incoming value and deletes `__proto__`, `prototype` and `constructor` — recursively, through arrays and nested objects, skipping typed arrays and the built-in types `Date`, `RegExp`, `Error`, `Map`, `Set`, `WeakMap` and `WeakSet`. It runs *before* the schema does, so a crafted key never reaches your schema and never reaches a downstream merge. `ValidationPipe` has the same protection. Treat it as defense in depth, not as permission to `Object.assign()` request data into anything.

**It mutates the value in place.** `stripProtoKeys` deletes those keys from the object Express parsed, not from a copy. If you also read the raw request body somewhere — a signature check, an audit log — it has already been modified. Verify signatures over the raw bytes, before body parsing, not over `req.body`.

**A parameter with no `schema` is not validated.** There is no error, no warning, and no log line. This is the single most important operational fact about this pipe: it is opt-in per parameter. An end-to-end test that posts garbage to every write route and asserts a 400 is the only thing that catches an omission.

**Use `z.strictObject()` for write bodies.** `z.object()` strips unknown keys silently, which is safe as long as you use the output — but silent is exactly what you do not want when a client starts sending `role`. See [Whitelisting and unknown properties](unknown-properties.md).

**Bound every string and array.** `z.string()` with no `.max()` accepts as much as the body parser allows, and an unbounded array of objects multiplies that into CPU. Give every field a ceiling, and cap the body on the parser — a schema cannot reject a payload it has already buffered.

**Do not echo the rejected value.** `StandardSchemaV1.Issue` carries a `message` and a `path`, not the input, which makes the default body safe. An `exceptionFactory` that reaches back into the request to add "you sent: …" undoes that, and on a login route it writes a password into your logs. See [Safe logging](../nestjs-security/safe-logging.md).

**Validation is not authorization.** `{ "accountId": "…" }` can be a perfectly valid UUID belonging to someone else. See [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

## Production considerations

**Build schemas once, at module load.** A schema constructed inside a handler allocates on every request. Export them from a `schemas/` module, as above.

**Zod 4 is fast, but a large schema on a hot path is still work.** Measure before assuming it is or is not your bottleneck; see [Performance](../nestjs-production/performance.md).

**`validateOptions` is a passthrough, and its shape differs from the serializer's.** On the pipe it is typed `Record<string, unknown>`; on `StandardSchemaSerializerInterceptor` it is `StandardSchemaV1.Options`, whose only spec-defined member is `libraryOptions`. Whatever you put there reaches the library verbatim, so what it does is the library's business, not Nest's.

**OpenAPI takes an extra step.** `@nestjs/swagger` 12.0.1 reads decorator metadata from DTO classes; it does not read a Standard Schema. Generate the document from the schema instead — Zod 4 ships `z.toJSONSchema()`, and `@asteasolutions/zod-to-openapi` 9.1.0 or `zod-openapi` 6.0.2 produce a full OpenAPI document. See [API documentation](../express-libraries/api-documentation.md) and [Choosing an approach](choosing-an-approach.md).

**Pin the schema library.** Zod 4.5.4, Valibot 1.4.2 and ArkType 2.2.3 are the verified versions here. These libraries move quickly, and coercion and error-message details change between minors.

**One error envelope.** Whichever stack a route uses, the client should see the same failure shape. One `exceptionFactory` per stack producing the same body, plus one exception filter, is the cheapest way to get there — see [Exception filters](../nestjs-request-handling/exception-filters.md).

## Common mistakes

- **Registering the pipe and forgetting the `schema` on a parameter.** The value passes through unvalidated and nothing tells you.
- **Setting `transform: false` to "avoid surprises".** It discards the schema's output, so defaults, coercions and `.transform()` stop reaching the handler.
- **Expecting `whitelist`-style options on this pipe.** Unknown-key policy lives in the schema: `z.strictObject()`, `v.strictObject()`, `.onUndeclaredKey('reject')`.
- **Typing the handler parameter by hand instead of with `z.infer`.** A hand-written interface drifts from the schema, and nothing fails when it does.
- **Coercing inside a JSON body schema.** It accepts `"12"` where the contract says `12` and hides a client bug.
- **Assuming the default error body is field-keyed.** It is a flat `message` array of `path: message` strings.
- **Trusting the default message formatter with a library that reports object path segments.** You get `[object Object]`; read `segment.key` in your own factory.
- **Building the schema inside the handler.** It is allocated per request for no benefit.
- **Expecting `@nestjs/swagger` to document a Standard Schema.** It reads class decorators; convert the schema instead.
- **Validating a signature over `req.body` after the pipe ran.** `stripProtoKeys` mutated the object in place.

## Related topics

- [Choosing an approach](choosing-an-approach.md) — this stack versus class-validator, with an actual recommendation.
- [The ValidationPipe](validation-pipe.md) — the classic pipe and every option it takes.
- [class-validator and class-transformer](class-validator.md) — the decorator stack this one is an alternative to.
- [Whitelisting and unknown properties](unknown-properties.md) — `z.strictObject()` and `whitelist` as one control.
- [Transforming payloads](transforming-payloads.md) — how this pipe's `transform` differs from the classic one's.
- [Serialization](serialization.md) — `StandardSchemaSerializerInterceptor`, the response-side counterpart.
- [Validation](../express-libraries/validation.md) — the Zod 4 API in full, outside Nest.
- [Pipes](../nestjs-request-handling/pipes.md) — where a pipe sits in the request lifecycle.
- [Validation as a security control](../nestjs-security/validation-as-a-control.md) — the threat model behind these settings.
- [Configuration](../nestjs/configuration.md) — `@nestjs/config` accepts a Standard Schema for environment validation too.
