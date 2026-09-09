# db-sqlite — `node:sqlite` and `better-sqlite3`, side by side

One Express 5 API, two SQLite drivers, identical routes. Mount `/node-sqlite/*` to
hit the driver that ships with Node, `/better-sqlite3/*` to hit the native addon.
Each driver owns its own file in `data/`, so the two halves cannot interfere.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `node:sqlite` `DatabaseSync` (built in, Node 22.5+) | `src/node-sqlite-store.js` |
| `better-sqlite3@13` | `src/better-sqlite3-store.js` |
| `PRAGMA foreign_keys = ON` and why it is not the default | both stores |
| `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout` | both stores |
| Prepared statements cached at startup, not per request | `stmts` object in both stores |
| Named parameters (`:email` / `@email`) | `insertUser` in both stores |
| Positional parameters (`?`) | `getUser`, `insertPost` |
| A transaction, hand-rolled | `createUserWithPosts` in `node-sqlite-store.js` |
| A transaction, via `db.transaction()` | `better-sqlite3-store.js` |
| Allow-listed `ORDER BY` identifier | `listUsers` in both stores |
| Constraint errors mapped to `409` (the two drivers report them differently) | `src/app.js` |
| An idempotent boot seed, applied to *both* files | `src/seed.js`, called from `src/server.js` |

## Prerequisites

Node 24. No database server, no Docker — SQLite is a file.

`node:sqlite` needs no install at all. `better-sqlite3` is a native addon; version 13
publishes Node-API prebuilt binaries, so `npm install` does not need a C++ toolchain
on common platforms.

## Install and run

```bash
cd examples/db-sqlite
npm install
npm start
npm test          # 12 tests, both drivers
```

Default port is **3010**; override with `PORT`. The database files are written to
`examples/db-sqlite/data/` (override with `DATA_DIR`). Delete that directory to start over.

`npm test` runs `test/stores.test.js`, which drives both stores through the same
HTTP surface with `node:test` + `supertest` and asserts they agree. It also asserts
the two SQL-safety properties this example exists to show: a `sort` column outside
the allow-list is rejected with `400`, and a name containing `Robert'); DROP TABLE
users;--` is stored and returned verbatim with no table dropped. Each run uses its
own temporary database files, so it does not touch `data/`.

## Seed data

Each driver owns a **separate file**, so there is no shared database to seed once — the
seed in `src/seed.js` runs against both stores at boot, through each store's own
`createUserWithPosts()` transaction. Both halves therefore start with identical rows:
user `1` Ada (two posts) and user `2` Grace (one post).

The seed looks each user up by its unique email before inserting, so restarting the
server against an existing `data/` directory inserts nothing and throws nothing:

```text
db-sqlite listening on http://localhost:3010
  data directory: .../examples/db-sqlite/data
  seed node:sqlite: 0 user(s) inserted, 2 total
  seed better-sqlite3: 0 user(s) inserted, 2 total
```

## Routes

`{driver}` below is either `node-sqlite` or `better-sqlite3`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + a row count from both drivers |
| GET | `/{driver}/users?sort=&direction=&limit=` | list, with an allow-listed sort column |
| POST | `/{driver}/users` | create one user |
| GET | `/{driver}/users/:id` | fetch one |
| DELETE | `/{driver}/users/:id` | delete (cascades to posts) |
| GET | `/{driver}/users/:id/posts` | that user's posts |
| POST | `/{driver}/users-with-posts` | user + posts in one transaction |

### Health

```bash
curl -s localhost:3010/health
```

```json
{"status":"ok","drivers":{"node:sqlite":{"ok":true,"users":2},"better-sqlite3":{"ok":true,"users":2}}}
```

### The same rows through either driver

```bash
curl -s localhost:3010/node-sqlite/users/1/posts
curl -s localhost:3010/better-sqlite3/users/1/posts
```

Both return the seeded posts; only the `driver` field differs:

```json
{"driver":"node:sqlite","posts":[{"id":1,"user_id":1,"title":"Notes on the Analytical Engine","body":"Note G describes the first algorithm.","created_at":"2026-09-09 09:57:29"},{"id":2,"user_id":1,"title":"On Bernoulli numbers","body":"A worked example for the engine.","created_at":"2026-09-09 09:57:29"}]}
```

### Create a user (named parameters)

```bash
curl -s -X POST localhost:3010/node-sqlite/users \
  -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan"}'
```

```json
{"driver":"node:sqlite","user":{"id":3,"email":"alan@example.com","name":"Alan","created_at":"2026-09-09 09:59:07"}}
```

### The transaction

```bash
curl -s -X POST localhost:3010/better-sqlite3/users-with-posts \
  -H 'content-type: application/json' \
  -d '{"email":"cobol@example.com","name":"Grace again","posts":[{"title":"Compilers"},{"title":"COBOL","body":"data division"}]}'
```

```json
{"driver":"better-sqlite3","user":{"id":3,"email":"cobol@example.com","name":"Grace again","created_at":"2026-09-09 09:59:07"},"posts":[{"id":4,"user_id":3,"title":"Compilers","body":"","created_at":"2026-09-09 09:59:07"},{"id":5,"user_id":3,"title":"COBOL","body":"data division","created_at":"2026-09-09 09:59:07"}]}
```

If any insert in the body fails, the whole thing rolls back and no user is created.

### The unique constraint becomes a 409, not a 500

`ada@example.com` is seeded at boot, so this fails on a fresh database too:

```bash
curl -s -X POST localhost:3010/node-sqlite/users \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada again"}' -w ' [%{http_code}]\n'
```

```json
{"error":"constraint violation","detail":"UNIQUE constraint failed: users.email"} [409]
```

## The SQL-safety point

Every value in this example is bound, never interpolated — `?` for positional,
`:name` / `@name` for named. That covers user input completely, with one exception
that SQL itself creates: **you cannot bind an identifier.** `ORDER BY ?` does not
work, so a client-chosen sort column has to be validated against a fixed list before
it goes anywhere near the string:

```js
if (!SORTABLE_USER_COLUMNS.has(sort)) throw Object.assign(new Error('...'), { status: 400 })
const dir = direction === 'desc' ? 'DESC' : 'ASC'
// lint-sql:allow sort is validated against SORTABLE_USER_COLUMNS and dir is a literal
const sql = `SELECT id, email, name, created_at FROM users ORDER BY ${sort} ${dir} LIMIT ?`
```

The `Set` is the security control; the `// lint-sql:allow` comment is only what tells
`scripts/lint-sql.mjs` the interpolation was deliberate. Try it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3010/better-sqlite3/users?sort=;DROP+TABLE+users"
# 400
```

## Choosing between the two

| | `node:sqlite` | `better-sqlite3` |
| --- | --- | --- |
| Install | none, built in | native addon (prebuilt binaries) |
| Available from | Node 22.5 | any |
| Transactions | you write `BEGIN`/`COMMIT`/`ROLLBACK` | `db.transaction(fn)`, nests as SAVEPOINTs |
| Extras | smaller surface | `pluck()`, `expand()`, user-defined functions, backups |
| Both | synchronous, single-process, no pool | |

Neither is asynchronous. SQLite calls block the event loop for the duration of the
query — which is microseconds for indexed lookups, and a real problem for a full table
scan over a large file. That is a property of SQLite in-process, not of either binding.
