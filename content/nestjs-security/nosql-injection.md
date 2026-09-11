---
title: NoSQL injection
description: Mongoose operator injection in NestJS 12 — an authentication bypass with a JSON object, $gt, $regex ReDoS and $where, then the pipe settings, DTO coercion and sanitizeFilter that close it.
status: current
updated: 2026-09-11
---

There is no string to escape. The payload is a JSON object, the driver receives it as an object, and MongoDB executes it as a query document exactly as designed. Nothing is malformed at any layer — which is why a filter built from `request.body` is a login bypass, and why the fix is a *type* check rather than an escaping step.

The engine-level mechanics are on [NoSQL injection](../security/nosql-injection.md). This page is the Nest version: where the untyped value gets in, which pipe settings stop it, and what `mongoose` **9.9.5** gives you on top.

## The threat

An attacker who can place an *object* where you expected a *string* controls the query operator. `{ "$ne": null }` matches every document. `{ "$gt": "" }` matches every string. `{ "$regex": "^a" }` reads a secret one character at a time. `$where` runs JavaScript on the server. None of these need a syntax error, a special character, or a single quote.

In a Nest application the entry point is almost always the same: a handler whose parameter is typed as a DTO but whose *value* was never checked against that type, because no pipe ran.

## A concrete exploit

A login endpoint. It hashes correctly, it uses Argon2, and it is a complete authentication bypass.

:::danger An object where a string was expected
```ts vulnerable title="DO NOT COPY — src/auth/auth.controller.ts"
import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common'
import { AuthService } from './auth.service.js'

export class LoginDto {
  email: string
  password: string
}

@Controller('auth')
export class AuthController {
  private readonly auth: AuthService

  constructor(auth: AuthService) {
    this.auth = auth
  }

  @Post('login')
  async login(@Body() body: LoginDto) {
    // `body` is TYPED as LoginDto. Nothing CHECKED that it is one.
    const user = await this.auth.findByCredentials(body.email, body.password)
    if (!user) throw new UnauthorizedException('Invalid credentials')
    return this.auth.issueToken(user)
  }
}
```

```ts vulnerable title="DO NOT COPY — src/auth/auth.service.ts"
@Injectable()
export class AuthService {
  private readonly users: Model<User>

  constructor(@InjectModel(User.name) users: Model<User>) {
    this.users = users
  }

  findByCredentials(email: unknown, password: unknown) {
    // Whatever arrived is spliced into the query document.
    return this.users.findOne({ email, password }).lean()
  }
}
```
:::

The TypeScript annotation is erased at build time. `LoginDto` at runtime is a JavaScript class nobody instantiated, and `body` is the parsed JSON — whatever shape it had.

```bash
curl -s -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$ne":null}}'
```

The filter Mongoose sends is `{ email: 'admin@example.com', password: { $ne: null } }` — "the admin, whose password is anything at all".

```json title="200 OK — authenticated as admin, no password"
{ "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…", "user": { "role": "admin" } }
```

### Without knowing an email either

Drop the email and let the operator pick a user:

```bash
curl -s -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":{"$gt":""},"password":{"$ne":null}}'
```

`{ $gt: "" }` matches every non-empty string, so `findOne` returns whichever document MongoDB reaches first — frequently the oldest account in the collection, which is frequently the founder's.

### `$regex`: extracting the value one character at a time

When the endpoint only tells you yes or no, `$regex` turns it into an oracle. Each request confirms one character of a reset token, an API key, or a hash:

```bash
# Is the first character of the admin's reset token 'a'?
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/reset/confirm \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","token":{"$regex":"^a"}}'
```

```text
401
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/reset/confirm \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","token":{"$regex":"^7"}}'
```

```text
200
```

Sixteen requests per character, a few hundred requests for the whole token. Every one of them is a well-formed 200 or 401.

The same operator is also a denial of service, because the regex runs on the **database server** against every document it has to examine:

```bash
curl -s -X POST localhost:3000/users/search \
  -H 'content-type: application/json' \
  -d '{"name":{"$regex":"(a+)+$"}}'
```

A nested quantifier against a long non-matching string backtracks exponentially. One request, one pegged database CPU, and your application's rate limiter never saw a second request to count.

### `$where`: JavaScript on the server

If the collection has not disabled it, `$where` accepts a string of JavaScript that MongoDB evaluates per document:

```bash
curl -s -X POST localhost:3000/users/search \
  -H 'content-type: application/json' \
  -d '{"$where":"function(){ return true }"}'
```

```json title="200 OK — the whole collection"
[ { "email": "admin@example.com", "role": "admin", "passwordHash": "$argon2id$…" }, … ]
```

A `$where` of `sleep(5000)` is the same denial of service with no cleverness required. Mongoose exposes it as `Query#$where()`, and an unvalidated filter object reaches it for free.

## The fix

Four layers. The first two are the ones that matter; the last two are for the code paths that build filters dynamically.

### 1. A global `ValidationPipe` that strips and rejects

This is the single change that closes operator injection across the whole application, and it is the same change that closes mass assignment. That is not a coincidence — both bugs are "a key the DTO did not declare reached the data layer".

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'

@Module({
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,            // drop every property with no decorator
        forbidNonWhitelisted: true, // …and reject rather than silently drop
        transform: true,            // hand the handler a real DTO instance
        transformOptions: { enableImplicitConversion: false },
      }),
    },
  ],
})
export class AppModule {}
```

Bind it with `APP_PIPE` in the module rather than `app.useGlobalPipes()` in `main.ts`. A test built from `AppModule` never executes `main.ts`, so a pipe bound there is missing from exactly the suite meant to prove it works.

### 2. A DTO that demands a primitive

`whitelist` removes keys you did not declare. It does not check the *type* of the keys you did. `@IsString()` is what rejects an object in a declared field.

```ts good title="src/auth/dto/login.dto.ts"
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string

  // The decorator that makes { "$ne": null } a 400 instead of a login.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string
}
```

| Payload | `whitelist` alone | `whitelist` + `@IsString()` |
| --- | --- | --- |
| `{"password":{"$ne":null}}` | passes — `password` is declared | **400** |
| `{"password":"x","role":"admin"}` | **400** — `role` is not declared | **400** |
| `{"password":["a","b"]}` | passes | **400** |

Both are needed, and neither replaces the other.

:::warning `transformOptions: { enableImplicitConversion: true }` weakens this
Implicit conversion coerces values toward the declared TypeScript type before validation. It makes `?page=2` become a number without a `@Type()` decorator, and it also makes some values pass a check they should have failed. Leave it off and convert explicitly with `@Type(() => Number)` where you need it. See [Transforming payloads](../nestjs-validation/transforming-payloads.md).
:::

The Zod equivalent, if you are on the Standard Schema stack, is the same idea in one line — `z.string()` rejects an object, and `z.strictObject` rejects the extra key:

```ts good title="src/auth/schemas/login.schema.ts"
import { z } from 'zod'

export const loginSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
})

export type Login = z.infer<typeof loginSchema>
```

### 3. Coerce at the data layer anyway

Validation is the boundary control. The repository is the last line, and it is the one that survives somebody adding an internal caller that skips the pipe — a queue consumer, a CLI command, a migration script. `$eq` makes "compare this as a value" explicit:

```ts good title="src/auth/auth.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { User } from './schemas/user.schema.js'

@Injectable()
export class AuthService {
  private readonly users: Model<User>

  constructor(@InjectModel(User.name) users: Model<User>) {
    this.users = users
  }

  findByEmail(email: string) {
    // $eq forces a value comparison even if `email` somehow arrived as an object.
    return this.users.findOne({ email: { $eq: String(email) } }).lean()
  }
}
```

Note what the fixed login flow no longer does: **it does not put the password in the query at all.** Look the user up by email, then verify the hash in the application. A password that never reaches the filter cannot be an operator.

```ts good title="src/auth/auth.service.ts"
import argon2 from 'argon2'

async findByCredentials(email: string, password: string) {
  const user = await this.users.findOne({ email: { $eq: String(email) } }).lean()
  // Verify against a constant dummy hash when the user is missing, so the
  // response time does not reveal whether the account exists.
  const digest = user?.passwordHash ?? DUMMY_ARGON2_HASH
  const ok = await argon2.verify(digest, password)
  return ok && user ? user : null
}
```

### 4. `sanitizeFilter` for filters you build from objects

Some queries are genuinely dynamic — a search screen with eight optional facets. Mongoose has a switch that wraps any user-supplied value containing `$`-prefixed keys in `$eq`, so an operator becomes a literal.

```ts good title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { ConfigModule, ConfigService } from '@nestjs/config'

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        // Global default: every query filter is sanitized.
        sanitizeFilter: true,
      }),
    }),
  ],
})
export class AppModule {}
```

It is also a per-query option, which is the better place for it when you want it only where a filter is assembled from input:

```ts good title="src/users/users.repository.ts"
search(filter: Record<string, unknown>) {
  // { name: { $regex: '…' } } becomes { name: { $eq: { $regex: '…' } } } — a literal.
  return this.users.find(filter).setOptions({ sanitizeFilter: true }).limit(50).lean()
}
```

When you *do* want an operator in a sanitized query, opt in explicitly with `mongoose.trusted()`:

```ts good title="src/users/users.repository.ts"
import mongoose from 'mongoose'

recentlyActive(since: Date) {
  return this.users
    .find({ lastSeenAt: mongoose.trusted({ $gte: since }) })
    .setOptions({ sanitizeFilter: true })
    .lean()
}
```

`mongoose.trusted()` marks *that object* as yours. It is the correct escape hatch precisely because it appears at the call site, where a reviewer reads it.

:::warning `sanitizeFilter` is a safety net, not the control
It wraps `$`-prefixed values in `$eq`. It does not turn a `$regex` denial of service into a well-formed query, it does not cap result sizes, and it does nothing for a projection or an update document. Validate the input; use `sanitizeFilter` for the dynamic paths you cannot enumerate.
:::

There is a matching `sanitizeProjection` option for the same problem on `.select()`, and it is worth setting wherever the field list is built from a `?fields=` parameter.

### Turn off `$where` at the server

`$where` has no place in an application query. It is disabled by default on MongoDB Atlas and can be disabled on a self-managed deployment with `security.javascriptEnabled: false` in `mongod.conf`. Do that, and the `$where` payload above becomes an error instead of a full-collection dump. It also disables `$accumulator` and `$function`, so check nothing legitimate uses them first.

## How to verify the fix

Replay the bypass:

```bash
curl -s -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$ne":null}}'
```

```json title="400 Bad Request"
{
  "message": ["password must be a string", "password must be longer than or equal to 8 characters"],
  "error": "Bad Request",
  "statusCode": 400
}
```

And the mass-assignment-shaped variant, which the same settings reject for a different reason:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse","$where":"return true"}'
```

```text
400
```

Then pin it down with a test, because a global pipe is one refactor away from not being global:

```ts title="test/nosql-injection.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('operator injection', () => {
  let app: import('@nestjs/common').INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(() => app.close())

  const payloads = [
    { email: 'admin@example.com', password: { $ne: null } },
    { email: { $gt: '' }, password: { $ne: null } },
    { email: 'admin@example.com', password: { $regex: '^' } },
    { email: 'admin@example.com', password: ['a', 'b'] },
  ]

  it.each(payloads)('rejects %j with 400', async (payload) => {
    await request(app.getHttpServer()).post('/auth/login').send(payload).expect(400)
  })

  it('rejects an undeclared $where key', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'a@b.test', password: 'correct-horse', $where: 'return true' })
      .expect(400)
  })
})
```

A 401 is not a pass. A 401 means the query ran and happened not to match — the injection reached the database and the request was merely unlucky. **400 is the pass condition**, because it means the value never became a filter.

## Production considerations

- **Cap the result size at the repository, not the controller.** `.limit(50)` on the query is what stops a matched-everything filter from serializing the collection into a response. An attacker who gets one operator through should still only get a page.
- **Set `maxTimeMS` on expensive queries.** It bounds a `$regex` backtracking storm the same way `statement_timeout` bounds a SQL one, and it is the only control that acts on work already running inside MongoDB.
- **Index the fields you filter on.** An unindexed `$regex` scans the collection; an indexed anchored one does not. This is a performance rule that doubles as an abuse control.
- **Use a least-privilege database user.** A role with `readWrite` on one database, not `dbOwner` and not `root`. `$where` and `$out` are considerably less interesting to an attacker who cannot write outside your collections.
- **Disable server-side JavaScript** unless something needs it. One line in `mongod.conf`, and an entire operator class stops existing.
- **Log the rejections.** A burst of 400s whose messages all say "must be a string" on a login route is somebody enumerating your operators. See [Safe logging](safe-logging.md).

## Common mistakes

- **Believing the TypeScript annotation is a runtime check.** `@Body() body: LoginDto` with no pipe hands you the parsed JSON, whatever shape it has. Types are erased.
- **`whitelist: true` without `@IsString()` on the declared fields.** The whitelist removes *undeclared* keys; an object in `password` is a declared key with the wrong type.
- **`forbidNonWhitelisted: true` without `whitelist: true`.** Completely inert — it is not a weaker mode, it does nothing. See [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md).
- **Binding the pipe only in `main.ts`.** Tests built from `AppModule` run without it and pass while proving nothing.
- **Putting the password in the query at all.** Look the user up by identifier and verify the hash in the application.
- **Treating a 401 in the injection test as a pass.** The query still ran. Assert 400.
- **Relying on `sanitizeFilter` instead of validation.** It rescues dynamic filter building; it does not bound regex cost, projections, or update documents.
- **Forgetting the update document.** `findOneAndUpdate(filter, req.body)` is the same bug on the write side, and `$set`/`$inc`/`$rename` are attacker-supplied operators there too.
- **Leaving `$where` enabled.** It is arbitrary JavaScript in a query, per document.
- **Assuming an unindexed `$regex` is "just slow".** One request can occupy a database core for minutes, and your rate limiter counted it once.
- **`enableImplicitConversion: true` in `transformOptions`.** It quietly coerces values past checks you wrote deliberately.

## Related topics

- [NoSQL injection](../security/nosql-injection.md) — the attack against MongoDB without a framework in the way.
- [SQL injection](sql-injection.md) — the same class where the payload is a string.
- [Validation as a security control](validation-as-a-control.md) — why the global pipe is the highest-leverage security setting in a Nest app.
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — `whitelist` and `forbidNonWhitelisted` in full.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — every option, and where to bind it.
- [Standard Schema with Zod](../nestjs-validation/standard-schema-with-zod.md) — the schema-side equivalent.
- [Mongoose](../nestjs-orms/mongoose.md) — schemas, models and the `@InjectModel` provider.
- [MongoDB](../nestjs-databases/mongodb.md) — connection options, indexes and `maxTimeMS`.
- [Authentication and session security](authentication-and-session-security.md) — the rest of what the login route needs.
- [Rate limiting and abuse](rate-limiting.md) — bounding the `$regex` oracle even when it is rejected.
- [Safe logging](safe-logging.md) — recording the probe without recording the payload.
