---
title: Validation
description: Validating request bodies, params and queries with Zod 4 in Express 5, including why you must use the parsed output and how strict objects block mass assignment.
status: current
updated: 2026-09-08
---

Every value in `req.body`, `req.params`, `req.query` and `req.headers` is attacker-controlled. Validation is the boundary where untyped, unbounded input becomes a known shape you can reason about — and the boundary only holds if the rest of your code uses the *parsed output*, not the original request.

## Why it exists

Without validation your handler is a set of implicit assumptions: that `req.body.email` is a string, that `req.body.quantity` is a positive integer, that `req.body` exists at all. Each assumption is a bug an attacker can trigger — a crash, a `NaN` written to the database, an admin flag set by a field you never intended to accept.

A schema makes those assumptions explicit, checks them once, and gives you a value whose shape is guaranteed downstream.

:::warning
In Express 5, `req.body` is **`undefined`** when no body parser ran (Express 4 gave you `{}`). Reading `req.body.email` on a route without `express.json()` throws a `TypeError`, not a validation error. Register the parser, and let the schema reject `undefined` cleanly.
:::

## Installation

:::tabs
@tab npm
```bash
npm install zod@4
```
@tab pnpm
```bash
pnpm add zod@4
```
@tab yarn
```bash
yarn add zod@4
```
:::

## The Zod 4 API

Zod 4 moved the string formats to the top level. The method forms still work but are deprecated, and you will see both in older material.

| Zod 3 (deprecated) | Zod 4 |
| --- | --- |
| `z.string().email()` | `z.email()` |
| `z.string().uuid()` | `z.uuid()` |
| `z.string().url()` | `z.url()` |
| `z.string().datetime()` | `z.iso.datetime()` |
| `z.string().ip()` | `z.ipv4()` / `z.ipv6()` |
| `z.object({…}).strict()` | `z.strictObject({…})` |
| `z.object({…}).passthrough()` | `z.looseObject({…})` |
| `error.flatten()` / `error.format()` | `z.flattenError(error)` / `z.treeifyError(error)` |

Two more Zod 4 details worth knowing: `z.uuid()` now enforces the RFC 9562 variant bits (use `z.guid()` if you need to accept any 8-4-4-4-12 hex string), and `z.number().int()` rejects values outside the safe-integer range — `z.int()` is the direct replacement.

## Basic example

Schemas are plain values, so the JavaScript and TypeScript versions are the same
code. The difference is that in TypeScript you get the static type for free with
`z.infer`, instead of maintaining a separate interface that can drift from the
schema that actually runs:

:::tabs
@tab JavaScript
```js title="src/schemas/user.js"
import { z } from 'zod'

export const createUserBody = z.strictObject({
  email: z.email(),
  displayName: z.string().min(1).max(80),
  age: z.int().min(13).max(150).optional(),
})

export const userIdParams = z.strictObject({
  id: z.uuid(),
})

export const listUsersQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).optional(),
})
```
@tab TypeScript
```ts title="src/schemas/user.ts"
import { z } from 'zod'

export const createUserBody = z.strictObject({
  email: z.email(),
  displayName: z.string().min(1).max(80),
  age: z.int().min(13).max(150).optional(),
})

export const userIdParams = z.strictObject({
  id: z.uuid(),
})

export const listUsersQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).optional(),
})

// Derived from the schema, so it cannot disagree with what is validated.
export type CreateUserBody = z.infer<typeof createUserBody>
export type ListUsersQuery = z.infer<typeof listUsersQuery>
```
:::

## A reusable validate middleware

One middleware, three optional schemas, and the parsed results attached where the handler can find them.

```js title="src/middleware/validate.js"
export function validate({ body, params, query, headers } = {}) {
  return (req, res, next) => {
    const valid = {}

    for (const [source, schema] of [
      ['body', body],
      ['params', params],
      ['query', query],
      ['headers', headers],
    ]) {
      if (!schema) continue

      const result = schema.safeParse(req[source])
      if (!result.success) {
        return res.status(400).json({
          error: 'validation_failed',
          source,
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        })
      }

      valid[source] = result.data
    }

    // `req.body` is writable, so overwrite it with the parsed value.
    if ('body' in valid) req.body = valid.body

    // `req.query` is a GETTER in Express 5 and cannot be assigned.
    // `req.params` is replaced by the router on each layer.
    // So publish everything on one property the handlers read from.
    req.valid = valid
    next()
  }
}
```

```js title="src/routes/users.js"
import { Router } from 'express'
import { validate } from '../middleware/validate.js'
import { createUserBody, userIdParams, listUsersQuery } from '../schemas/user.js'

const router = Router()

router.post('/', validate({ body: createUserBody }), async (req, res) => {
  const user = await createUser(req.valid.body)
  res.status(201).json(user)
})

router.get('/:id', validate({ params: userIdParams }), async (req, res) => {
  const user = await findUser(req.valid.params.id)
  if (!user) return res.status(404).json({ error: 'not_found' })
  res.json(user)
})

router.get('/', validate({ query: listUsersQuery }), async (req, res) => {
  const { page, perPage, q } = req.valid.query
  res.json(await listUsers({ page, perPage, q }))
})

export default router
```

The handlers are `async` with no wrapper. Express 5 forwards a rejected promise to the error middleware automatically.

### Why you must use the parsed result

`safeParse` does not mutate its input. It returns a **new** value with defaults applied, coercions performed, and unknown keys handled according to the schema. If your handler keeps reading `req.body`, none of that happened:

```js vulnerable title="DO NOT COPY"
router.post('/', validate({ body: createUserBody }), async (req, res) => {
  // The schema stripped `role`, but req.body still has it.
  const user = await db.insert(req.body)
  res.status(201).json(user)
})
```

That is the mass-assignment bug: the schema *proved* the request was acceptable and then you used the unproven object anyway. Assign the parsed value back (`req.body = result.data`), read from `req.valid`, or both — but never validate one object and use another.

### Express 5 makes `req.query` read-only

```js vulnerable title="DO NOT COPY — throws in Express 5"
req.query = listUsersQuery.parse(req.query)
```

In Express 5, `req.query` is defined as a getter that parses the URL lazily. Assigning to it throws in strict mode (ESM is always strict) or silently does nothing otherwise. `req.params` is not much better: the router rebuilds it as it descends through routers, so a value you write on one layer can be replaced on the next.

Publishing the parsed values on your own property — `req.valid` above, or `res.locals` if you prefer to keep `req` untouched — sidesteps both. Pick one convention and use it everywhere, because a handler that reads `req.query.page` on a validated route is a bug that only appears when someone sends a bad value.

:::note
Express 5's default query parser is **`'simple'`** (`querystring`), not `'extended'` (`qs`). `?a[b]=1` gives you the key `'a[b]'` as a string rather than a nested object. Opt back in with `app.set('query parser', 'extended')` if you need nesting — and then validate the nested shape, because `qs` will happily build deep objects and arrays from a crafted query string.
:::

## Strict objects and mass assignment

`z.object()` **strips** unknown keys: they are removed from the output but the parse succeeds. `z.strictObject()` **rejects** them with an error.

```js
const loose = z.object({ email: z.email() })
loose.parse({ email: 'a@b.test', role: 'admin' })
// => { email: 'a@b.test' }   — silently dropped

const strict = z.strictObject({ email: z.email() })
strict.parse({ email: 'a@b.test', role: 'admin' })
// => throws: Unrecognized key: "role"
```

Both are safe *if you use the output*. Prefer `strictObject` for request bodies anyway:

- It turns a client sending the wrong field name into a loud 400 instead of a silently ignored value, which saves hours of "why isn't my update saving".
- It makes probing visible. Someone sending `role`, `isAdmin`, or `accountId` to a profile-update endpoint shows up in your logs instead of being quietly discarded.

The one place `strictObject` hurts is a query schema that must tolerate tracking parameters (`utm_source` and friends). Use `z.object()` there and accept the strip.

For the attack itself — how an ignored `role` field becomes an admin account when it reaches an ORM's `update()` — see [Mass assignment](../security/mass-assignment.md).

## Coercion for params and query strings

Everything in a URL is a string. `req.params.id` is `'42'`, never `42`, and `?page=2` is `'2'`.

```js
z.coerce.number().int().min(1)   // '2' -> 2
z.coerce.boolean()               // careful, see below
z.coerce.date()                  // '2026-09-08' -> Date
```

Use coercion **only** on `params`, `query` and headers. In a JSON body the client already has real types, and coercing there hides bugs: `{ "quantity": "12" }` should be a 400, not a silently repaired `12`.

:::warning
`z.coerce.boolean()` applies JavaScript truthiness. The string `'false'` is a non-empty string, so it coerces to **`true`**. For a query flag, be explicit:

```js
const flag = z.enum(['true', 'false']).transform((v) => v === 'true')
```
:::

Note also that `z.coerce.number()` maps `''` to `0` and `null` to `0`. If an absent parameter must be distinguishable from zero, put `.optional()` outside the coercion and validate the range.

## Error responses

Return the field paths and messages; do not return the input.

```json title="400 Bad Request"
{
  "error": "validation_failed",
  "source": "body",
  "issues": [
    { "path": "email", "code": "invalid_format", "message": "Invalid email address" },
    { "path": "age", "code": "too_small", "message": "Too small: expected number to be >=13" }
  ]
}
```

`result.error.issues` is the stable, structured form and is what you should map over. Zod 4 also ships `z.treeifyError(err)` (nested, mirrors the schema shape), `z.flattenError(err)` (one level, convenient for simple forms) and `z.prettifyError(err)` (a human-readable string — useful in logs, not in an API response).

Echoing the offending value back is a reflected-content risk if that response is ever rendered, and it can put a secret straight into your logs when the failing field was a password or a token.

## Validating everything else

Bodies are not the only untrusted surface.

```js title="src/app.js"
import express from 'express'

const app = express()

// Cap the body before the schema ever sees it.
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))
```

`express.urlencoded()` defaults to `extended: false` in Express 5. A size limit is not optional: a schema cannot reject a 50 MB body it has already buffered into memory.

Headers you depend on deserve a schema too:

```js
const authHeaders = z.object({
  authorization: z.string().regex(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/),
})
```

Header names arrive lower-cased, and `req.headers` may hold an **array** for headers sent more than once — `z.string()` correctly rejects that rather than letting `.split(' ')` blow up.

## express-validator as the alternative

`express-validator` 7.3.2 wraps `validator.js` as a chain of middlewares. It fits codebases that prefer per-field declarations to a schema object, and it sanitizes as well as validates.

```bash
npm install express-validator@7
```

```js title="src/routes/users.js"
import { Router } from 'express'
import { checkSchema, validationResult, matchedData } from 'express-validator'

const router = Router()

const createUserSchema = checkSchema(
  {
    email: {
      isEmail: true,
      normalizeEmail: true,
      errorMessage: 'A valid email is required',
    },
    displayName: {
      trim: true,
      isLength: { options: { min: 1, max: 80 } },
    },
    age: {
      optional: true,
      isInt: { options: { min: 13, max: 150 } },
      toInt: true,
    },
  },
  ['body'], // only look in the body, never in query or params
)

router.post('/', createUserSchema, async (req, res) => {
  const result = validationResult(req)
  if (!result.isEmpty()) {
    return res.status(400).json({ error: 'validation_failed', issues: result.array() })
  }

  // matchedData() returns ONLY the fields the schema declared,
  // after sanitization. This is the express-validator answer to
  // mass assignment — never pass req.body to your model.
  const data = matchedData(req, { locations: ['body'] })
  res.status(201).json(await createUser(data))
})

export default router
```

`matchedData()` is the load-bearing part. Without it you are back to reading `req.body`, which still contains every unknown field the client sent and the *unsanitized* values. Pass `locations` explicitly so a validated `body.id` cannot be satisfied by a `query.id`.

Restricting each chain to one location (the second argument to `checkSchema`) matters for the same reason: the default `check()` searches body, cookies, headers, params and query in turn, so a client can move a value to whichever location passes.

| | Zod 4 | express-validator 7 |
| --- | --- | --- |
| Shape | One schema object per request part | A chain per field |
| Output | A new, typed value from `safeParse` | `matchedData(req)` |
| Unknown keys | Stripped, or rejected with `strictObject` | Absent from `matchedData()` |
| Sanitization | Explicit `.transform()` | Built in (`trim`, `escape`, `normalizeEmail`) |
| Types | Inferred (`z.infer<typeof schema>`) | Manual |
| Reuse elsewhere | Same schema validates jobs, config, API docs | Express-only |

Zod is the better default because the schema is a value you can reuse — for OpenAPI generation (see [API documentation](api-documentation.md)), for config parsing at boot, for validating a queue message. express-validator is a reasonable choice when you want its sanitizers and are already invested in the chain style.

:::warning
`escape` and `normalizeEmail` change the value. `escape` HTML-encodes at the input boundary, which corrupts data that is not destined for HTML — store the original and encode on output instead. `normalizeEmail` rewrites addresses (stripping Gmail dots, for example), so two users can normalize to the same address; that is a feature for deduplication and a bug if you then fail to find the account they registered with.
:::

## Security considerations

**Validation is not authorization.** A perfectly valid `{ "accountId": "…" }` from a user who does not own that account is still an IDOR. Schemas check shape; ownership checks are separate. See [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md).

**Validation is not output encoding.** A valid string may still contain `<script>`. Escape at render time, parameterize at query time. See [Cross-site scripting (XSS)](../security/xss.md) and [SQL injection](../security/sql-injection.md).

**Bound every string and array.** `z.string()` with no `.max()` accepts as much as your body limit allows; an unbounded array of objects multiplies that into memory and database work. Give every field a ceiling.

**Reject unknown keys on write endpoints.** `strictObject` on bodies is the cheapest mass-assignment defense there is.

**Never trust a value because it appeared in a JWT or a header.** Both are input. Validate claims with the same rigor as a body — see [JWT pitfalls](../security/jwt-pitfalls.md).

**Validate before you touch the database, not after.** A schema that runs after a lookup has already paid for the query the attacker wanted to trigger.

**Beware regex denial of service.** A hand-written `.regex()` with nested quantifiers (`(a+)+$`) can be driven to exponential backtracking by a crafted string. Prefer the built-in formats, keep custom patterns anchored and simple, and always pair them with `.max()`.

**Do not echo input in error messages.** The path and a generic message are enough.

## Production considerations

**Compile schemas once, at module load.** Building a schema inside a handler allocates on every request. Export them from a `schemas/` module.

**Type inference is free with Zod.** `type CreateUser = z.infer<typeof createUserBody>` keeps the runtime check and the compile-time type from drifting apart, which is the failure mode of hand-written interfaces.

**Keep one error shape across the API.** Clients parse it. Decide on the envelope (`error`, `issues[]`, `path`, `code`) once and route both validation failures and other 4xx responses through the same serializer — see [Error handling](../express/error-handling.md).

**Log validation failures at `warn`, with the path but not the value.** A spike of failures on one field is either a client regression or someone probing.

**Reuse the schema for the OpenAPI document** so the docs cannot describe a contract the code does not enforce.

**Body limits belong on the parser, not the schema.** `express.json({ limit: '100kb' })` rejects at 100 KB and returns a 413; a schema would have to buffer the whole thing first.

**Zod 4 is meaningfully faster than Zod 3** and tree-shakes better because the formats are top-level functions, but a large schema on a hot path is still work. If a request part never varies, validate it once at boot rather than per request.

## Common mistakes

- **Validating `req.body` and then using `req.body` anyway.** The schema's output is the point.
- **Assigning to `req.query`.** It is a getter in Express 5. Put parsed values on `req.valid` or `res.locals`.
- **Reading `req.body` on a route with no body parser.** In Express 5 that is `undefined`, and the property access throws.
- **Using `z.object()` for write bodies and assuming it rejects extras.** It strips silently; `z.strictObject()` rejects.
- **Coercing inside a JSON body schema.** It masks client bugs and accepts `"12"` where you meant `12`.
- **`z.coerce.boolean()` on a query flag.** `'false'` becomes `true`.
- **Using express-validator without `matchedData()`.** You validated some fields and then handed the raw body to the model.
- **Leaving `checkSchema` unscoped,** letting a client satisfy a body rule with a query parameter.
- **No `.max()` on strings, no `limit` on the body parser.** Both are denial-of-service surface.
- **Returning the invalid input in the error response.** It leaks secrets into logs and reflects attacker content.
- **Treating a passing schema as an authorization decision.**

## Related topics

- [Mass assignment](../security/mass-assignment.md) — the exploit that `strictObject` and `matchedData()` prevent.
- [Error handling](../express/error-handling.md) — turning validation failures into one consistent error envelope.
- [API documentation](api-documentation.md) — generating OpenAPI from these same Zod schemas.
- [SQL injection](../security/sql-injection.md) — why validation is not a substitute for parameterized queries.
- [Cross-site scripting (XSS)](../security/xss.md) — why validation is not a substitute for output encoding.
- [Request and response](../express/request-and-response.md) — what `req.body`, `req.query` and `req.params` actually are in Express 5.
