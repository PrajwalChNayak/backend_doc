---
title: When to use an ORM
description: An honest account of what an ORM buys you, what it costs you, and the query shapes where you should drop to SQL instead.
status: current
updated: 2026-09-08
---

An ORM is a trade: you give up direct control of the SQL text in exchange for a typed schema, generated migrations, and a data-access layer that survives refactoring. That trade is excellent for the ninety percent of an API that reads and writes a handful of rows by primary key, and it is a bad trade for reporting, bulk work, and anything where the query plan is the product.

## Why it exists

Hand-written SQL scales badly along one specific axis: **schema change**. Rename a column in a codebase with two hundred inline query strings and the compiler tells you nothing. The failure shows up at runtime, in production, on the one endpoint nobody tested.

An ORM moves the schema into code that the type checker and a migration tool both understand. That is the real product. Query convenience is a side effect.

The second thing it exists for is **parameterization by default**. Every mainstream ORM builds parameterized statements unless you explicitly opt out. A team writing raw strings has to get that right on every single query; a team using an ORM only has to get it right on the handful that use the raw escape hatch.

## When to use it

**Your schema changes often.** Early-stage products change column shape weekly. Generated migrations plus a typed client turn a rename into a compile error instead of a pager alert.

**You have more than three people on the codebase.** An ORM is a shared vocabulary. `user.posts` means the same thing to everyone; `LEFT JOIN posts p ON p.author_id = u.id` means whatever the author was thinking that day.

**Most of your queries are CRUD by key.** Fetch one row, update three columns, insert with a returning clause. An ORM writes exactly the SQL you would have written, faster, and it maps the result to a typed object for free.

**You want migrations you did not have to hand-write.** Diffing a declarative schema against the database is genuinely hard to do well. Prisma and Drizzle do it well. Writing that yourself is not a good use of your time.

**You are on TypeScript and want the database in the type system.** This is the strongest single argument. `user.emial` failing at build time is worth a lot.

## When not to use it

**Reporting and analytics queries.** Window functions, `GROUP BY ROLLUP`, lateral joins, CTEs that reference each other. Every ORM either cannot express these or expresses them so awkwardly that the SQL would have been shorter. Write the SQL.

**Bulk operations.** Loading fifty thousand rows into objects to update a single column is a category error. `UPDATE … WHERE …` in one statement is three orders of magnitude faster than the loop. Use `COPY`, `INSERT … SELECT`, or a batched `UPDATE`.

**Anything where you need the exact plan.** If you are tuning against `EXPLAIN ANALYZE`, you need to control the query text. An ORM that "helpfully" restructures your join into a subquery has taken the thing you were tuning away from you.

**Very hot single-purpose paths.** An ORM adds a query-building step and a row-mapping step per call. It is usually irrelevant. On a path doing 40k queries per second it is not.

:::note
"Use an ORM" and "use SQL" are not exclusive. The healthy shape is an ORM for the CRUD surface and a small, reviewed set of raw queries for the ten reports that need them. Every ORM on this site supports that — see the raw escape-hatch section on each page.
:::

## How it works

Every ORM here does the same four things in some form.

| Stage | What happens | Where it leaks |
| --- | --- | --- |
| Schema definition | You declare tables/models in code or a DSL | Types the ORM cannot express (domains, partial indexes, generated columns) |
| Query building | Method calls or objects become a SQL AST | Anything the AST has no node for |
| Execution | Parameterized statement goes to the driver | Driver-level features (streaming, `COPY`, prepared-statement caching) |
| Hydration | Rows become objects/entities | Column-to-field mapping cost, N+1 on relations |

### The leaky abstraction cost

The abstraction leaks in a specific, predictable place: **whenever the relational model and the object model disagree.** A row is a tuple; an object is a graph. Turning one into the other requires the ORM to guess, and every ORM guesses differently.

Concretely, this is where the time goes:

- Debugging a slow endpoint means reading generated SQL you did not write. Turn query logging on **before** you need it.
- Composite keys, self-referencing hierarchies, and polymorphic associations are awkward in every ORM without exception.
- Two ORMs disagree on what a `null` in a `where` clause means. TypeORM 1.0 now throws on it by default rather than guessing.
- Migrations generated from a schema diff cannot know your intent. A rename looks exactly like a drop plus an add. You get a data-destroying migration unless you check.

:::warning
The generated migration for a column rename is almost always `DROP COLUMN` + `ADD COLUMN`. Read every generated migration before you apply it. This is not paranoia; it is the single most common way teams lose a column of production data.
:::

### The N+1 trap

This is the failure mode that makes people say "the ORM is slow." The ORM is not slow. This code is slow:

```ts title="src/routes/authors.ts"
const authors = await repo.findAll()          // 1 query
for (const author of authors) {
  author.books = await books.findByAuthor(author.id)  // N queries
}
```

One hundred authors becomes 101 round trips. At 1ms of network latency each, that is 101ms of pure waiting for data a single join would have returned in 3ms.

The fix is always the same shape — tell the ORM up front which relations you need, so it can emit a join or a second batched query:

```ts title="src/routes/authors.ts" good
// Prisma
const authors = await prisma.author.findMany({ include: { books: true } })

// Drizzle
const authors = await db.query.authors.findMany({ with: { books: true } })

// TypeORM
const authors = await repo.find({ relations: { books: true } })

// Sequelize
const authors = await Author.findAll({ include: [Book] })

// Mongoose
const authors = await Author.find().populate('books')
```

Lazy-loading proxies are the reason this happens by accident: `author.books` looks like a property access and is actually a network call. Prefer ORMs and configurations where relation loading is explicit.

:::tip
Assert on query count in tests, not just on response bodies. Every ORM here can emit a log or event per query. A test that fails when an endpoint goes from 2 queries to 47 catches N+1 the day it is introduced, not the week the table gets big.
:::

### You still have to know SQL

An ORM does not remove the need to understand SQL; it removes the need to *type* it. You still have to know:

- What an index is and which one your `WHERE` clause can use.
- Why `SELECT *` on a wide table hurts, and how to select columns instead.
- What a transaction isolation level does, and why your read-modify-write is racy at `READ COMMITTED`.
- How to read `EXPLAIN ANALYZE` output.

An engineer who does not know these things writes slow queries in every ORM. The ORM just makes the slow query shorter.

## Common patterns

### Repository boundary

Keep ORM types out of your HTTP layer. A thin repository module that returns plain objects means swapping the ORM — or dropping to raw SQL for one query — touches one file.

```ts title="src/repos/users.ts"
import { prisma } from '../db.js'

export async function findActiveUsers(limit: number) {
  const rows = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, email: true, createdAt: true },
    take: limit,
  })
  return rows.map((r) => ({ id: r.id, email: r.email, joinedAt: r.createdAt }))
}
```

### Select only the columns you need

Every ORM defaults to selecting all columns. On a table with a `text` blob or a large `jsonb` column, that is the difference between a 2KB and a 400KB result set. Use `select` / `columns` / `attributes` explicitly on hot paths.

### Escape hatch from day one

Set up the raw-query path before you need it, so nobody invents their own under pressure. Each ORM page here shows the safe form.

## Security considerations

**Parameterization is the default and the escape hatch is the exception.** The generated query builders on every ORM in this section emit parameterized SQL. Injection enters through exactly two doors:

1. The raw-query API used with string interpolation.
2. Dynamic identifiers — table names, column names, `ORDER BY` — which parameterization **cannot** protect.

The second one surprises people, so be explicit about it. A placeholder is a *value* slot. The database plans the statement first and binds values second, which is precisely why a value can never become SQL syntax. An identifier is part of the syntax, so it has to be resolved before planning, so it can never be a bind parameter.

```js vulnerable title="DO NOT COPY"
// ?sort=created_at%3B+DROP+TABLE+users--
const sql = 'SELECT * FROM users ORDER BY ' + req.query.sort
const { rows } = await pool.query(sql)
```

The only correct fix is an allow-list. Not escaping, not a regex, not "it's only a column name":

```js good title="src/repos/users.js"
const SORTABLE = new Map([
  ['created_at', 'created_at'],
  ['name', 'name'],
  ['email', 'email'],
])
const DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])

export async function listUsers(pool, { sort = 'created_at', dir = 'desc', limit = 50 }) {
  const column = SORTABLE.get(sort)
  const direction = DIRECTIONS.get(dir)
  if (!column || !direction) throw new Error('invalid sort')

  // lint-sql:allow column and direction come from the SORTABLE/DIRECTIONS maps above
  const text = `SELECT id, email, created_at FROM users ORDER BY ${column} ${direction} LIMIT $1`
  const { rows } = await pool.query(text, [limit])
  return rows
}
```

Note that the allow-list maps an *input token* to a *literal you wrote*. Mapping to a value from the request — even one that passed a regex — puts attacker-controlled text into the statement.

**Mass assignment is the other ORM-specific hole.** `prisma.user.update({ data: req.body })` will happily set `role: 'admin'` if the request says so. Validate and pick fields explicitly; never spread a request body into a write.

**Field-level exposure.** `findMany()` with no `select` returns the password hash. Choose columns on anything that reaches a response.

## Production considerations

**Turn on slow-query logging before launch.** Every ORM here can log the SQL it generates with a duration. Log statements over some threshold with the parameters redacted. You cannot debug generated SQL you cannot see.

**Pool sizing is yours, not the ORM's.** The default pool is small and the default is usually right: a Postgres instance handling 200 concurrent connections spends its time context-switching. Size the pool to what the database can serve, then queue in the app. See [Connection pooling](../databases/connection-pooling.md).

**Migrations run as a deployment step, not on boot.** Three replicas starting simultaneously will race the migration table. See [Migration strategy](./migration-strategy.md).

**Set a statement timeout at the database.** An ORM will cheerfully wait forever for a query that has locked itself out. A server-side `statement_timeout` is the only backstop that works when the app is wedged.

**Budget for the generated-SQL learning curve.** The first production incident with an ORM is always someone reading a query plan for SQL they did not write. Make sure at least two people on the team can do that.

## Common mistakes

- **Treating the ORM as a reason not to learn SQL.** It is a reason to learn it faster, because you now have to read SQL you did not write.
- **Lazy-loading in a loop.** The N+1 above. It is invisible in code review and obvious in a query log.
- **Selecting every column everywhere.** Free until the table gets a `jsonb` column, then suddenly not.
- **Applying generated migrations without reading them.** Renames become drops. Check every one.
- **Spreading `req.body` into `data` / `values` / `set`.** Mass assignment. See [Mass assignment](../security/mass-assignment.md).
- **Using the raw escape hatch with template interpolation** because "it's just an internal admin endpoint." Internal admin endpoints are where the interesting data is.
- **Picking an ORM on benchmark numbers.** The difference between ORMs on a CRUD workload is noise next to one missing index.
- **Running migrations from application startup code.** Works with one replica, corrupts with three.

## Related topics

- [Comparison table](./comparison.md) — which of these six to actually pick.
- [Migration strategy](./migration-strategy.md) — generated vs hand-written, and zero-downtime schema change.
- [Testing with a database](./testing-with-a-database.md) — how to test the queries the ORM generates.
- [N+1 queries](../databases/n-plus-one-queries.md) — the failure mode in detail, with query logs.
- [SQL injection](../security/sql-injection.md) — the threat model behind the escape-hatch rules above.
- [Connection pooling](../databases/connection-pooling.md) — sizing the pool the ORM sits on top of.
- [Indexing basics](../databases/indexing-basics.md) — the thing that actually makes queries fast.
- [Mass assignment](../security/mass-assignment.md) — why `data: req.body` is a vulnerability.
