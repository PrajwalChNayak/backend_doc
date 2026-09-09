---
title: Knex
description: Knex 3.3.0 — a SQL query builder with a migration CLI, and the difference between ? value bindings and ?? identifier bindings in knex.raw.
status: current
updated: 2026-09-08
---

Knex is a query builder, not an ORM. There are no models, no entities, no schema definition and no hydration — you build SQL with method chains, it returns rows as plain objects, and it ships a migration and seed CLI that many other tools are built on. It is the least magical option on this page, and for some teams that is the entire appeal.

This page documents **`knex` 3.3.0**.

## Why it exists

Two reasons.

**Dialect portability.** `knex('users').where({ id }).limit(1)` emits correct SQL for PostgreSQL, MySQL, SQLite, SQL Server, Oracle and CockroachDB, including the identifier quoting and `LIMIT`/`TOP` differences. Writing that by hand across dialects is tedious and easy to get subtly wrong.

**Composition.** SQL strings do not compose; query builders do. Adding a filter conditionally is an `if` statement instead of a string-splicing exercise, and every value you add arrives as a bind parameter automatically.

The migration CLI is the other half of the value. It is simple, it works, and it has no opinions about your data model.

## When to use it

- **You want SQL, with parameterization handled.** Knex's whole proposition.
- **Dynamic query shapes.** Search endpoints with a dozen optional filters. Composing a builder beats composing a string.
- **You already use an ORM and need a second tool for reports.** Knex sits alongside anything; it just needs a connection.
- **You want a migration runner without adopting a data model.** Knex migrations work fine on a database whose queries you write by hand.
- **Legacy schemas.** Nothing to map, no entities to define, no introspection step.

## When not to use it

- **You want type safety from your schema.** Knex has no schema definition, so it cannot infer anything. You hand-write interfaces and nothing checks them against the database. This is the single biggest reason to pick [Drizzle](./drizzle.md) instead.
- **You want relations and eager loading.** There are none. A join returns flat rows, and assembling a nested object graph is your code.
- **You want generated migrations.** Every migration is hand-written.
- **You want an active, fast-moving project.** Knex is stable and maintained, but development is slow. Its `engines` field still says `>=16`.

:::note
[Objection.js](https://vincit.github.io/objection.js/) (3.1.5) is an ORM built on top of Knex, adding models, relations and eager loading while keeping the Knex query builder underneath. It is a reasonable answer to "I like Knex but I want relations". Activity is low; evaluate that before adopting it for a new project. [Kysely](https://kysely.dev/) (0.29.5) is the other direction — a Knex-shaped builder with real TypeScript inference.
:::

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install knex@3.3.0 pg
```
@tab pnpm
```bash
pnpm add knex@3.3.0 pg
```
@tab yarn
```bash
yarn add knex@3.3.0 pg
```
:::

The driver is yours: `pg`, `mysql2`, `better-sqlite3`, `tedious` or `oracledb`.

Knex declares `engines.node: >=16`. That is a compatibility floor left over from an older release, not a recommendation — target Node 24 LTS.

### Connect

```js title="src/db.js"
import knexFactory from 'knex'

export const db = knexFactory({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 10, acquireTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 },
  acquireConnectionTimeout: 10_000,
  migrations: { directory: './src/db/migrations', tableName: 'knex_migrations' },
  seeds: { directory: './src/db/seeds' },
})
```

Knex pools with [tarn](https://github.com/vincit/tarn.js). Defaults are `min: 2, max: 10` for PostgreSQL and MySQL.

### Migrations define the schema

There is no schema file. The migrations *are* the schema.

```bash
npx knex migrate:make create_users
npx knex migrate:latest
npx knex migrate:status
npx knex migrate:rollback
```

```js title="src/db/migrations/20260908120000_create_users.js"
export async function up(knex) {
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary()
    table.string('email', 255).notNullable().unique()
    table.text('name').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('posts', (table) => {
    table.increments('id').primary()
    table.text('title').notNullable()
    table.boolean('published').notNullable().defaultTo(false)
    table.integer('author_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE')
    table.index(['author_id', 'published'], 'posts_author_published_idx')
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('posts')
  await knex.schema.dropTableIfExists('users')
}
```

Knex wraps each migration in a transaction where the dialect supports transactional DDL — PostgreSQL does, MySQL largely does not. It also takes a lock in a `knex_migrations_lock` table, so concurrent runners serialize rather than collide.

### CRUD

```js title="src/routes/users.js"
import express from 'express'
import { db } from '../db.js'

const router = express.Router()

router.post('/users', async (req, res) => {
  const [user] = await db('users')
    .insert({ email: req.body.email, name: req.body.name })
    .returning(['id', 'email', 'name'])
  res.status(201).json(user)
})

router.get('/users/:id', async (req, res) => {
  const user = await db('users')
    .select('id', 'email', 'name', 'created_at')
    .where({ id: Number(req.params.id) })
    .first()
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.patch('/users/:id', async (req, res) => {
  const [user] = await db('users')
    .where({ id: Number(req.params.id) })
    .update({ name: req.body.name })
    .returning(['id', 'name'])
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.delete('/users/:id', async (req, res) => {
  await db('users').where({ id: Number(req.params.id) }).del()
  res.status(204).end()
})

export default router
```

`returning()` works on PostgreSQL, SQL Server and modern SQLite. MySQL does not support it — you insert, then select.

Full runnable version: [`examples/orm-knex`](../../examples/orm-knex/README.md).

## How it works

### Relations are joins, and you assemble the graph

There is no `include`. You write the join and shape the rows:

```js title="src/repos/posts.js"
export async function listPostsWithAuthors(limit = 20) {
  const rows = await db('posts as p')
    .join('users as u', 'u.id', 'p.author_id')
    .select('p.id', 'p.title', 'u.id as author_id', 'u.email as author_email')
    .where('p.published', true)
    .orderBy('p.created_at', 'desc')
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    author: { id: r.author_id, email: r.author_email },
  }))
}
```

For one-to-many, a join duplicates the parent across children. The two options are the same ones a hand-written SQL codebase has: aggregate in the database (`json_agg` on PostgreSQL), or run a second query with a `whereIn` and group in JavaScript.

```js title="src/repos/users.js"
// Two queries, no duplication, no N+1
const users = await db('users').select('id', 'email').limit(20)
const posts = await db('posts')
  .select('id', 'title', 'author_id')
  .whereIn('author_id', users.map((u) => u.id))

const byAuthor = Map.groupBy(posts, (p) => p.author_id)
const result = users.map((u) => ({ ...u, posts: byAuthor.get(u.id) ?? [] }))
```

Two queries regardless of row count. Writing this by hand is the tax Knex charges for having no ORM layer.

### Transactions

```js title="src/services/transfer.js"
import { db } from '../db.js'

export async function transfer(fromId, toId, cents) {
  return db.transaction(async (trx) => {
    const [from] = await trx('accounts')
      .where({ id: fromId })
      .decrement('balance', cents)
      .returning('balance')

    if (from.balance < 0) throw new Error('insufficient funds')

    await trx('accounts').where({ id: toId }).increment('balance', cents)
  })
}
```

The callback form commits on resolve and rolls back on throw. Use `trx` for every query inside — `db` takes a different connection from the pool and is not in the transaction.

`decrement`/`increment` push the arithmetic into SQL, which is what makes concurrent transfers safe. For a check-then-act you need a row lock:

```js
const row = await trx('accounts').where({ id: fromId }).forUpdate().first()
```

Knex also supports `trx.isolationLevel` via `db.transaction(fn, { isolationLevel: 'serializable' })`.

### TypeScript story

This is Knex's weak point and it is worth being blunt about it: **Knex cannot know your schema.** There is no schema file to infer from, so the types you get are the types you write, and nothing verifies them against the database.

Declaration merging into `knex/types/tables` is the supported mechanism:

```ts title="src/types/knex.d.ts"
declare module 'knex/types/tables' {
  interface User {
    id: number
    email: string
    name: string | null
    created_at: Date
  }

  interface Tables {
    users: User
    users_composite: Knex.CompositeTableType<
      User,
      Pick<User, 'email' | 'name'>,          // insert shape
      Partial<Pick<User, 'name'>>            // update shape
    >
  }
}
```

With that in place, `db('users').where({ id: 1 })` type-checks the column names and `select('id', 'email')` narrows the result.

The catch is the one that matters: this interface is hand-maintained. Add a column in a migration, forget to update the interface, and TypeScript will confidently tell you the column does not exist — or worse, that a dropped column still does. There is no generation step to keep them in sync.

If schema-derived types matter to you, that is the argument for [Drizzle](./drizzle.md) or Kysely over Knex.

### Connection pooling

```js title="src/db.js"
export const db = knexFactory({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: {
    min: 0,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    acquireTimeoutMillis: 5_000,        // wait for a free connection
    createTimeoutMillis: 5_000,         // wait for a new connection to open
    idleTimeoutMillis: 30_000,
    reapIntervalMillis: 1_000,
    propagateCreateError: false,        // queue rather than fail the first waiter
  },
  acquireConnectionTimeout: 10_000,     // knex-level timeout on getting a connection
})
```

Two different timeouts, and confusing them is a common source of "my requests hang":

- `pool.acquireTimeoutMillis` is tarn's timeout for handing out a pooled connection.
- `acquireConnectionTimeout` is Knex's own timeout on a *query* waiting for a connection. It defaults to 60000ms, which is far too long for an HTTP request path.

Set both. `min: 0` lets the pool shrink when idle, which matters if you have many replicas sharing one database.

## Common patterns

### Conditional filters

```js title="src/repos/posts.js"
export function searchPosts({ published, authorId, since }) {
  const q = db('posts').select('id', 'title', 'created_at')

  if (published !== undefined) q.where('published', published)
  if (authorId) q.where('author_id', authorId)
  if (since) q.where('created_at', '>=', since)

  return q.orderBy('created_at', 'desc').limit(50)
}
```

Every `.where()` value becomes a bind parameter. Composing filters this way is safe by construction — there is no string to inject into.

### Reusable query fragments

```js
const activeUsers = () => db('users').whereNull('deleted_at')

const count = await activeUsers().count({ n: '*' }).first()
const page = await activeUsers().select('id', 'email').limit(20)
```

Note that a Knex builder is a thenable and executes when awaited, so a shared builder object cannot be reused after execution. Return a fresh builder from a function, as above.

### Seeds

```bash
npx knex seed:make 001_users
npx knex seed:run
```

Seeds are unordered by default — prefix filenames numerically, or use `knex.seed.run({ specific: '001_users.js' })`. See [Seeding](../databases/seeding.md).

## Security considerations

### Everything the builder touches is a bind parameter

```js good title="src/repos/users.js"
// Values in the builder are always parameterized
await db('users').where({ email: req.body.email }).first()
// SELECT * FROM "users" WHERE "email" = ? LIMIT ?   -- ['x@example.com', 1]
```

There is no way to inject through `.where()`, `.insert()`, `.update()` or `whereIn()`. The values never enter the SQL text.

### knex.raw: ? for values, ?? for identifiers

`knex.raw` has two placeholder types, and knowing which is which is the whole safety story.

| Placeholder | Binds | Rendered as |
| --- | --- | --- |
| `?` | A **value** | A driver bind parameter |
| `??` | An **identifier** | A quoted table/column name |
| `:name` | A value | A driver bind parameter |
| `:name:` | An identifier | A quoted name (note the trailing colon) |

```js good title="src/repos/search.js"
import { db } from '../db.js'

// Positional value binding
const { rows } = await db.raw('SELECT id, email FROM users WHERE email = ?', [req.body.email])

// Identifier + value together
const result = await db('users').where(db.raw('?? = ?', ['users.email', req.body.email]))

// Named form
const named = await db.raw(':col: = :value', { col: 'users.email', value: req.body.email })
```

Named bindings resolve every value except `undefined`; an unresolved placeholder throws rather than silently producing broken SQL.

For an `IN` list with named bindings, nest a `knex.raw` that generates one placeholder per element — do not join the values into a string:

```js good
const names = ['Sally', 'Jay', 'Foobar']
await db.raw('SELECT * FROM users WHERE name IN (:names)', {
  names: db.raw(names.map(() => '?').join(', '), names),
})
```

### Interpolation into raw is the hole

```js vulnerable title="DO NOT COPY"
// curl "localhost:3000/users?email=x'%20OR%20'1'%3D'1"
const { rows } = await db.raw(
  `SELECT id, email, password_hash FROM users WHERE email = '${req.query.email}'`,
)
```

The bindings array is not magic protection — it only fills the placeholders. If the value is already inside the template literal, the injection happened before Knex saw the query.

```js good title="src/repos/search.js"
const { rows } = await db.raw('SELECT id, email FROM users WHERE email = ?', [req.query.email])
```

:::danger
`db.raw` with **no bindings argument** is just a SQL string. Any template interpolation in it is a concatenation. Every dynamic piece must be a `?`, `??`, `:name` or `:name:` placeholder.
:::

### Identifiers, ORDER BY, and knex.ref

Bind parameters are value slots, so an `ORDER BY` column cannot be one. Knex gives you `??` and `knex.ref()` for identifiers — both **quote** the name so it cannot break out of the identifier position, but neither restricts *which* identifier, so an allow-list still does the real work:

```js good title="src/repos/posts.js"
import { db } from '../db.js'

const SORT_COLUMNS = new Map([
  ['created_at', 'posts.created_at'],
  ['title', 'posts.title'],
])
const DIRECTIONS = new Map([['asc', 'asc'], ['desc', 'desc']])

export async function listPosts({ sort = 'created_at', dir = 'desc', limit = 50 }) {
  const column = SORT_COLUMNS.get(sort)
  const direction = DIRECTIONS.get(dir)
  if (!column || !direction) throw new Error('invalid sort')

  return db('posts')
    .select('id', 'title')
    .orderBy(column, direction)
    .limit(limit)
}
```

`orderBy()` with a mapped column name is the simplest safe form — the builder quotes the identifier and the value came from your map.

When you must build the fragment yourself, use `??` rather than interpolation:

```js good title="src/repos/reports.js"
const ALLOWED = new Set(['created_at', 'title'])

export async function report(column, limit) {
  if (!ALLOWED.has(column)) throw new Error('invalid column')
  const { rows } = await db.raw(
    'SELECT ??, count(*) FROM posts GROUP BY 1 ORDER BY 2 DESC LIMIT ?',
    [column, limit],
  )
  return rows
}
```

`knex.ref()` is the builder-side equivalent, useful where a column reference has to appear as a value position:

```js good
await db('posts').select('title', db.ref('created_at').as('published_at'))
```

### Mass assignment

```js vulnerable title="DO NOT COPY"
await db('users').where({ id }).update(req.body)   // sets role, is_admin, …
```

Knex writes every key in the object that maps to a column. Build the update from named fields after validation. See [Mass assignment](../security/mass-assignment.md).

### Select columns explicitly

`db('users').where({ id })` with no `select` returns every column, password hash included. Always project on read paths that reach a response.

## Production considerations

**Set `acquireConnectionTimeout`.** The 60-second default turns pool exhaustion into a minute of hanging requests. Five to ten seconds is a reasonable ceiling on an HTTP path.

**Set `pool.acquireTimeoutMillis` too.** It is the tarn-level equivalent, and they cover different moments.

**`pool.max` × replicas is your real connection count.** See [Connection pooling](../databases/connection-pooling.md).

**Run `migrate:latest` as a release step.** Knex's migration lock makes concurrent runs safe-ish, but a replica that starts before migrations finish still runs against the old schema. See [Migration strategy](./migration-strategy.md).

**Know your dialect's transactional DDL story.** PostgreSQL rolls a failed migration back cleanly; MySQL leaves you half-migrated. Keep MySQL migrations to one statement each so a failure is unambiguous.

**`CREATE INDEX CONCURRENTLY` needs the transaction off.** Set `config.transaction = false` on that migration.

**Route slow queries to your logger.**

```js
db.on('query-response', (_response, obj) => {
  const ms = Date.now() - (obj.__startTime ?? Date.now())
  if (ms > 200) logger.warn({ sql: obj.sql, ms }, 'slow query')
})
db.on('query', (obj) => { obj.__startTime = Date.now() })
```

Log `obj.sql`, not `obj.bindings` — the bindings are user data.

**Treat the hand-written table interfaces as production risk.** They drift from the schema silently. A test that selects every declared column from every table catches it cheaply.

**Destroy the pool on shutdown.** `await db.destroy()` on `SIGTERM`.

## Common mistakes

- **Interpolating into `db.raw` and assuming the bindings array protects you.** It only fills placeholders.
- **Using `?` where you meant `??`.** A column name bound as a value becomes a quoted *string literal*, so `ORDER BY ?` with `'name'` sorts every row by the constant `'name'`.
- **Forgetting the trailing colon in `:name:`.** Same failure, harder to spot.
- **Leaving `acquireConnectionTimeout` at 60 seconds.** Pool exhaustion becomes a hang.
- **Reusing a builder object after awaiting it.** Builders are thenables and are consumed on execution. Return a fresh one from a function.
- **Using `db` instead of `trx` inside a transaction callback.** Different connection, not in the transaction.
- **Expecting `returning()` to work on MySQL.** It does not.
- **Joining one-to-many and reporting the row count as the parent count.** The join duplicates parents.
- **Letting the `Tables` interfaces drift from the migrations.** Nothing checks them.
- **`update(req.body)`.** Mass assignment.
- **Running `migrate:latest` from app startup.** Race across replicas.

## Related topics

- [Comparison table](./comparison.md) — Knex against the ORMs.
- [Drizzle](./drizzle.md) — the same shape of tool with real schema-derived types.
- [Sequelize](./sequelize.md) — an ORM with a similar hand-written migration story.
- [Migration strategy](./migration-strategy.md) — running `migrate:latest` in CI/CD safely.
- [Testing with a database](./testing-with-a-database.md) — migrating and truncating between tests.
- [Seeding](../databases/seeding.md) — the seed CLI in more detail.
- [SQL injection](../security/sql-injection.md) — the threat behind the `?` / `??` rules.
- [Connection pooling](../databases/connection-pooling.md) — sizing tarn's pool.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the driver underneath.
- [`examples/orm-knex`](../../examples/orm-knex/README.md) — the runnable version of this page.
