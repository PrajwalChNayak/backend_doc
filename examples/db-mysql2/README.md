# db-mysql2 — MySQL with mysql2/promise

An Express 5 API over `mysql2@3` using the promise API. It shows the pool settings that
matter, why you should reach for `execute()` before `query()`, how to run a transaction
without leaking a connection, and how to get the new row's id out of MySQL, which has
no `RETURNING`.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `mysql.createPool()` with `connectionLimit`, `waitForConnections`, `queueLimit` | `src/db.js` |
| `multipleStatements: false` set **explicitly** | `src/db.js` |
| `execute()` with `?` placeholders everywhere | `src/app.js` |
| `withTransaction(fn)` — `getConnection` + `try/finally release()` | `src/db.js` |
| `insertId` and `affectedRows` from the OkPacket | `POST /users`, `PUT /users` |
| `INSERT … AS new ON DUPLICATE KEY UPDATE` (the non-deprecated upsert form) | `PUT /users` |
| Bulk insert with `VALUES ?` via `query()` | `POST /users-with-posts` |
| MySQL error codes mapped to HTTP status | error handler in `src/app.js` |

## Prerequisites

Node 24 and a MySQL server.

```bash
docker run --rm -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=appdb -p 3306:3306 mysql:9
```

First boot takes roughly 20 seconds while MySQL initialises the data directory. Wait for
`ready for connections` in the container log.

That container matches this example's default `MYSQL_URL`:
`mysql://root:mysql@localhost:3306/appdb`.

**Without a database the example prints a connection-help block and exits 1.** Set
`DEGRADED_OK=1` to keep serving with `/health` returning `503 {"status":"degraded"}`.

## Install and run

```bash
cd examples/db-mysql2
npm install
npm start
npm run migrate     # DDL only
```

Default port **3012** (`PORT`). Connection string from `MYSQL_URL`.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `SELECT 1`; 503 when MySQL is down |
| GET | `/users?limit=&q=` | list / search |
| GET | `/users/:id` | fetch one |
| POST | `/users` | insert, returns `insertId` |
| PUT | `/users` | upsert by email |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users-with-posts` | user + bulk posts in one transaction |
| POST | `/rollback-demo` | forces a duplicate key and proves the rollback |

### Health

```bash
curl -s localhost:3012/health
```

```json
{"status":"ok","database":"up","latencyMs":1}
```

### Create — `insertId` instead of `RETURNING`

```bash
curl -s -X POST localhost:3012/users -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada"}'
```

```json
{"insertId":1,"affectedRows":1,"user":{"id":1,"email":"ada@example.com","name":"Ada","created_at":"2026-09-08T18:22:03.000Z"}}
```

### Transaction with a bulk insert

```bash
curl -s -X POST localhost:3012/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"grace@example.com","name":"Grace","posts":[{"title":"Compilers"},{"title":"COBOL"}]}'
```

### Rollback proof

```bash
curl -s -X POST localhost:3012/rollback-demo -H 'content-type: application/json' \
  -d '{"email":"dup@example.com","name":"Dup"}'
# {"rolledBack":true,"rowsWithThatEmail":0,"note":"InnoDB undid both inserts, so the count is 0"}
```

## The SQL-safety point — why `execute()` and not `query()`

Both are safe when you pass values as the second argument. They are safe for **different
reasons**, and that difference is the whole answer:

| | `conn.query(sql, values)` | `conn.execute(sql, values)` |
| --- | --- | --- |
| How the values get in | mysql2 escapes them and splices them into the SQL text **in Node** | sent to MySQL as a separate binary payload; the server never re-parses them |
| Protocol | text protocol, one round trip | `COM_STMT_PREPARE` + `COM_STMT_EXECUTE`, statement cached per connection |
| Repeated queries | re-parsed by the server every time | parsed once, reused |
| `?` for identifiers / lists | supports `??` identifiers and nested-array `VALUES ?` | values only |

`execute()` is the default choice because correctness does not depend on mysql2's
escaping being perfect for your charset and column type — the value is never part of the
statement. Use `query()` deliberately, for the two things prepared statements cannot
express: DDL, and the nested-array bulk `VALUES ?` form (both appear in this example,
neither takes user input into the SQL text).

**Never build the SQL string yourself.** These are the same query, and only one of them
survives `?id=1 OR 1=1`:

```js
// unsafe — do not copy
const [rows] = await pool.query('SELECT * FROM users WHERE id = ' + req.params.id)

// safe
const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id])
```

`multipleStatements` is set to `false` explicitly in `src/db.js` even though that is
already the default. With it on, an injected `;` does not just leak a row — it lets the
attacker append an entirely new statement.

## Production considerations

- `queueLimit: 0` means an unbounded backlog. When MySQL slows down, an unbounded queue
  turns latency into an out-of-memory crash. Bound it and shed load instead.
- `connectionLimit` is per Node process. Multiply by your instance count and compare
  against MySQL's `max_connections` (151 by default).
- Prepared statements are cached **per connection**. A pool of 10 connections holds up
  to 10 copies of each statement; MySQL's `max_prepared_stmt_count` (16382 server-wide)
  is the ceiling, and generating dynamic SQL per request is what exhausts it.
- `pool.end()` on SIGTERM drains in-flight queries. Exiting without it drops them.
- MySQL's `TIMESTAMP` range ends in 2038. Use `DATETIME` if you store dates past that.
