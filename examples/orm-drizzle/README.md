# orm-drizzle — Drizzle ORM over better-sqlite3

An Express 5 API over `drizzle-orm@0.45` with a `users` / `posts` one-to-many
relation. Five sibling examples (`orm-prisma`, `orm-typeorm`, `orm-sequelize`,
`orm-knex`, `orm-mongoose`) expose the **same routes over the same domain**, so
you can diff them against each other.

## What it demonstrates

| Thing | Where |
| --- | --- |
| A code-first schema in **plain JavaScript** — no TypeScript build step | `src/schema.js` |
| `relations()` — the second half `db.query.*` needs | `src/schema.js` |
| `drizzle-kit generate` from a `.js` schema and a `.js` config | `drizzle.config.js`, `drizzle/` |
| Applying migrations from code with `migrate()` | `src/migrate.js` |
| Idempotent seed data, at boot and via `npm run seed` | `src/seed.js` |
| The query builder: `select` / `insert … returning` / `update` / `delete` | `src/app.js` |
| The **relational query API** (`db.query.users.findFirst({ with: … })`) | `GET /users/:id` |
| An explicit `innerJoin` for the flat shape | `GET /posts` |
| A synchronous transaction | `POST /users-with-posts` |
| The `` sql`…` `` tagged template, which parameterises every `${}` | `GET /stats/authors` |

## Why this example is JavaScript and not TypeScript

Drizzle is normally shown in TypeScript because the table objects are what give
you typed rows. **None of that is required at runtime.** `sqliteTable()` is an
ordinary function call, so `src/schema.js` is plain ESM and the app runs with
`node src/server.js` — no build, no type-stripping, no loader. You lose the
editor types, not the behaviour, and `drizzle-kit` reads the `.js` schema
happily:

```text
Reading config file '…/drizzle.config.js'
2 tables
posts 5 columns 1 indexes 1 fks
users 4 columns 1 indexes 0 fks
```

If you want the types, rename the two files to `.ts` and run them with Node 24's
native type stripping (`node src/server.ts`) — the syntax here is type-only, so
it strips cleanly. Nothing else changes.

## Prerequisites

Node 24. **No database server** — SQLite is a file, written to `data/app.db`.

`better-sqlite3@13` is a native addon that ships Node-API prebuilt binaries, so
`npm install` needs no C++ toolchain on common platforms.

## Install and run

```bash
cd examples/orm-drizzle
npm install
npm start          # migrates and seeds at boot, then listens
```

Default port **3021**; override with `PORT`. `DATABASE_FILE` moves the database.

The separate steps, if you want them:

```bash
npm run setup      # node src/migrate.js — apply drizzle/*.sql
npm run seed       # node src/seed.js
npm run generate   # drizzle-kit generate — diff the schema, WRITE a new .sql
```

`drizzle-kit generate` writes SQL for you to review and commit; `migrate()`
applies it. `drizzle-kit push` skips the file and mutates the database directly —
fine for a scratch database, wrong for anything you have to roll back.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + a row count |
| GET | `/users?sort=&direction=&limit=` | list, allow-listed sort column |
| POST | `/users` | create one |
| GET | `/users/:id` | fetch one **with its posts** (relational query) |
| PATCH | `/users/:id` | rename |
| DELETE | `/users/:id` | delete (cascades to posts) |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users/:id/posts` | add a post |
| GET | `/posts?limit=` | posts joined to their author |
| POST | `/users-with-posts` | user + posts in one transaction |
| GET | `/stats/authors?minPosts=` | the `` sql`…` `` escape hatch |

### Health

```bash
curl -s localhost:3021/health
```

```json
{"status":"ok","orm":"drizzle-orm","users":2}
```

### The relational query — one call, nested rows

```bash
curl -s localhost:3021/users/1
```

```json
{"orm":"drizzle-orm","user":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-09 09:59:34","posts":[{"id":1,"userId":1,"title":"Note G","body":"The first published algorithm.","createdAt":"2026-09-09 09:59:34"},{"id":2,"userId":1,"title":"On the Analytical Engine","body":"","createdAt":"2026-09-09 09:59:34"}]}}
```

Two APIs, two shapes, both one statement:

| | `db.query.users.findMany({ with: { posts: true } })` | `db.select().from(posts).innerJoin(users, …)` |
| --- | --- | --- |
| Needs | `relations()` passed into `drizzle()` | nothing |
| Returns | a tree — `user.posts` is an array | flat rows, one per post |
| Good for | rendering an object graph | aggregates, reports, joins on three tables |

`db.query.*` is empty unless you pass the `relations()` objects into
`drizzle(sqlite, { schema })`. That is the whole answer to "why is
`db.query.users` undefined".

### Create, and the unique constraint as a 409

```bash
curl -s -X POST localhost:3021/users -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan Turing"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"drizzle-orm","user":{"id":3,"email":"alan@example.com","name":"Alan Turing","createdAt":"2026-09-09 09:59:51"}} [201]
```

Repeat it:

```json
{"error":"constraint violation","detail":"UNIQUE constraint failed: users.email"} [409]
```

Drizzle does not wrap driver errors, so that is better-sqlite3's own
`SQLITE_CONSTRAINT_UNIQUE` reaching your error handler unchanged. That is a
deliberate design choice — and it means the mapping to 409 is per-driver, not
portable the way Prisma's `P2002` or Sequelize's `UniqueConstraintError` are.

### The transaction

```bash
curl -s -X POST localhost:3021/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"edsger@example.com","name":"Edsger","posts":[{"title":"GOTO"},{"title":"Shortest path","body":"1956"}]}' \
  -w ' [%{http_code}]\n'
```

```json
{"orm":"drizzle-orm","user":{"id":4,"email":"edsger@example.com","name":"Edsger","createdAt":"2026-09-09 09:59:52"},"posts":[{"id":4,"userId":4,"title":"GOTO","body":"","createdAt":"2026-09-09 09:59:52"},{"id":5,"userId":4,"title":"Shortest path","body":"1956","createdAt":"2026-09-09 09:59:52"}]} [201]
```

better-sqlite3 is synchronous, so this transaction callback is synchronous too.
**Do not make it `async`** — Drizzle would commit before your promise settled.
On an async driver (libsql, Postgres, D1) the callback *is* async; the API looks
the same and the rule is the opposite.

### The raw query

```bash
curl -s "localhost:3021/stats/authors?minPosts=1"
```

```json
{"orm":"drizzle-orm","authors":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","post_count":2},{"id":4,"email":"edsger@example.com","name":"Edsger","post_count":2},{"id":2,"email":"grace@example.com","name":"Grace Hopper","post_count":1}]}
```

## The SQL-safety point

`` sql`…` `` is a **tagged template**. Every `${}` inside it becomes a bound
parameter, and a table object interpolates as its quoted name — so the query
below reads like string interpolation and is not one:

```js good title="src/app.js"
const rows = db.all(sql`
  SELECT u.id, u.email, COUNT(p.id) AS post_count
  FROM ${users} u LEFT JOIN ${posts} p ON p.user_id = u.id
  GROUP BY u.id HAVING COUNT(p.id) >= ${minPosts}
`)
```

`sql.raw()` is the opposite: it splices its argument into the statement verbatim.

```js vulnerable title="DO NOT COPY"
const email = req.query.email
const rows = db.all(sql.raw(`SELECT * FROM users WHERE email = '${email}'`))
// ?email=x' OR '1'='1  returns every user
```

```js good title="the fix"
const rows = db.all(sql`SELECT * FROM users WHERE email = ${email}`)
```

Use `sql.raw()` only for SQL fragments you wrote yourself — a keyword, an
optimiser hint. For a dynamic **column or table name** the right tool is
`sql.identifier(name)`, which quotes it properly; even then, check the name
against a fixed allow-list first, because quoting stops a break-out but does not
stop a client naming a column you never meant to expose.

In this example the sort column never becomes a string at all. `orderBy` takes a
column *object*, so the lookup table is the allow-list:

```js title="src/schema.js"
export const SORTABLE_USER_COLUMNS = { id: users.id, email: users.email, name: users.name, created_at: users.createdAt }
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3021/users?sort=;DROP+TABLE+users"
# 400
```
