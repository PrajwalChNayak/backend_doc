---
title: NoSQL injection
description: MongoDB operator injection through JSON bodies, a working authentication bypass, and how to coerce input to primitives before it ever reaches a query.
status: current
updated: 2026-09-08
---

NoSQL injection does not need quotes or semicolons. MongoDB queries *are* objects, so if you pass a request body straight into a filter, an attacker replaces a scalar you expected with an operator object like `{ "$ne": null }` and changes what the query means. `express.json()` makes the attack trivially reachable: the body is already a parsed object with whatever shape the client sent.

## The threat

A MongoDB filter is a plain object. When user input becomes a value in that object unchecked, the attacker can substitute a query operator (`$ne`, `$gt`, `$regex`, `$in`) to match rows they should not, turn a lookup into a full scan, cause catastrophic backtracking with a crafted `$regex` (ReDoS), or — if server-side JavaScript is enabled — execute arbitrary JS in the database with `$where` or `$expr`. The reach is the same as SQL injection: authentication bypass and data exfiltration, without a single special character.

## A concrete exploit

This login handler passes `req.body` fields directly into `findOne`.

:::danger MongoDB operator injection
`email` and `password` come straight from the JSON body into the filter. The client controls their *type*, so it can send an operator object instead of a string.
:::

```js vulnerable title="DO NOT COPY"
import express from 'express'
import { MongoClient } from 'mongodb'

const client = new MongoClient(process.env.MONGO_URL)
const users = client.db('app').collection('users')

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true })) // also builds nested objects

app.post('/login', async (req, res) => {
  const { email, password } = req.body
  // Whatever shape the client sent becomes the filter.
  const user = await users.findOne({ email, password })
  res.json({ authenticated: user !== null })
})

app.listen(3000)
```

**Authentication bypass.** The attacker sends an operator where a string was expected. `{ "$ne": null }` means "any value that is not null", so the password condition matches the admin row regardless of the stored password:

```bash
curl -s -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$ne":null}}'
```

Response — authenticated as admin:

```json
{ "authenticated": true }
```

The filter MongoDB actually evaluated was `{ email: 'admin@example.com', password: { $ne: null } }`.

**No known email either.** With `$gt` on both fields the attacker logs in as *whatever the first user is*, without knowing any address:

```bash
curl -s -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"email":{"$gt":""},"password":{"$gt":""}}'
```

**`$regex` ReDoS / extraction.** A regex value turns the lookup into pattern matching. Anchored guesses extract a secret character by character, and a pathological pattern pins CPU at 100%:

```bash
curl -s -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$regex":"^a"}}'
```

**`$where` / `$expr` JavaScript execution.** If server-side JS is enabled, `$where` runs an attacker string as JavaScript inside the database process:

```bash
curl -s 'http://localhost:3000/search' -H 'content-type: application/json' \
  -d '{"filter":{"$where":"sleep(5000) || true"}}'
```

Because `express.urlencoded({ extended: true })` also parses nested objects, the same attack works through a form body: `email[$ne]=` produces `{ email: { $ne: '' } }`. Any parser that builds nested objects from the request is a delivery mechanism.

## The fix in code

The root cause is a **type confusion**: you expected a string and got an object. Fix it at the boundary by validating and coercing every field to the primitive you expect *before* it can reach a query. Zod does this cleanly, and its parsed output is a new object of known shape — the operator object never survives validation.

```js good title="src/auth.controller.js"
import express from 'express'
import { z } from 'zod'
import { MongoClient } from 'mongodb'

const client = new MongoClient(process.env.MONGO_URL)
const users = client.db('app').collection('users')

const loginSchema = z.object({
  email: z.email(),          // must be a string that is an email
  password: z.string().min(1), // must be a string, never an object
})

const app = express()
app.use(express.json())

app.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid credentials shape' })
  }
  const { email, password } = parsed.data // guaranteed strings

  // Look up by the identifier only, then verify the hash in code.
  const user = await users.findOne({ email: { $eq: email } })
  const ok = user ? await verifyHash(password, user.passwordHash) : false
  res.json({ authenticated: ok })
})
```

Three habits make operator injection impossible:

- **Coerce to primitives at the edge.** After `z.string()` (or `z.email()`, `z.coerce.number()`), a value cannot be `{ $ne: null }` — parsing rejects the object. This is the single most important step.
- **Never pass `req.body` (or `req.query`) as a filter.** Build the filter yourself from validated fields. Wrap comparisons in explicit `$eq` so even a value that slipped through is treated as a literal, not an operator.
- **Verify passwords in application code**, not by matching them in the query. The database should look up the user by email; hash comparison belongs in `argon2.verify`/`bcrypt.compare`.

For Mongoose, `sanitizeFilter` wraps user-supplied values in `$eq` so embedded operators are treated as literals. Set it per query or globally, as belt-and-braces on top of validation:

```js good title="src/user.model.js (Mongoose)"
// Per query: operators inside `filter` are neutralized into literals.
const user = await User.findOne(filter, null, { sanitizeFilter: true })

// Or globally at connect time.
mongoose.set('sanitizeFilter', true)
```

Finally, **disable server-side JavaScript** on the database so `$where`/`$expr`-JS cannot run even if a filter reaches them. Start `mongod` with `security.javascriptEnabled: false` (or `--noscripting` on older servers). Application code should never need `$where`.

:::warning
`express-mongo-sanitize` is **unmaintained** — its last release (2.2.0) was published in 2022. Beyond being stale, it works by mutating `req.query`, `req.body` and `req.params` in place, and in Express 5 `req.query` is a **getter with no setter**. A middleware that assigns to `req.query` therefore throws a `TypeError` (or, depending on how it guards the write, silently sanitizes nothing) on Express 5. Do not add it to a new Express 5 app. Validate and coerce with Zod at the boundary instead; that neutralizes the same attack without touching the immutable request objects.
:::

## How to verify the fix

Re-run the bypass payload against the fixed handler. Validation rejects the object-typed password before any query runs:

```bash
curl -s -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":{"$ne":null}}'
```

Response:

```json
{ "error": "invalid credentials shape" }
```

An automated test pins the behavior so a refactor cannot quietly reintroduce the hole:

```js title="test/login.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

test('operator-object password is rejected, not evaluated', async () => {
  const res = await request(createApp())
    .post('/login')
    .send({ email: 'admin@example.com', password: { $ne: null } })

  assert.equal(res.status, 400)
  assert.equal(res.body.authenticated, undefined)
})

test('a real string password reaches the handler', async () => {
  const res = await request(createApp())
    .post('/login')
    .send({ email: 'admin@example.com', password: 'hunter2' })

  assert.equal(res.status, 200)
  assert.equal(typeof res.body.authenticated, 'boolean')
})
```

## Common mistakes

- **Spreading `req.body` into a filter** — `findOne({ ...req.body })` or `findOne(req.query)`. The client then controls the query shape. Build the filter from validated fields only.
- **Validating presence but not type.** `if (!email) return 400` still lets `{ $ne: null }` through — it is truthy. Assert the type with `z.string()`.
- **Comparing passwords inside the query.** Matching `{ email, password }` invites the `$ne`/`$regex` bypass. Look up by email; verify the hash in code.
- **Leaving server-side JS enabled.** `$where` and `$expr`-JS become code execution. Turn scripting off.
- **Reaching for `express-mongo-sanitize` on Express 5.** It is unmaintained and its mutation of `req.query` conflicts with the Express 5 getter. Coerce with Zod instead.
- **Assuming form bodies are safe.** `express.urlencoded({ extended: true })` builds nested objects too, so `field[$ne]=` is a valid delivery vector.

## Related topics

- [SQL injection](sql-injection.md) — the same class against relational databases, where the payload is a string.
- [Validation](../express-libraries/validation.md) — Zod 4 schemas that coerce input to primitives at the boundary.
- [MongoDB](../databases/mongodb.md) — driver usage and query construction.
- [Mongoose](../orms/mongoose.md) — `sanitizeFilter` and schema-level typing.
- [Authentication and session security](authentication-and-session-security.md) — verifying credentials safely once the lookup is fixed.
