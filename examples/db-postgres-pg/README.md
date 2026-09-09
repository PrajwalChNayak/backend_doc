# db-postgres-pg — PostgreSQL with node-postgres

An Express 5 API over `pg@8` showing the parts of node-postgres that decide whether a
service survives production: one shared `Pool`, `$1` placeholders everywhere, a
transaction helper that cannot leak a connection, an upsert, timeouts, and a health
check that answers even when the database is gone.

## What it demonstrates

| Thing | Where |
| --- | --- |
| A single process-wide `Pool` with `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` | `src/db.js` |
| `statement_timeout` and `idle_in_transaction_session_timeout` applied per connection | `src/db.js` |
| `pool.on('error')` — required, or a dead idle socket kills the process | `src/db.js` |
| `withTransaction(fn)` using `pool.connect()` + `try/finally client.release()` | `src/db.js` |
| `$1` placeholders for every value | all of `src/app.js` |
| `INSERT … ON CONFLICT (email) DO UPDATE … RETURNING` | `PUT /users` |
| `UNNEST($2::text[], $3::text[])` — bulk insert without building a VALUES list | `POST /users-with-posts` |
| `SELECT 1` health check with pool statistics | `GET /health` |
| Postgres SQLSTATE codes mapped to HTTP status | error handler in `src/app.js` |

## Prerequisites

Node 24 and a PostgreSQL server.

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
```

That gives you `postgres://postgres:postgres@localhost:5432/postgres`, which is this
example's default `DATABASE_URL`.

**Without a database this example prints a connection-help block and exits 1** — it does
not throw a stack trace. Set `DEGRADED_OK=1` to keep the process up instead; `/health`
then returns `503 {"status":"degraded"}`.

## Install and run

```bash
cd examples/db-postgres-pg
npm install
npm start                    # boots, probes, migrates
npm run migrate              # DDL only, no server
```

Default port **3011** (`PORT`). Connection string from `DATABASE_URL`.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `SELECT 1` + pool counters; 503 when the DB is down |
| GET | `/users?limit=&q=` | list / search |
| GET | `/users/:id` | fetch one |
| PUT | `/users` | upsert by email, returns 201 on insert / 200 on update |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users-with-posts` | user + posts in one transaction |
| POST | `/rollback-demo` | forces a unique violation and proves the rollback |

### Health

```bash
curl -s localhost:3011/health
```

```json
{"status":"ok","database":"up","latencyMs":2,"pool":{"total":1,"idle":1,"waiting":0}}
```

### Upsert

```bash
curl -s -X PUT localhost:3011/users -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada"}'
# 201  {"user":{...,"inserted":true}}

curl -s -X PUT localhost:3011/users -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada Lovelace"}'
# 200  {"user":{...,"name":"Ada Lovelace","inserted":false}}
```

`(xmax = 0) AS inserted` is the standard trick for telling an insert from an update in
an upsert's `RETURNING` clause: `xmax` is zero on a freshly inserted tuple.

### Transaction and rollback

```bash
curl -s -X POST localhost:3011/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"grace@example.com","name":"Grace","posts":[{"title":"Compilers"},{"title":"COBOL"}]}'
```

```bash
curl -s -X POST localhost:3011/rollback-demo -H 'content-type: application/json' \
  -d '{"email":"dup@example.com","name":"Dup"}'
# {"rolledBack":true,"rowsWithThatEmail":0,"note":"both inserts were undone, so the count is 0"}
```

### When Postgres is not running

```
  Cannot reach PostgreSQL.

    DATABASE_URL : postgres://postgres:postgres@localhost:5432/postgres
    error        : ECONNREFUSED — connect ECONNREFUSED ::1:5432

  Start one with Docker:

    docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
```

## The SQL-safety point

node-postgres sends parameterised statements to the server: the SQL text and the
values travel separately, so a value can never become syntax. Placeholders are
**numbered** (`$1`, `$2`) and the values go in an array:

```js
const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])
```

Two habits this example builds on top of that:

- **When the query shape varies, choose between whole statements** rather than gluing a
  `WHERE` clause together. `GET /users` has two complete queries, one with the search
  predicate and one without.
- **Wildcards belong in SQL, not in the parameter.** `email ILIKE '%' || $1 || '%'`
  concatenates inside the database, where `$1` is still just a string. Building
  `` `%${q}%` `` in JavaScript is not injectable either, but it hands the user control
  of `%` and `_`, which is a denial-of-service knob on a large table.

The one thing `$1` cannot do is stand in for an identifier — a table or column name.
This example never needs one; see `examples/db-sqlite` for the allow-list pattern when
you do.

## Production considerations

- `max` is per process. Four instances with `max: 10` means 40 backends on a server
  whose default `max_connections` is 100. Count them before you scale out, or put
  PgBouncer in front.
- `statement_timeout` is enforced by Postgres, so it actually cancels the query. A
  client-side `AbortController` only stops you waiting — the backend keeps burning CPU.
- `pool.end()` on SIGTERM lets in-flight queries finish. Exiting without it drops them.
- The `pool.on('error')` listener is not optional. An idle connection dropped by a
  database restart emits `error` on the pool, and an unhandled `'error'` event
  terminates the process.
