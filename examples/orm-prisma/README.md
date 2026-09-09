# orm-prisma — Prisma 7 over SQLite

An Express 5 API over `prisma@7` with a `users` / `posts` one-to-many relation.
Five sibling examples (`orm-drizzle`, `orm-typeorm`, `orm-sequelize`, `orm-knex`,
`orm-mongoose`) expose the **same routes over the same domain**, so you can diff
them against each other.

> ⚠️ **Pin Prisma 7 explicitly.** The npm `latest` dist-tag currently points at
> **`8.0.0-rc.13`**, a release candidate — `npm install prisma` without a range
> gives you a pre-release. This example pins `prisma@^7.10.0` and
> `@prisma/client@^7.10.0`, which is the current stable line, and the CLI will
> print an "Update available 7.10.0 -> 8.0.0-rc.13" banner. Ignore it.

## What it demonstrates

| Thing | Where |
| --- | --- |
| A Prisma schema with a relation, `@map`ped to snake_case columns | `prisma/schema.prisma` |
| Prisma 7's `prisma.config.js` — the URL is no longer in the schema | `prisma.config.js` |
| A **driver adapter** (`@prisma/adapter-better-sqlite3`), required in v7 | `src/db.js` |
| A committed SQL migration, applied with `migrate deploy` | `prisma/migrations/` |
| Idempotent seed data, at boot and via `npm run seed` | `src/seed.js` |
| CRUD with `create` / `findMany` / `findUnique` / `update` / `delete` | `src/app.js` |
| Eager loading with `include`, and `select` inside it | `GET /users/:id`, `GET /posts` |
| A nested write (`posts: { create: [...] }`) — one implicit transaction | `src/seed.js` |
| An **interactive transaction** (`$transaction(async tx => …)`) | `POST /users-with-posts` |
| The raw escape hatch: `$queryRaw` tagged template | `GET /stats/authors` |
| `P2002` / `P2025` mapped to 409 / 404 instead of 500 | error handler in `src/app.js` |

## Prerequisites

Node 24. **No database server** — SQLite is a file, written to `prisma/dev.db`.

`@prisma/adapter-better-sqlite3` pulls in `better-sqlite3`, a native addon.
Version 13 publishes Node-API prebuilt binaries, so `npm install` needs no C++
toolchain on common platforms. The adapter's own dependency range asks for
`better-sqlite3@^12`, which has **no prebuilt binary for Node 24 on Windows**;
this example therefore carries

```json
"overrides": { "better-sqlite3": "^13.0.3" }
```

so one prebuilt v13 is used everywhere. Remove the override and `npm install`
fails with a `node-gyp` "You need to install the latest version of Visual
Studio" error.

## Install and run

```bash
cd examples/orm-prisma
npm install
npm run setup     # prisma migrate deploy && prisma generate
npm start
```

Default port **3020**; override with `PORT`. Override the database file with
`DATABASE_FILE` (an absolute path) and it will be created on demand.

`npm run setup` is not optional: unlike the other examples in this set, Prisma
does not create tables at boot. If you skip it the server prints

```text
  The database schema is not ready.

    database : …/prisma/dev.db
    error    : The table `main.users` does not exist in the current database.

  Apply the migrations first:

    npm run setup      # prisma migrate deploy && prisma generate
```

and exits 1.

To change the schema, edit `prisma/schema.prisma` and create a new migration:

```bash
npx prisma migrate dev --name add_something
```

`migrate dev` is a development command — it can reset the database. `npm run
setup` uses `migrate deploy`, which only applies what is already committed and is
the one to run in CI and production.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + a row count |
| GET | `/users?sort=&direction=&limit=` | list, allow-listed sort field |
| POST | `/users` | create one |
| GET | `/users/:id` | fetch one **with its posts** (`include`) |
| PATCH | `/users/:id` | rename |
| DELETE | `/users/:id` | delete (cascades to posts) |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users/:id/posts` | add a post via `connect` |
| GET | `/posts?authorEmail=&limit=` | posts with the author eager-loaded |
| POST | `/users-with-posts` | user + posts in one interactive transaction |
| GET | `/stats/authors?minPosts=` | the `$queryRaw` escape hatch |

### Health

```bash
curl -s localhost:3020/health
```

```json
{"status":"ok","orm":"prisma","users":2}
```

### List, and fetch one with its posts

```bash
curl -s localhost:3020/users
```

```json
{"orm":"prisma","users":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-09T10:08:23.711Z"},{"id":2,"email":"grace@example.com","name":"Grace Hopper","createdAt":"2026-09-09T10:08:23.728Z"}]}
```

```bash
curl -s localhost:3020/users/1
```

```json
{"orm":"prisma","user":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-09T10:08:23.711Z","posts":[{"id":1,"title":"Note G","body":"The first published algorithm.","userId":1,"createdAt":"2026-09-09T10:08:23.711Z"},{"id":2,"title":"On the Analytical Engine","body":"","userId":1,"createdAt":"2026-09-09T10:08:23.711Z"}]}}
```

`include` is two statements, not a JOIN: Prisma fetches the user, then fetches
every post with `WHERE user_id IN (…)`, then stitches them. That is why it is not
N+1 even for a page of fifty users.

### Create — and the unique constraint as a 409

```bash
curl -s -X POST localhost:3020/users -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan Turing"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"prisma","user":{"id":3,"email":"alan@example.com","name":"Alan Turing","createdAt":"2026-09-09T10:08:39.903Z"}} [201]
```

Repeat it:

```json
{"error":"constraint violation","detail":"unique constraint on a field"} [409]
```

Prisma normalises database errors into codes that mean the same thing on every
provider. `P2002` is a unique violation, `P2025` is "the record this operation
needed does not exist" — which is what `DELETE /users/999` returns as a 404.

### The interactive transaction

```bash
curl -s -X POST localhost:3020/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"edsger@example.com","name":"Edsger","posts":[{"title":"GOTO"},{"title":"Shortest path","body":"1956"}]}' \
  -w ' [%{http_code}]\n'
```

```json
{"orm":"prisma","user":{"id":4,"email":"edsger@example.com","name":"Edsger","createdAt":"2026-09-09T10:08:40.337Z"},"posts":[{"id":4,"title":"GOTO","body":"","userId":4,"createdAt":"2026-09-09T10:08:40.349Z"},{"id":5,"title":"Shortest path","body":"1956","userId":4,"createdAt":"2026-09-09T10:08:40.349Z"}]} [201]
```

If any insert fails, the user is not created either. Two forms exist and they are
not interchangeable:

| Form | Shape | Use when |
| --- | --- | --- |
| `$transaction([q1, q2, q3])` | array of prepared queries | the queries are independent |
| `$transaction(async (tx) => …)` | callback, "interactive" | a later query needs an earlier result |

Inside the callback, **every query must use `tx`**. A call on the outer `prisma`
runs on a different connection and is not rolled back with the rest.

### The raw query

```bash
curl -s "localhost:3020/stats/authors?minPosts=1"
```

```json
{"orm":"prisma","authors":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","post_count":2},{"id":4,"email":"edsger@example.com","name":"Edsger","post_count":2},{"id":2,"email":"grace@example.com","name":"Grace Hopper","post_count":1}]}
```

## The SQL-safety point

`$queryRaw` is a **tagged template**. It looks like string interpolation and is
not one: every `${}` becomes a bound parameter, so the value cannot become SQL
text no matter what it contains.

```js good title="src/app.js"
const authors = await prisma.$queryRaw`
  SELECT u.id, u.email, COUNT(p.id) AS post_count
  FROM users u LEFT JOIN posts p ON p.user_id = u.id
  GROUP BY u.id HAVING COUNT(p.id) >= ${minPosts}
`
```

The functions with `Unsafe` in the name, and `Prisma.raw`, take an ordinary
string — so anything you interpolate lands in the statement:

```js vulnerable title="DO NOT COPY"
const email = req.query.email
const rows = await prisma.$queryRawUnsafe(
  `SELECT * FROM users WHERE email = '${email}'`
)
// ?email=x' OR '1'='1  returns every user
```

```js good title="the fix"
const rows = await prisma.$queryRaw`SELECT * FROM users WHERE email = ${email}`
// or, if you must keep the string form, pass values as arguments. The
// placeholder is the one the provider uses — `?` on SQLite and MySQL,
// `$1` on PostgreSQL:
const rows2 = await prisma.$queryRawUnsafe(
  'SELECT * FROM users WHERE email = ?',
  email,
)
```

Two more details worth knowing:

- `Prisma.sql` builds composable fragments that keep their bindings, and
  `Prisma.join()` expands a list. `Prisma.raw()` does not — it splices text.
  Use `Prisma.raw` only for SQL you wrote, never for a value.
- Calling `prisma.$queryRaw(someString)` with **parentheses** instead of a
  template is not the tagged form. Prisma throws — *"`$queryRaw` is a tag
  function, please use it like the following"* — rather than run it.

Everything outside the raw hatch — `findMany`, `where`, `orderBy` — takes
structured objects that never become SQL text, so injection is not reachable
there at all. The allow-list on `?sort=` exists only to turn an unknown field
into a clean 400 instead of a `PrismaClientValidationError`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3020/users?sort=nope"
# 400
```

## Prisma 7 notes

Two things changed from Prisma 6 and will break copied-in older code:

1. **`url` is gone from `datasource` in `schema.prisma`.** Putting it back gives
   you `P1012: The datasource property 'url' is no longer supported in schema
   files.` The CLI reads it from `prisma.config.js`; the client gets it from the
   adapter you construct.
2. **The client needs a driver adapter.** There is no bundled query engine
   deciding how to talk to SQLite any more — you pass `new PrismaBetterSqlite3({
   url })` (note the lower-case `qlite`; the export is `PrismaBetterSqlite3`).
3. **The generator is `prisma-client`, not `prisma-client-js`, and it needs an
   `output` path.** `prisma-client-js` still generates without a warning on
   7.10.0, but it writes into `node_modules`, which Prisma 7 is moving away
   from. This example uses the current form:

   ```prisma
   generator client {
     provider = "prisma-client"
     output   = "../src/generated/prisma"
   }
   ```

   That generator emits **TypeScript**, so the imports here are
   `./generated/prisma/client.ts`. There is still no build step: the annotations
   are type-only, and Node 24 strips them natively when it loads the file. On an
   older runtime you would need `tsc` or `tsx` — one more reason this example
   targets Node 24.

   `src/generated/` is git-ignored. Run `npm run setup` after a fresh clone, or
   any time you change `schema.prisma`.
