---
title: The ValidationPipe
description: How the classic NestJS ValidationPipe works, every option that matters, and why it belongs at the global level rather than on individual handlers.
status: current
updated: 2026-09-09
---

`ValidationPipe` is the piece of NestJS that turns a DTO class into an enforced contract. It takes the raw value a parameter decorator produced, hands it to `class-transformer` and `class-validator`, and either passes a typed instance to your handler or throws a `BadRequestException` before your handler ever runs.

NestJS 12 ships two validation stacks. This page is about the classic one. The Standard Schema alternative is on [Standard Schema with Zod](standard-schema-with-zod.md), and [Choosing an approach](choosing-an-approach.md) compares them.

## Why it exists

Without a pipe, `@Body()` gives you whatever `express.json()` parsed — a plain object with no guarantees. The `CreateUserDto` type annotation on the parameter is erased at compile time and enforces nothing at runtime.

```ts title="src/users/users.controller.ts"
@Post()
create(@Body() body: CreateUserDto) {
  // Without a pipe, `body` is `{}` typed as CreateUserDto.
  // It can be null, an array, a string, or an object with 400 unknown keys.
  return this.users.create(body)
}
```

`ValidationPipe` closes that gap. It is the only reason the DTO class means anything at runtime.

## Installation

`class-validator` and `class-transformer` are **peer dependencies** of `@nestjs/common` — Nest does not bundle them, and `ValidationPipe` throws a descriptive error at first use if they are missing.

:::tabs
@tab npm
```bash
npm install class-validator@0.15 class-transformer@0.5 reflect-metadata@0.2
```
@tab pnpm
```bash
pnpm add class-validator@0.15 class-transformer@0.5 reflect-metadata@0.2
```
@tab yarn
```bash
yarn add class-validator@0.15 class-transformer@0.5 reflect-metadata@0.2
```
:::

Verified versions: `class-validator` 0.15.1, `class-transformer` 0.5.1, `reflect-metadata` 0.2.2.

The DTO's *types* — the difference between `email: string` and `email: number` — are only visible at runtime if TypeScript emits them, so the compiler options are load-bearing:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strictNullChecks": true
  }
}
```

Both flags are non-negotiable for this stack; see [class-validator and class-transformer](class-validator.md) for what breaks without them.

## Basic example

```ts title="src/users/dto/create-user.dto.ts"
import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  email: string

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName: string

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(150)
  age?: number
}
```

```ts title="src/main.ts"
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  }),
)

await app.listen(3000)
```

A request with a bad `email` now returns a 400 with a per-field message, and the handler is never entered.

```bash
curl -sS -X POST localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"email":"not-an-email","displayName":""}'
```

```json title="400 Bad Request"
{
  "message": [
    "email must be an email",
    "displayName must be longer than or equal to 1 characters"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

## Where to bind it

There are three places, and they are not equivalent.

### Globally, from the bootstrap file

```ts title="src/main.ts"
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
```

Simple, and correct for most applications. The limitation is that the pipe is constructed outside the DI container, so it cannot inject providers.

### Globally, as a provider

```ts title="src/app.module.ts"
import { Module, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
    },
  ],
})
export class AppModule {}
```

`APP_PIPE` registers the pipe inside the container, so it can inject a `ConfigService` or a logger. It also keeps the pipe active in tests that build the app from `AppModule` without going through `main.ts` — a common reason validation silently disappears in end-to-end tests.

### Per handler or per parameter

```ts title="src/users/users.controller.ts"
import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common'

@Controller('users')
export class UsersController {
  @Post()
  @UsePipes(new ValidationPipe({ groups: ['create'] }))
  create(@Body() body: CreateUserDto) {
    return body
  }

  @Post('draft')
  createDraft(@Body(new ValidationPipe({ skipMissingProperties: true })) body: CreateUserDto) {
    return body
  }
}
```

Use these only to *override* the global pipe for one route. A more local pipe replaces the global one for that parameter — it does not merge with it, so an override that forgets `whitelist: true` reopens mass assignment on exactly that route.

:::best-practice
Bind it globally, once, with `whitelist` and `forbidNonWhitelisted` on. A per-route pipe is an exception you should be able to justify in a code review.
:::

### Why global is the default answer

A per-route pipe is opt-in security. Every new controller is unprotected until someone remembers to decorate it, and nothing in the test suite fails when they forget. A global pipe inverts that: every route is validated, and a route that needs different behavior has to say so explicitly.

The cost is real but small — a route whose body is genuinely free-form needs `@Body()` without a DTO class, because the pipe only validates parameters whose metatype is a class it can construct.

## The options

Every option below comes from `ValidationPipeOptions`, which extends `class-validator`'s `ValidatorOptions` and adds the Nest-specific keys.

| Option | Default | What it does |
| --- | --- | --- |
| `whitelist` | `false` | Strips every property that has no validation decorator from the output object. |
| `forbidNonWhitelisted` | `false` | With `whitelist`, throws instead of stripping. Requires `whitelist: true` to have any effect. |
| `forbidUnknownValues` | `true` in class-validator 0.14+ | Rejects a value whose class has no registered metadata at all — the guard against an empty DTO passing everything. |
| `transform` | `false` | Runs `plainToInstance` so the handler receives a real DTO instance, and applies primitive conversion to path and query params. |
| `transformOptions` | — | A `ClassTransformOptions` object passed to `class-transformer`. See [Transforming payloads](transforming-payloads.md). |
| `disableErrorMessages` | `false` | Omits the `message` array from the response. |
| `errorHttpStatusCode` | `400` | The status thrown on failure. `422` is the common alternative. |
| `exceptionFactory` | — | `(errors: ValidationError[]) => any`. Return the exception to throw. Overrides `errorHttpStatusCode`. |
| `stopAtFirstError` | `false` | Reports only the first failing constraint per property. |
| `validateCustomDecorators` | `false` | Also validates values produced by custom `createParamDecorator` decorators. |
| `groups` | — | Only runs constraints tagged with these validation groups. |
| `always` | `false` | Runs constraints that declare no group even when `groups` is set. |
| `strictGroups` | `false` | With `groups`, ignores constraints that have no group at all. |
| `skipMissingProperties` | `false` | Skips validation for any property that is `null` or `undefined`. |
| `skipNullProperties` | `false` | Skips validation for `null` properties only. |
| `skipUndefinedProperties` | `false` | Skips validation for `undefined` properties only. |
| `dismissDefaultMessages` | `false` | Suppresses the built-in messages, leaving only your custom ones. |
| `validationError.target` | `true` | Whether the failing object is attached to each `ValidationError`. |
| `validationError.value` | `true` | Whether the failing **value** is attached to each `ValidationError`. |
| `enableDebugMessages` | `false` | Logs class-validator warnings, such as a DTO with no decorators. |
| `expectedType` | — | Forces the pipe to validate against this class instead of the parameter's inferred metatype. |

:::warning
`forbidNonWhitelisted: true` without `whitelist: true` does nothing. The two are a pair, and shipping only the first is a common and silent misconfiguration. See [Whitelisting and unknown properties](unknown-properties.md).
:::

### The `skip*` options are sharper than they look

`skipMissingProperties: true` disables validation for every absent property, including required ones. It exists for `PATCH`-shaped payloads, but a better answer is usually `PartialType` from `@nestjs/mapped-types`, which marks each field optional while keeping every other constraint:

```ts title="src/users/dto/update-user.dto.ts"
import { PartialType } from '@nestjs/mapped-types'
import { CreateUserDto } from './create-user.dto.js'

export class UpdateUserDto extends PartialType(CreateUserDto) {}
```

`PartialType` keeps `@IsEmail()` enforced when `email` *is* present. `skipMissingProperties` gives that up globally.

## Custom error shapes with `exceptionFactory`

The default response body is a `message` array of English strings. That is fine for a browser form and poor for a machine client, which wants a field path and a stable code.

```ts title="src/common/validation-exception.factory.ts"
import { BadRequestException } from '@nestjs/common'
import type { ValidationError } from 'class-validator'

interface FieldIssue {
  path: string
  code: string
  message: string
}

function flatten(errors: ValidationError[], parent = ''): FieldIssue[] {
  const out: FieldIssue[] = []
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property
    for (const [code, message] of Object.entries(error.constraints ?? {})) {
      out.push({ path, code, message })
    }
    if (error.children?.length) out.push(...flatten(error.children, path))
  }
  return out
}

export function validationExceptionFactory(errors: ValidationError[]) {
  return new BadRequestException(
    { error: 'validation_failed', issues: flatten(errors) },
    { errorCode: 'VALIDATION_FAILED' },
  )
}
```

```ts title="src/main.ts"
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: validationExceptionFactory,
  }),
)
```

Two details are worth calling out. `ValidationError.children` is how nested DTOs report — a flat map over `errors` loses every message from an inner object. And `errorCode` is a real field on `HttpExceptionOptions` in NestJS 12, so you can attach a stable machine code without inventing a wrapper.

The result is one envelope your clients can parse:

```json title="400 Bad Request"
{
  "error": "validation_failed",
  "issues": [
    { "path": "email", "code": "isEmail", "message": "email must be an email" },
    { "path": "address.postalCode", "code": "matches", "message": "postalCode must match /^\\d{5}$/" }
  ]
}
```

## How it works

The pipe runs after guards and after the parameter decorator has produced a value, and before the handler. For each parameter it:

1. Reads the parameter's design-time metatype from `emitDecoratorMetadata`.
2. Bails out and passes the value straight through when the metatype is `String`, `Boolean`, `Number`, `Array`, `Object` or absent — there is no schema to validate against.
3. Runs `plainToInstance(metatype, value, transformOptions)`.
4. Runs `validate(instance, validatorOptions)`.
5. On failure, calls `exceptionFactory` (or builds the default `BadRequestException`).
6. On success, returns the instance when `transform: true`, or the original plain value when `transform: false`.

Step 2 is the one that surprises people: a `@Body() body: Record<string, unknown>` parameter is *never* validated, because `Object` is not a class the pipe will construct. Nothing warns you.

Step 6 explains why `transform: false` makes `@Type()` conversions and class getters vanish — the pipe validated an instance and then handed you the plain object anyway.

## Security considerations

**`whitelist: true` is the mass-assignment control.** Without it the pipe validates the properties it knows about and passes every other key through untouched, straight into whatever you hand it to. This is the single most important setting on the pipe — see [Whitelisting and unknown properties](unknown-properties.md) and [Mass assignment](../security/mass-assignment.md).

**Set `forbidUnknownValues` on, and never disable it.** With it off, a DTO class that has no validation metadata — because someone forgot the decorators, or because a build step dropped `emitDecoratorMetadata` — validates successfully with zero constraints applied. The failure is silent and total.

**A missing global binding is a whole-application bypass.** Verify it in an end-to-end test that posts garbage to one route and asserts a 400, not by reading `main.ts`. Registering via `APP_PIPE` makes the pipe part of the module graph, so `Test.createTestingModule({ imports: [AppModule] })` picks it up.

**`disableErrorMessages: true` hides information from attackers and from you.** It is occasionally right for a public API where field names are sensitive. It is not a substitute for not putting secrets in field names.

**`validationError.value` defaults to `true`.** Any exception filter or logger that serializes the raw `ValidationError` will write the rejected value — which on a login route is the submitted password — into your logs. Set `validationError: { value: false, target: false }` unless you have proven your error path never logs it. See [Safe logging](../nestjs-security/safe-logging.md).

**Validation is not authorization.** A structurally perfect `{ "accountId": "…" }` from a user who does not own that account is still an IDOR. See [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

**Cap the body before the pipe sees it.** The pipe validates a payload that is already parsed and in memory. Body limits belong on the Express body parser, not on the DTO.

## Production considerations

**Keep one pipe configuration.** A codebase with three different `new ValidationPipe({...})` calls has three different security postures, and the weakest one is the one an attacker uses.

**`transform: true` costs an object construction per request.** It is worth it — but it is not free, and on a very hot endpoint with a large nested DTO it is measurable. Measure before you assume it is the bottleneck.

**Do not enable `enableImplicitConversion` reflexively.** It is a `transformOptions` flag with genuinely surprising behavior; [Transforming payloads](transforming-payloads.md) covers why.

**Log validation failures at `warn` with the path only.** A spike on one field is either a client regression or someone probing your parameter names.

**Route validation failures through the same error envelope as everything else.** One `exceptionFactory` plus one exception filter beats a special case per controller — see [Exception filters](../nestjs-request-handling/exception-filters.md).

**Pin `class-validator` and `class-transformer` exactly.** Both are pre-1.0, and both have shipped behavior changes in patch-looking releases.

## Common mistakes

- **Setting `forbidNonWhitelisted: true` without `whitelist: true`.** The first does nothing without the second.
- **Binding the pipe in `main.ts` only, then wondering why end-to-end tests accept invalid payloads.** Tests that build from `AppModule` never run `main.ts`. Use `APP_PIPE`.
- **Typing a body parameter as `any`, `object` or `Record<string, unknown>`.** The pipe skips it entirely and reports nothing.
- **A DTO declared as an `interface`.** Interfaces do not exist at runtime, so there is no metatype to validate. DTOs must be classes.
- **Forgetting `emitDecoratorMetadata`.** Decorators still register, but the implicit type checks and nested-object detection stop working.
- **Overriding the global pipe per-route and dropping `whitelist`.** The local pipe replaces the global one; it does not extend it.
- **Reaching for `skipMissingProperties: true` to support `PATCH`.** Use `PartialType` instead and keep the constraints on the fields that were sent.
- **Mapping `errors` in `exceptionFactory` without recursing into `children`.** Every nested-object message is lost.
- **Assuming `transform: true` also strips unknown keys.** Stripping is `whitelist`; `transform` is construction.
- **Leaving `validationError.value` on and logging the raw error.** That is how passwords end up in a log aggregator.

## Related topics

- [class-validator and class-transformer](class-validator.md) — the decorators the pipe actually runs.
- [Whitelisting and unknown properties](unknown-properties.md) — the mass-assignment control in detail, with a worked exploit.
- [Transforming payloads](transforming-payloads.md) — what `transform` and `transformOptions` really do.
- [Standard Schema with Zod](standard-schema-with-zod.md) — the other validation stack in NestJS 12.
- [Choosing an approach](choosing-an-approach.md) — which of the two to use, and when each is wrong.
- [Pipes](../nestjs-request-handling/pipes.md) — where pipes sit in the request lifecycle.
- [DTOs](../nestjs-request-handling/dtos.md) — designing the classes the pipe validates.
- [Validation as a security control](../nestjs-security/validation-as-a-control.md) — the threat model this page's settings address.
- [Validation](../express-libraries/validation.md) — the plain-Express equivalent, with the Zod 4 API in detail.
