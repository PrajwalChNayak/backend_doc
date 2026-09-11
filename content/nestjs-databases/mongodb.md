---
title: MongoDB
description: MongooseModule.forRootAsync and forFeature in Nest 12, decorator schemas, ParseObjectIdPipe, and the operator-injection hole that a global ValidationPipe closes.
status: current
updated: 2026-09-11
---

`@nestjs/mongoose` turns a Mongoose connection into a provider and each model into an injectable token. That part is mechanical. The part that matters is that MongoDB takes a **query object**, and an object parsed from JSON can contain operators — so a request body that reaches a filter unchecked is an authentication bypass, not a validation nicety. This page covers the wiring and that hole. The driver-level material — projections, indexes, aggregation, the replica-set requirement for transactions — is in [MongoDB](../databases/mongodb.md).

## Installing

```bash
npm install @nestjs/mongoose@12.0.0 mongoose@9.10.0
```

`@nestjs/mongoose` 12 targets Nest 12 and Mongoose 9. It manages the connection lifecycle, so you do not call `mongoose.connect()` yourself and you do not close it on shutdown — the module's own provider does, given `app.enableShutdownHooks()`.

## The connection

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
        maxPoolSize: config.get<number>('database.poolMax') ?? 10,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5_000,
        socketTimeoutMS: 20_000,
        retryAttempts: 5,
        retryDelay: 2_000,
        onConnectionCreate: (connection) => {
          connection.on('disconnected', () => console.warn('mongo disconnected'))
          connection.on('reconnected', () => console.warn('mongo reconnected'))
        },
      }),
    }),
  ],
})
export class MongoModule {}
```

`MongooseModuleOptions` extends Mongoose's own `ConnectOptions`, plus a handful of Nest-specific keys:

| Key | What it does |
| --- | --- |
| `uri` | The connection string. `MongooseModule.forRoot(uri, options)` takes it as the first argument instead. |
| `retryAttempts` / `retryDelay` | How many times Nest retries the **initial** connection before failing the bootstrap. Nothing to do with reconnects later. |
| `connectionName` | Names a second connection so its tokens do not collide with the default. |
| `onConnectionCreate` | Runs once with the `Connection`, which is where event listeners belong. |
| `lazyConnection` | Skips connecting during bootstrap. Useful in tests; means the first query pays the connect cost. |
| `connectionFactory` | Wraps the connection — the hook global plugins are registered from. |
| `verboseRetryLog` | Logs the reason for each retry rather than just the attempt number. |

`serverSelectionTimeoutMS` is the one to set deliberately. It defaults high, and a wrong hostname then presents as a 30-second hang on the first request rather than a fast failure at boot.

## Schemas and models

```ts title="src/users/user.schema.ts"
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type UserDocument = HydratedDocument<User>

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true, index: true, lowercase: true, trim: true })
  email: string

  @Prop({ required: true })
  displayName: string

  // select: false keeps it out of every query result unless explicitly asked
  // for. One line that removes a whole class of accidental disclosure.
  @Prop({ required: true, select: false })
  passwordHash: string

  @Prop({ type: [String], default: [] })
  roles: string[]
}

export const UserSchema = SchemaFactory.createForClass(User)
UserSchema.index({ createdAt: -1 })
```

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

`forFeature` registers a provider whose token is `getModelToken(User.name)`; `@InjectModel(User.name)` is shorthand for `@Inject(getModelToken(User.name))`. Like TypeORM's `forFeature`, it is **scoped to the module that imported it** — another module that wants the `User` model must import `forFeature` itself, or (better) go through `UsersService`.

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { User, UserDocument } from './user.schema.js'

@Injectable()
export class UsersService {
  private readonly users: Model<UserDocument>

  constructor(@InjectModel(User.name) users: Model<UserDocument>) {
    this.users = users
  }

  async findById(id: Types.ObjectId) {
    // .lean() returns a plain object instead of a hydrated document: no
    // getters, no change tracking, several times faster on read paths.
    const user = await this.users.findById(id).select('email displayName roles').lean().exec()
    if (!user) throw new NotFoundException()
    return user
  }

  findByEmail(email: string) {
    // The filter value is a string because the parameter is typed and the
    // caller validated it. See the injection section below.
    return this.users.findOne({ email }).select('+passwordHash').lean().exec()
  }
}
```

`@nestjs/mongoose` 12 also ships `ParseObjectIdPipe` and `IsObjectIdPipe`, so a route parameter becomes a real `ObjectId` before the service sees it:

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

Without it, `findById('not-an-id')` throws a `CastError` that surfaces as a 500. With it, a malformed id is a 400 before any database call happens.

## Operator injection — the auth bypass

:::danger This is the MongoDB vulnerability that matters
A Mongo filter is a **document**, and `express.json()` will happily parse `{"$ne": null}` into a nested object. If that object reaches a query, the attacker is no longer supplying a value — they are supplying an operator.

```ts vulnerable title="DO NOT COPY — src/auth/auth.service.ts"
async login(body: { email: unknown; password: unknown }) {
  // body came straight off the request with no validation
  const user = await this.users.findOne({ email: body.email }).select('+passwordHash')
  if (!user) throw new UnauthorizedException()
  return this.tokens.issue(user)
}
```

```bash
curl -X POST https://api.example.com/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":{"$ne":null},"password":{"$ne":null}}'
```

The filter Mongo receives is `{ email: { $ne: null } }` — "any user whose email is not null", which is every user. `findOne` returns the first one, typically the oldest account, typically an administrator. The password is never checked because the code only checks whether a user was found. That is a full authentication bypass with one `curl` and no credentials.
:::

`$gt: ""` does the same thing. `$regex` turns the field into a search and lets an attacker extract a value character by character — send `{"$regex":"^a"}`, then `^aa`, and read the response timing or the 200/401 difference. `$where` executes JavaScript on the server if the deployment allows it.

There are two independent fixes and you want both.

### 1. A global ValidationPipe with whitelisting

```ts title="src/main.ts"
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

const app = await NestFactory.create(AppModule)

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,             // drop properties with no decorator
    forbidNonWhitelisted: true,  // 400 instead of silently dropping
    transform: true,             // produce real DTO instances
    forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false },
  }),
)

app.enableShutdownHooks()
await app.listen(3000)
```

```ts title="src/auth/dto/login.dto.ts"
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'

export class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email: string

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password: string
}
```

`@IsEmail()` and `@IsString()` are the load-bearing part: an object fails both, so `{"$ne":null}` is rejected with a 400 before the service is called. `whitelist: true` removes anything the DTO does not declare, and `forbidNonWhitelisted: true` makes the attempt visible rather than silent.

:::warning `transform: true` alone is not enough
Without `whitelist`, class-transformer copies unknown properties straight onto the DTO instance, so an extra `{"role":"admin"}` survives and a later `Object.assign(doc, dto)` grants it. Whitelisting is what makes the DTO a boundary instead of a suggestion. See [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md).
:::

### 2. Type the filter value at the query site

Validation protects the endpoints that have DTOs. A background job, a webhook handler, or a query built from a URL parameter can still take an unvalidated value. Force the type where the query is built:

```ts good title="src/users/users.service.ts"
findByEmail(email: string) {
  // Even if a caller passes an object through a loose `any`, String() makes
  // it a scalar and the filter can no longer contain an operator.
  return this.users.findOne({ email: String(email) }).select('+passwordHash').lean().exec()
}
```

And verify the password rather than inferring authentication from "a document came back":

```ts good title="src/auth/auth.service.ts"
async login(dto: LoginDto) {
  const user = await this.users.findByEmail(dto.email)
  // Always compare, even when no user was found, against a dummy hash — so
  // the response time does not reveal whether the account exists.
  const ok = await verify(user?.passwordHash ?? DUMMY_HASH, dto.password)
  if (!user || !ok) throw new UnauthorizedException('Invalid credentials')
  return this.tokens.issue(user)
}
```

[NoSQL injection](../nestjs-security/nosql-injection.md) has the full threat model, the extraction-by-`$regex` walkthrough and the regression test that keeps it closed.

### Verify the fix

```bash
# Expect 400, not 200 and not 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":{"$ne":null},"password":{"$ne":null}}'
```

Make that a test. The fix lives in `main.ts`, a long way from the auth service, and it is exactly the kind of thing a refactor removes.

## Transactions

Mongo transactions require a **replica set** — they do not exist on a standalone `mongod`, which is what most local Docker setups run. A single-node replica set is enough for development.

```ts title="src/orders/orders.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectConnection, InjectModel } from '@nestjs/mongoose'
import { Connection, Model } from 'mongoose'
import { Order, OrderDocument } from './order.schema.js'

@Injectable()
export class OrdersService {
  private readonly connection: Connection
  private readonly orders: Model<OrderDocument>

  constructor(
    @InjectConnection() connection: Connection,
    @InjectModel(Order.name) orders: Model<OrderDocument>,
  ) {
    this.connection = connection
    this.orders = orders
  }

  async createWithStock(userId: string, items: readonly { sku: string; qty: number }[]) {
    const session = await this.connection.startSession()
    try {
      // withTransaction retries transient transaction errors for you.
      return await session.withTransaction(async () => {
        const [order] = await this.orders.create([{ userId, items, status: 'pending' }], { session })
        // Every operation in the unit of work must carry the SAME session.
        await this.reserveStock(items, session)
        return order
      })
    } finally {
      await session.endSession()
    }
  }
}
```

The rule is identical to the SQL one: **the session is a parameter, not ambient state.** An operation inside the callback that omits `{ session }` runs outside the transaction and is not rolled back. [Transactions](transactions.md) covers propagating that session down a service chain without rewriting every signature.

## Security considerations

**A global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted` is the control, not a nicety.** It is what stops an object reaching a filter position. Register it in `main.ts` and add a test that proves the operator payload returns 400.

**Never build a filter from a request object by spreading it.** `this.users.find({ ...query })` with `query` from `@Query()` gives the caller the whole query language, including `$where` and `$regex` on any field. Map explicitly, field by field, from a validated DTO.

**Do not infer authentication from a document being returned.** The bypass above works because the code checks `if (!user)` and never compares the password. Always compare, and compare against a dummy hash when no user was found so the timing does not leak account existence.

**`select: false` on `passwordHash`, tokens and secrets.** It makes disclosure opt-in. Pair it with explicit `.select()` on read paths so a future schema field is not returned by default either.

**Enforce ownership in the filter, not after the read.** `findOne({ _id: id, ownerId: user.id })` cannot return another tenant's document. `findById(id)` followed by an `if` is a check that a later refactor removes — [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

**Cast route parameters with `ParseObjectIdPipe`.** An unparsed id produces a `CastError` 500, and a `CastError` message echoes the input.

**Bound `$regex` or forbid it.** A user-supplied regex is a ReDoS vector and, in a filter, a value-extraction oracle. If you need prefix search, anchor and escape the pattern yourself, or use a text index.

**Disable server-side JavaScript.** `$where` and `mapReduce` execute JavaScript in `mongod`. Run with `security.javascriptEnabled: false` unless something genuinely needs it.

**The database user gets one database and no admin role.** `readWrite` on the application's database. Not `root`, not `dbAdminAnyDatabase` — an injection then cannot enumerate other databases or create users.

**TLS on, certificate verified.** `tls=true` in the URI for any managed cluster, and do not set `tlsAllowInvalidCertificates`.

## Production considerations

- **`app.enableShutdownHooks()`.** The Mongoose module closes the connection in its own shutdown hook, which does not run without it.
- **Set `serverSelectionTimeoutMS` to a few seconds.** The default turns a misconfigured host into a long hang instead of a fast, obvious failure.
- **Size `maxPoolSize` against the cluster's connection limit.** It is per process: `maxPoolSize` × replicas. [Connection pooling](connection-pooling.md).
- **Create indexes through migrations, not `autoIndex`.** `autoIndex` is convenient in development and a foreground index build on a large collection in production. Set `autoIndex: false` there and create indexes as a deploy step — [Migrations](migrations.md).
- **`.lean()` on read paths.** Hydrating documents you are about to serialize costs measurable CPU for nothing.
- **Project explicitly.** Returning whole documents ships every field a future migration adds, over the wire and into your JSON.
- **Transactions need a replica set**, in every environment including CI. A single-node replica set is a one-flag Docker change and worth doing so the code path is exercised.
- **Watch for unindexed queries.** Enable the profiler or the slow-query log; a collection scan that is fine at ten thousand documents is an outage at ten million. [Indexing basics](../databases/indexing-basics.md).
- **Handle the `disconnected` event.** Mongoose buffers commands while disconnected by default, so an outage presents as slowly-resolving requests. `bufferCommands: false` makes it a fast failure instead.
- **Do not log the URI.** It contains the password, and Mongoose errors quote connection options.

## Common mistakes

- **No global `ValidationPipe`.** The operator-injection bypass at the top of this page.
- **`transform: true` without `whitelist: true`.** Unknown properties survive onto the DTO; mass assignment follows.
- **Spreading `@Query()` into a filter.** You have exposed the whole query language.
- **Checking `if (!user)` and never comparing the password.** Authentication by existence.
- **Expecting `forFeature` models to be injectable everywhere.** They are scoped to the importing module.
- **`findById(req.params.id)` without a cast pipe.** A `CastError` 500 that echoes the input.
- **Omitting `{ session }` on one operation inside a transaction.** That write is not part of the unit of work and does not roll back.
- **Assuming transactions work on a standalone `mongod`.** They do not; you need a replica set.
- **`autoIndex: true` in production.** A foreground index build on a large collection blocks writes.
- **Returning hydrated documents from controllers.** Every field is serialized, including ones added later.
- **`select: false` on a secret but then `.select('+passwordHash')` on a general read path.** It defeats the point; only the auth path should ask for it.
- **Leaving `bufferCommands` at its default.** During an outage, requests hang instead of failing.

## Related topics

- [MongoDB](../databases/mongodb.md) — the driver: pool options, projections, indexes, aggregation and the replica-set requirement.
- [NoSQL injection](../nestjs-security/nosql-injection.md) — the full threat model, `$regex` extraction, and the tests that keep it closed.
- [Connections and DI](connections-and-di.md) — `forRootAsync`, module scoping and the shutdown hook.
- [The ValidationPipe](../nestjs-validation/validation-pipe.md) — the global pipe options and what each one actually prevents.
- [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md) — why `whitelist` is the security-relevant flag.
- [Transactions](transactions.md) — passing the session down the service chain.
- [Mongoose](../nestjs-orms/mongoose.md) — schemas, virtuals, populate and avoiding N+1 with Mongoose in Nest.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — ownership in the filter rather than after the read.
- [Health checks](health-checks.md) — `MongooseHealthIndicator` and a readiness probe that pings the cluster.
- [Connection pooling](connection-pooling.md) — `maxPoolSize` per process against the cluster limit.
