---
title: Mongoose
description: Mongoose 9.10.0 with @nestjs/mongoose 12.0.0 — forRootAsync and forFeature, @InjectModel, decorator schemas with SchemaFactory, select:false, populate without N+1, transactions on a replica set, and sanitizeFilter.
status: current
updated: 2026-09-11
---

`@nestjs/mongoose` is one of the two first-party ORM modules. It registers the Mongoose `Connection` as a provider, turns each schema into an injectable model token, and lets you declare schemas with decorators instead of a `new Schema({...})` literal — so a schema file reads like the rest of a Nest codebase. The library itself is covered in [Mongoose](../orms/mongoose.md), and the connection options and operator-injection threat in depth in [MongoDB](../nestjs-databases/mongodb.md). This page is the ORM-shaped half: schemas, models, relations and the patterns that go wrong.

This page documents **`@nestjs/mongoose` 12.0.0** with **`mongoose` 9.10.0**.

:::warning
Mongoose 9 removed callback support across the API and changed middleware signatures: **a `pre` hook no longer receives `next`** — hooks are `async` functions or return promises. Most Mongoose material online predates this. If a snippet calls `next()` in a `pre` hook or passes a callback to `save()`, it is Mongoose 7 or earlier.
:::

## Why it exists

MongoDB accepts any document you send it. Two years in, the `users` collection holds four different shapes and every read path needs defensive checks. Mongoose enforces shape at the application boundary instead — schema, casting, validators, hooks.

What `@nestjs/mongoose` adds on top is the container. The `Connection` becomes a provider with a lifecycle Nest owns, `forFeature` registers one provider per model so a service receives a narrow dependency, and `getModelToken(User.name)` is the seam a unit test overrides. Without it you would `import { User } from '../models/user.js'` at module scope, and every test that touches a service would touch a real database.

## When to use it

- **The database is MongoDB.** This is effectively the decision — Prisma 7 dropped MongoDB entirely, so the real question is Mongoose or the raw driver.
- **You want validation and defaults close to the data.** Required fields, enums, custom validators, declared once on the schema class.
- **Cross-document references.** `populate()` is the practical answer to MongoDB having no join in the query language you usually want to write.
- **Lifecycle hooks.** Hashing before save, stamping audit fields, cascading a soft delete.

## When not to use it

- **Aggregation-heavy analytics.** You will live in `aggregate()`, where the schema layer mostly gets in the way. Use the driver — [MongoDB](../nestjs-databases/mongodb.md).
- **Bulk ingest.** Casting and validating a million documents costs real time. `bulkWrite`, or the driver.
- **Your data is a graph of joins with transactional integrity across five collections.** The problem is the database choice, not the ORM. See [Choosing a database](../databases/choosing-a-database.md).

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install @nestjs/mongoose@12.0.0 mongoose@9.10.0
```
@tab pnpm
```bash
pnpm add @nestjs/mongoose@12.0.0 mongoose@9.10.0
```
@tab yarn
```bash
yarn add @nestjs/mongoose@12.0.0 mongoose@9.10.0
```
:::

The MongoDB driver is bundled with Mongoose — do not install `mongodb` separately unless you need the driver directly, and match the bundled version if you do.

:::note How the examples are written
Nest's constructor injection is usually written with the parameter-property shorthand, `constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {}`. The snippets here declare the field and assign it, because the site's snippet checker type-strips every `ts` block. The two forms are equivalent — use the shorthand in your own code.
:::

### forRootAsync

The connection is a provider, so its options come from `ConfigService` rather than `process.env` read at module-definition time.

```ts title="src/database/mongo.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGO_URL'),
        maxPoolSize: config.get<number>('DB_POOL_MAX') ?? 10,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5_000,
        socketTimeoutMS: 20_000,
        bufferCommands: false,
        autoIndex: config.get<string>('NODE_ENV') !== 'production',
        retryAttempts: 5,
        retryDelay: 2_000,
      }),
    }),
  ],
})
export class MongoModule {}
```

`MongooseModuleOptions` extends Mongoose's own `ConnectOptions` and adds `retryAttempts`, `retryDelay`, `connectionName`, `onConnectionCreate`, `lazyConnection`, `connectionFactory` and `verboseRetryLog`. The full table is in [MongoDB](../nestjs-databases/mongodb.md); three of them matter for an ORM discussion:

- **`autoIndex`** builds every declared index when a model compiles. Convenient in development, wrong in production — an index build on a large collection is unscheduled DDL against a live cluster. Gate it on the environment and create production indexes in a migration.
- **`bufferCommands: false`** makes queries fail fast while disconnected instead of queueing. The default turns a database outage into hanging requests while your health check keeps passing.
- **`serverSelectionTimeoutMS`** decides whether a primary failover looks like a brief error spike or a thirty-second stall.

`MongooseModule` manages one `Connection` per registered name and closes it on shutdown — provided `app.enableShutdownHooks()` is in `main.ts`.

### Schemas with decorators

`@Schema()` and `@Prop()` describe the document; `SchemaFactory.createForClass()` turns the class into a real Mongoose schema.

```ts title="src/users/user.schema.ts"
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type UserDocument = HydratedDocument<User>

@Schema({ timestamps: true, collection: 'users', strict: 'throw' })
export class User {
  @Prop({ required: true, unique: true, index: true, lowercase: true, trim: true })
  email: string

  @Prop({ default: null })
  name: string | null

  // select: false keeps this out of every query result unless a query asks for
  // it by name. One line that removes a whole class of accidental disclosure.
  @Prop({ required: true, select: false })
  passwordHash: string

  @Prop({ type: String, enum: ['user', 'admin'], default: 'user' })
  role: string
}

export const UserSchema = SchemaFactory.createForClass(User)
UserSchema.index({ createdAt: -1 })
```

Two schema options are doing real work. `strict: 'throw'` rejects writes containing fields that are not in the schema instead of silently dropping them, which turns a typo into an error rather than a missing value. `timestamps: true` adds `createdAt` and `updatedAt` maintained by Mongoose.

`@Prop()` infers the Mongo type from the TypeScript type for scalars. For anything the design-time type cannot express — an enum, an array element type, a reference — pass `type` explicitly, as `role` does above. This is the most common source of "why is my field a `Mixed`".

```ts title="src/posts/post.schema.ts"
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'
import { User } from '../users/user.schema.js'

export type PostDocument = HydratedDocument<Post>

@Schema({ timestamps: true, collection: 'posts', strict: 'throw' })
export class Post {
  @Prop({ required: true, trim: true })
  title: string

  @Prop({ required: true })
  body: string

  @Prop({ default: false })
  published: boolean

  // A reference is an ObjectId plus a `ref`. MongoDB has no foreign key and no
  // cascade — nothing stops this pointing at a deleted user.
  @Prop({ type: Types.ObjectId, ref: User.name, required: true, index: true })
  author: Types.ObjectId
}

export const PostSchema = SchemaFactory.createForClass(Post)
PostSchema.index({ author: 1, published: 1 })
```

### forFeature and @InjectModel

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { User, UserSchema } from './user.schema.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

`forFeature` registers a provider whose token is `getModelToken(User.name)`, and `@InjectModel(User.name)` is shorthand for `@Inject(getModelToken(User.name))`. Like TypeORM's `forFeature`, it is **scoped to the module that imported it** — a second module wanting the `User` model must call `forFeature` itself, or (better) go through `UsersService`. Export the service, not the model; see [Repository vs active record](./repository-vs-active-record.md).

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { User, UserDocument } from './user.schema.js'
import { CreateUserDto } from './dto/create-user.dto.js'

@Injectable()
export class UsersService {
  private readonly users: Model<UserDocument>

  constructor(
    @InjectModel(User.name)
    users: Model<UserDocument>,
  ) {
    this.users = users
  }

  async create(dto: CreateUserDto) {
    // Named fields, never the DTO object itself. See Security considerations.
    const user = await this.users.create({
      email: dto.email,
      name: dto.name ?? null,
      passwordHash: dto.passwordHash,
    })
    return { id: user.id, email: user.email, name: user.name }
  }

  async findById(id: Types.ObjectId) {
    // .lean() returns a plain object instead of a hydrated document: no
    // change tracking, no getters, several times faster on a read path.
    const user = await this.users.findById(id).select('email name role').lean().exec()
    if (!user) throw new NotFoundException()
    return user
  }

  findByEmail(email: string) {
    // `email` is a string because the parameter is typed and the caller
    // validated it. That is what stops operator injection — see below.
    return this.users.findOne({ email }).select('+passwordHash').lean().exec()
  }
}
```

`.select('+passwordHash')` is how you opt back in to a `select: false` field. The `+` is the whole mechanism, and it makes every place that touches the hash greppable.

`@nestjs/mongoose` 12 also ships `ParseObjectIdPipe` and `IsObjectIdPipe`, so a malformed id is a 400 before any database call happens rather than a `CastError` surfacing as a 500:

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'
import { ParseObjectIdPipe } from '@nestjs/mongoose'
import { Types } from 'mongoose'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.users.findById(id)
  }
}
```

### Overriding the model in a test

```ts title="src/users/users.service.spec.ts"
import { Test } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { User } from './user.schema.js'
import { UsersService } from './users.service.js'

const model = {
  findById: () => ({
    select: () => ({ lean: () => ({ exec: async () => ({ _id: '1', email: 'a@example.com' }) }) }),
  }),
}

const moduleRef = await Test.createTestingModule({
  providers: [UsersService, { provide: getModelToken(User.name), useValue: model }],
}).compile()

const service = moduleRef.get(UsersService)
```

Mongoose's chainable query builder makes the fake noisy, which is a fair signal: a service that chains six query-builder calls in a controller-facing method is hard to fake because it is hard to reason about. Keep query construction in one place, or use a real database with [Database fixtures](../nestjs-testing/database-fixtures.md).

## How it works

### Populated relations

`ref` is a Mongoose convention, not a database constraint. `populate()` implements the join in the application:

```ts title="src/posts/posts.service.ts"
list(limit: number) {
  return this.posts
    .find({ published: true })
    .select('title author createdAt')
    .populate({ path: 'author', select: 'email name' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec()
}
```

`populate` issues **a second query** with an `$in` on the collected ids — two round trips regardless of how many posts came back. That is not an N+1, as long as you populate on the query and not in a loop:

```ts vulnerable title="DO NOT COPY — N+1 inside a Nest service"
async list(limit: number) {
  const posts = await this.posts.find({ published: true }).limit(limit).lean().exec()
  for (const post of posts) {
    // One query per post. 50 posts is 51 round trips.
    post.author = await this.users.findById(post.author).lean().exec()
  }
  return posts
}
```

Count the populate paths on your list endpoints. Each one is another round trip, so three nested populates is four queries per request before you have rendered anything. [Avoiding N+1](./avoiding-n-plus-one.md) has the detection and the batching alternative; `$lookup` in an aggregation does the join server-side in one trip when the extra round trip actually costs you.

:::tip
Use `.lean()` on every read whose result you are only going to serialize. It skips hydrating a full Mongoose document and returns a plain object — commonly several times faster, and it removes the risk of serializing internal document state. Do not use it when you need `save()`, virtuals or instance methods.
:::

### Transactions need a replica set

MongoDB transactions require a replica set or a sharded cluster. A standalone `mongod` cannot run them, which is why they work in Atlas and fail on a developer laptop running `docker run mongo`.

```ts title="src/billing/transfer.service.ts"
import { BadRequestException, Injectable } from '@nestjs/common'
import { InjectConnection, InjectModel } from '@nestjs/mongoose'
import { Connection, Model, Types } from 'mongoose'
import { Account, AccountDocument } from './account.schema.js'

@Injectable()
export class TransferService {
  private readonly connection: Connection
  private readonly accounts: Model<AccountDocument>

  constructor(
    @InjectConnection()
    connection: Connection,
    @InjectModel(Account.name)
    accounts: Model<AccountDocument>,
  ) {
    this.connection = connection
    this.accounts = accounts
  }

  async transfer(fromId: Types.ObjectId, toId: Types.ObjectId, cents: number) {
    const session = await this.connection.startSession()
    try {
      await session.withTransaction(async () => {
        // The balance check and the decrement are ONE atomic document update,
        // so two concurrent transfers cannot both pass the check.
        const debited = await this.accounts.findOneAndUpdate(
          { _id: fromId, balance: { $gte: cents } },
          { $inc: { balance: -cents } },
          { session, returnDocument: 'after' },
        )
        if (!debited) throw new BadRequestException('Insufficient funds')

        await this.accounts.updateOne({ _id: toId }, { $inc: { balance: cents } }, { session })
      })
    } finally {
      await session.endSession()
    }
  }
}
```

Three things are load-bearing.

**Start the session from the injected `Connection`**, not from the `mongoose` singleton. `@InjectConnection()` gives you the connection this module owns; with a named second connection, `@InjectConnection('analytics')` gives you that one. The singleton might be neither.

**Pass `{ session }` to every operation inside.** An operation without it runs outside the transaction and is not rolled back — the Mongoose equivalent of using `this.prisma` instead of `tx`, and just as invisible. That is also why a transaction spanning several Nest services needs the session threaded through as a parameter; see [Transactions](../nestjs-databases/transactions.md).

**`withTransaction` commits on resolve, aborts on throw, and retries transient transaction errors.** Prefer it over manual `startTransaction`/`commitTransaction`, and always `endSession()` in a `finally` — a leaked session holds a connection.

Run a **single-node replica set** in development and in CI so this code path is exercised rather than discovered in staging. [Testing with a database](../nestjs-databases/testing-with-a-database.md).

### Hooks and plugins in a Nest codebase

Mongoose middleware is attached to the schema, which lives outside the DI container. That is fine for pure data concerns and a trap for anything that needs a provider.

```ts title="src/users/user.schema.ts"
import argon2 from 'argon2'

// Mongoose 9: a `pre` hook is async and takes no `next` argument.
UserSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return
  this.passwordHash = await argon2.hash(this.passwordHash)
})
```

A hook that needs an injected service — an audit logger, an event emitter, a config value — cannot reach one from module scope. Use `forFeatureAsync` with a `useFactory`, which runs inside the container:

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { User, UserSchema } from './user.schema.js'

@Module({
  imports: [
    MongooseModule.forFeatureAsync([
      {
        name: User.name,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => {
          const schema = UserSchema
          schema.set('autoIndex', config.get<string>('NODE_ENV') !== 'production')
          return schema
        },
      },
    ]),
  ],
})
export class UsersModule {}
```

:::warning Hooks do not fire for every operation
`pre('save')` runs on `save()` and on `create()`. It does **not** run on `updateOne`, `findOneAndUpdate`, `updateMany` or `bulkWrite` — those are document-update middleware, a different hook name and a different `this`. A password-hashing hook on `save` plus a `findOneAndUpdate` password reset elsewhere in the codebase is how a plaintext password ends up in the database.
:::

### Migrations and indexes

Mongoose has no migration system, and MongoDB has no DDL to apply — but there is still data to reshape when a schema changes, and `strict: 'throw'` means old documents can start failing validation.

Two things you have to own. A **migration runner** for data changes (`migrate-mongo` is the common choice), run as a release step. And **deliberate index management**: turn `autoIndex` off in production and create indexes in a reviewed migration, so an index build happens when you chose it rather than when a pod restarted. [Migrations](../nestjs-databases/migrations.md).

Because MongoDB accepts anything, an "additive" schema change is invisible until a read path assumes the new field exists. Every addition needs a default, a backfill, or read-side handling — pick one explicitly.

## Security considerations

Mongoose's injection risk is not SQL. A Mongo filter is an **object**, a JSON request body is also an object, and an attacker who controls part of a filter can substitute a query **operator** where you expected a value. It is the only tool in this section whose injection vector needs no raw API at all.

### Operator injection

```ts vulnerable title="DO NOT COPY — src/auth/auth.service.ts"
// POST /auth/login  {"email":"admin@example.com","password":{"$ne":null}}
async login(body: { email: unknown; password: unknown }) {
  const user = await this.users
    .findOne({ email: body.email, passwordHash: body.password })
    .select('+passwordHash')
    .exec()
  if (!user) throw new UnauthorizedException()
  return this.tokens.issue(user)
}
```

`body.password` is `{ $ne: null }`, so the filter becomes "email matches **and** the hash is not null" — true for every user who has a password. The attacker is now the admin. The same trick works anywhere request input spreads into a filter: `{ $gt: '' }` matches every string, `{ $regex: '^a' }` enumerates values a character at a time, `{ $exists: true }` maps your schema.

### Fix one: the global ValidationPipe

The primary control, and the one that generalises. A DTO with `class-validator` decorators plus `whitelist: true` means a non-string `password` never reaches the service:

```ts good title="src/main.ts"
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import mongoose from 'mongoose'
import { AppModule } from './app.module.js'

// Belt: any nested object whose keys start with `$` is wrapped in an $eq and
// compared as a literal value instead of interpreted as an operator.
mongoose.set('sanitizeFilter', true)

const app = await NestFactory.create(AppModule)

// Braces: a payload that is not the declared shape is rejected with a 400
// before any service, and therefore any filter, sees it.
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)

app.enableShutdownHooks()
await app.listen(3000)
```

```ts good title="src/auth/dto/login.dto.ts"
import { IsEmail, IsString, MinLength } from 'class-validator'

export class LoginDto {
  @IsEmail()
  email: string

  @IsString()
  @MinLength(8)
  password: string
}
```

`@IsString()` is the whole fix for this class of bug. `{ $ne: null }` is not a string, so the request is a 400 and the service never runs.

### Fix two: cast explicitly at the query site

Validation is the control; typing the parameter is the proof. A service method whose parameter is `email: string` cannot receive an operator object from correctly typed callers, and the query builds from a scalar:

```ts good title="src/auth/auth.service.ts"
import { Injectable, UnauthorizedException } from '@nestjs/common'
import argon2 from 'argon2'
import { LoginDto } from './dto/login.dto.js'

@Injectable()
export class AuthService {
  async login(dto: LoginDto) {
    // Look the user up by identifier only. The password is NEVER part of the
    // filter — it is verified against the hash in application code, so even a
    // filter bug cannot authenticate anybody.
    const user = await this.users.findByEmail(dto.email)
    if (!user || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Invalid credentials')
    }
    return this.tokens.issue(user)
  }
}
```

Two independent controls: the payload is validated, and the secret is not in the query at all.

### sanitizeFilter, and when to reach for mongoose.trusted()

`sanitizeFilter` is **off by default** for backward compatibility. Turned on, `{ pwd: { $ne: null } }` becomes `{ pwd: { $eq: { $ne: null } } }` — a search for a document whose `pwd` field is literally that object, which matches nothing. That is the correct outcome.

It is a safety net, not a substitute for validation, and it has an edge: a filter *you* built with a legitimate operator also gets wrapped. Mark those:

```ts good title="src/posts/posts.service.ts"
import mongoose from 'mongoose'

recentSince(since: Date) {
  return this.posts.find({ createdAt: mongoose.trusted({ $gte: since }) }).lean().exec()
}
```

`mongoose.trusted()` says "this operator object is mine, not the user's". Only ever wrap objects you constructed in the same file.

Per-query opt-in, when a global change is too big a blast radius:

```ts good
const user = await this.users.findOne({ email }).setOptions({ sanitizeFilter: true }).exec()
```

### $where and $function are code execution

```ts vulnerable title="DO NOT COPY"
const users = await this.users.find({ $where: `this.name === '${name}'` }).exec()
```

`$where` runs **JavaScript on the database server**. A crafted `name` does not merely alter the filter; it executes attacker code in the server's context and can hang the server with a loop. There is no safe way to use it with user input — every query it can express has a normal-operator or aggregation equivalent. Same for `$function` and `$accumulator` in pipelines.

### The raw escape hatch bypasses everything

Three ways down to the driver, in increasing order of "you are on your own":

```ts
// 1. Aggregation — still Mongoose, still casts pipeline values
const stats = await this.posts.aggregate([
  { $match: { author: userId, published: true } },
  { $group: { _id: '$author', total: { $sum: 1 } } },
])

// 2. The raw driver collection — no schema, no casting, no middleware,
//    and no sanitizeFilter
const doc = await this.users.collection.findOne({ _id: id })

// 3. A raw database command
const ping = await this.connection.db.command({ ping: 1 })
```

`Model.collection` bypasses everything Mongoose does for you, including `sanitizeFilter`. Any filter built there must be constructed from validated scalars by hand.

Aggregation is the more common trap, because a `$match` stage is a filter like any other:

```ts vulnerable title="DO NOT COPY"
// The caller writes your pipeline stage.
return this.posts.aggregate([{ $match: query }])
```

Build `$match` from named, validated fields.

### Mass assignment

```ts vulnerable title="DO NOT COPY"
await this.users.create(body)                                  // role: 'admin'
await this.users.findByIdAndUpdate(id, { $set: body }).exec()  // same
```

`strict: 'throw'` blocks fields that are **not** in the schema. `role` *is* in the schema — which is exactly why it is exploitable. Validate, then construct the write from named fields. See [Mass assignment](../security/mass-assignment.md).

### Do not leak fields

`select: false` on `passwordHash` is the strongest schema-level default in this section, and it is not enough on its own. Pair it with an explicit `.select()` on every read path, so adding a sensitive field to the schema next year does not silently start returning it. Map to a DTO before the controller — [Serialization](../nestjs-validation/serialization.md).

Full threat model with working payloads and verification: [NoSQL injection](../nestjs-security/nosql-injection.md).

## Production considerations

**`autoIndex: false` in production.** Index builds on model compile are unscheduled DDL against a live collection. Create indexes in migrations.

**`bufferCommands: false`.** Otherwise a database outage becomes hanging requests rather than errors, and the readiness probe keeps passing while nothing works.

**Set `maxPoolSize` explicitly.** The driver default is **100 per instance**, multiplied by your replica count — far and away the highest default in this section. [Connection pooling](../nestjs-databases/connection-pooling.md).

**Set `serverSelectionTimeoutMS` to a few seconds.** It decides how a failover looks to your users.

**`app.enableShutdownHooks()`**, or `MongooseModule` never closes the connection on `SIGTERM`. [Graceful shutdown](../nestjs-production/graceful-shutdown.md).

**Transactions need a replica set**, in development and CI as well as production, or the code path is never exercised before staging.

**Turn `sanitizeFilter` on and then verify it.** Write an end-to-end test that posts `{"password":{"$ne":null}}` to the login route and asserts a 401. A control nobody tested is a control nobody has.

**Map `CastError` and `ValidationError` to 400 in one exception filter**, and do not forward their messages — Mongoose validation errors name your internal fields and constraints.

**Watch populate counts per endpoint.** They are the cheapest thing to get wrong and the easiest to measure.

**Use `MongooseHealthIndicator`** from `@nestjs/terminus` for readiness, never for liveness — a database outage should not restart your pods. [Health checks](../nestjs-databases/health-checks.md).

## Common mistakes

- **Leaving `sanitizeFilter` off.** It is off by default, and it is a one-line mitigation for operator injection.
- **No global `ValidationPipe`.** That is the actual fix; `sanitizeFilter` is the net under it.
- **Putting the password in the filter.** Look the user up by identifier, verify the hash in code.
- **Using `$where`.** Server-side JavaScript execution.
- **Calling `next()` in a `pre` hook.** Mongoose 9 hooks are async and take no `next`.
- **Assuming `pre('save')` runs on `findOneAndUpdate`.** It does not — different middleware, different hook.
- **Forgetting `runValidators: true`** on `findOneAndUpdate` / `updateOne`. Validators do not run on updates by default.
- **Forgetting `{ session }` on one operation inside a transaction.** That write is not in the transaction and will not roll back.
- **Starting the session from the `mongoose` singleton** instead of the injected `Connection`.
- **Populating in a loop.** `populate()` on the query batches; a loop is N+1.
- **Hydrating documents you only serialize.** Use `.lean()`.
- **`autoIndex` on in production.** Unscheduled index builds on live collections.
- **Expecting `forFeature` models to be injectable everywhere.** The provider is scoped to the importing module.
- **Exporting the model instead of the service.** Mongoose types then spread across three modules.
- **`create(body)`.** Mass assignment; `strict` does not protect fields that are in the schema.
- **Using `Model.collection` and assuming Mongoose still protects you.** It does not.
- **Expecting transactions on a standalone `mongod`.** Replica set required.

## Related topics

- [Mongoose](../orms/mongoose.md) — the library itself: schema options, `populate` semantics, the Mongoose 9 changes.
- [MongoDB](../nestjs-databases/mongodb.md) — connection options in full, `ParseObjectIdPipe`, and the operator-injection exploit with verification.
- [Choosing an ORM](./choosing-an-orm.md) — Mongoose against the SQL options inside Nest.
- [Comparison table](./comparison.md) — where Mongoose sits on escape-hatch safety.
- [Avoiding N+1](./avoiding-n-plus-one.md) — populate counts, batching and detection.
- [Transactions](../nestjs-databases/transactions.md) — threading a session across services.
- [NoSQL injection](../nestjs-security/nosql-injection.md) — the full threat model with payloads.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — `whitelist`, `forbidNonWhitelisted` and why they are a security control.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — `forRootAsync` and the provider lifecycle.
- [Migrations](../nestjs-databases/migrations.md) — reshaping data in a schemaless store, and index builds.
- [Health checks](../nestjs-databases/health-checks.md) — `MongooseHealthIndicator` in a readiness probe.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — `getModelToken` in a testing module.
