---
title: Whitelisting and unknown properties
description: How whitelist and forbidNonWhitelisted stop mass assignment in NestJS 12, the Zod strictObject equivalent, and a worked exploit that escalates a user to admin through an unfiltered body.
status: current
updated: 2026-09-11
---

An HTTP body is a bag of keys an attacker chose. Validation tells you the keys you *expected* are acceptable; it says nothing about the ones you did not expect. Deciding what happens to those is the single most consequential validation setting in a Nest application, and both validation stacks get it wrong by default.

This page is the control in detail: `whitelist` and `forbidNonWhitelisted` on `ValidationPipe`, `z.strictObject()` on the schema side, and a worked exploit that turns an ignored field into an admin account.

## Why it exists

`class-validator` only knows about properties that carry a decorator. Everything else is invisible to it — and by default, invisible means *untouched*, not *removed*. The pipe validates `email`, finds no problem, and hands your service an object that still has every other key the client sent.

That object then reaches something that iterates its keys: an ORM's `create()` or `save()`, an `Object.assign()`, a `{ ...body }` spread into an entity. The database column the attacker guessed gets written. This is mass assignment, and the Nest-specific detail is that a *validated* payload can still carry it.

## The exploit

A profile-update endpoint. The DTO is careful, the pipe is registered, and every field the client is allowed to send is constrained.

:::danger A validated body is not a filtered body
```ts vulnerable title="DO NOT COPY — src/users/users.controller.ts"
import { Body, Controller, Param, Patch } from '@nestjs/common'
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator'
import { UsersService } from './users.service.js'

export class UpdateProfileDto {
  @IsOptional()
  @IsEmail()
  email?: string

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string
}

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateProfileDto) {
    // `body` validated cleanly. It also still has every key the client sent,
    // because nothing told the pipe to remove them.
    return this.users.update(id, body)
  }
}
```

```ts vulnerable title="DO NOT COPY — src/users/users.service.ts"
@Injectable()
export class UsersService {
  private readonly repo: Repository<User>

  constructor(@InjectRepository(User) repo: Repository<User>) {
    this.repo = repo
  }

  async update(id: string, patch: Partial<User>) {
    const user = await this.repo.findOneByOrFail({ id })
    // Every key in `patch` becomes a column assignment, including `role`.
    Object.assign(user, patch)
    return this.repo.save(user)
  }
}
```

The pipe was configured with the default options:

```ts vulnerable title="DO NOT COPY — src/main.ts"
app.useGlobalPipes(new ValidationPipe())
```
:::

The `User` entity has a `role` column, because the application has roles. The DTO does not mention it — which is exactly why nothing checks it.

```bash
curl -sS -X PATCH localhost:3000/users/8f1c…/  \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <a normal user token>' \
  -d '{"displayName":"Mallory","role":"admin"}'
```

```json title="200 OK"
{
  "id": "8f1c…",
  "displayName": "Mallory",
  "email": "mallory@example.test",
  "role": "admin"
}
```

Two hundred, not four hundred. `displayName` passed `@MaxLength(80)`, `role` was never looked at, and `Object.assign` wrote it. The attacker did not bypass validation — validation ran and approved the request.

The same hole exists with a Prisma `update({ data: body })`, a Mongoose `findByIdAndUpdate(id, body)`, a Drizzle `.set(body)`, and any hand-written `{ ...entity, ...body }`. The ORM is not the bug; handing it unfiltered input is.

## The fix

Two options on the pipe, and they are a pair.

```ts good title="src/main.ts"
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,            // remove every property with no decorator
    forbidNonWhitelisted: true, // …and reject instead of removing, loudly
    transform: true,
  }),
)

await app.listen(3000)
```

| Option | Effect |
| --- | --- |
| `whitelist: true` | Strips every property that has no validation decorator from the value the handler receives. |
| `forbidNonWhitelisted: true` | Changes stripping into rejection. **Requires `whitelist: true`** — on its own it does nothing at all. |

`whitelist: true` alone is safe: `role` never reaches the service. `forbidNonWhitelisted: true` on top of it is better, because the client finds out. A silently dropped field is how "why isn't my update saving" becomes a two-hour debugging session, and how someone probing your column names does it without leaving a trace in your logs.

:::warning `forbidNonWhitelisted` without `whitelist` is a no-op
It is not a weaker setting or a warning-only mode. It is inert. This is the most common misconfiguration of this pipe, and it looks correct in a code review because the dangerous-sounding option is the one that is present.
:::

### Verifying the fix

Same request, same token, same route:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH localhost:3000/users/8f1c…/ \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <a normal user token>' \
  -d '{"displayName":"Mallory","role":"admin"}'
```

```text
400
```

```json title="400 Bad Request"
{
  "message": ["property role should not exist"],
  "error": "Bad Request",
  "statusCode": 400
}
```

Then make it a test, because a configuration you verified by hand once is a configuration someone will change:

```ts title="test/mass-assignment.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

it('rejects an unexpected privileged field', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  await app.init()

  await request(app.getHttpServer())
    .patch('/users/8f1c-0000-0000-0000')
    .set('authorization', `Bearer ${userToken}`)
    .send({ displayName: 'Mallory', role: 'admin' })
    .expect(400)

  await app.close()
})
```

:::best-practice
Register the pipe through `APP_PIPE` in `AppModule` rather than only in `main.ts`. A test that builds the app from `AppModule` never executes `main.ts`, so a pipe bound there is absent from exactly the suite that was supposed to prove it works — and the test above would pass a 200 straight through as a failure you then "fix" by lowering the expectation.
:::

### Do not rely on the pipe alone

The whitelist is the boundary control, and it is the right place for the check. It is not the only place:

```ts good title="src/users/users.service.ts"
@Injectable()
export class UsersService {
  private readonly repo: Repository<User>

  constructor(@InjectRepository(User) repo: Repository<User>) {
    this.repo = repo
  }

  async update(id: string, patch: UpdateProfileDto) {
    const user = await this.repo.findOneByOrFail({ id })

    // Assign the fields this operation is allowed to change, by name.
    // A new column on the entity cannot become writable by accident.
    if (patch.email !== undefined) user.email = patch.email
    if (patch.displayName !== undefined) user.displayName = patch.displayName

    return this.repo.save(user)
  }
}
```

Explicit assignment is not busywork. It means adding a `role` column to the entity — or a `stripeCustomerId`, or an `emailVerified` — does not make it writable from an endpoint that was written before it existed. The whitelist protects you today; explicit assignment protects you from next quarter's migration.

## The Zod equivalent

On the Standard Schema side the policy lives in the schema, not the pipe. `StandardSchemaValidationPipe` has no `whitelist` option and needs none.

```ts title="src/users/schemas/update-profile.schema.ts"
import { z } from 'zod'

// Rejects unknown keys.
export const updateProfileSchema = z.strictObject({
  email: z.email().optional(),
  displayName: z.string().min(1).max(80).optional(),
})

export type UpdateProfile = z.infer<typeof updateProfileSchema>
```

| Zod 4 | Unknown keys | Equivalent pipe setting |
| --- | --- | --- |
| `z.strictObject({…})` | Rejected with an `Unrecognized key` issue | `whitelist: true, forbidNonWhitelisted: true` |
| `z.object({…})` | Stripped from the output, parse succeeds | `whitelist: true` |
| `z.looseObject({…})` | Passed through into the output | the default, `whitelist: false` |

```bash
curl -sS -X PATCH localhost:3000/users/8f1c…/ \
  -H 'content-type: application/json' \
  -d '{"displayName":"Mallory","role":"admin"}'
```

```json title="400 Bad Request"
{
  "message": ["role: Unrecognized key: \"role\""],
  "error": "Bad Request",
  "statusCode": 400
}
```

The other libraries have the same three-way split: `v.strictObject()` / `v.object()` / `v.looseObject()` in Valibot, and `.onUndeclaredKey('reject' | 'delete' | 'ignore')` in ArkType.

:::warning `z.object()` is safe only if you use the output
Stripping happens in the *returned* value. The pipe's `transform` option defaults to `true`, so your handler receives the stripped object and you are fine. Set `transform: false` and the pipe hands back the original input — unknown keys intact — after a successful validation. That combination is a mass-assignment hole that reads like a performance tweak.
:::

The full Zod 4 API — `strictObject` versus `looseObject`, `z.coerce`, the error helpers — is on [Validation](../express-libraries/validation.md). Everything there behaves identically inside Nest.

## Nested objects need the same treatment

A whitelisted top level says nothing about the objects inside it.

```ts vulnerable title="DO NOT COPY"
import { IsEmail, IsObject } from 'class-validator'

export class UpdateProfileDto {
  @IsEmail()
  email: string

  // Decorated, so the whitelist keeps it. Never inspected, so its
  // contents are whatever the client sent.
  @IsObject()
  preferences: Record<string, unknown>
}
```

`{"email":"a@b.test","preferences":{"role":"admin"}}` passes with `whitelist: true` and `forbidNonWhitelisted: true`, because `preferences` *is* whitelisted — the pipe does not descend into a value it has no class for.

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

`@Type()` is what makes the nested value a `PreferencesDto` instance, which is what gives the whitelist something to whitelist against. Without it the object stays plain and the strip never reaches inside. `@ValidateNested()` and `@Type()` are a pair — see [class-validator and class-transformer](class-validator.md).

Zod nests without ceremony, but strictness is per object, so every level needs it:

```ts good title="src/users/schemas/update-profile.schema.ts"
import { z } from 'zod'

export const updateProfileSchema = z.strictObject({
  email: z.email(),
  preferences: z.strictObject({
    theme: z.enum(['light', 'dark']),
    emailDigest: z.boolean(),
  }),
})
```

A `z.object()` nested inside a `z.strictObject()` still strips its own unknown keys silently. Be deliberate at every level.

## Prototype-pollution keys

`__proto__`, `prototype` and `constructor` in a JSON body are just strings, and they are the reason a `{ ...body }` spread or a deep merge can change the behavior of unrelated objects.

Both Nest 12 pipes handle this before validation runs. `ValidationPipe` and `StandardSchemaValidationPipe` each call a `stripProtoKeys` routine that deletes those three keys from the incoming value, recursing through arrays and nested objects, and skipping typed arrays and the built-in `Date`, `RegExp`, `Error`, `Map`, `Set`, `WeakMap` and `WeakSet` types so a real instance is not mangled.

Two consequences worth knowing:

- It happens **before** your schema or your decorators see the value, so you cannot write a rule that detects the attempt. If you want to log probing, do it in middleware on the raw parsed body.
- It **mutates the value in place**. If something else in your stack reads the same object — a request-signature check, an audit log of the raw body — it is reading a modified object. Verify signatures over the raw bytes before body parsing.

The whitelist helps here too: a decorated DTO plus `whitelist: true` drops those keys anyway, because they carry no constraint.

## Query strings and route parameters

`whitelist` applies to any parameter the pipe validates against a class, including a query DTO:

```ts title="src/users/users.controller.ts"
import { Controller, Get, Query } from '@nestjs/common'
import { IsInt, IsOptional, Max, MaxLength, Min } from 'class-validator'
import { Type } from 'class-transformer'

export class ListUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number

  @IsOptional()
  @MaxLength(200)
  q?: string
}

@Controller('users')
export class UsersController {
  @Get()
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query)
  }
}
```

`forbidNonWhitelisted: true` on a query DTO is the one place the strict setting regularly hurts: the first `?utm_source=newsletter` link someone shares returns a 400. Either declare the tracking parameters you tolerate, or override the pipe for that route with `whitelist: true` and `forbidNonWhitelisted: false`. On the schema side, that is `z.object()` instead of `z.strictObject()`.

Be careful with a per-route override. A local pipe *replaces* the global one for that parameter rather than merging with it, so an override that forgets `whitelist` reopens the hole on exactly that route.

## Security considerations

**This is the control for OWASP API3, mass assignment.** The threat, the exploit and the general fix are on [Mass assignment](../security/mass-assignment.md); the Nest-specific framing is on [Validation as a security control](../nestjs-security/validation-as-a-control.md).

**Both stacks fail open by default.** `new ValidationPipe()` with no options validates and passes unknown keys through. `StandardSchemaValidationPipe` with `z.object()` strips them silently, and with no `schema` on the parameter validates nothing at all. Neither default is the safe one.

**An undecorated property is invisible, not permitted.** With `whitelist: true` it is stripped — which is the behavior you want, and also the behavior that makes a forgotten decorator look like "the field stopped working" rather than "validation is broken". Use `@Allow()` when you genuinely want a property accepted with no constraint.

**Whitelisting does not bound size.** `whitelist: true` removes unknown keys after the body has been parsed into memory. A 50 MB body of unknown keys is still parsed, still allocated, and still stripped. Cap it on the body parser.

**Whitelisting is not authorization.** Rejecting `role` from the body does not stop a user from updating an account that is not theirs. Ownership checks are a separate control — see [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

**A whitelist on input does not protect output.** The same entity that must not accept `role` from a client usually must not return `passwordHash` to one. That is [Serialization](serialization.md), and it needs its own allowlist.

**Verify with a request, not by reading configuration.** The end-to-end test above is the control. Everything else is an intention.

## Common mistakes

- **`forbidNonWhitelisted: true` without `whitelist: true`.** Completely inert, and it looks right.
- **`new ValidationPipe()` with no options.** Validates, strips nothing, and hands unknown keys to your service.
- **Binding the pipe only in `main.ts`.** Tests built from `AppModule` run without it and prove nothing.
- **Overriding the global pipe per route and dropping `whitelist`.** The local pipe replaces the global one rather than extending it.
- **`@ValidateNested()` without `@Type()`.** The nested object is neither validated nor stripped.
- **Assuming a nested `z.object()` inherits strictness from an outer `z.strictObject()`.** It does not; set it per level.
- **`transform: false` with `z.object()`.** The pipe returns the original input, unknown keys included.
- **Spreading the DTO into an entity in the service.** Assign the allowed fields by name so a new column is not writable by default.
- **`forbidNonWhitelisted: true` on a query DTO with no room for tracking parameters.** The first marketing link is a 400.
- **Believing `whitelist: true` bounds the payload.** It runs after parsing; the body limit is on the parser.
- **Treating a passing whitelist as proof the request is authorized.**

## Related topics

- [The ValidationPipe](validation-pipe.md) — every option on the pipe, and where to bind it.
- [class-validator and class-transformer](class-validator.md) — why `@ValidateNested()` needs `@Type()`.
- [Standard Schema with Zod](standard-schema-with-zod.md) — the schema-side stack and its `stripProtoKeys` behavior.
- [Transforming payloads](transforming-payloads.md) — why `transform: false` interacts with stripping.
- [Serialization](serialization.md) — the same allowlist problem on the response side.
- [Mass assignment](../security/mass-assignment.md) — the attack, end to end, with the generic fix.
- [Validation as a security control](../nestjs-security/validation-as-a-control.md) — where validation sits in the Nest threat model.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the control the whitelist does not provide.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — how to make the verification above part of CI.
- [Validation](../express-libraries/validation.md) — `strictObject` and the Zod 4 API outside Nest.
