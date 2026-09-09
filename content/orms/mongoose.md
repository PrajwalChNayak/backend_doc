---
title: Mongoose
description: Mongoose 9.9.5 — schemas over a schemaless database, populate, transactions, and stopping operator injection with sanitizeFilter.
status: current
updated: 2026-09-08
---

Mongoose puts a schema, casting layer, validation system and middleware pipeline on top of the MongoDB Node driver. MongoDB does not enforce document shape, so Mongoose's real job is to enforce it in your application — which also means its security model is about **operator injection**, not SQL injection.

This page documents **Mongoose 9.9.5**, which requires Node `>=20.19.0` and bundles the MongoDB driver (`mongodb` ~7.5).

:::warning
Mongoose 9 removed callback support across the API and changed middleware signatures. **Pre middleware no longer receives a `next` argument** — hooks must be `async` functions or return promises. Most Mongoose material online predates this. If a snippet calls `next()` in a `pre` hook or passes a callback to `save()`, it is Mongoose 7 or earlier.
:::

## Why it exists

MongoDB will accept any document you send it. Two years into a project that means the `users` collection contains four different shapes, half of them with `email` as a string and half as an array, and every read path needs defensive checks.

Mongoose fixes that at the application boundary: a schema, casting on write, validators, and a typed model. It also gives you `populate()` for cross-collection references, middleware for cross-cutting concerns like soft deletes and audit fields, and a discriminator system for polymorphic collections.

## When to use it

- **Any non-trivial MongoDB application.** The alternative is enforcing shape by convention, and convention loses.
- **You want validation and defaults close to the data.** Required fields, enums, min/max, custom validators — all declared once.
- **Cross-document references.** `populate()` is the practical answer to MongoDB having no joins in the query language you usually want to write.
- **Lifecycle hooks.** Hashing a password before save, stamping `updatedAt`, cascading a soft delete.

## When not to use it

- **Analytics and aggregation-heavy workloads.** You will live in `aggregate()`, where Mongoose adds a schema you are mostly bypassing. Use the driver.
- **Bulk ingest.** Casting and validating a million documents costs real time. `bulkWrite` with `lean` inputs, or the driver directly.
- **You wanted a relational database.** Mongoose does not make MongoDB relational. If your data is a graph of joins with transactional integrity across five collections, the problem is the database choice — see [Choosing a database](../databases/choosing-a-database.md).
- **Prisma users hoping to reuse it.** Prisma 7 dropped MongoDB support entirely.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install mongoose@9.9.5
```
@tab pnpm
```bash
pnpm add mongoose@9.9.5
```
@tab yarn
```bash
yarn add mongoose@9.9.5
```
:::

The MongoDB driver comes bundled — do not install `mongodb` separately unless you need the driver directly, and if you do, match the version Mongoose bundles.

### Connect

```js title="src/db.js"
import mongoose from 'mongoose'

mongoose.set('sanitizeFilter', true)
mongoose.set('strictQuery', true)

export async function connect() {
  await mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 45_000,
  })
}
```

Turn `sanitizeFilter` on globally at startup. The reasoning is under Security considerations below, and the short version is that it closes the default-open operator-injection hole in one line.

### Schema and model

```js title="src/models/user.js"
import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[^@\s]+@[^@\s]+$/,
    },
    name: { type: String, default: null },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
  },
  { timestamps: true, strict: 'throw' },
)

userSchema.index({ createdAt: -1 })

export const User = mongoose.model('User', userSchema)
```

Two options doing real work. `select: false` keeps `passwordHash` out of query results unless explicitly requested — a default that has prevented a lot of accidental disclosure. `strict: 'throw'` rejects writes containing fields not in the schema instead of silently dropping them, which turns a typo into an error rather than a missing value.

```js title="src/models/post.js"
import mongoose from 'mongoose'

const postSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    published: { type: Boolean, default: false },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true, strict: 'throw' },
)

postSchema.index({ author: 1, published: 1 })

export const Post = mongoose.model('Post', postSchema)
```

### CRUD

```js title="src/routes/users.js"
import express from 'express'
import { User } from '../models/user.js'

const router = express.Router()

router.post('/users', async (req, res) => {
  const user = await User.create({ email: req.body.email, name: req.body.name })
  res.status(201).json({ id: user.id, email: user.email, name: user.name })
})

router.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id).select('email name createdAt').lean()
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.patch('/users/:id', async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { name: req.body.name } },
    { new: true, runValidators: true, projection: 'email name' },
  ).lean()
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.delete('/users/:id', async (req, res) => {
  await User.findByIdAndDelete(req.params.id)
  res.status(204).end()
})

export default router
```

Two details worth copying. `runValidators: true` is **not** the default on update operations — without it, `findByIdAndUpdate` skips your schema validators entirely. And `returnDocument: 'after'` is the modern spelling of `new: true`; both work in Mongoose 9 but `new` and `returnOriginal` are deprecated.

An invalid ObjectId in `req.params.id` produces a `CastError`, which Express 5 forwards to your error middleware. Map `CastError` and `ValidationError` to 400 there rather than checking in every handler.

Full runnable version: [`examples/orm-mongoose`](../../examples/orm-mongoose/README.md).

## How it works

### References and populate

MongoDB has no foreign keys. `ref` is a Mongoose convention, and `populate()` implements the join in the application:

```js
const posts = await Post.find({ published: true })
  .populate({ path: 'author', select: 'email name' })
  .select('title author createdAt')
  .limit(20)
  .lean()
```

`populate` issues **a second query** with an `$in` on the collected ids. That is two round trips, not N+1 — as long as you populate on the query rather than in a loop:

```js vulnerable title="DO NOT COPY — N+1"
const posts = await Post.find().lean()
for (const p of posts) {
  p.author = await User.findById(p.author).lean()   // one query per post
}
```

`$lookup` in an aggregation does the join server-side in one round trip. It is faster and much less pleasant to write. Reach for it when the extra round trip actually costs you, not by default.

:::tip
Use `.lean()` on every read whose result you are only going to serialize. It skips hydrating full Mongoose documents and returns plain objects — commonly several times faster, and it removes the risk of accidentally serializing internal document state. Do not use it when you need `save()`, virtuals or instance methods.
:::

### Transactions

MongoDB transactions require a replica set or a sharded cluster. A standalone `mongod` does not support them, which is why they fail in local development and work in Atlas.

```js title="src/services/transfer.js"
import mongoose from 'mongoose'
import { Account } from '../models/account.js'

export async function transfer(fromId, toId, cents) {
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const from = await Account.findOneAndUpdate(
        { _id: fromId, balance: { $gte: cents } },
        { $inc: { balance: -cents } },
        { session, returnDocument: 'after' },
      )
      if (!from) throw new Error('insufficient funds')

      await Account.updateOne({ _id: toId }, { $inc: { balance: cents } }, { session })
    })
  } finally {
    await session.endSession()
  }
}
```

`withTransaction` commits on resolve, aborts on throw, and retries on transient transaction errors — which is why you should prefer it over manual `startTransaction`/`commitTransaction`.

Pass `{ session }` to **every** operation inside. An operation without it runs outside the transaction and will not be rolled back.

The `{ _id, balance: { $gte: cents } }` filter combined with `$inc` is the important part: the check and the decrement are one atomic document update, so two concurrent transfers cannot both pass the balance check.

### Migrations

Mongoose has no migration system. MongoDB is schemaless, so there is no DDL to apply — but there is still data to reshape when your schema changes, and `strict: 'throw'` means old documents can start failing validation.

The two things you need:

**A migration runner for data changes.** [`migrate-mongo`](https://github.com/seppevs/migrate-mongo) (14.0.7) is the common choice; it keeps an applied-migrations collection and runs `up`/`down` scripts against the native driver.

```js title="migrations/20260908120000-add-role-to-users.cjs"
module.exports = {
  async up(db) {
    await db.collection('users').updateMany(
      { role: { $exists: false } },
      { $set: { role: 'user' } },
    )
  },
  async down(db) {
    await db.collection('users').updateMany({}, { $unset: { role: '' } })
  },
}
```

**Deliberate index management.** Mongoose's `autoIndex` builds declared indexes on model compile. That is convenient in development and wrong in production: index builds on a large collection block, and you have no control over when they happen.

```js title="src/db.js"
mongoose.set('autoIndex', process.env.NODE_ENV !== 'production')
```

Create production indexes in a migration, with the driver, so they are reviewed and scheduled like any other schema change.

:::warning
Because MongoDB accepts anything, an "additive" schema change is invisible until a read path assumes the new field exists. Every schema addition needs either a default, a backfill migration, or read-side handling for documents written before it. Pick one explicitly.
:::

### TypeScript story

Mongoose 9 infers the document type from the schema, which works well for straightforward schemas:

```ts title="src/models/user.ts"
import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose'

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, default: null },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
  },
  { timestamps: true },
)

type UserDoc = InferSchemaType<typeof userSchema>
export const User = mongoose.model('User', userSchema)

export type User = HydratedDocument<UserDoc>
```

Mongoose 9 changed several types. `FilterQuery` is now **`QueryFilter`**, and it enforces stricter property typing. `create()` and `insertOne()` no longer accept generic parameters. A document's `id` is now typed as a string virtual rather than `any`.

The inference has limits: discriminators, deeply nested subdocuments and `populate()` results often need explicit generics. `populate<{ author: UserDoc }>(...)` is normal.

### Connection pooling

Pool settings are MongoDB driver options passed to `connect()`:

| Option | Meaning |
| --- | --- |
| `maxPoolSize` | Maximum connections per `mongod` (driver default 100) |
| `minPoolSize` | Connections kept warm |
| `serverSelectionTimeoutMS` | How long to look for a usable server before failing |
| `socketTimeoutMS` | Socket inactivity timeout |
| `maxIdleTimeMS` | How long an idle connection is kept |

The driver's default `maxPoolSize` of 100 is high for a service with several replicas. Set it explicitly.

`serverSelectionTimeoutMS` is the one that decides how a primary failover looks to your users: at the default it is a long hang, at 5000ms it is a burst of fast errors your health check and load balancer can act on.

Mongoose buffers operations while disconnected. That turns a database outage into requests that hang rather than fail. Set `bufferCommands: false` (or a short `bufferTimeoutMS`) in production so calls fail fast — see [Retries and timeouts](../databases/retries-and-timeouts.md).

## Common patterns

### Lean reads by default in the API layer

Hydrated documents are for code that mutates and saves. Read endpoints should be `.lean()`.

### Password hashing in a pre-save hook

```js title="src/models/user.js"
import argon2 from 'argon2'

// Mongoose 9: pre middleware is async, with no `next` argument
userSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return
  this.passwordHash = await argon2.hash(this.passwordHash)
})
```

Note the signature. In Mongoose 9 a `pre` hook is an `async` function that takes no `next`; returning resolves the hook and throwing aborts the operation.

### Soft deletes with a query hook

```js
postSchema.add({ deletedAt: { type: Date, default: null } })

postSchema.pre(/^find/, function () {
  if (!this.getOptions().withDeleted) this.where({ deletedAt: null })
})
```

## Security considerations

Mongoose's injection risk is not SQL. MongoDB queries are **objects**, and a request body is also an object, so an attacker who controls part of a filter can substitute a query **operator** where you expected a value.

### Operator injection

```js vulnerable title="DO NOT COPY"
// POST /login  {"email":"admin@example.com","password":{"$ne":null}}
const user = await User.findOne({
  email: req.body.email,
  password: req.body.password,
}).select('+password')
if (user) return issueSession(user)
```

`req.body.password` is `{ $ne: null }`, so the filter becomes "email matches **and** password is not null" — which is true for every user with a password. The attacker logs in as the admin without knowing the password.

The same trick works on any endpoint that spreads user input into a filter: `{ $gt: '' }` matches every string, `{ $regex: '^a' }` enumerates values one character at a time, and `{ $exists: true }` reveals which fields exist.

### Fix one: sanitizeFilter

`sanitizeFilter` wraps any nested object whose keys start with `$` in an `$eq`, so it is compared as a literal value instead of interpreted as an operator:

```js
const obj = { username: 'val', pwd: { $ne: null } }
sanitizeFilter(obj)
obj // { username: 'val', pwd: { $eq: { $ne: null } } }
```

`pwd: { $eq: { $ne: null } }` looks for a document whose `pwd` field is literally the object `{ $ne: null }`. There is no such document, so the login fails — which is the correct outcome.

Turn it on globally:

```js good title="src/db.js"
import mongoose from 'mongoose'

mongoose.set('sanitizeFilter', true)
```

Or per query, when a global change is too big a blast radius:

```js good
const user = await User.findOne({ email, password }).setOptions({ sanitizeFilter: true })
```

It is **off by default** for backward compatibility, so this is opt-in on every project.

When you legitimately need an operator in a filter that passes through sanitization, mark it:

```js good
import mongoose from 'mongoose'

const q = await Post.find({ createdAt: mongoose.trusted({ $gte: since }) })
```

`mongoose.trusted()` says "this operator object is mine, not the user's". Only ever wrap objects you constructed.

### Fix two: cast explicitly

`sanitizeFilter` is a safety net, not a substitute for typing your inputs. The primary fix is that a value from a request should be forced to a scalar before it reaches a query:

```js good title="src/routes/auth.js"
import argon2 from 'argon2'
import { z } from 'zod'
import { User } from '../models/user.js'

const loginSchema = z.object({ email: z.email(), password: z.string().min(8) })

router.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body)

  const user = await User.findOne({ email }).select('+passwordHash')
  if (!user || !(await argon2.verify(user.passwordHash, password))) {
    return res.status(401).json({ error: 'invalid credentials' })
  }
  return issueSession(res, user)
})
```

Two independent things make this safe. Validation guarantees `email` and `password` are strings, so no operator can arrive. And the password is never part of the filter at all — it is verified against a hash in application code, so even a filter bug cannot authenticate anyone.

Schema casting helps too: with `email` declared as `String`, Mongoose rejects `{ $ne: null }` as an uncastable value on many query paths. Helps — does not replace the two fixes above.

### $where and $function are code execution, not injection

```js vulnerable title="DO NOT COPY"
const users = await User.find({ $where: `this.name === '${req.query.name}'` })
```

`$where` runs **JavaScript on the database server**. A crafted `name` does not just alter the filter; it executes attacker code in the server's context, and it can trivially hang the server with an infinite loop.

There is no safe way to use `$where` with user input. Do not use `$where` at all — every query it can express can be expressed with normal operators or an aggregation. The same applies to `$function` and `$accumulator` in aggregation pipelines.

### The raw escape hatch

Mongoose gives you three ways down to the driver, in increasing order of "you are on your own":

```js
// 1. Aggregation — still goes through Mongoose, still casts pipeline values
const stats = await Post.aggregate([
  { $match: { author: userId, published: true } },
  { $group: { _id: '$author', total: { $sum: 1 } } },
])

// 2. The raw driver collection — no schema, no casting, no middleware, no hooks
const doc = await User.collection.findOne({ _id: id })

// 3. A raw database command
const result = await mongoose.connection.db.command({ ping: 1 })
```

`Model.collection` bypasses everything Mongoose does for you, **including `sanitizeFilter` and schema casting**. Any filter you build there must be constructed from validated scalars by hand.

Aggregation pipelines are the more common trap, because `$match` stages are filters like any other and user input goes into them the same way:

```js vulnerable title="DO NOT COPY"
await Post.aggregate([{ $match: req.query }])   // attacker writes the pipeline stage
```

Build `$match` from named, validated fields.

### Mass assignment

```js vulnerable title="DO NOT COPY"
await User.create(req.body)                                   // role: 'admin'
await User.findByIdAndUpdate(id, { $set: req.body })          // same
```

`strict: 'throw'` blocks fields that are not in the schema, but `role` **is** in the schema — that is exactly why it is exploitable. Validate and construct the update from named fields. See [Mass assignment](../security/mass-assignment.md).

### Do not leak fields

`select: false` on `passwordHash` is a good default. Combine it with explicit `.select()` on read paths so adding a sensitive field to a schema later does not silently start returning it.

## Production considerations

**`mongoose.set('autoIndex', false)` in production.** Index builds on model compile are unscheduled DDL against a live collection. Create indexes in migrations.

**`bufferCommands: false`.** Otherwise a database outage becomes hanging requests instead of errors, and your health checks keep passing while nothing works.

**Set `maxPoolSize` explicitly.** The driver default of 100 per instance multiplies by your replica count.

**Set `serverSelectionTimeoutMS` to a few seconds.** It decides whether a failover looks like a brief error spike or a long stall.

**Transactions need a replica set.** A single-node local `mongod` cannot run them. Use a single-node replica set in development and in tests so the code path is exercised — see [Testing with a database](./testing-with-a-database.md).

**Turn `sanitizeFilter` on and keep it on.** Then verify it: write a test that posts `{"password":{"$ne":null}}` to your login route and asserts a 401.

**Handle `CastError` and `ValidationError` in one error middleware.** Both should be 400, and neither should reach the client with its full message — Mongoose validation errors name your internal fields.

**Watch `populate` counts.** Each `populate` path is another round trip. Three nested populates on a list endpoint is four queries per request.

**Close the connection on shutdown.** `await mongoose.disconnect()` on `SIGTERM`.

## Common mistakes

- **Leaving `sanitizeFilter` off.** It is off by default and it is the one-line fix for operator injection.
- **Passing `req.body` fields straight into a filter.** Validate to scalars first.
- **Putting the password in the query.** Look the user up by identifier, then verify the hash in code.
- **Using `$where`.** It is server-side JavaScript execution.
- **Forgetting `runValidators: true`** on `findOneAndUpdate` / `updateOne`. Validators do not run on updates by default.
- **Calling `next()` in a `pre` hook.** Mongoose 9 hooks are async and take no `next`.
- **Populating in a loop.** `populate()` on the query batches; a loop is N+1.
- **Hydrating documents you only serialize.** Use `.lean()`.
- **`autoIndex` on in production.** Unscheduled index builds on live collections.
- **Expecting transactions on a standalone `mongod`.** Replica set required.
- **Using `Model.collection` and assuming Mongoose still protects you.** It does not.
- **`create(req.body)`.** Mass assignment; `strict` does not help for fields that are in the schema.

## Related topics

- [NoSQL injection](../security/nosql-injection.md) — the operator-injection threat in full, with working payloads.
- [MongoDB](../databases/mongodb.md) — the driver underneath, and when to skip Mongoose.
- [Comparison table](./comparison.md) — Mongoose against the SQL ORMs.
- [Choosing a database](../databases/choosing-a-database.md) — whether MongoDB is the right call at all.
- [Migration strategy](./migration-strategy.md) — reshaping data in a schemaless store.
- [Testing with a database](./testing-with-a-database.md) — replica sets and per-test isolation for MongoDB.
- [Validation](../express-libraries/validation.md) — casting request input to scalars before it reaches a query.
- [Mass assignment](../security/mass-assignment.md) — why `create(req.body)` is a hole.
- [`examples/orm-mongoose`](../../examples/orm-mongoose/README.md) — the runnable version of this page.
