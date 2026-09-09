---
title: SQL injection
description: How SQL injection works, a working exploit against a concatenated query, and the parameterized fix for pg, mysql2, better-sqlite3 and every major ORM.
status: current
updated: 2026-09-08
---

SQL injection happens when user input is pasted into a query string instead of being sent to the database as data. The database then parses attacker text as SQL. It remains the highest-impact bug you can ship because one vulnerable query usually exposes the whole schema, and the fix — send values as parameters — is both complete and free.

This page follows the same shape for every issue: the threat, a concrete exploit you can run, the fix in code, and how to verify it. The full runnable pair is [`examples/vulnerable-sql-injection`](../../examples/vulnerable-sql-injection/README.md) and [`examples/fixed-sql-injection`](../../examples/fixed-sql-injection/README.md).

## The threat

An attacker who controls any fragment of a query controls the query. Depending on the statement they can read every row of every table the app user can see, bypass authentication by making a `WHERE` clause always true, extract other tables through a `UNION`, infer data one bit at a time when no output is echoed (blind injection), or — if the driver allows stacked statements — run `DROP`, `UPDATE` and `DELETE`. The blast radius is defined by the database privileges of the connection, not by what the endpoint was meant to do.

## A concrete exploit

Here is a login/lookup handler that builds SQL by concatenation. It is deliberately broken.

:::danger SQL injection via string concatenation
The `id` and `email` values arrive from the request and are pasted straight into the query text. Every payload below is parsed as SQL.
:::

```js vulnerable title="DO NOT COPY"
import express from 'express'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = express()
app.use(express.json())

// Attacker-controlled `id` is concatenated into the query text.
app.get('/users/:id', async (req, res) => {
  const sql = `SELECT id, email FROM users WHERE id = ${req.params.id}`
  const { rows } = await pool.query(sql)
  res.json(rows)
})

// Classic authentication bypass surface.
app.post('/login', async (req, res) => {
  const { email, password } = req.body
  const sql =
    `SELECT id FROM users WHERE email = '${email}' AND password = '${password}'`
  const { rows } = await pool.query(sql)
  res.json({ authenticated: rows.length > 0 })
})

app.listen(3000)
```

**Authentication bypass.** The password check disappears because the injected `OR '1'='1'` makes the whole `WHERE` clause true, and `--` comments out the rest of the line:

```bash
curl -s -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com'\'' -- ","password":"anything"}'
```

The query the database actually runs is:

```sql
SELECT id FROM users WHERE email = 'admin@example.com' -- ' AND password = 'anything'
```

Response — logged in as admin without a password:

```json
{ "authenticated": true }
```

**UNION-based extraction.** Because the numeric `id` is unquoted, the attacker appends a `UNION` that selects from another table. The column count and types must line up with the original `SELECT id, email`:

```bash
curl -s 'http://localhost:3000/users/0 UNION SELECT table_name, null FROM information_schema.tables'
```

Response — the entire table list leaks through the `email` column:

```json
[
  { "id": "users", "email": null },
  { "id": "password_resets", "email": null },
  { "id": "payment_methods", "email": null }
]
```

**Stacked statement (destructive).** If the driver or a misconfiguration permits multiple statements, `;` ends the intended query and starts a new one:

```bash
curl -s 'http://localhost:3000/users/1; DROP TABLE password_resets'
```

**Blind / time-based.** When the endpoint returns nothing useful, the attacker still gets one bit per request by making the database pause only when a guess is true. `pg_sleep(5)` runs only if the first character of the admin's password hash is `a`:

```bash
curl -s -w '%{time_total}\n' \
  "http://localhost:3000/users/1 AND (SELECT CASE WHEN substr(password,1,1)='a' THEN pg_sleep(5) ELSE pg_sleep(0) END FROM users WHERE email='admin@example.com') IS NOT NULL"
```

A 5-second response means the guess was right; an instant response means it was wrong. Repeat to reconstruct the whole value. No data is ever printed, so logs that only record status codes see nothing unusual.

## The fix in code — drivers

Send values as parameters. The query text becomes a constant the attacker can never reach; the database receives the value out-of-band and never parses it as SQL. Nothing else — no escaping, no quoting, no regex — is required or sufficient.

:::tabs
@tab PostgreSQL
```js good title="src/users.repo.js (pg)"
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// $1, $2 … are numbered placeholders. Values travel in the array.
export async function findUser(id) {
  const { rows } = await pool.query(
    'SELECT id, email FROM users WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function login(email, password) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE email = $1 AND password_hash = $2',
    [email, password],
  )
  return rows.length > 0
}
```
@tab MySQL
```js good title="src/users.repo.js (mysql2)"
import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  multipleStatements: false, // default; never turn this on
})

// execute() uses a real prepared statement with ? placeholders.
export async function findUser(id) {
  const [rows] = await pool.execute(
    'SELECT id, email FROM users WHERE id = ?',
    [id],
  )
  return rows[0] ?? null
}
```
@tab SQLite
```js good title="src/users.repo.js (better-sqlite3)"
import Database from 'better-sqlite3'

const db = new Database('app.db')

// prepare() once, then bind values on every call.
const byId = db.prepare('SELECT id, email FROM users WHERE id = ?')

export function findUser(id) {
  return byId.get(id) ?? null
}
```
:::

`mysql2`'s `execute()` sends a true server-side prepared statement; `query()` with a values array is also parameterized but interpolates client-side. Prefer `execute()`. In `pg`, placeholders are always `$1`-style and there is no string-substitution mode to get wrong.

:::note
Node ships `node:sqlite` (stable enough to teach on Node 24). Its prepared statements bind exactly the same way, so you get parameterization with zero native build:

```js good title="node:sqlite"
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('app.db')
const stmt = db.prepare('SELECT id, email FROM users WHERE id = ?')
const row = stmt.get(id)
```
:::

## The fix in code — ORMs and query builders

Every ORM has a raw-SQL escape hatch, and every one of them has a safe form and a dangerous form that look almost identical. The rule is the same across all of them: the tagged-template or bindings form parameterizes; the `*Raw`/`.raw()` string form does not.

### Prisma

`$queryRaw` is a **tagged template** — interpolations become bind parameters. `$queryRawUnsafe` takes a plain string and reopens the hole. Build fragments with `Prisma.sql` and `Prisma.join`, never by concatenation. `Prisma.raw` injects unescaped text and is exactly as dangerous as `$queryRawUnsafe`.

```js good title="src/users.repo.js (Prisma 7)"
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

// Tagged template: ${id} is a bind parameter, not text.
export function findUser(id) {
  // lint-sql:allow $queryRaw is a tagged template — ${id} is sent as a bind parameter
  return prisma.$queryRaw`SELECT id, email FROM users WHERE id = ${id}`
}

// Composing a fragment safely: Prisma.sql keeps parameters as parameters,
// Prisma.join builds an IN-list of bind parameters.
export function findUsers(ids) {
  // lint-sql:allow $queryRaw tagged template; Prisma.join emits bind placeholders
  return prisma.$queryRaw`
    SELECT id, email FROM users
    WHERE id IN (${Prisma.join(ids)})
  `
}
```

:::danger Prisma raw-SQL escape hatch
`$queryRawUnsafe` and `Prisma.raw` do **not** parameterize their string argument.
:::

```js vulnerable title="DO NOT COPY"
// Both of these paste `id` into the query text.
prisma.$queryRawUnsafe(`SELECT id FROM users WHERE id = ${id}`)
prisma.$queryRaw`SELECT id FROM users WHERE id = ${Prisma.raw(id)}`
```

### Drizzle

The `sql` template parameterizes every `${value}` interpolation; `sql.raw()` inserts text verbatim with no escaping.

```js good title="src/users.repo.js (Drizzle)"
import { sql } from 'drizzle-orm'

export function findUser(db, id) {
  // ${id} is mapped to a placeholder and passed as a value.
  // lint-sql:allow the sql`` tagged template maps ${id} to a bind placeholder
  return db.execute(sql`SELECT id, email FROM users WHERE id = ${id}`)
}
```

:::danger Drizzle sql.raw
```js vulnerable title="DO NOT COPY"
import { sql } from 'drizzle-orm'
// sql.raw() does not escape or parameterize — id lands in the query text.
db.execute(sql`SELECT id FROM users WHERE id = ${sql.raw(id)}`)
```
:::

### TypeORM

The query builder binds `:name` placeholders from an object. Concatenating into `.where()` defeats it. The low-level `.query()` takes a parameter array as its second argument.

```js good title="src/users.repo.js (TypeORM)"
export function findUser(dataSource, id) {
  return dataSource
    .getRepository('User')
    .createQueryBuilder('u')
    .where('u.id = :id', { id }) // :id is bound, not interpolated
    .getOne()
}

export function findUserRaw(dataSource, id) {
  // Second argument is the parameter array.
  return dataSource.query('SELECT id, email FROM users WHERE id = $1', [id])
}
```

:::danger TypeORM concatenated where()
```js vulnerable title="DO NOT COPY"
dataSource
  .getRepository('User')
  .createQueryBuilder('u')
  .where('u.id = ' + id) // pasted into SQL
  .getOne()
```
:::

### Sequelize

Sequelize has two substitution mechanisms, and the difference is the whole point. `replacements` are escaped and inlined **by Sequelize** before the SQL is sent. `bind` values are passed to the driver as true bind parameters and never appear in the query text. Both are safe; string interpolation is the hole.

```js good title="src/users.repo.js (Sequelize)"
import { QueryTypes } from 'sequelize'

// bind: real driver bind parameters ($1 for postgres).
export function findUserBound(sequelize, id) {
  return sequelize.query('SELECT id, email FROM users WHERE id = $1', {
    bind: [id],
    type: QueryTypes.SELECT,
  })
}

// replacements: Sequelize escapes the value and substitutes :id itself.
export function findUserReplaced(sequelize, id) {
  return sequelize.query('SELECT id, email FROM users WHERE id = :id', {
    replacements: { id },
    type: QueryTypes.SELECT,
  })
}
```

:::danger Sequelize string interpolation
```js vulnerable title="DO NOT COPY"
sequelize.query(`SELECT id FROM users WHERE id = ${id}`, {
  type: QueryTypes.SELECT,
})
```
:::

### Knex

`knex.raw()` binds `?` positional values from its second argument. `??` is the placeholder for **identifiers** (table/column names) and quotes them for the dialect. `knex.ref()` produces a column reference safely.

```js good title="src/users.repo.js (Knex)"
export function findUser(knex, id) {
  // ? binds the value; the value never becomes SQL text.
  return knex.raw('SELECT id, email FROM users WHERE id = ?', [id])
}

export function selectColumn(knex, column, id) {
  // ?? quotes an identifier for the dialect (see allow-listing below first).
  return knex.raw('SELECT ?? FROM users WHERE id = ?', [column, id])
}
```

## What parameterization does NOT protect

Bind parameters replace **values** only. You cannot bind a table name, a column name, the direction of an `ORDER BY`, or (in most drivers) the identifier half of anything. If any of those is dynamic, the value never reaches a placeholder and you are back to building SQL text. The only safe technique is an **allow-list**: compare the input against a fixed set of known-good strings and use the known-good string, never the input. A regex "sanitizer" is not an allow-list — it tries to enumerate bad input, and it always misses.

```js good title="src/reports.repo.js"
import createError from 'http-errors'

// Fixed, known-safe identifiers. The user picks an entry; you use the entry.
const SORTABLE = new Set(['created_at', 'email', 'id'])
const DIRECTIONS = new Map([['asc', 'ASC'], ['desc', 'DESC']])
const TABLES = new Map([['users', 'users'], ['orders', 'orders']])

export async function listRows(pool, { table, sort, dir, limit }) {
  const tableName = TABLES.get(table)
  if (!tableName) throw createError(400, 'unknown table')

  if (!SORTABLE.has(sort)) throw createError(400, 'bad sort column')
  const direction = DIRECTIONS.get(dir)
  if (!direction) throw createError(400, 'bad sort direction')

  // LIMIT binds as a value in pg; keep it a parameter.
  const max = Math.min(Number(limit) || 20, 100)

  // Every ${...} below came from a Set/Map lookup, not from the request.
  // lint-sql:allow tableName/sort/direction are validated against fixed allow-lists above
  const sql =
    `SELECT id, email, created_at FROM ${tableName} ORDER BY ${sort} ${direction} LIMIT $1`
  const { rows } = await pool.query(sql, [max])
  return rows
}
```

For `IN (...)` lists, never build the list by joining strings. Generate one placeholder per element and pass the values:

```js good title="src/users.repo.js — IN list"
export async function findByIds(pool, ids) {
  if (ids.length === 0) return []
  // $1, $2, $3 … one generated placeholder per id — no user data in the text.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  // lint-sql:allow placeholders is a generated "$1, $2" list; values pass in the array
  const { rows } = await pool.query(
    `SELECT id, email FROM users WHERE id IN (${placeholders})`,
    ids,
  )
  return rows
}
```

That template contains no user data — only the generated `$1, $2` text — so it is safe, but note it still needs care: the `ids` array length is attacker-controlled, so cap it. Where the driver offers array binding (`pg` supports `WHERE id = ANY($1)` with a JS array), prefer that and skip the generated list entirely.

When you genuinely must quote a dynamic identifier, use the driver's own quoting rather than hand-rolling it: Knex's `??` placeholder and `mysql2`'s `connection.escapeId()` both quote identifiers for their dialect. (A separate package, `pg-format`, offers a `%I` identifier specifier for `pg`; `pg` itself ships no such helper.) Quoting is still second to an allow-list — quote only from a set you have already validated.

## Second-order injection

A value stored safely through a parameterized query is not permanently safe. It becomes dangerous again the moment some *other* code path reads it back and concatenates it into SQL. The parameter boundary protects the query that runs, not the string that comes out.

:::danger Second-order injection
```js vulnerable title="DO NOT COPY"
// Step 1 (safe): the username is stored via a bind parameter.
await pool.query('INSERT INTO users (username) VALUES ($1)', [req.body.username])

// Step 2 (vulnerable): a later job reads it back and concatenates it.
const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [id])
const name = rows[0].username // e.g.  admin' --
await pool.query(`UPDATE audit SET actor = '${name}'`) // injected again
```
:::

The fix is not "sanitize on the way in" — it is to parameterize **every** query, including the ones that consume data you previously stored. Treat data from your own database with the same suspicion as data from the request.

## Least privilege

Parameterization stops the injection; least privilege caps the damage of any injection you missed. The account your application connects with should be able to do the DML the app needs and nothing else. It must not own the tables, must not be a superuser, and must not hold DDL rights. Run migrations as a **separate, more privileged** user that the running app never uses, so a compromised app connection cannot alter or drop the schema.

```sql title="grants.sql (PostgreSQL)"
-- Migration owner: owns the schema, runs DDL. Used only by the migration tool.
CREATE ROLE app_migrator LOGIN PASSWORD :'migrator_pw';

-- Runtime user: no ownership, no DDL, no superuser.
CREATE ROLE app_runtime LOGIN PASSWORD :'runtime_pw';

-- The runtime user gets only the DML it needs on existing tables.
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;

-- Explicitly deny the dangerous verbs.
REVOKE CREATE ON SCHEMA public FROM app_runtime;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM app_runtime;
```

With those grants, even a successful `DROP TABLE` injection fails: the runtime role has no rights to drop anything. The UNION read still works, so this is a mitigation, not a substitute for the fix.

## Defence in depth

- **`multipleStatements: false`** in `mysql2` (the default) prevents `;`-stacked statements from a single injected value. Leave it off; turning it on to run a batch of admin SQL creates the stacked-query hole.
- **`statement_timeout`** in PostgreSQL bounds how long any query — including a blind `pg_sleep` probe or a runaway `UNION` — can run: `SET statement_timeout = '3s'` per session, or set it on the role. It limits the resource cost of an attack in progress.
- **A WAF is a mitigation, not a fix.** Pattern-based blocking of `UNION SELECT` or `OR 1=1` catches script-kiddie payloads and buys time, but encodings, comments, and case tricks bypass it routinely. Never treat a WAF as permission to keep a concatenated query.
- **Escaping functions are a trap.** `mysql_real_escape_string`-style helpers exist and appear to work, but they are easy to apply in the wrong place, wrong charset or wrong context (numeric fields, identifiers), and one missed call is a hole. Parameterization removes the entire class; escaping only narrows it.

## Detection

- **Code review greps** for the shapes that are almost always wrong:

  ```bash
  # template-literal SQL and string-concatenated SQL
  grep -rEn "(query|execute)\s*\(\s*\`" src/
  grep -rEn "(SELECT|INSERT|UPDATE|DELETE)[^;]*(\+|\$\{)" src/
  grep -rn "queryRawUnsafe\|Prisma.raw\|sql.raw\|multipleStatements" src/
  ```

- **The site's own linter.** `scripts/lint-sql.mjs` scans every fenced block in `content/` and every example source file for interpolated SQL and fails the build. The `// lint-sql:allow` marker is the only way to allow-list a validated identifier interpolation, and it forces the justification into the diff.
- **`npm audit`** and a lockfile catch a vulnerable driver or ORM version; run it in CI.
- **Static analysis** (ESLint security plugins, CodeQL's `js/sql-injection` query) flags tainted data flowing into a query sink across function boundaries, which grep cannot follow.

## Common mistakes

- **"I escaped the quotes, so it's safe."** Escaping is context-specific and misses numeric fields, identifiers and second-order paths. Parameterize instead.
- **Parameterizing the value but concatenating the column or `ORDER BY`.** Placeholders bind values only. Allow-list every dynamic identifier.
- **Building an `IN (...)` list by `ids.join(',')`.** That is concatenation. Generate one placeholder per element, or use `= ANY($1)`.
- **Using `$queryRawUnsafe`, `Prisma.raw`, `sql.raw` or `.query(concatenatedString)`** because the tagged-template form "didn't work." It did; the string form is the escape hatch, not the default.
- **Trusting data read back from your own tables.** Second-order injection concatenates stored-but-tainted values. Every query is parameterized, including reads-then-writes.
- **Running the app as the database owner or a superuser.** A missed query then becomes a schema wipe. Separate the migration user from the runtime user.
- **Treating a WAF as the fix.** It buys time against known payloads and nothing more.

## Related topics

- [NoSQL injection](nosql-injection.md) — the same class against MongoDB operators, where the payload is an object, not a string.
- [Validation](../express-libraries/validation.md) — coercing input to primitives with Zod before it reaches a query.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — parameterized `pool.query` and `statement_timeout` in depth.
- [MySQL with mysql2](../databases/mysql-with-mysql2.md) — `execute()` prepared statements and `multipleStatements`.
- [Prisma](../orms/prisma.md) — `$queryRaw` versus `$queryRawUnsafe` and `Prisma.sql`.
- [Knex](../orms/knex.md) — `raw` bindings, `??` identifiers and `knex.ref`.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — where injection sits in the wider list.
