---
title: MongoDB
description: Using the mongodb 7.6.0 driver directly — client reuse, pool sizing, indexes, cursors, aggregation, replica-set transactions and the operator-injection auth bypass.
status: current
updated: 2026-09-08
---

The `mongodb` package is the official Node.js driver. It is worth using directly: the API is small, it maps closely to what the server actually does, and nothing is hidden from you. This page covers the driver itself — [Mongoose](../orms/mongoose.md) covers the schema layer built on top of it.

The most important section is the last technical one. A JSON request body can turn into a MongoDB *operator*, and that is an authentication bypass, not a theoretical risk.

## Installing

:::tabs
@tab npm
```bash
npm install mongodb@^7.6.0
```
@tab pnpm
```bash
pnpm add mongodb@^7.6.0
```
@tab yarn
```bash
yarn add mongodb@^7.6.0
```
:::

## Basic example

Full runnable version: [`examples/db-mongodb`](../../examples/db-mongodb/README.md) — a complete
Express 5 API over this driver, including the operator-injection defence below and a
health check that answers `503` in milliseconds when MongoDB is unreachable instead of
hanging.

```js title="src/db.js"
import { MongoClient } from 'mongodb'

const client = new MongoClient(process.env.MONGODB_URI, {
  maxPoolSize: 20,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
})

await client.connect()

export const db = client.db(process.env.MONGODB_DB)
export const users = db.collection('users')

export async function closeDb() {
  await client.close()
}
```

```js title="src/users.repo.js"
import { ObjectId } from 'mongodb'
import { users } from './db.js'

export function findUserById(id) {
  if (!ObjectId.isValid(id)) return null
  return users.findOne({ _id: new ObjectId(id) }, { projection: { passwordHash: 0 } })
}
```

`ObjectId.isValid()` before constructing is not optional. `new ObjectId('not-an-id')` throws, and an unhandled throw in a route handler is a 500 where a 404 belongs.

## One MongoClient, forever

`MongoClient` **is** the connection pool. Create exactly one per process, connect once at startup, and reuse it for the life of the application.

```js vulnerable title="DO NOT COPY — a client per request"
export async function handler(req, res) {
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  const user = await client.db('app').collection('users').findOne({ _id: id })
  res.json(user)
}
```

That pays a TCP handshake, a TLS handshake, an authentication round trip and a server-discovery cycle on every request — typically tens of milliseconds — and leaks a pool per request if the `close()` is ever skipped. Under load it exhausts the server's connection limit.

In a serverless function, hoist the client outside the handler so it survives between invocations on a warm container, and set `maxPoolSize` low (1–5) because you have many containers. See [Connection pooling](connection-pooling.md).

### Pool and timeout options

| Option | Default | What it does |
| --- | --- | --- |
| `maxPoolSize` | 100 | Maximum connections per server in the topology. 100 per process is almost always too many. |
| `minPoolSize` | 0 | Connections kept warm. Raise it if connection setup latency shows in p99. |
| `maxIdleTimeMS` | 0 (never) | How long an idle connection stays in the pool. |
| `serverSelectionTimeoutMS` | 30000 | How long to look for a suitable server before failing. **Lower this** — 30 s means a request hangs for half a minute during a failover. |
| `connectTimeoutMS` | 30000 | TCP connect timeout. |
| `socketTimeoutMS` | 0 (none) | Socket inactivity timeout. |
| `waitQueueTimeoutMS` | 0 (none) | How long an operation waits for a free connection before failing. |

Set `serverSelectionTimeoutMS` and `waitQueueTimeoutMS` explicitly. Their defaults are tuned for long-running batch jobs, not for an HTTP request that has a 10-second budget.

Individual operations also take `maxTimeMS`, which bounds work **on the server**:

```js
const rows = await users.find({ status: 'active' }, { maxTimeMS: 3_000 }).toArray()
```

That is the MongoDB equivalent of Postgres's `statement_timeout` — the server actually stops working. A client-side abort does not.

## Reads

`findOne` returns a document or `null`. `find` returns a **cursor**, which is lazy — nothing has been fetched until you iterate it.

```js
// One document.
const user = await users.findOne({ email }, { projection: { _id: 1, email: 1, name: 1 } })

// Many documents, materialised. Only when the result set is bounded.
const page = await users
  .find({ tenantId, status: 'active' })
  .project({ _id: 1, email: 1, name: 1 })
  .sort({ createdAt: -1 })
  .limit(50)
  .toArray()
```

For anything unbounded — an export, a migration, a reconciliation job — iterate the cursor instead of calling `toArray()`. `toArray()` buffers every matching document in Node's heap, and a collection that grew past your assumptions becomes an out-of-memory crash.

```js title="src/export.js"
const cursor = users.find({ tenantId }).project({ _id: 1, email: 1 }).batchSize(500)

try {
  for await (const doc of cursor) {
    await writeRow(doc)
  }
} finally {
  await cursor.close()
}
```

`for await` closes the cursor when the loop completes normally, but not if you `break` or throw — hence the `finally`. An unclosed cursor holds server-side resources until it times out.

### Projections matter more than you think

`projection: { passwordHash: 0 }` is not cosmetic. Documents are read whole by default, so a projection reduces network bytes, driver deserialization and Node heap. More importantly, it is the mechanism that stops `passwordHash`, `mfaSecret` and `resetToken` from being handed to a route that `res.json()`s the object.

Make the exclusion of secrets structural. A repository function that returns a full user document is one careless `res.json(user)` away from a credential leak.

Inclusion and exclusion cannot be mixed in one projection, except for `_id`. Prefer an explicit inclusion list — it fails closed when someone adds a new sensitive field.

## Indexes

MongoDB will happily scan an entire collection. It does not warn you, and on a small development data set it is fast. The difference only appears in production.

Create indexes explicitly at deploy time, not at startup on every boot:

```js title="migrations/001-indexes.js"
await db.collection('users').createIndex({ email: 1 }, { unique: true })
await db.collection('orders').createIndex({ userId: 1, createdAt: -1 })
await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

- `{ email: 1 }, { unique: true }` is the *only* thing that actually prevents duplicate emails. An application-level "check then insert" is a race. A duplicate insert then fails with error code `11000`, which you map to HTTP 409.
- Compound indexes follow the same leftmost-prefix rule as SQL B-trees: `{ userId: 1, createdAt: -1 }` serves queries on `userId`, and on `userId + createdAt`, but not on `createdAt` alone. See [Indexing basics](indexing-basics.md).
- A TTL index (`expireAfterSeconds`) is the clean way to expire sessions and tokens. The background remover runs about once a minute, so expiry is eventual, not exact — never rely on it for a security boundary.

Confirm an index is used with `explain`:

```js
const plan = await users.find({ email: 'a@example.com' }).explain('executionStats')
console.log(plan.executionStats.executionStages.stage) // 'IXSCAN' good, 'COLLSCAN' bad
console.log(plan.executionStats.totalDocsExamined)     // should be ~nReturned
```

`totalDocsExamined` far above `nReturned` means the index is missing or the wrong shape.

Building an index on a large collection locks by default. In a replica set, MongoDB builds indexes without blocking reads and writes from version 4.2 onward, but it still consumes I/O — schedule it.

## Aggregation basics

The aggregation pipeline is an array of stages, each transforming the stream from the previous one.

```js title="src/reports.js"
export function revenueByDay(tenantId, since) {
  return db.collection('orders').aggregate([
    { $match: { tenantId, createdAt: { $gte: since }, status: 'paid' } },
    { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        totalCents: { $sum: '$totalCents' },
        orders: { $sum: 1 },
    } },
    { $sort: { _id: 1 } },
  ]).toArray()
}
```

Two rules decide whether a pipeline is fast:

1. **`$match` first, and make it index-eligible.** Only a `$match` (or `$sort`) at the *start* of the pipeline can use an index. A `$match` after a `$group` filters an in-memory stream.
2. **`$project` early** to drop fields you do not need, so later stages move less data.

`$lookup` performs a join. It works, and it is much slower than a relational join — there is no query planner choosing a hash join for you. If most of your reads need `$lookup`, that is evidence the data belongs in a relational database. See [Choosing a database](choosing-a-database.md).

Aggregations have a 100 MB memory limit per stage; `{ allowDiskUse: true }` lifts it at a large performance cost. Needing it usually means the `$match` is not selective enough.

## Transactions need a replica set

`client.startSession()` and `session.withTransaction()` give you multi-document ACID transactions — but only against a **replica set** or a sharded cluster. A standalone `mongod` cannot start a session transaction, and the error message at 2 a.m. is not obvious.

```js title="src/transfer.js"
export async function transfer(fromId, toId, amountCents) {
  const session = client.startSession()
  try {
    await session.withTransaction(async () => {
      const accounts = db.collection('accounts')
      const debit = await accounts.updateOne(
        { _id: fromId, balanceCents: { $gte: amountCents } },
        { $inc: { balanceCents: -amountCents } },
        { session },
      )
      if (debit.modifiedCount !== 1) throw new Error('insufficient funds')

      await accounts.updateOne({ _id: toId }, { $inc: { balanceCents: amountCents } }, { session })
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    })
  } finally {
    await session.endSession()
  }
}
```

Details that matter:

- **Every operation inside must be passed `{ session }`.** An operation that forgets it runs outside the transaction and is not rolled back. This is the most common transaction bug in MongoDB code.
- `withTransaction` **retries automatically** on transient transaction errors, so the callback must be idempotent — it may run more than once.
- A transaction has a 60-second server-side limit by default and holds resources for its duration. Keep it short; never `await` an HTTP call inside one. See [Transactions](transactions.md).
- Development against a standalone `mongod` and production against a replica set is a configuration difference that hides transaction bugs until release. Run a single-node replica set locally instead.

A single-document update is atomic without any of this. Most "I need a transaction" cases in MongoDB are actually "I should have modeled this as one document" or "I should use a conditional update", as the `balanceCents: { $gte: amountCents }` filter above does.

## Operator injection — the auth bypass

:::danger This is the vulnerability to worry about
A MongoDB query is a **JavaScript object**. `express.json()` parses request bodies into JavaScript objects. If a value from the body reaches a query object without being coerced to a primitive, the caller controls a query *operator*, not a value.

```js vulnerable title="DO NOT COPY — src/auth.js"
app.post('/login', async (req, res) => {
  const { email, password } = req.body
  const user = await users.findOne({ email, password })
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  res.json({ token: issueToken(user) })
})
```

Exploit — no password required:

```bash
curl -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$ne":null}}'
```

The query becomes `{ email: 'admin@example.com', password: { $ne: null } }` — "any user whose password is not null" — and returns the admin. `{"$gt":""}` and `{"$regex":"^a"}` work the same way; a regex lets an attacker extract the value one character at a time.

`{"email":{"$ne":null},"password":{"$ne":null}}` logs in as whichever user the server returns first.
:::

The fix is not escaping — nothing is being escaped. The fix is to **validate the type and coerce to a primitive before the value can reach a query**.

```js good title="src/auth.js"
import { z } from 'zod'
import argon2 from 'argon2'

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
})

app.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body)

  // `email` is now provably a string, so it cannot be an operator object.
  const user = await users.findOne(
    { email },
    { projection: { _id: 1, email: 1, passwordHash: 1 } },
  )

  // Compare the password in the application, never in the query.
  const ok = user ? await argon2.verify(user.passwordHash, password) : false
  if (!ok) return res.status(401).json({ error: 'invalid credentials' })

  res.json({ token: issueToken(user) })
})
```

Three separate defenses, all of which you want:

1. **Schema validation at the edge.** `z.email()` rejects an object outright — a `{$ne: null}` value is not a string, so `parse` throws and your error middleware returns 400. See [Validation](../express-libraries/validation.md).
2. **Never put a credential in a query filter.** Look the user up by identifier, then verify the hash in application code with `argon2.verify`. A password should never be a query term even when it is correctly a string. See [Password hashing](../express-libraries/password-hashing.md).
3. **Coerce at the boundary of the repository.** A repository function that takes `(email: string)` and is only ever called with a validated value is structurally safe.

Verify the fix with the same `curl`: it must return **400**, not 401 and certainly not 200.

The same shape applies far beyond login. Any handler that spreads user input into a filter is exposed:

```js vulnerable title="DO NOT COPY"
const results = await products.find({ ...req.query }).toArray()
```

`?price[$gt]=` with the extended query parser, or a JSON body, gives the caller arbitrary query control — including `$where`, which evaluates JavaScript on the server. Build filters explicitly from named, validated fields. Never spread.

Full treatment, including `$where` and aggregation-stage injection: [NoSQL injection](../security/nosql-injection.md).

## Security considerations

**Validate and coerce every value that reaches a query.** This is the whole game. Objects from JSON bodies are operators waiting to happen; strings and numbers are not.

**Never spread `req.body` or `req.query` into a filter or an update.** Build the object field by field from validated input. Spreading into an `$set` is also a mass-assignment hole — a body containing `role: 'admin'` promotes the user. See [Mass assignment](../security/mass-assignment.md).

**Disable server-side JavaScript.** `$where`, `$function` and `$accumulator` run JavaScript in the database. Start `mongod` with `--noscripting` (or `security.javascriptEnabled: false`) so an injected `$where` cannot execute.

**Use a least-privilege user.** MongoDB has real role-based access control — use it. The application user gets `readWrite` on one database. It does not get `dbAdmin`, `clusterAdmin` or `root`, and the migration job uses a different credential.

```js title="mongosh"
db.getSiblingDB('admin').createUser({
  user: 'app',
  pwd: passwordPrompt(),
  roles: [{ role: 'readWrite', db: 'appdb' }],
})
```

**Require TLS and authentication.** An unauthenticated MongoDB reachable from the internet is the classic ransom incident. Bind to a private network, enable auth, and verify the certificate — do not disable certificate validation to make a connection string work.

**Project secrets out at the repository layer**, so no route can serialize a `passwordHash`.

**Never return raw driver errors.** A duplicate-key error message includes the index name and the duplicated value, which is a user-enumeration oracle.

**`ObjectId` is not a secret.** It embeds a timestamp and is sequential enough to enumerate. It identifies; it does not authorize. Every read must check ownership — see [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md).

## Production considerations

- **One `MongoClient` per process**, connected at startup, `await client.close()` on `SIGTERM`. See [Graceful shutdown](../production/graceful-shutdown.md).
- **Lower `serverSelectionTimeoutMS`** to something inside your request budget. The 30-second default turns a brief election into a pile of hung requests.
- **`maxPoolSize` × replicas must fit the cluster's limit.** The 100 default is a per-process pool; twenty replicas is 2000 connections.
- **Write concern is a durability decision.** `w: 'majority'` acknowledges only after a majority of the replica set has the write. Anything less can be rolled back during a failover. Use `majority` for anything you would be unhappy to lose.
- **Read preference is a correctness decision.** `secondaryPreferred` gives you more read capacity and stale reads. A read-after-write on a secondary can miss the write you just made.
- **Create indexes in a migration, not at boot.** `createIndex` on every process start is wasted work and a surprise index build in the middle of a deploy.
- **Monitor `COLLSCAN`.** Enable the slow-query profiler at a sane threshold and alert on collection scans against large collections.
- **Bound every collection.** Documents have a 16 MB limit; an array field that grows per event will eventually hit it, and performance degrades long before it does. Model unbounded growth as its own collection.
- **Cap `maxTimeMS`** on request-path queries so a missing index cannot pin a connection indefinitely.
- **Run a replica set in every environment**, including local development, so transaction behavior matches.

## Common mistakes

- **Creating a `MongoClient` per request.** It is the pool; there should be one.
- **Passing an unvalidated body value into a filter.** The operator-injection bypass above.
- **Spreading `req.query` into `find()`.** Hands the caller the query language.
- **`new ObjectId(id)` without `isValid`.** A malformed path parameter throws and becomes a 500.
- **`toArray()` on an unbounded query.** Works in development, out-of-memory in production.
- **Forgetting `{ session }`** on an operation inside `withTransaction`. It silently runs outside the transaction.
- **Expecting transactions on a standalone `mongod`.** They need a replica set.
- **Relying on an application-level uniqueness check.** Only a unique index is atomic.
- **Assuming TTL indexes delete on time.** The sweeper runs roughly every 60 seconds.
- **Treating "schemaless" as "no schema".** The schema still exists; it now lives in every read path in your code, with no way to migrate old documents. See [Choosing a database](choosing-a-database.md).
- **Returning full documents from repository functions**, then discovering `passwordHash` in an API response.

## Related topics

- [NoSQL injection](../security/nosql-injection.md) — the full exploit set, including `$where` and aggregation stages.
- [Mongoose](../orms/mongoose.md) — schemas, casting and middleware on top of this driver.
- [Choosing a database](choosing-a-database.md) — whether documents are the right model at all.
- [Connection pooling](connection-pooling.md) — sizing `maxPoolSize` across replicas and serverless.
- [Transactions](transactions.md) — isolation, retries and where transaction boundaries belong.
- [Indexing basics](indexing-basics.md) — leftmost prefixes and covering indexes, which apply here too.
- [Validation](../express-libraries/validation.md) — the Zod layer that makes the injection impossible.
- [Mass assignment](../security/mass-assignment.md) — why spreading input into `$set` promotes users.
- [N+1 queries](n-plus-one-queries.md) — the `$in` batching fix.
