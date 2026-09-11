---
title: Validation as a security control
description: Why the global ValidationPipe in NestJS 12 is a security boundary rather than an ergonomics feature — whitelist against mass assignment and operator injection, the v12 prototype-key stripping, and validating every boundary.
status: current
updated: 2026-09-11
---

Validation is usually introduced as developer comfort: nicer errors, typed handlers, less defensive code. That framing is why it gets configured badly. A global `ValidationPipe` with the right two options is the control that closes mass assignment, operator injection and prototype pollution in a single registration — and the default constructor closes none of them. This page makes the security argument, then shows what the argument costs you in configuration.

The option-by-option reference is [The ValidationPipe](../nestjs-validation/validation-pipe.md); the whitelist in depth, with the admin-escalation exploit, is [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md). This page is why you should treat both as security documents.

## The threat: a type annotation is not a check

`@Body() body: CreateUserDto` compiles to `@Body() body`. TypeScript types are erased; at runtime the parameter holds whatever `JSON.parse` produced. Everything downstream — your service, your ORM, your query — is written against a shape that nobody verified.

Three distinct vulnerabilities come out of that one fact, and one setting closes all three.

| Vulnerability | The payload | What it reaches |
| --- | --- | --- |
| Mass assignment (OWASP API3) | an **extra key**: `{"role":"admin"}` | an ORM `save()` / `update()` that iterates keys |
| Operator injection (OWASP API8) | a **wrong type**: `{"password":{"$ne":null}}` | a Mongoose filter, where an object is an operator |
| Prototype pollution | a **reserved key**: `{"__proto__":{"isAdmin":true}}` | a spread or deep merge, then every object in the process |

They are usually written up as three unrelated bugs in three unrelated places. In a Nest application they are one bug in one place: the boundary where an unverified object became a typed parameter.

## The exploit, three payloads, one endpoint

```ts vulnerable title="DO NOT COPY — src/main.ts"
// The default constructor. Validates the fields you declared; passes everything
// else straight through to your service.
app.useGlobalPipes(new ValidationPipe())
```

```bash
# 1 — an extra key the DTO never mentioned
curl -s -X PATCH localhost:3000/users/me -H 'content-type: application/json' \
  -H 'authorization: Bearer <normal user>' \
  -d '{"displayName":"Mallory","role":"admin"}'
```

```json title="200 OK"
{ "id": "8f1c…", "displayName": "Mallory", "role": "admin" }
```

```bash
# 2 — a declared key with the wrong type
curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$ne":null}}'
```

```json title="200 OK"
{ "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" }
```

```bash
# 3 — a reserved key
curl -s -X PATCH localhost:3000/users/me -H 'content-type: application/json' \
  -d '{"displayName":"Mallory","__proto__":{"isAdmin":true}}'
```

Three requests, three classes of compromise, one missing options object.

## The fix is four lines

```ts good title="src/app.module.ts"
import { Module, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,            // strip every property with no decorator
        forbidNonWhitelisted: true, // …and reject instead, so probing is visible
        transform: true,            // hand the handler the validated instance
        transformOptions: { enableImplicitConversion: false },
      }),
    },
  ],
})
export class AppModule {}
```

| Payload | Result |
| --- | --- |
| `{"displayName":"Mallory","role":"admin"}` | **400** — `property role should not exist` |
| `{"email":"…","password":{"$ne":null}}` | **400** — `password must be a string` |
| `{"displayName":"Mallory","__proto__":{…}}` | the key is deleted before validation; the rest validates |

### `whitelist` handles the extra key

`class-validator` only knows properties that carry a decorator. `whitelist: true` deletes everything else from the object your handler receives. It is the mass-assignment control, and it is also the reason an undeclared `$where` key never reaches a Mongoose filter.

### `forbidNonWhitelisted` turns stripping into rejection

It **requires `whitelist: true`** — on its own it is completely inert, not a weaker mode. That is the most common misconfiguration of this pipe and it survives code review because the dangerous-sounding option is the one that is present.

Rejection is better than stripping for a reason beyond debuggability: a silently stripped field means somebody enumerating your column names gets 200s the whole way and leaves nothing in your logs. A 400 per attempt is an abuse signal your rate limiter and your alerting can both see.

### `@IsString()` handles the wrong type

This is the half people miss. The whitelist filters *which* keys survive; the decorators decide *what* may be in them. A `password` field with no type decorator is a declared key, so the whitelist keeps it — including when its value is `{ "$ne": null }`.

```ts good title="src/auth/dto/login.dto.ts"
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string

  @IsString()   // the decorator that turns an operator payload into a 400
  @MinLength(8)
  @MaxLength(128)
  password: string
}
```

Every field needs a type constraint, not only a semantic one. `@IsOptional()` alone, or `@Allow()` alone, declares a property with no type check — which is precisely the shape an operator injection needs.

### `transform: true` is not cosmetic

`ValidationPipe`'s `transform` option defaults to **`false`** (`StandardSchemaValidationPipe`'s defaults to `true` — they differ, and it matters).

With `transform: true`, the handler receives the validated, whitelisted class instance. With `transform: false`, what the handler receives depends on an internal detail of the pipe: reading the shipped `@nestjs/common@12.0.1` source, the non-transform path returns a plain-converted copy of the validated entity *only when more than one validator option was supplied*, and otherwise returns the original input untouched. `new ValidationPipe()` with no options therefore hands your handler the raw parsed body; `new ValidationPipe({ whitelist: true })` does not.

You should not have to know that. Set `transform: true` and the answer is always "the validated instance". Three things follow from it:

- **The object your service sees is the object that was checked.** No branch, no key-count heuristic.
- **`@Type(() => Number)` conversions are preserved**, so `perPage` is a number in your handler rather than a numeric string that gets coerced somewhere you did not choose.
- **The value is an instance of the DTO class**, which is what `ClassSerializerInterceptor`, `instanceof` checks and response mapping need.

:::warning `enableImplicitConversion: true` is not the shortcut it looks like
Implicit conversion coerces values toward the declared TypeScript type before validation runs. It is convenient for query strings and it quietly lets values through checks you wrote on purpose. Leave it off and be explicit with `@Type()`. See [Transforming payloads](../nestjs-validation/transforming-payloads.md).
:::

### Bind it with `APP_PIPE`, not only in `main.ts`

`app.useGlobalPipes()` in `main.ts` works in production and is absent from your tests, because `Test.createTestingModule({ imports: [AppModule] })` never runs `main.ts`. The result is a suite that cannot fail on the control it was written to prove, and a green build that means nothing.

`APP_PIPE` puts the pipe in the module graph, so every test that builds the application gets it. It also lets the pipe inject dependencies, which `useGlobalPipes` with a constructed instance cannot.

:::best-practice
If you keep a `main.ts` registration for clarity, make it read from the same exported instance the `APP_PIPE` provider uses. Two independently written configurations is how a production pipe ends up strict and a test pipe permissive.
:::

## Prototype-pollution keys are handled for you

New enough in v12 to be worth stating explicitly: **both** validation pipes strip `__proto__`, `prototype` and `constructor` from the incoming value before validation. `ValidationPipe.transform()` calls `stripProtoKeys(value)` immediately after normalizing nil values; `StandardSchemaValidationPipe.transform()` calls the same routine before handing the value to the schema. Both recurse through nested objects and arrays, and both skip the built-in `Date`, `RegExp`, `Error`, `Map`, `Set`, `WeakMap` and `WeakSet` types so a real instance is not mangled.

Two consequences you will actually hit:

- **It runs before your rules.** Your schema cannot detect the attempt, because the key is already gone. If you want to alert on probing, inspect the parsed body in middleware.
- **It mutates in place.** Anything else reading the same object — a request-signature check, an audit log of the raw body — sees the modified object. Verify webhook signatures over `request.rawBody` (which needs `rawBody: true` on `NestFactory.create`) before body parsing has any say.

The whitelist would have removed those keys anyway, since none of them carries a decorator. The stripping matters for the parameters the pipe *does not* validate against a class, and for the `StandardSchemaValidationPipe` path where the unknown-key policy lives in the schema instead.

## The Standard Schema stack

`StandardSchemaValidationPipe` has no `whitelist` option and needs none: unknown-key policy is a property of the schema.

```ts good title="src/users/schemas/update-profile.schema.ts"
import { z } from 'zod'

// strictObject rejects unknown keys; z.string() rejects an object in a string field.
export const updateProfileSchema = z.strictObject({
  email: z.email().optional(),
  displayName: z.string().min(1).max(80).optional(),
})

export type UpdateProfile = z.infer<typeof updateProfileSchema>
```

```ts good title="src/app.module.ts"
import { Module, StandardSchemaValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [{ provide: APP_PIPE, useFactory: () => new StandardSchemaValidationPipe() }],
})
export class AppModule {}
```

| Zod 4 | Unknown keys | `ValidationPipe` equivalent |
| --- | --- | --- |
| `z.strictObject({…})` | rejected with an `Unrecognized key` issue | `whitelist: true, forbidNonWhitelisted: true` |
| `z.object({…})` | stripped from the output | `whitelist: true` |
| `z.looseObject({…})` | passed through | the default — a mass-assignment hole |

:::danger `transform: false` on the schema pipe is a real hole
`StandardSchemaValidationPipe` returns `result.value` when `transform` is true (the default) and the **original input** when it is false. With a `z.object()` — which strips unknown keys in its *output* — turning transform off gives your handler the unstripped input after a successful validation. That combination reads like a performance tweak and is a mass-assignment vulnerability.
:::

Two more properties of this pipe worth knowing before you rely on it:

- **A parameter with no `schema` in its metadata is returned untouched.** There is no "validate everything by default"; a forgotten `@Body({ schema })` is an unvalidated body with no error anywhere.
- **`validateCustomDecorators` defaults to `false`.** A value produced by your own `createParamDecorator()` is not validated unless you opt in.

## Validate at every boundary, not only at the controller

The pipe guards HTTP parameters. It does not guard anything else, and every one of these has shipped as a breach in somebody's application:

| Boundary | What runs there | The control |
| --- | --- | --- |
| HTTP body / query / params | `ValidationPipe` | the configuration above |
| Webhook payloads | the same pipe — *if* you gave the route a DTO | signature over `rawBody`, then a DTO, then an event-type allow-list |
| Microservice messages | pipes apply to `@MessagePattern` handlers too | the same global pipe; set `transform: true` |
| Queue jobs (BullMQ) | **nothing** | validate in the processor, with the same schema |
| Scheduled tasks reading a table | **nothing** | treat stored data as untrusted; re-validate before use |
| Environment variables | **nothing, by default** | `validationSchema` on `ConfigModule` — see [Secrets and config validation](secrets-and-config.md) |
| Upstream API responses | **nothing** | parse into a DTO before it reaches an entity |

The queue case is the one that bites hardest, because the payload usually *came* from a validated HTTP request — six months ago, before the DTO changed:

```ts good title="src/reports/reports.processor.ts"
import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { reportJobSchema } from './schemas/report-job.schema.js'

@Processor('reports')
export class ReportsProcessor extends WorkerHost {
  async process(job: Job<unknown>) {
    // The job was enqueued by a past version of this code. Validate it now.
    const data = reportJobSchema.parse(job.data)
    return this.reports.generate(data)
  }
}
```

Reuse the schema, do not re-describe it. A second description of the same shape drifts from the first, and the drift is always in the direction of accepting more.

## Verifying

A configuration you verified by reading it is a configuration you have not verified.

```ts title="test/validation-control.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('the global validation pipe is a security control', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    // Building from AppModule is the point: this is what proves APP_PIPE is bound.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(() => app.close())

  it('rejects an undeclared privileged property', () =>
    request(app.getHttpServer())
      .patch('/users/me')
      .set('authorization', `Bearer ${userToken}`)
      .send({ displayName: 'Mallory', role: 'admin' })
      .expect(400))

  it('rejects an object where a string is declared', () =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: { $ne: null } })
      .expect(400))

  it('does not let __proto__ reach the handler', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .set('authorization', `Bearer ${userToken}`)
      .send({ displayName: 'Mallory', __proto__: { isAdmin: true } })
      .expect(200)

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
    expect(response.body.isAdmin).toBeUndefined()
  })
})
```

Run it against the whole application, not against the pipe in isolation. The failure mode being tested is "the pipe is not where you think it is", and a unit test that constructs the pipe by hand cannot see that.

## Production considerations

- **Error bodies leak your schema.** `forbidNonWhitelisted` replies `property role should not exist`, which confirms the attacker guessed a column name that exists in your DTO namespace. That is an acceptable trade for the abuse signal, but do not add the *value* or the *target object* to the error — `validationError: { target: false, value: false }` keeps them out.
- **`disableErrorMessages: true` for hostile surfaces.** It replaces the detail with a generic message. Use it on public, unauthenticated endpoints if schema disclosure worries you more than support burden; keep detail on authenticated ones.
- **`errorFormat: 'grouped'` changes the response shape.** New in v12: `message` becomes `Record<string, string[]>` instead of `string[]`. It is a breaking change for any client or exception filter that assumes an array. Pick one and keep it.
- **Whitelisting does not bound size.** It runs *after* the body has been parsed into memory. A 50 MB body of unknown keys is parsed, allocated, then stripped. Cap the body on the adapter and cap uploads on multer.
- **Alert on a 400 burst.** A client producing hundreds of `should not exist` errors is mapping your data model. That is reconnaissance, and it is one of the few attack signals that arrives pre-labelled.
- **A per-route pipe replaces the global one for that parameter.** It does not merge. An override written to relax `forbidNonWhitelisted` for tracking query parameters, that forgets to repeat `whitelist`, reopens mass assignment on exactly that route.

## Common mistakes

- **Treating validation as ergonomics.** It is the boundary between "an object an attacker composed" and "a value your code is written against".
- **`new ValidationPipe()` with no options.** Validates the declared fields, passes every other key to your service.
- **`forbidNonWhitelisted: true` without `whitelist: true`.** Inert. Reads as the strict option; does nothing.
- **Declaring a field with no type decorator.** `@IsOptional()` or `@Allow()` alone leaves the door open for an object where a string belongs.
- **Assuming `transform` defaults to `true` on `ValidationPipe`.** It defaults to `false`, and the non-transform return path is not something you want to depend on.
- **`enableImplicitConversion: true` because a query parameter would not coerce.** Use `@Type(() => Number)` on that field instead.
- **Registering the pipe only in `main.ts`.** Absent from the tests that exist to prove it.
- **Overriding the pipe per route and dropping `whitelist`.** Local pipes replace, not extend.
- **`z.object()` where you meant `z.strictObject()`,** or a nested `z.object()` inside a strict parent — strictness is per level.
- **`transform: false` on `StandardSchemaValidationPipe`.** Returns the original input, unknown keys intact.
- **Forgetting `@Body({ schema })` on one route.** That parameter is silently unvalidated; there is no default schema.
- **Validating only HTTP.** Queue jobs, microservice messages, webhook bodies and upstream responses all need the same schema.
- **Believing validation is authorization.** Rejecting `role` from a body does not stop a user from editing somebody else's record. See [Authorization and IDOR](authorization-and-idor.md).
- **Believing validation protects the response.** The entity that must not accept `role` usually must not return `passwordHash` either. See [Serialization](../nestjs-validation/serialization.md).

## Related topics

- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — the whitelist in full, with the escalation exploit and the nested-DTO trap.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — every option and every binding scope.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the schema-first stack and its own defaults.
- [Transforming payloads](../nestjs-validation/transforming-payloads.md) — `@Type()`, `enableImplicitConversion` and what `transform` returns.
- [Serialization](../nestjs-validation/serialization.md) — the same allow-list problem on the response side.
- [NoSQL injection](nosql-injection.md) — the operator payload this configuration stops.
- [SQL injection](sql-injection.md) — why a validated string is still not a parameterized query.
- [Authorization and IDOR](authorization-and-idor.md) — the control validation does not provide.
- [Secrets and config validation](secrets-and-config.md) — the same idea applied to the environment.
- [Pipes](../nestjs-request-handling/pipes.md) — where pipes sit in the request lifecycle.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — building the app from `AppModule` so the control is present.
- [Mass assignment](../security/mass-assignment.md) — the framework-independent version of the first payload.
