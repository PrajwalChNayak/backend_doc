---
title: Mass assignment
description: How PATCH /users/me with an extra property escalates to admin, and the allow-list, schema and ORM-level fixes that stop it in Express 5.
status: current
updated: 2026-09-08
---

Mass assignment is what happens when the shape of a request body decides which columns get written. The client sends one extra property, your code copies the whole object onto a record, and a field that was never part of the feature changes. It is OWASP API3:2023, and it is one line of code away in almost every "update your profile" handler.

## The exploit

**The threat.** Any authenticated user grants themselves any property the model has: `role`, `isVerified`, `credits`, `organizationId`, `emailVerifiedAt`, `deletedAt`.

**The vulnerable handler.** This is the shape, and it is everywhere:

:::danger
```js vulnerable title="DO NOT COPY — src/routes/users.js"
app.patch('/users/me', requireAuth, express.json(), async (req, res) => {
  const user = await db.users.findById(req.user.id)
  Object.assign(user, req.body)          // every key in the body becomes a column write
  await user.save()
  res.json(user)
})
```
:::

The ORM variants are the same bug:

:::danger
```js vulnerable title="DO NOT COPY"
await User.update(req.body, { where: { id: req.user.id } })        // Sequelize
await prisma.user.update({ where: { id: req.user.id }, data: req.body })   // Prisma
await User.findByIdAndUpdate(req.user.id, req.body)                // Mongoose
```
:::

**The exploit.** The intended request:

```bash
$ curl -s -X PATCH https://api.example.com/users/me \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"displayName":"Ann"}'
{"id":1,"email":"ann@example.com","displayName":"Ann","role":"user","isVerified":false}
```

The response tells the attacker exactly which properties exist. Add one:

```bash
$ curl -s -X PATCH https://api.example.com/users/me \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"displayName":"Ann","role":"admin","isVerified":true}'
{"id":1,"email":"ann@example.com","displayName":"Ann","role":"admin","isVerified":true}
```

Reproduced against Express 5.2.1: `200`, `"role":"admin"`, persisted. The next request to `/admin/users` succeeds.

There is no exotic step here. The attacker did not need to know the field names — the endpoint returned them.

## Fix 1: an explicit allow-list

The smallest correct fix. Name the fields the endpoint is allowed to write, and copy only those.

```js good title="src/routes/users.js"
const PROFILE_FIELDS = ['displayName', 'bio', 'locale', 'timezone']

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]))

app.patch('/users/me', requireAuth, express.json({ limit: '16kb' }), async (req, res) => {
  const updates = pick(req.body ?? {}, PROFILE_FIELDS)
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_updatable_fields' })
  }

  const user = await users.update(req.user.id, updates)
  res.json(publicUser(user))
})
```

:::warning
`req.body ?? {}` is not optional in Express 5. Without a body parser — or on a `PATCH` with no body at all — `req.body` is `undefined`, not `{}`, and `pick(undefined, …)` throws.
:::

An allow-list **ignores** unknown keys. That is quiet: an attacker learns nothing, but neither does a legitimate client with a typo. Prefer fix 2 when you want a real error.

## Fix 2: a strict schema that rejects unknown keys

Zod 4's `z.strictObject()` (or `.strict()` on an existing object schema) fails on any key it does not know. The client gets a 400 that names the offending key, and the write never happens.

```js good title="src/schemas/user.js"
import { z } from 'zod'

export const ProfileUpdate = z.strictObject({
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().max(500).optional(),
  locale: z.enum(['en', 'de', 'fr']).optional(),
  timezone: z.string().max(64).optional(),
})
```

```js good title="src/routes/users.js"
import { ProfileUpdate } from '../schemas/user.js'

app.patch('/users/me', requireAuth, express.json({ limit: '16kb' }), async (req, res) => {
  const parsed = ProfileUpdate.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
    })
  }

  // parsed.data contains ONLY the declared keys, correctly typed.
  const user = await users.update(req.user.id, parsed.data)
  res.json(publicUser(user))
})
```

**Verify it.** The same escalation attempt:

```bash
$ curl -s -X PATCH https://api.example.com/users/me \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"displayName":"Ann","role":"admin"}'
{"error":"invalid_body","issues":[{"path":[],"code":"unrecognized_keys","message":"Unrecognized key: \"role\""}]}
```

`400`, and the row is untouched:

```bash
$ psql -Atc "select role, is_verified from users where id = 1"
user|f
```

That output is from a real run against Express 5.2.1 with Zod 4.5.4.

:::note
`z.object()` in Zod 4 **strips** unknown keys rather than rejecting them — which is safe (they never reach your data) but silent. `z.strictObject()` rejects. `z.looseObject()` passes them through and is the one to avoid on a write path. Pick strict for request bodies so a client sending a field you removed finds out immediately.
:::

## Fix 3: map to a DTO in the service layer

Validation at the edge protects the HTTP route. It does not protect a service function called from a queue worker, a CLI script, or another service. Make the service take a typed argument rather than "an object":

```js good title="src/services/users.js"
import { pool } from '../db.js'

/**
 * @param {string} id
 * @param {{ displayName?: string, bio?: string, locale?: string, timezone?: string }} patch
 */
export async function updateProfile(id, patch) {
  const { rows } = await pool.query(
    `UPDATE users
        SET display_name = COALESCE($2, display_name),
            bio          = COALESCE($3, bio),
            locale       = COALESCE($4, locale),
            timezone     = COALESCE($5, timezone),
            updated_at   = now()
      WHERE id = $1
      RETURNING id, email, display_name, bio, locale, timezone`,
    [id, patch.displayName ?? null, patch.bio ?? null, patch.locale ?? null, patch.timezone ?? null],
  )
  return rows[0] ?? null
}
```

The column list is written out, once, in the only place that writes it. No object spread can reach `role` because `role` is not in the statement. This is the version that survives a refactor.

The same principle applies on the way out. A response serializer stops the *other* half of API3:2023 — returning fields the caller should not see, which is what told the attacker `role` existed in the first place:

```js good title="src/serializers/user.js"
export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  bio: u.bio,
  createdAt: u.created_at,
})
```

Never `res.json(user)` on a database row. The row grows a `password_hash`, a `mfa_secret` or an `internal_notes` column eventually, and the endpoint starts leaking it the day the migration lands.

## ORM-specific protections

An ORM narrows the hole; none of them close it. Every one of these still writes `role` if `role` is a real column and you pass it.

### Sequelize 6.37.8 — `fields`

`fields` restricts which attributes are validated and written, regardless of what is set on the instance:

```js good
const PROFILE_FIELDS = ['displayName', 'bio', 'locale', 'timezone']

const user = await User.findByPk(req.user.id)
user.set(req.body ?? {})                     // sets everything…
await user.save({ fields: PROFILE_FIELDS })  // …but only these columns are written
```

`Model.create()` and `Model.bulkCreate()` take the same option — important on signup, where `role` and `credits` are exactly what an attacker wants to set:

```js good
await User.create(req.body, { fields: ['email', 'passwordHash', 'displayName'] })
```

### Prisma 7.10.0 — the `data` object is the allow-list

Prisma rejects a key that is not on the model at runtime with `PrismaClientValidationError: Unknown argument …`. That catches typos; it does **not** catch mass assignment, because `role` *is* on the model:

:::danger
```js vulnerable title="DO NOT COPY"
await prisma.user.update({ where: { id: req.user.id }, data: req.body })
```
:::

Write the fields out:

```js good
const user = await prisma.user.update({
  where: { id: req.user.id },
  data: {
    displayName: patch.displayName,
    bio: patch.bio,
    locale: patch.locale,
    timezone: patch.timezone,
  },
  select: { id: true, email: true, displayName: true, bio: true, createdAt: true },
})
```

`select` does double duty: it is the response allow-list, so `passwordHash` cannot reach `res.json` even by accident.

:::note
Prisma 8 exists on npm's `latest` dist-tag as a release candidate. This page documents **7.10.0**, the current stable release.
:::

### Mongoose 9.9.5 — `strict` and `select: false`

Mongoose schemas are `strict` by default: a property not in the schema is silently dropped on save. That protects you from *undeclared* fields only — `role`, being declared, is written normally.

```js good title="src/models/user.js"
import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    displayName: { type: String, maxlength: 80 },
    // Never returned by a query unless explicitly selected.
    passwordHash: { type: String, required: true, select: false },
    mfaSecret: { type: String, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
  },
  { strict: 'throw' },     // reject unknown paths instead of dropping them silently
)

export const User = mongoose.model('User', userSchema)
```

`strict: 'throw'` turns the silent drop into an error, which is what you want on a write path. `select: false` keeps `passwordHash` and `mfaSecret` out of every query result unless a caller writes `.select('+passwordHash')` — a deliberate act that shows up in review.

The update itself still needs an allow-list:

```js good
await User.findByIdAndUpdate(
  req.user.id,
  { $set: pick(req.body ?? {}, PROFILE_FIELDS) },
  { new: true, runValidators: true },
)
```

:::warning
`req.body` from `express.json()` is parsed by `JSON.parse`, so it cannot contain a `__proto__` that pollutes the prototype — but it *can* contain a literal `"__proto__"` key, and `Object.assign`/spread onto a plain object with such a key is a known hazard in some library code paths. Another reason not to hand the raw body to anything: an allow-list drops the key before it can matter. See [NoSQL injection](nosql-injection.md) for the operator-injection version of the same problem (`{"role":{"$ne":null}}`).
:::

## Separate schemas per actor

The most common re-introduction of this bug is one `UserUpdate` schema shared between "a user edits their own profile" and "an admin edits any user". The admin schema must include `role`; the moment it is shared, so does the user one.

Model the *operation*, not the table:

```js good title="src/schemas/user.js"
import { z } from 'zod'

// What a user may change about themselves.
export const ProfileUpdate = z.strictObject({
  displayName: z.string().min(1).max(80).optional(),
  bio: z.string().max(500).optional(),
  locale: z.enum(['en', 'de', 'fr']).optional(),
})

// What an admin may change about anyone. A superset — and a different route.
export const AdminUserUpdate = z.strictObject({
  displayName: z.string().min(1).max(80).optional(),
  role: z.enum(['user', 'admin']).optional(),
  isVerified: z.boolean().optional(),
  suspendedAt: z.iso.datetime().nullable().optional(),
})
```

```js good title="src/routes/users.js"
router.patch('/users/me', requireAuth, validate(ProfileUpdate), updateOwnProfile)

router.patch('/admin/users/:id',
  requireAuth,
  requireRole('admin'),
  validate(AdminUserUpdate),
  updateUserAsAdmin,
)
```

Two routes, two schemas, two authorization checks. `role` appears in exactly one of them, and that one is behind `requireRole('admin')`.

The reusable middleware:

```js good title="src/middleware/validate.js"
export const validate = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
    })
  }
  req.validated = parsed.data      // handlers read req.validated, never req.body
  next()
}
```

Make `req.validated` the convention and `req.body` a smell. A grep for `req.body` outside middleware then finds every remaining instance of this bug.

## Testing it

```js title="test/mass-assignment.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app.js'
import { pool } from '../src/db.js'

test('a user cannot promote themselves via PATCH /users/me', async () => {
  const token = await tokenFor('ann@example.com')

  const res = await request(app)
    .patch('/users/me')
    .set('Authorization', `Bearer ${token}`)
    .send({ displayName: 'Ann', role: 'admin' })

  assert.equal(res.status, 400)
  assert.equal(res.body.issues[0].code, 'unrecognized_keys')

  const { rows } = await pool.query('SELECT role FROM users WHERE email = $1', ['ann@example.com'])
  assert.equal(rows[0].role, 'user', 'role must be unchanged in the database')
})

test('the profile response does not expose internal columns', async () => {
  const token = await tokenFor('ann@example.com')
  const res = await request(app).get('/users/me').set('Authorization', `Bearer ${token}`).expect(200)

  for (const leaked of ['passwordHash', 'password_hash', 'mfaSecret', 'role', 'internalNotes']) {
    assert.ok(!(leaked in res.body), `${leaked} must not be serialized`)
  }
})

test('an admin can set role on the admin route', async () => {
  const token = await tokenFor('root@example.com')
  await request(app)
    .patch('/admin/users/1')
    .set('Authorization', `Bearer ${token}`)
    .send({ role: 'admin' })
    .expect(200)
})
```

The database assertion is the important one. A 400 alone does not prove the write did not happen — a handler that validates *after* updating returns 400 and still escalates.

Run with `node --test`.

## Security considerations

- **Mass assignment is an authorization bug wearing a validation costume.** The fix is naming which actor may write which field; validation is how you enforce it.
- **The response is the reconnaissance.** Returning the full row hands the attacker the field names. Serialize explicitly.
- **Creation is worse than update.** `POST /users` with `{"role":"admin"}` needs no existing account, and signup handlers are the ones most often written with a spread.
- **Nested objects hide it.** `{"profile":{"displayName":"Ann"},"account":{"plan":"enterprise"}}` — a strict schema must be strict at every level, and `z.strictObject` applies only to the level you put it on.
- **The `id` field counts.** `{"id":"other-user-id"}` on a create, or on an upsert, is object-level authorization bypass by another route. See [IDOR and broken object-level authorization](broken-object-level-authorization.md).
- **A field that is safe today may not be tomorrow.** An allow-list stays correct when a column is added; a deny-list does not.

## Common mistakes

- **`Object.assign(entity, req.body)` or `{ ...entity, ...req.body }`.** The canonical form of the bug.
- **A deny-list.** `delete req.body.role` misses the `isVerified` column added next quarter, and misses `role` spelled `Role` on a case-insensitive ORM.
- **Validating and then writing `req.body` anyway.** `schema.parse(req.body)` whose return value is discarded validates nothing useful — write `parsed.data`.
- **`z.object()` where `z.strictObject()` was meant.** Safe, because unknown keys are stripped, but silent — you never learn a client is sending `role`.
- **One schema shared by the user route and the admin route.** `role` is now writable by everyone.
- **Trusting the ORM.** Sequelize, Prisma and Mongoose all write a declared field when you pass it. Only `fields`, an explicit `data` object, or an allow-list stops that.
- **`res.json(user)` straight from the database.** Leaks whatever the next migration adds.
- **Forgetting `req.body` can be `undefined` in Express 5.** `pick(req.body, …)` throws on a bodyless request.
- **Testing only the HTTP status.** Assert the stored value; a late validation returns 400 after the write.
- **Allow-listing on `PATCH` but not on `POST`.** Registration is the highest-value target.

## Related topics

- [Validation](../express-libraries/validation.md) — Zod 4 and `express-validator` patterns in full.
- [IDOR and broken object-level authorization](broken-object-level-authorization.md) — the other half of API3:2023, including `userId` in the body.
- [NoSQL injection](nosql-injection.md) — what an unfiltered body does to a MongoDB query.
- [Layered architecture](../express/layered-architecture.md) — where DTO mapping belongs.
- [Sequelize](../orms/sequelize.md) — `fields`, and instance versus model updates.
- [Prisma](../orms/prisma.md) — `data` and `select` in the client API.
- [Mongoose](../orms/mongoose.md) — schema `strict` modes and `select: false`.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — API3:2023 in context.
