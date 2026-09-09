---
title: Drizzle
description: Drizzle ORM 0.45.2 — TypeScript schemas that compile to SQL you can predict, with drizzle-kit migrations and a safe sql tagged template.
status: current
updated: 2026-09-08
---

Drizzle is a thin, fully typed SQL builder that happens to have relational queries and a migration tool. You define tables in TypeScript, and the query you write maps almost one-to-one onto the SQL that gets sent. There is no runtime engine, no code generation step, and no hidden query rewriting.

This page documents **`drizzle-orm` 0.45.2** with **`drizzle-kit` 0.31.10**.

:::note
A `1.0.0-rc.4` exists on the `rc` dist-tag, and the official documentation site has largely moved to that v1 API — most visibly, v1 replaces `relations()` with `defineRelations()`. The `latest` tag is still `0.45.2`, which is what this page covers. If you copy a relations snippet from the website and it uses `defineRelations`, it is v1 and will not compile against 0.45.2.
:::

## Why it exists

Drizzle exists because the type safety of a generated client and the predictability of hand-written SQL were treated as a trade-off, and they are not. The schema is plain TypeScript, so the types come from inference rather than a generation step, and the query builder is close enough to SQL that you can read the generated statement off the source.

It also weighs almost nothing. There is no query engine binary, the dependency list is empty, and it runs on workers and edge runtimes where a heavier ORM cannot.

## When to use it

- **You know SQL and want to keep knowing it.** `select().from().where()` maps to `SELECT … FROM … WHERE …`. Nothing surprises you in a query log.
- **Serverless or edge.** No engine, no generated client, tiny runtime, fast cold starts.
- **You want type inference without a build step.** Edit the schema, types update. There is no `generate` to forget.
- **You need `INSERT … ON CONFLICT`, CTEs, window functions, or `FOR UPDATE`.** Drizzle expresses these directly rather than pushing you to a raw string.
- **You want migrations you can hand-edit.** `drizzle-kit generate` writes plain `.sql` files, and editing them is normal practice rather than a workaround.

## When not to use it

- **You want the ORM to hide SQL from you.** It will not. Drizzle assumes you can read a join.
- **Deeply nested relational reads across many tables.** The relational query API is good, but Prisma's nested `select`/`include` ergonomics are better for graph-shaped reads.
- **You need a mature migration story with drift repair and a shadow database.** `drizzle-kit` is good; `prisma migrate` is more complete.
- **Large schemas on older TypeScript setups.** Heavy type inference costs editor responsiveness in a way generated types do not.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install drizzle-orm@0.45.2 pg
npm install --save-dev drizzle-kit@0.31.10 @types/pg
```
@tab pnpm
```bash
pnpm add drizzle-orm@0.45.2 pg
pnpm add -D drizzle-kit@0.31.10 @types/pg
```
@tab yarn
```bash
yarn add drizzle-orm@0.45.2 pg
yarn add -D drizzle-kit@0.31.10 @types/pg
```
:::

`drizzle-orm` declares no `engines` and has zero runtime dependencies — the database driver is a peer dependency you install yourself.

### Schema

```ts title="src/db/schema.ts"
import { relations } from 'drizzle-orm'
import {
  boolean, index, integer, pgTable, serial, text, timestamp, varchar,
} from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    published: boolean('published').notNull().default(false),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('posts_author_published_idx').on(table.authorId, table.published)],
)

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}))
```

`relations()` is metadata for the relational query API only. It does **not** create foreign keys — `.references()` does that.

### Connect

```ts title="src/db/index.ts"
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

export const db = drizzle(pool, { schema })
```

Passing `schema` is what enables `db.query.*`. Without it you get the SQL builder but not the relational API.

### CRUD

```ts title="src/routes/users.ts"
import express from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

const router = express.Router()

router.post('/users', async (req, res) => {
  const [user] = await db
    .insert(users)
    .values({ email: req.body.email, name: req.body.name })
    .returning({ id: users.id, email: users.email, name: users.name })
  res.status(201).json(user)
})

router.get('/users/:id', async (req, res) => {
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, Number(req.params.id)))
    .limit(1)
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.patch('/users/:id', async (req, res) => {
  const [user] = await db
    .update(users)
    .set({ name: req.body.name })
    .where(eq(users.id, Number(req.params.id)))
    .returning({ id: users.id, name: users.name })
  res.json(user)
})

router.delete('/users/:id', async (req, res) => {
  await db.delete(users).where(eq(users.id, Number(req.params.id)))
  res.status(204).end()
})

export default router
```

Express 5 forwards rejections from `async` handlers to your error middleware, so there is no wrapper here.

Full runnable version: [`examples/orm-drizzle`](../../examples/orm-drizzle/README.md).

## How it works

### Relations and eager loading

Two ways to read related rows, and the difference matters.

**Relational queries** — declarative, returns a nested object graph:

```ts
const rows = await db.query.users.findMany({
  columns: { id: true, email: true },
  with: {
    posts: {
      columns: { id: true, title: true },
      where: (posts, { eq }) => eq(posts.published, true),
      limit: 5,
    },
  },
  limit: 20,
})
// rows[0].posts is typed as { id: number; title: string }[]
```

**Joins** — explicit, returns flat rows you shape yourself:

```ts
import { eq } from 'drizzle-orm'

const rows = await db
  .select({ userId: users.id, email: users.email, postTitle: posts.title })
  .from(users)
  .leftJoin(posts, eq(posts.authorId, users.id))
  .where(eq(users.id, 1))
```

Use relational queries when you want a graph, joins when you want a projection. Neither issues a query per parent row, so neither is an N+1 — that only happens if you write the loop yourself.

### Transactions

```ts title="src/services/transfer.ts"
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { accounts } from '../db/schema.js'

export async function transfer(fromId: number, toId: number, cents: number) {
  return db.transaction(async (tx) => {
    const [from] = await tx
      .update(accounts)
      .set({ balance: sql`${accounts.balance} - ${cents}` })
      .where(eq(accounts.id, fromId))
      .returning({ balance: accounts.balance })

    if (from.balance < 0) tx.rollback()

    await tx
      .update(accounts)
      .set({ balance: sql`${accounts.balance} + ${cents}` })
      .where(eq(accounts.id, toId))
  })
}
```

`tx.rollback()` throws to abort; so does any other thrown error. Use `tx` for every statement inside the callback — `db` would take a different connection and would not be part of the transaction.

Note the `sql` template doing arithmetic against the current column value. That produces `balance = "accounts"."balance" - $1`, which is atomic in the database. Reading the balance into JavaScript and writing back a computed number is a lost-update race.

### Migrations

Configure `drizzle-kit`:

```ts title="drizzle.config.ts"
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
})
```

Valid dialects are `postgresql`, `mysql`, `sqlite`, `turso`, `singlestore`, `mssql` and `cockroach`.

```bash
# Diff the schema against the last snapshot, write a .sql migration
npx drizzle-kit generate

# Apply pending migrations
npx drizzle-kit migrate

# Prototyping only: push the schema straight to the database
npx drizzle-kit push

# Introspect an existing database into a schema file
npx drizzle-kit pull

# Validate the migration folder for conflicts
npx drizzle-kit check
```

The generated migrations are plain SQL in `./drizzle` alongside a JSON snapshot in `./drizzle/meta`. The snapshot is how the next `generate` computes a diff, so **commit the whole folder** — losing `meta` means the next diff tries to recreate your entire schema.

Because the output is plain SQL, hand-editing is expected. A generated rename arrives as `DROP COLUMN` + `ADD COLUMN`; open the file and rewrite it as `ALTER TABLE … RENAME COLUMN …` before applying.

Apply migrations from a script in your release job rather than from your app:

```ts title="scripts/migrate.ts"
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
await pool.end()
```

### TypeScript story

Everything is inferred from the schema object. No generation, no `.d.ts` to regenerate.

```ts title="src/types.ts"
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'
import { users } from './db/schema.js'

type User = InferSelectModel<typeof users>       // what a SELECT returns
type NewUser = InferInsertModel<typeof users>    // what an INSERT accepts
```

The insert type respects defaults and nullability — a column with `.defaultNow()` is optional on insert, a `.notNull()` column without a default is required. Partial selects narrow the result type to exactly the keys you asked for.

The cost is compile time. Inference this deep is expensive, and a schema with a hundred tables and heavy relational queries will make your editor think. Splitting the schema across files helps; there is no way to make it free.

### Connection pooling

Drizzle does not pool. The driver does. For `node-postgres` you configure `pg`'s `Pool` and hand it over:

```ts title="src/db/index.ts"
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})
export const db = drizzle(pool, { schema })
```

This is an advantage in practice: pool behaviour, TLS options and keepalive settings are the driver's documented options, not an ORM's re-interpretation of them. See [Connection pooling](../databases/connection-pooling.md).

Drizzle also accepts a config object and will build the client for you:

```ts
const db = drizzle({ connection: process.env.DATABASE_URL!, schema })
```

Prefer passing your own `Pool` in a server, so you own the pool settings and can close it on shutdown.

## Common patterns

### Prepared statements on hot paths

```ts title="src/repos/users.ts"
import { eq, sql } from 'drizzle-orm'

const byId = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .prepare('users_by_id')

export const findUser = (id: number) => byId.execute({ id })
```

`sql.placeholder` marks a value slot filled at execution time, so the query is built once and the SQL text is stable — which also means the database can reuse the plan.

### Dynamic filters

```ts title="src/repos/posts.ts"
import { and, eq, gte, type SQL } from 'drizzle-orm'

const conditions: SQL[] = []
if (filters.published !== undefined) conditions.push(eq(posts.published, filters.published))
if (filters.since) conditions.push(gte(posts.createdAt, filters.since))

const rows = await db
  .select()
  .from(posts)
  .where(conditions.length ? and(...conditions) : undefined)
```

Every condition carries its value as a parameter. Building a filter list this way is safe by construction — nothing becomes SQL text.

## Security considerations

### The sql tagged template is parameterized

`sql` is a tagged template. Interpolated values become numbered placeholders and travel to the driver separately from the statement:

```ts good title="src/repos/search.ts"
import { sql } from 'drizzle-orm'

const email = req.body.email
const rows = await db.execute(
  sql`SELECT id, email FROM users WHERE email = ${email}`,
)
// Sent as: SELECT id, email FROM users WHERE email = $1   -- ['x@example.com']
```

Interpolating a **table or column object** is also safe, but for a different reason — Drizzle knows it is an identifier and escapes it:

```ts good
await db.execute(sql`SELECT * FROM ${users} WHERE ${users.id} = ${id}`)
// SELECT * FROM "users" WHERE "users"."id" = $1
```

### sql.raw() is not

`sql.raw()` splices a string into the statement verbatim. No escaping, no parameter:

```ts vulnerable title="DO NOT COPY"
import { sql } from 'drizzle-orm'
// GET /users?email=x'%20OR%20'1'%3D'1
await db.execute(sql.raw(`SELECT * FROM users WHERE email = '${req.query.email}'`))
```

:::danger
`sql.raw()` nested inside a `sql` template inherits none of the template's safety. `sql\`… ${sql.raw(userInput)}\`` is exactly as dangerous as string concatenation. The tag protects its own interpolations, not the contents of a `raw`.
:::

The correct form for a dynamic value is always the plain interpolation:

```ts good
await db.execute(sql`SELECT * FROM users WHERE email = ${req.body.email}`)
```

### Dynamic identifiers and ORDER BY

Placeholders are value slots, so an `ORDER BY` column can never be one. Drizzle gives you two safe routes.

**Route one — map to schema column objects.** The map values are real columns, so Drizzle escapes the identifier and there is no string in play at all:

```ts good title="src/repos/posts.ts"
import { asc, desc } from 'drizzle-orm'

const SORT_COLUMNS = { created_at: posts.createdAt, title: posts.title } as const
const SORT_DIRECTIONS = { asc, desc } as const

export async function listPosts(sort: string, dir: string, limit: number) {
  const column = SORT_COLUMNS[sort as keyof typeof SORT_COLUMNS]
  const direction = SORT_DIRECTIONS[dir as keyof typeof SORT_DIRECTIONS]
  if (!column || !direction) throw new Error('invalid sort')

  return db.select().from(posts).orderBy(direction(column)).limit(limit)
}
```

This is the one to use. It is safe without needing a linter exemption, because no attacker-controlled string is ever concatenated.

**Route two — `sql.identifier()`** when you genuinely have only a name, still behind an allow-list:

```ts good title="src/repos/reports.ts"
import { sql } from 'drizzle-orm'

const ALLOWED = new Set(['created_at', 'title'])

export async function report(column: string, limit: number) {
  if (!ALLOWED.has(column)) throw new Error('invalid column')
  // lint-sql:allow column is checked against the ALLOWED set and quoted by sql.identifier
  return db.execute(
    sql`SELECT ${sql.identifier(column)} AS value, count(*) FROM posts
        GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`,
  )
}
```

`sql.identifier()` quotes the name so it cannot break out of the identifier position, but it does not restrict *which* identifier — an attacker could still name a column you did not intend to expose. The allow-list is doing the real work; `sql.identifier()` handles the quoting.

### Mass assignment

`.values(req.body)` and `.set(req.body)` write whatever keys match columns:

```ts vulnerable title="DO NOT COPY"
await db.update(users).set(req.body).where(eq(users.id, id)) // sets role, isAdmin, …
```

Build the object from named fields after validation. See [Mass assignment](../security/mass-assignment.md).

### Select columns explicitly

`db.select().from(users)` returns every column including the password hash. Pass a projection object on anything that reaches a response.

## Production considerations

**Commit the whole `drizzle/` folder, `meta/` included.** The JSON snapshot is the diff baseline. Without it `drizzle-kit generate` cannot tell what changed and will emit a full-schema migration.

**Never run `drizzle-kit push` against production.** It applies the diff with no migration file and no history. It is a prototyping tool.

**Read every generated migration.** Column renames come out as drop-plus-add. Rewrite them by hand — the files are plain SQL for exactly this reason.

**Run migrations in a release step with `max: 1`.** A dedicated pool of one connection, then `pool.end()`. See [Migration strategy](./migration-strategy.md).

**Pool sizing belongs to the driver.** `max` × replicas is your real connection count against the database.

**Turn on query logging in staging.** `drizzle(pool, { schema, logger: true })` prints the generated SQL. Drizzle's SQL is predictable, but "predictable" is worth verifying once per non-trivial query.

**Watch type-check time as the schema grows.** If `tsc` starts taking minutes, split the schema across modules and consider whether the deepest relational queries need to be joins instead.

**Pin `drizzle-orm` and `drizzle-kit` together.** They share a snapshot format. A `drizzle-kit` upgrade can change the snapshot version and force a migration-folder upgrade (`drizzle-kit up`).

## Common mistakes

- **Copying `defineRelations` from the website.** That is the 1.0 RC API. On 0.45.2 it is `relations(table, ({ one, many }) => …)`.
- **Forgetting `{ schema }` when creating the client.** `db.query` is then undefined and the relational API silently does not exist.
- **Expecting `relations()` to create foreign keys.** It is query metadata. Use `.references()` for the constraint.
- **Using `sql.raw()` for a value.** That is what plain interpolation in the `sql` template is for.
- **Assuming `sql.raw()` is safe because it is inside a `sql` template.** It is not.
- **Not committing `drizzle/meta`.** The next `generate` produces nonsense.
- **`push` in CI.** Use `generate` + `migrate`.
- **Using `db` instead of `tx` inside a transaction callback.** Different connection, not in the transaction.
- **`.set(req.body)`.** Mass assignment.
- **Reading a balance into JS and writing it back.** Use `sql\`${col} - ${n}\`` so the arithmetic happens in the database.

## Related topics

- [Comparison table](./comparison.md) — Drizzle against the other five.
- [Prisma](./prisma.md) — the alternative if you want migrations and relations handled for you.
- [Knex](./knex.md) — if you want a query builder with no schema layer at all.
- [Migration strategy](./migration-strategy.md) — expand/contract and running `drizzle-kit migrate` in CI.
- [Testing with a database](./testing-with-a-database.md) — migrating a test database from the same folder.
- [SQL injection](../security/sql-injection.md) — the threat behind the `sql.raw()` rules.
- [Connection pooling](../databases/connection-pooling.md) — sizing the `pg` pool Drizzle sits on.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the driver underneath.
- [`examples/orm-drizzle`](../../examples/orm-drizzle/README.md) — the runnable version of this page.
