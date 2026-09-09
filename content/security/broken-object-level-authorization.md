---
title: IDOR and broken object-level authorization
description: Why GET /orders/1042 returns someone else's order, how to scope every query by its owner, and how to test that user B gets a 404.
status: current
updated: 2026-09-08
---

Broken object-level authorization — IDOR, in older writing — is the most exploited API vulnerability there is, and the cheapest to find. The attacker changes a number. It happens because authentication and authorization get conflated: the handler proves *who is calling* and then never asks *whether this caller may have this object*.

## The exploit

**The threat.** Every record of every user, readable and often writable, by anyone with an account.

**The vulnerable handler.** It has a guard. The guard is the wrong guard:

:::danger
```js vulnerable title="DO NOT COPY — src/routes/orders.js"
app.get('/orders/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id])
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
  res.json(rows[0])
})
```
:::

`requireAuth` establishes that `req.user` exists. Nothing after that mentions `req.user`.

**The exploit.** Log in as anybody. Read your own order to learn the id format:

```bash
$ curl -s -H "Authorization: Bearer $USER_B_TOKEN" https://api.example.com/orders/2087
{"id":2087,"user_id":77,"total_cents":1990,"status":"shipped","shipping_address":"…"}
```

Now decrement:

```bash
$ curl -s -H "Authorization: Bearer $USER_B_TOKEN" https://api.example.com/orders/1042
{"id":1042,"user_id":12,"total_cents":89900,"status":"paid",
 "shipping_address":"Ann Meier, Hauptstraße 14, 10827 Berlin",
 "email":"ann@example.com","last4":"4242"}
```

`user_id` is 12. The caller is 77. The response is `200`.

And then the loop, which is the part that turns a bug into a breach:

```bash
$ for id in $(seq 1 5000); do
    curl -s -H "Authorization: Bearer $USER_B_TOKEN" "https://api.example.com/orders/$id"
  done > everything.json
```

Sequential integer ids make this a five-minute job. No rate limit stops it if the limit is per minute and the attacker is patient.

## Fix: scope the query, do not check afterwards

There are two ways to write the fix, and only one of them is right.

:::warning
**Fetch-then-check** is the tempting version:

```js
const order = await orders.findById(req.params.id)
if (order.userId !== req.user.id) return res.status(403).json({ error: 'forbidden' })
```

It works until somebody adds an early `return` above it, or a second code path that loads the same object, or a logger that records the row before the check. It also leaks existence through the 403/404 distinction, and through response timing. Every check is a check somebody can forget.
:::

**Scope the query instead.** The ownership condition lives in the `WHERE` clause, so a row you are not allowed to see is a row that does not come back:

```js good title="src/routes/orders.js"
app.get('/orders/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, total_cents, status, created_at
       FROM orders
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id],
  )

  if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
  res.json(rows[0])
})
```

Not "fetch and compare" — "fetch what you are allowed to fetch". The difference matters because the failure mode is different: forget the scope and you get a query that returns nothing useful in testing, rather than a check that silently never runs.

**Verify it.** The same request, same token:

```bash
$ curl -s -i -H "Authorization: Bearer $USER_B_TOKEN" https://api.example.com/orders/1042
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8

{"error":"not_found"}
```

And the owner is unaffected:

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $USER_A_TOKEN" \
    https://api.example.com/orders/1042
200
```

The ORM forms:

```js good
// Prisma 7.10.0 — the ownership condition is part of the where, not a later if.
const order = await prisma.order.findFirst({
  where: { id, userId: req.user.id },
  select: { id: true, totalCents: true, status: true, createdAt: true },
})

// Sequelize 6.37.8
const order = await Order.findOne({ where: { id, userId: req.user.id } })

// Mongoose 9.9.5
const order = await Order.findOne({ _id: id, userId: req.user.id })
```

Note `findFirst` rather than `findUnique` in Prisma: `findUnique` only accepts unique fields in `where`, so it cannot carry the ownership condition, and that constraint is what pushes people back into fetch-then-check.

## 404, not 403

**The threat.** `403 Forbidden` on an object that exists and `404 Not Found` on one that does not is an existence oracle. An attacker who cannot read your orders can still enumerate which order ids are real, how many orders you process per day (id gaps over time), and whether a specific user id or invoice number exists.

```bash
# With 403/404 distinction, this maps your entire database
$ for id in $(seq 1 100000); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" ".../orders/$id")
    [ "$code" = "403" ] && echo "$id exists"
  done
```

**The fix.** Return `404` for both "does not exist" and "not yours". The scoped query does this naturally — there is only one branch to write.

```js good
if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
```

Two exceptions, both deliberate:

- **When the caller can legitimately know the object exists** — a shared document, a team resource they were removed from — `403` is more useful and leaks nothing new.
- **Your own admin tooling**, where distinguishing the two states is the point.

Keep the response *body* identical too. `{"error":"not_found"}` in both cases; not `{"error":"not_found","resource":"order"}` in one and something else in the other.

## A reusable check in the service layer

Routes multiply. HTTP is not the only caller — a queue worker, a GraphQL resolver, a CSV export job and an internal admin script all touch the same objects. Put the rule where all of them pass.

```js good title="src/services/orders.js"
import createError from 'http-errors'
import { pool } from '../db.js'

/**
 * Loads an order the actor is allowed to see, or throws 404.
 * Every caller — HTTP, worker, script — goes through this.
 */
export async function getOrderFor(actor, orderId) {
  const { rows } = await pool.query(
    `SELECT o.id, o.user_id, o.total_cents, o.status, o.created_at
       FROM orders o
      WHERE o.id = $1
        AND ($2::boolean OR o.user_id = $3)`,
    [orderId, actor.role === 'admin', actor.id],
  )

  if (rows.length === 0) throw createError(404, 'not_found')
  return rows[0]
}

export async function cancelOrderFor(actor, orderId) {
  const order = await getOrderFor(actor, orderId)          // authorization, once
  if (order.status !== 'paid') throw createError(409, 'order_not_cancellable')

  const { rows } = await pool.query(
    `UPDATE orders SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status = 'paid'
      RETURNING id, status`,
    [order.id],
  )
  return rows[0]
}
```

```js good title="src/routes/orders.js"
import express from 'express'
import { getOrderFor, cancelOrderFor } from '../services/orders.js'

const router = express.Router()

// Express 5 forwards a rejected promise to the error handler — no wrapper needed.
router.get('/:id', requireAuth, async (req, res) => {
  res.json(await getOrderFor(req.user, req.params.id))
})

router.post('/:id/cancel', requireAuth, async (req, res) => {
  res.json(await cancelOrderFor(req.user, req.params.id))
})

export default router
```

The route file now contains no authorization logic at all, which is the point: a new route cannot forget a check it does not perform.

`http-errors` 2.0.1 gives the thrown error a `status` and an `expose` flag your error handler can act on:

```js good title="src/middleware/errors.js"
export function errorHandler(err, req, res, next) {
  const status = err.status ?? 500
  if (status >= 500) req.log.error({ err }, 'unhandled error')
  res.status(status).json({ error: err.expose ? err.message : 'internal_error' })
}
```

## Write paths, and the `userId` in the body

**The threat.** Read-side IDOR gets found in reviews. The write side gets missed, and it is worse: the attacker does not read a record, they create or modify one attributed to someone else.

:::danger
```js vulnerable title="DO NOT COPY"
app.post('/orders', requireAuth, express.json(), async (req, res) => {
  const order = await orders.create(req.body)      // body carries userId
  res.status(201).json(order)
})

app.patch('/orders/:id', requireAuth, express.json(), async (req, res) => {
  const order = await orders.update(req.params.id, req.body)
  res.json(order)
})
```
:::

**The exploit.** Two variants, both one field:

```bash
# 1. Create an order on someone else's account — their card, your address.
$ curl -s -X POST https://api.example.com/orders \
    -H "Authorization: Bearer $USER_B_TOKEN" -H 'content-type: application/json' \
    -d '{"userId":12,"items":[{"sku":"GPU-4090","qty":1}],"shippingAddress":"…attacker…"}'
{"id":9001,"user_id":12,"status":"pending"}

# 2. Move an existing object into your own account.
$ curl -s -X PATCH https://api.example.com/orders/1042 \
    -H "Authorization: Bearer $USER_B_TOKEN" -H 'content-type: application/json' \
    -d '{"userId":77}'
{"id":1042,"user_id":77,...}
```

**The fix.** The owner comes from the authenticated principal. It is never read from the body, and it is never updatable:

```js good title="src/services/orders.js"
import { z } from 'zod'

// userId is deliberately absent. z.strictObject rejects it if a client sends it.
export const CreateOrder = z.strictObject({
  items: z.array(z.strictObject({ sku: z.string().max(32), qty: z.int().min(1).max(20) }))
    .min(1).max(50),
  shippingAddressId: z.uuid(),
})

export async function createOrderFor(actor, input) {
  const { rows } = await pool.query(
    `INSERT INTO orders (user_id, shipping_address_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING id, user_id, status`,
    [actor.id, input.shippingAddressId],        // actor.id, never input.userId
  )
  return rows[0]
}
```

And the update carries the ownership condition into the `WHERE`, so a row you do not own is a row you do not update:

```js good
const { rowCount } = await pool.query(
  `UPDATE orders SET shipping_address_id = $3, updated_at = now()
    WHERE id = $1 AND user_id = $2`,
  [orderId, actor.id, input.shippingAddressId],
)
if (rowCount === 0) throw createError(404, 'not_found')
```

`rowCount === 0` covers both "no such order" and "not yours" with one branch and one status code.

Note that `shippingAddressId` is itself an object reference — see the next section.

## Nested resources and referenced ids

**The threat.** The parent is scoped correctly and the child is not, or a foreign key in the body points at someone else's object.

:::danger
```js vulnerable title="DO NOT COPY"
// The order is checked. The invoice is fetched by id alone.
app.get('/orders/:orderId/invoices/:invoiceId', requireAuth, async (req, res) => {
  const order = await getOrderFor(req.user, req.params.orderId)   // correct
  const invoice = await invoices.findById(req.params.invoiceId)   // wrong
  res.json(invoice)
})
```
:::

```bash
$ curl -s -H "Authorization: Bearer $T" https://api.example.com/orders/2087/invoices/1042
{"id":1042,"order_id":1042,"pdf_url":"…","billing_name":"Ann Meier",...}
```

The invoice belongs to order 1042, not to order 2087. Nothing checked the relationship.

**The fix.** Scope the child by the parent *and* the parent by the owner, in one query:

```js good
const { rows } = await pool.query(
  `SELECT i.id, i.pdf_url, i.issued_at
     FROM invoices i
     JOIN orders o ON o.id = i.order_id
    WHERE i.id = $1 AND o.id = $2 AND o.user_id = $3`,
  [req.params.invoiceId, req.params.orderId, req.user.id],
)
if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
```

The same rule applies to **every id in a request body**. `shippingAddressId`, `projectId`, `teamId`, `paymentMethodId` — each is an object reference the client chose, and each needs the same ownership condition:

```js good title="src/services/orders.js"
// Resolve the referenced address WITHIN the actor's scope. If it is not theirs,
// there is no such address as far as this request is concerned.
const { rows: addresses } = await pool.query(
  'SELECT id FROM addresses WHERE id = $1 AND user_id = $2',
  [input.shippingAddressId, actor.id],
)
if (addresses.length === 0) throw createError(400, 'invalid_shipping_address')
```

A useful review heuristic: **every id that came from the client needs a scope**. Path parameters, body fields, query filters. If you can grep the handler for `req.params` and `req.body` and find an id that never appears next to `req.user.id`, that is the bug.

## Unguessable ids are a mitigation, not a control

Switching from sequential integers to UUIDv4 removes *enumeration*. It does not remove the vulnerability.

`crypto.randomUUID()` gives 122 bits of randomness, so a `seq 1 5000` sweep stops working. That is real value: it turns a five-minute mass extraction into an attack that needs the ids from somewhere else. But ids leak constantly:

- shared links, screenshots, support tickets, `Referer` headers,
- a list endpoint that returns ids the caller should not see,
- a webhook or export that includes ids from other tenants,
- browser history and analytics payloads.

An attacker who has one id can read one object, and that object often contains more ids.

```js good
// Public identifiers: random, not sequential.
const id = crypto.randomUUID()
```

:::warning
Do not use `uuid` v1 or any time-ordered identifier as an unguessable id. UUIDv7 and ULID are *sortable by design* — that is why they exist — which means neighbouring ids are guessable from one sample. Use v7 for a primary key if you want index locality, and expose a separate random public id, or use `crypto.randomUUID()` (v4) for anything a client sees.
:::

Random ids buy you time. The `WHERE user_id = $2` is the control.

## Broken function-level authorization

**The threat.** The sibling bug, OWASP API5:2023: the *operation* is privileged, not the object. An admin route that checks only that you are logged in.

:::danger
```js vulnerable title="DO NOT COPY"
app.use('/admin', requireAuth, adminRouter)   // authenticated, not authorized
```
:::

**The exploit.** Nothing links to `/admin` from the user interface. It is in the JavaScript bundle, in your OpenAPI document, or found by trying it:

```bash
$ curl -s -H "Authorization: Bearer $ANY_USER_TOKEN" https://api.example.com/admin/users
[{"id":1,"email":"ann@example.com","role":"admin"},{"id":2,...}]

$ curl -s -o /dev/null -w '%{http_code}\n' -X DELETE \
    -H "Authorization: Bearer $ANY_USER_TOKEN" https://api.example.com/admin/users/7
204
```

**The fix.** A separate middleware, applied at the mount point so it cannot be omitted from a route added later:

```js good title="src/middleware/require-role.js"
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' })
  // 404, not 403: do not confirm that /admin exists to a non-admin.
  if (!roles.includes(req.user.role)) return res.status(404).json({ error: 'not_found' })
  next()
}
```

```js good title="src/app.js"
app.use('/admin', requireAuth, requireRole('admin'), adminRouter)
```

Two rules that keep this from regressing:

- **Deny by default.** Do not enumerate the privileged routes; enumerate the *public* ones. A route added tomorrow should be inaccessible until someone grants access to it.
- **Do not decide from the HTTP method.** "GET is safe, POST needs admin" fails the first time a GET endpoint exports data. Authorize the operation, not the verb.

```js good title="src/app.js"
const PUBLIC = new Set(['/health', '/login', '/password-reset/request'])

// Anything not explicitly public requires an authenticated principal.
app.use((req, res, next) => {
  if (PUBLIC.has(req.path)) return next()
  return requireAuth(req, res, next)
})
```

## Testing it

The test that matters asserts the *negative* case with a second user. Write it once per resource; it is the regression net for this whole page.

```js title="test/orders-authorization.test.js"
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app.js'
import { seedUser, seedOrder } from './helpers.js'

let userA, userB, orderOfA

before(async () => {
  userA = await seedUser({ email: 'ann@example.com', role: 'user' })
  userB = await seedUser({ email: 'bob@example.com', role: 'user' })
  orderOfA = await seedOrder({ userId: userA.id, totalCents: 89900 })
})

test('the owner can read their own order', async () => {
  await request(app)
    .get(`/orders/${orderOfA.id}`)
    .set('Authorization', `Bearer ${userA.token}`)
    .expect(200)
})

test("user B gets 404 for user A's order", async () => {
  const res = await request(app)
    .get(`/orders/${orderOfA.id}`)
    .set('Authorization', `Bearer ${userB.token}`)

  assert.equal(res.status, 404, 'must not be 200, and must not be 403')
  assert.deepEqual(res.body, { error: 'not_found' })
})

test("user B cannot cancel user A's order", async () => {
  await request(app)
    .post(`/orders/${orderOfA.id}/cancel`)
    .set('Authorization', `Bearer ${userB.token}`)
    .expect(404)

  const still = await request(app)
    .get(`/orders/${orderOfA.id}`)
    .set('Authorization', `Bearer ${userA.token}`)
    .expect(200)

  assert.equal(still.body.status, 'paid', 'the order must be unchanged')
})

test('user B cannot create an order attributed to user A', async () => {
  const res = await request(app)
    .post('/orders')
    .set('Authorization', `Bearer ${userB.token}`)
    .send({ userId: userA.id, items: [{ sku: 'GPU-4090', qty: 1 }], shippingAddressId: userB.addressId })

  // Either 400 from the strict schema, or 201 with the order owned by B — never A.
  if (res.status === 201) assert.equal(res.body.user_id, userB.id)
  else assert.equal(res.status, 400)
})

test('a non-admin cannot reach the admin router', async () => {
  await request(app)
    .get('/admin/users')
    .set('Authorization', `Bearer ${userB.token}`)
    .expect(404)
})
```

Run with `node --test`. Make "user B gets 404" a required test for every resource — a checklist item in your pull-request template costs nothing and catches the whole class.

## Security considerations

- **Authentication is not authorization.** `requireAuth` answers "who"; nothing more.
- **Every client-supplied id needs a scope** — path, body and query alike.
- **Prefer scoping over checking.** A missing `AND user_id = $2` fails visibly in tests; a missing `if` does not.
- **Keep the 404 uniform.** Same status, same body, comparable timing.
- **Object-level and function-level authorization are separate.** Passing one says nothing about the other.
- **Random ids raise the cost of enumeration and nothing else.** Do not let them become the reason a scope was skipped.
- **List endpoints are the same bug at scale.** `GET /orders` without `WHERE user_id = $1` returns everything, and it is a single missing clause.

## Production considerations

- **Log the actor and the object on every authorization failure** — `{ actorId, resource: 'order', resourceId, outcome: 'denied' }`. A burst of denials from one principal is enumeration in progress.
- **Alert on the ratio, not the count.** One 404 is a typo. Two hundred 404s from one token in a minute is a sweep.
- **Consider database-enforced scoping for multi-tenant systems.** PostgreSQL row-level security makes the tenant condition impossible to omit, at the cost of a per-connection session variable and more complex debugging.
- **Audit the read side too.** An access log that records only writes cannot tell you what was extracted during an incident.
- **Review new routes for the scope specifically.** It is the single check most often missing, and it is fast to look for: find the ids, find `req.user.id` next to them.

## Common mistakes

- **`requireAuth` and nothing else.** The whole vulnerability in one line.
- **Fetch-then-check.** One forgotten `if` away from the bug, and it leaks existence.
- **`403` for "not yours".** A working existence oracle.
- **Different bodies or different timings for the two 404s.** Same oracle, more subtle.
- **Reading the owner from `req.body.userId`.** The client picks the victim.
- **Allowing `userId` to be updated at all.** Objects do not change owner via `PATCH`.
- **Scoping the parent but not the child.** `/orders/:orderId/invoices/:invoiceId` with an unjoined invoice lookup.
- **Ignoring foreign keys in the body.** `shippingAddressId`, `teamId`, `paymentMethodId` are all object references.
- **Believing UUIDs fixed it.** They stopped enumeration. The record is still readable by anyone who learns the id.
- **Using a sortable id (v7/ULID) as the unguessable one.** Sortable means guessable from a neighbour.
- **`findUnique` in Prisma where the ownership condition belongs.** It cannot take a non-unique field — use `findFirst`.
- **An admin router guarded only by authentication.** API5:2023, one `requireRole` away.
- **Testing only the happy path.** The test that catches this is the one where user B asks for user A's object.

## Related topics

- [Mass assignment](mass-assignment.md) — the other half of API3:2023, including `userId` in the body.
- [Authentication and session security](authentication-and-session-security.md) — how `req.user` gets populated in the first place.
- [JWT pitfalls](jwt-pitfalls.md) — why a `role` claim is not an authorization decision.
- [Rate limiting and abuse](rate-limiting-and-abuse.md) — slowing the enumeration sweep that follows.
- [Layered architecture](../express/layered-architecture.md) — where the authorization helper belongs.
- [Error handling](../express/error-handling.md) — turning a thrown `http-errors` 404 into a response.
- [Testing](../express-libraries/testing.md) — `node:test` and `supertest` setup.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — API1:2023 and API5:2023.
