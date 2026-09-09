---
title: class-validator and class-transformer
description: The decorator-based validation stack in NestJS 12 — the common constraints, nested and array validation, custom and async validators, and what a 0.x dependency means for your API.
status: current
updated: 2026-09-09
---

`class-validator` 0.15.1 and `class-transformer` 0.5.1 are the two packages that give a DTO class runtime meaning. `ValidationPipe` is only the adapter; these libraries do the work. They are peer dependencies of `@nestjs/common`, so you install and version them yourself.

## Why it exists

A DTO is a class whose *properties* carry the contract. Constraints live next to the field they constrain, so there is nothing to keep in sync — the type, the validation and the OpenAPI description are all on the same line of the same file.

```ts title="src/orders/dto/create-order.dto.ts"
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsPositive, IsString, Length, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class OrderLineDto {
  @IsString()
  @Length(1, 64)
  sku: string

  @IsInt()
  @IsPositive()
  quantity: number
}

export class CreateOrderDto {
  @IsIn(['standard', 'express'])
  shipping: 'standard' | 'express'

  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines: OrderLineDto[]
}
```

## The runtime requirement

This stack is built on `reflect-metadata` 0.2.2 and the TypeScript metadata emit. Both are required.

```json title="tsconfig.json"
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2023",
    "strictNullChecks": true
  }
}
```

`reflect-metadata` must be imported once, before anything decorated is loaded:

```ts title="src/main.ts"
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)
await app.listen(3000)
```

:::warning
Node's native TypeScript type-stripping (`node --experimental-strip-types`, unflagged from Node 23.6) **cannot run this code**. Type-stripping erases types without emitting anything, so `emitDecoratorMetadata` has nothing to emit and legacy decorators are not executed at all. A NestJS project using `class-validator` needs a real compile step — `nest build`, `tsc`, or a bundler that runs the TypeScript transform. Not an SWC/esbuild configuration with decorator metadata turned off, either.
:::

What breaks without `emitDecoratorMetadata` is subtle rather than loud:

- `@ValidateNested()` cannot discover the nested class, so nested objects are not validated. `@Type()` is what saves you here, which is why it is not optional.
- `class-transformer` cannot convert types implicitly, so `@Type(() => Number)` becomes mandatory everywhere.
- `ValidationPipe` may see `Object` as the metatype and skip the parameter silently.

## The constraints you will actually use

| Group | Decorators |
| --- | --- |
| Presence | `@IsDefined()`, `@IsNotEmpty()`, `@IsOptional()`, `@Allow()` |
| Primitives | `@IsString()`, `@IsInt()`, `@IsNumber()`, `@IsBoolean()`, `@IsArray()`, `@IsObject()` |
| Numbers | `@Min()`, `@Max()`, `@IsPositive()`, `@IsNegative()` |
| Strings | `@Length()`, `@MinLength()`, `@MaxLength()`, `@Matches()`, `@IsNotEmpty()` |
| Formats | `@IsEmail()`, `@IsUUID()`, `@IsUrl()`, `@IsISO8601()`, `@IsDateString()`, `@IsJSON()` |
| Sets | `@IsIn()`, `@IsNotIn()`, `@IsEnum()` |
| Arrays | `@ArrayMinSize()`, `@ArrayMaxSize()`, `@ArrayUnique()`, `@ArrayNotEmpty()` |
| Structure | `@ValidateNested()`, `@ValidateIf()`, `@Validate()` |

Two behaviors are worth memorizing because they cause most of the confusion:

**`@IsOptional()` skips every other constraint when the value is `null` or `undefined`.** It is not "may be absent" — it is "if absent, stop". A field that must be present but may be `null` needs `@IsDefined()` plus `@ValidateIf((o) => o.field !== null)`.

**A property with no decorator at all is invisible.** `class-validator` never sees it, `whitelist: true` strips it, and `forbidNonWhitelisted: true` rejects it. If you genuinely want to accept a free-form value, mark it `@Allow()` — that registers the property without constraining it.

### Bound every string and array

```ts
@IsString()
@MaxLength(2000)
description: string
```

`@IsString()` alone accepts as much as your body limit allows. `@IsArray()` alone accepts a hundred thousand elements, each of which `@ValidateNested({ each: true })` will then validate — that is quadratic-looking work an attacker chooses for you. Give every string a `@MaxLength()` and every array an `@ArrayMaxSize()`.

## Nested validation

`@ValidateNested()` and `@Type()` are a pair. Neither works alone.

```ts title="src/users/dto/create-user.dto.ts"
import { IsEmail, IsOptional, IsString, Matches, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class AddressDto {
  @IsString()
  street: string

  @Matches(/^\d{5}$/)
  postalCode: string
}

export class CreateUserDto {
  @IsEmail()
  email: string

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto
}
```

- `@ValidateNested()` tells `class-validator` to descend into the value.
- `@Type(() => AddressDto)` tells `class-transformer` to build an `AddressDto` instance from the plain object, so the nested decorators are attached to something.

Without `@Type()`, the nested value stays a plain object and `whitelist: true` cannot strip its unknown keys — a nested object becomes a mass-assignment hole even though the top level is protected. `@Type()` also matters because the arrow function defers evaluation, which is what lets two DTO classes reference each other across files without a circular-import crash.

:::danger Unprotected nested objects
```ts vulnerable title="DO NOT COPY"
export class UpdateProfileDto {
  @IsEmail()
  email: string

  // No @ValidateNested(), no @Type(). This object is never inspected,
  // and whitelist:true does not reach inside it.
  @IsObject()
  preferences: Record<string, unknown>
}
```

`POST /profile` with `{"email":"a@b.test","preferences":{"role":"admin","__proto__":{"admin":true}}}` sends the whole `preferences` object through to whatever consumes it.
:::

```ts good title="src/users/dto/update-profile.dto.ts"
import { IsBoolean, IsEmail, IsIn, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class PreferencesDto {
  @IsIn(['light', 'dark'])
  theme: 'light' | 'dark'

  @IsBoolean()
  emailDigest: boolean
}

export class UpdateProfileDto {
  @IsEmail()
  email: string

  @ValidateNested()
  @Type(() => PreferencesDto)
  preferences: PreferencesDto
}
```

With the pipe configured `whitelist: true, forbidNonWhitelisted: true`, that same request now returns a 400 naming `preferences.role` as an unexpected property.

## Arrays

`{ each: true }` applies a constraint to every element rather than to the array itself.

```ts title="src/tags/dto/tag-list.dto.ts"
import { ArrayMaxSize, ArrayUnique, IsString, Length, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class TagListDto {
  @IsString({ each: true })
  @Length(1, 32, { each: true })
  @ArrayUnique()
  @ArrayMaxSize(20)
  tags: string[]
}

export class BulkDto {
  @ValidateNested({ each: true })
  @Type(() => TagListDto)
  @ArrayMaxSize(100)
  batches: TagListDto[]
}
```

`@ArrayMaxSize()` goes on the array; `@IsString({ each: true })` goes on the elements. Mixing them up produces a constraint that always passes, which is the worst kind of bug because nothing fails.

To validate a **top-level array body**, the pipe needs to be told what the elements are, because the parameter's metatype is just `Array`:

```ts title="src/tags/tags.controller.ts"
import { Body, Controller, ParseArrayPipe, Post } from '@nestjs/common'

@Controller('tags')
export class TagsController {
  @Post('bulk')
  bulk(@Body(new ParseArrayPipe({ items: TagListDto, whitelist: true })) items: TagListDto[]) {
    return items.length
  }
}
```

## Custom validators

Two forms. Use the inline one for a rule that lives in one place, and the class form for a rule you reuse or that needs a provider.

### Inline, with `registerDecorator`

```ts title="src/common/validators/is-after.ts"
import { registerDecorator } from 'class-validator'
import type { ValidationArguments, ValidationOptions } from 'class-validator'

export function IsAfter(property: string, options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAfter',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const other = (args.object as Record<string, unknown>)[args.constraints[0]]
          return (
            typeof value === 'string' &&
            typeof other === 'string' &&
            Date.parse(value) > Date.parse(other)
          )
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be after ${args.constraints[0]}`
        },
      },
    })
  }
}
```

```ts title="src/events/dto/create-event.dto.ts"
import { IsISO8601 } from 'class-validator'
import { IsAfter } from '../../common/validators/is-after.js'

export class CreateEventDto {
  @IsISO8601()
  startsAt: string

  @IsISO8601()
  @IsAfter('startsAt')
  endsAt: string
}
```

Cross-field rules are the main reason to write a custom validator. `args.object` is the whole DTO instance, which is how you reach the other field.

### As a constraint class

```ts title="src/common/validators/is-strong-passphrase.constraint.ts"
import { ValidatorConstraint } from 'class-validator'
import type { ValidatorConstraintInterface } from 'class-validator'

@ValidatorConstraint({ name: 'isStrongPassphrase', async: false })
export class IsStrongPassphraseConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && value.length >= 12 && /\s/.test(value.trim())
  }

  defaultMessage(): string {
    return 'passphrase must be at least 12 characters and contain a space'
  }
}
```

```ts title="src/auth/dto/register.dto.ts"
import { IsEmail, Validate } from 'class-validator'
import { IsStrongPassphraseConstraint } from '../../common/validators/is-strong-passphrase.constraint.js'

export class RegisterDto {
  @IsEmail()
  email: string

  @Validate(IsStrongPassphraseConstraint)
  passphrase: string
}
```

### Async validators with dependency injection

A constraint class can be a Nest provider, which is how a validator reaches a repository. It requires `useContainer` so `class-validator` resolves constraints through Nest's container instead of constructing them itself.

```ts title="src/users/validators/is-email-available.constraint.ts"
import { Injectable } from '@nestjs/common'
import { ValidatorConstraint } from 'class-validator'
import type { ValidatorConstraintInterface } from 'class-validator'
import { UsersService } from '../users.service.js'

@ValidatorConstraint({ name: 'isEmailAvailable', async: true })
@Injectable()
export class IsEmailAvailableConstraint implements ValidatorConstraintInterface {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  async validate(value: unknown): Promise<boolean> {
    if (typeof value !== 'string') return false
    return !(await this.users.existsByEmail(value))
  }

  defaultMessage(): string {
    return 'email is already registered'
  }
}
```

```ts title="src/main.ts"
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { useContainer } from 'class-validator'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

// Without this, class-validator news up the constraint itself and the
// injected UsersService is undefined at the first request.
useContainer(app.select(AppModule), { fallbackOnErrors: true })

await app.listen(3000)
```

The constraint class must also be listed in a module's `providers`.

:::warning
A database-backed validator turns every request into a query, and an unauthenticated endpoint with an async uniqueness check is a free user-enumeration oracle and a free load generator. Rate-limit those routes, and prefer a unique constraint in the database plus a caught conflict error for the authoritative check. The validator is a UX affordance, not the source of truth — two concurrent registrations both pass it.
:::

## Validation groups

Groups let one DTO serve two operations.

```ts title="src/users/dto/user.dto.ts"
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator'

export class UserDto {
  @IsEmail({}, { groups: ['create', 'update'] })
  email: string

  @IsString({ groups: ['create'] })
  @MinLength(12, { groups: ['create'] })
  password: string

  @IsOptional({ groups: ['update'] })
  @IsString({ groups: ['create', 'update'] })
  displayName?: string
}
```

```ts title="src/users/users.controller.ts"
import { Body, Controller, Patch, Post, UsePipes, ValidationPipe } from '@nestjs/common'

@Controller('users')
export class UsersController {
  @Post()
  @UsePipes(new ValidationPipe({ groups: ['create'], whitelist: true, forbidNonWhitelisted: true }))
  create(@Body() body: UserDto) {
    return body
  }

  @Patch()
  @UsePipes(new ValidationPipe({ groups: ['update'], whitelist: true, forbidNonWhitelisted: true }))
  update(@Body() body: UserDto) {
    return body
  }
}
```

Groups are powerful and easy to get wrong: a constraint with no `groups` is skipped once `groups` is set, unless `always: true` is on. In practice two small DTO classes — or `PartialType`/`OmitType` from `@nestjs/mapped-types` 12.0.0 — are easier to read and harder to misconfigure than one grouped class.

## Composing DTOs

```ts title="src/users/dto/index.ts"
import { OmitType, PartialType, PickType } from '@nestjs/mapped-types'
import { CreateUserDto } from './create-user.dto.js'

export class UpdateUserDto extends PartialType(CreateUserDto) {}
export class LoginDto extends PickType(CreateUserDto, ['email'] as const) {}
export class PublicUserDto extends OmitType(CreateUserDto, ['password'] as const) {}
```

These copy the validation metadata, so the derived class stays in step with the base. `@nestjs/swagger` 12.0.1 exports its own versions of the same helpers that additionally copy the OpenAPI metadata — import from `@nestjs/swagger` if you generate docs, and from `@nestjs/mapped-types` if you do not.

## Security considerations

**An undecorated property is not validated.** It is also not whitelisted, so with `whitelist: false` it flows straight into your service. Decorate every field you accept, and let the pipe reject the rest.

**`@ValidateNested()` without `@Type()` leaves the inner object unchecked and unstripped.** This is the most common way a whitelisted API still has a mass-assignment hole.

**Prototype-pollution keys need the whitelist.** `__proto__` and `constructor` in a JSON body are just keys; a decorated DTO plus `whitelist: true` drops them because they carry no constraint. Without the whitelist, whatever you merge that object into inherits them.

**Set an upper bound on everything.** Unbounded strings and arrays are denial-of-service surface, and nested arrays multiply.

**Async validators are I/O on an unauthenticated path.** Rate-limit them, and never let the error message distinguish "already registered" on a public route unless you have accepted account enumeration.

**A hand-written `@Matches()` pattern can be a ReDoS.** Nested quantifiers such as `(a+)+$` backtrack exponentially. Keep patterns anchored and simple, and always pair one with `@MaxLength()`.

**`class-validator` messages echo the property name, not the value** — but a `ValidationError` object carries `value`, so anything that logs the raw error logs the password. Configure `validationError: { value: false }` on the pipe.

## Production considerations

**`class-validator` is at 0.15.1 and `class-transformer` at 0.5.1 — both are pre-1.0.** That is not a reason to avoid them; they are the default stack for a framework at version 12, and NestJS declares them as peers precisely so you control the version. It *is* a reason to:

- Pin exact versions in `package.json` rather than a caret range, and upgrade deliberately. Semver's "patch releases are safe" promise does not formally apply below 1.0, and both libraries have changed validation behavior in releases that looked like patches.
- Read the changelog on every bump, and re-run the end-to-end tests that assert 400 responses. A default flipping — `forbidUnknownValues` did exactly this in 0.14 — changes what your API accepts.
- Keep the two versions moving together. `class-transformer` produces the instances `class-validator` inspects; a mismatch shows up as constraints that quietly stop firing.
- Treat "no release in a while" as a stability signal rather than a crisis, but have an exit: DTO classes are the coupling point, and [Standard Schema with Zod](standard-schema-with-zod.md) is a supported alternative inside the same framework version.

**Decorator metadata is a build concern.** If you switch to SWC or esbuild for speed, verify decorator metadata emission is still on. The symptom of losing it is validation that passes everything, not a build error.

**Reuse DTOs across transports.** The same class validates an HTTP body, a microservice message and a queue payload. That is a real advantage of the class-based approach, and the reason to keep DTOs free of HTTP-specific concerns.

## Common mistakes

- **`@ValidateNested()` without `@Type()`.** The nested object is never validated and never whitelisted.
- **`@IsArray()` plus `@IsString()` without `{ each: true }`.** You asserted the array is a string.
- **`@ArrayMaxSize()` written with `{ each: true }`.** It then constrains each element's length, not the array's.
- **Expecting `@IsOptional()` to mean "nullable but still checked".** It short-circuits every other constraint on the property.
- **Declaring a DTO as an `interface`.** There is no runtime class, so nothing validates.
- **Leaving a property undecorated and expecting it through.** Use `@Allow()` if you really mean it.
- **Setting `groups` on the pipe and forgetting `always: true`,** which silently disables every ungrouped constraint.
- **Forgetting `useContainer()` with an injecting validator.** The dependency is `undefined` at the first request, not at boot.
- **Trying to run a `class-validator` project with Node's type-stripping.** Decorators need a real compiler.
- **Using a caret range for `class-validator`.** A 0.x minor bump can change what your API accepts.

## Related topics

- [The ValidationPipe](validation-pipe.md) — the pipe that runs these decorators, and every option it takes.
- [Whitelisting and unknown properties](unknown-properties.md) — why `whitelist` and these decorators are one control, not two.
- [Transforming payloads](transforming-payloads.md) — what `@Type()` and `class-transformer` do beyond validation.
- [Serialization](serialization.md) — `@Exclude()` and `@Expose()`, the response-side half of `class-transformer`.
- [Choosing an approach](choosing-an-approach.md) — decorators versus schemas, with an actual recommendation.
- [DTOs](../nestjs-request-handling/dtos.md) — how to structure and share these classes.
- [OpenAPI with Swagger](../nestjs-libraries/swagger.md) — turning these decorators into an API document.
- [Mass assignment](../security/mass-assignment.md) — the attack the whitelist prevents.
- [Validation](../express-libraries/validation.md) — the schema-first equivalent outside Nest.
