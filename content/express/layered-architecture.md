---
title: Layered architecture
description: Routes, controllers, services and repositories in an Express 5 app — what belongs in each layer, which direction dependencies point, and where validation and transactions live.
status: current
updated: 2026-09-08
---

A layered Express app splits each request into four jobs: decide which code runs (routes), translate HTTP to and from plain values (controllers), apply the business rules (services), and talk to the database (repositories). The value is not the folder names — it is the rule that dependencies only ever point downward, which is what keeps the business rules testable and the framework replaceable.

## Why it exists

The alternative is the "fat handler": a route callback that reads `req.body`, validates it, runs three queries, decides a business rule, and calls `res.json()`. It works until you need the same rule somewhere else — a background job, a CLI command, a second endpoint — and discover the rule cannot run without an HTTP request to carry it.

Layers give each concern one home:

- A rule can be tested with plain values and no server.
- A query can change without touching a status code.
- A response shape can change without touching a rule.
- New endpoints reuse the rules instead of copying them.

## When not to use it

A four-file structure for a three-endpoint webhook receiver is overhead. Start with routes plus controllers; add a service the first time a rule has two callers or a controller exceeds a screen; add a repository when queries start appearing in more than one service. Introduce a layer when the pain arrives, not before — but do it before the codebase has memorized the shortcut.

## Basic example

Full runnable version: [`examples/layered-api`](../../examples/layered-api/README.md).

```js title="src/features/orders/orders.routes.js"
import express from 'express'
import * as controller from './orders.controller.js'

const router = express.Router()

router.post('/', controller.create)
router.get('/:id', controller.getById)

export default router
```

```js title="src/features/orders/orders.controller.js"
import { z } from 'zod'
import * as orders from './orders.service.js'

const createOrderSchema = z.object({
  customerId: z.uuid(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
})

// No try/catch: Express 5 forwards a rejected promise to the error handler.
export async function create(req, res) {
  const input = createOrderSchema.parse(req.body)
  const order = await orders.placeOrder(input)
  res.status(201).json(toResponse(order))
}

export async function getById(req, res) {
  const order = await orders.getOrder(req.params.id)
  res.json(toResponse(order))
}

function toResponse(order) {
  return { id: order.id, total: order.total_cents / 100, status: order.status }
}
```

```js title="src/features/orders/orders.service.js"
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import * as repo from './orders.repository.js'
import * as inventory from '../inventory/inventory.repository.js'
import { withTransaction } from '../../lib/db.js'

export async function placeOrder({ customerId, items }) {
  return withTransaction(async (tx) => {
    for (const item of items) {
      const stock = await inventory.reserve(tx, item.sku, item.quantity)
      if (!stock) throw new ConflictError(`insufficient stock for ${item.sku}`)
    }
    return repo.insertOrder(tx, { customerId, items })
  })
}

export async function getOrder(id) {
  const order = await repo.findById(id)
  if (!order) throw new NotFoundError('order not found')
  return order
}
```

```js title="src/features/orders/orders.repository.js"
import { pool } from '../../lib/db.js'

export async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function insertOrder(tx, { customerId, items }) {
  const { rows } = await tx.query(
    'INSERT INTO orders (customer_id, total_cents, status) VALUES ($1, $2, $3) RETURNING *',
    [customerId, totalOf(items), 'pending'],
  )
  return rows[0]
}
```

## How it works

### What each layer owns

| Layer | Owns | Must never contain |
| --- | --- | --- |
| **Routes** | paths, HTTP methods, which middleware runs | business rules, queries |
| **Controllers** | parsing and validating input, calling one service, choosing the status code and response shape | business rules, SQL, ORM calls |
| **Services** | business rules, orchestration, transaction boundaries, domain errors | `req`, `res`, `next`, status codes, SQL strings |
| **Repositories** | queries, mapping rows to objects, database-specific concerns | business rules, HTTP concepts |

Two of those prohibitions do the heavy lifting.

**No `req` or `res` below the controller.** The moment a service takes `req`, it can only be called from an HTTP request. Your background worker, your migration script and your unit test all need to fabricate a fake request object, and the service quietly grows dependencies on middleware that happened to run first. Pass plain values in; return plain values out.

```js
// Wrong: the rule is now HTTP-only.
export async function placeOrder(req) {
  const { items } = req.body
  // …
}

// Right: callable from anywhere.
export async function placeOrder({ customerId, items }) {
  // …
}
```

**No SQL or ORM calls in a controller.** A query in a controller cannot be reused, cannot participate in a transaction owned by a service, and drags the database schema into the layer that formats JSON. When you later swap `pg` for an ORM, or add caching, you want one file to change.

### Dependency direction

Routes depend on controllers, controllers on services, services on repositories. Nothing points back up.

```text
HTTP  ->  routes  ->  controllers  ->  services  ->  repositories  ->  database
                          |               |
                     validation      business rules,
                     status codes    transactions
```

A repository that imports a service, or a service that imports a controller, is a cycle. It usually means a rule ended up in the wrong layer — move the rule, do not add the import.

Errors travel the other way, as data. A service throws a domain error (`NotFoundError`, `ConflictError`); the controller does nothing; the [error handler](error-handling.md) maps it to a status. That is how services stay free of HTTP without losing the ability to say what went wrong.

### Where validation belongs

Two different checks, two different layers:

- **Shape validation** — is `quantity` an integer, is `customerId` a UUID, is `items` non-empty — belongs at the edge, in the controller or in validation middleware. It is about the HTTP payload, and its failure is always a 400.
- **Rule validation** — is this customer allowed to order, is there stock, is the account past due — belongs in the service. It needs data the request does not carry, and its failure may be a 403, a 409 or a 422.

Getting this backwards produces either services that trust garbage, or controllers that need database access to validate.

```js
// Controller: shape only.
const input = createOrderSchema.parse(req.body)   // ZodError -> 400

// Service: rules.
if (customer.status === 'suspended') throw new ForbiddenError('account suspended')
```

Validating at the edge also closes mass assignment: parse into a schema that lists the fields you accept, and pass the *parsed* object down. Never hand `req.body` itself to a repository — see [Mass assignment](../security/mass-assignment.md).

### Where transactions belong

In the **service**, because only the service knows what "one unit of work" means. Reserving stock and inserting an order must commit or fail together; neither repository can decide that alone.

The mechanism: the service opens the transaction and passes the handle down to each repository call.

```js title="src/lib/db.js"
import pg from 'pg'

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

Repositories therefore take an optional executor as their first argument — the pool for a standalone read, the transaction client when they are part of a unit of work. A repository that always reaches for the global pool cannot be enlisted in a transaction, which is the most common reason "we have transactions" turns out to be false in production.

Never start a transaction in a controller: the boundary then depends on the endpoint rather than on the rule, and two endpoints doing the same thing get different atomicity.

### Testing seams

Each boundary is a place to substitute a fake, which is what makes the structure pay for itself:

| Test | Substitute | Tool |
| --- | --- | --- |
| Service unit test | a fake repository object | plain functions, no database |
| Repository test | a real database | SQLite or a throwaway container |
| Route/controller test | a real app, fake service | `supertest` against the exported app |
| End-to-end | nothing | `supertest` plus a real database |

That is the second reason to export a factory rather than a singleton app — `createApp({ orderService })` lets a route test assert on status codes and JSON shape without touching a database.

To get that seam, export the service as a factory over its repositories rather than importing them at module scope:

```js title="src/features/orders/orders.service.js — injectable form"
export function createOrderService({ orders, inventory, withTransaction }) {
  return {
    async placeOrder({ customerId, items }) {
      return withTransaction(async (tx) => {
        for (const item of items) {
          const stock = await inventory.reserve(tx, item.sku, item.quantity)
          if (!stock) throw new ConflictError(`insufficient stock for ${item.sku}`)
        }
        return orders.insertOrder(tx, { customerId, items })
      })
    },
  }
}
```

```js title="test/orders.service.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrderService } from '../src/features/orders/orders.service.js'

test('rejects an order with insufficient stock', async () => {
  const service = createOrderService({
    orders: { insertOrder: async () => ({ id: 'o1' }) },
    inventory: { reserve: async () => null },
    withTransaction: (fn) => fn(null),
  })

  await assert.rejects(
    () => service.placeOrder({ customerId: 'c1', items: [{ sku: 'x', quantity: 1 }] }),
    { name: 'ConflictError' },
  )
})
```

No database, no server, no mocking library — the rule is just a function over its collaborators.

## Common patterns

**Group by feature, not by layer, once the app is real.** `src/features/orders/{routes,controller,service,repository}.js` keeps everything one change touches in one directory. Grouping by layer means a single feature change edits four folders and every folder eventually holds forty files.

**Return domain objects, not database rows, from services.** A `snake_case` row leaking to the controller means the database column names become your public API, and renaming a column becomes a breaking change.

**Keep the controller thin enough to read in one glance.** Validate, call one service function, choose a status, shape the response. If a controller calls three services and decides between them, that decision is a business rule in the wrong place.

**Inject dependencies instead of importing singletons** where you want a testing seam. A module-level `import { pool }` is fine for a repository; a service that reaches for a global clock, a global logger and a global queue is not testable without module mocking.

**One service function per use case**, named after the use case (`placeOrder`, `cancelOrder`) rather than after the data (`updateOrder`). Use-case names survive schema changes.

## Common mistakes

- **Passing `req` into a service.** The rule becomes HTTP-only and untestable. Pass values.
- **Querying from a controller.** The query cannot be reused or enlisted in a transaction, and the schema leaks upward.
- **Starting transactions in the controller.** The unit of work should be defined by the rule, not by the endpoint.
- **A repository that ignores the transaction handle** and always uses the global pool — the code looks transactional and is not.
- **Doing rule validation with a schema** (or shape validation in the service). Different failures, different layers, different status codes.
- **Passing `req.body` straight through** to a repository or ORM `update`. That is mass assignment; pass the parsed object.
- **Anemic layers.** A controller that only calls a service that only calls a repository, with no rules anywhere, is four files of ceremony — collapse it until there is a rule to hold.
- **Cyclic imports** between a service and a repository. Something is in the wrong layer.
- **Returning raw rows from services**, making column names part of your API.
- **Building layers before the second caller exists.** Start small, split on the second use.

## Related topics

- [Setup and project structure](setup-and-project-structure.md) — the directory tree these layers live in.
- [Routers and modularity](routers-and-modularity.md) — the routes layer, in detail.
- [Error handling](error-handling.md) — how a domain error from a service becomes an HTTP status.
- [Middleware](middleware.md) — the cross-cutting work that sits above the controller.
- [Validation](../express-libraries/validation.md) — schemas at the edge.
- [Testing](../express-libraries/testing.md) — exercising each seam above.
- [Transactions](../databases/transactions.md) — the database side of `withTransaction`.
- [Connection pooling](../databases/connection-pooling.md) — why the executor is passed rather than created.
- [When to use an ORM](../orms/when-to-use-an-orm.md) — what changes in the repository layer if you adopt one.
- [Mass assignment](../security/mass-assignment.md) — the vulnerability the parsed-object rule prevents.
