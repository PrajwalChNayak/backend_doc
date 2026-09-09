# db-mongodb — the official MongoDB driver

An Express 5 API over `mongodb@7`. It covers the operational basics — one reused
`MongoClient`, indexes created at boot, projections that never leak a password hash —
and then spends most of its effort on the failure mode that actually gets Mongo-backed
APIs breached: **operator injection**.

## What it demonstrates

| Thing | Where |
| --- | --- |
| A single `MongoClient` for the process, with fail-fast timeouts | `src/db.js` |
| `createIndex` at boot, including the `unique` index that backs the 409 | `src/db.js` |
| CRUD with `insertOne` / `findOne` / `findOneAndUpdate` / `deleteOne` | `src/app.js` |
| `projection: { passwordHash: 0 }` on every read | `src/app.js` |
| `$set` with a whitelisted field instead of spreading `req.body` | `PATCH /users/:id` |
| Manual cascade — Mongo has no foreign keys | `DELETE /users/:id` |
| **Operator-injection-proof login** | `POST /login` |
| Constant-time password comparison with `node:crypto` scrypt | `src/password.js` |
| Every route answering `503` — fast — when Mongo is unreachable | `isDatabaseUnavailable()` in `src/db.js`, the error handler in `src/app.js` |

## Prerequisites

Node 24 and a MongoDB server.

```bash
docker run --rm -p 27017:27017 mongo:8
```

Default `MONGODB_URL` is `mongodb://localhost:27017`, database `backend_doc_example`
(override with `MONGODB_DB`).

**Without a database the example still starts.** It prints a connection-help block and
then serves in degraded mode: every route answers `503` immediately, naming the
`docker run` line above. Set `REQUIRE_DB=1` for the other policy — print the help and
exit 1, which is what you want from a container an orchestrator will restart.

## When MongoDB is not running

A route that blocks on a dead database is worse than a route that fails. It holds a
socket, it makes health checks meaningless, and one dependency outage becomes a total
outage. So the client is given a short `serverSelectionTimeoutMS` (3s, against a 30s
default) and a short `connectTimeoutMS`, and the error handler maps every "cannot reach
the server" error to a `503`:

```bash
PORT=3013 npm start          # with nothing listening on 27017

curl -s -m 8 -w '\n%{http_code} %{time_total}s\n' localhost:3013/health
curl -s -m 8 -w '\n%{http_code} %{time_total}s\n' localhost:3013/users
```

```text
{"status":"degraded","database":"unreachable","hint":"start MongoDB with: docker run --rm -p 27017:27017 mongo:8"}
503 0.014191s
{"error":"database unreachable","database":"mongodb","url":"mongodb://localhost:27017","detail":"Topology is closed","hint":"start MongoDB with: docker run --rm -p 27017:27017 mongo:8"}
503 0.012800s
```

Two different failures reach that handler, and you need both:

| Situation | Driver error | Time to the 503 |
| --- | --- | --- |
| Mongo was down when the process started | `MongoTopologyClosedError` — the driver gave up and closed its own topology, so every later operation fails instantly | milliseconds |
| Mongo died while the process was running | `MongoServerSelectionError` | up to `serverSelectionTimeoutMS` (3s) |

Matching only `MongoServerSelectionError` leaves the first case as a `500` with a stack
trace. `isDatabaseUnavailable()` in `src/db.js` covers both, plus the network errors.

Routes that never touch the database keep working while degraded — validation still
returns `400`, unknown paths still return `404`. When Mongo comes back **after** a
successful start, the driver reconnects on its own and `/health` returns `200` again;
when it was already down at start-up the client has closed itself, so restart the
process once Mongo is up.

## Install and run

```bash
cd examples/db-mongodb
npm install
npm start
```

Default port **3013** (`PORT`).

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `db.command({ ping: 1 })`; 503 when Mongo is down |
| — | any route below | `503` with the `docker run` hint while Mongo is unreachable |
| GET | `/users?limit=` | list (never returns `passwordHash`) |
| POST | `/users` | register: email, name, password |
| GET | `/users/:id` | fetch one by ObjectId |
| PATCH | `/users/:id` | rename — one whitelisted field |
| DELETE | `/users/:id` | delete + cascade to posts |
| POST | `/users/:id/posts` | add a post |
| GET | `/users/:id/posts` | that user's posts, newest first |
| POST | `/login` | the injection-resistant login |

### Health

```bash
curl -s localhost:3013/health
```

```json
{"status":"ok","database":"up","latencyMs":1}
```

### Register and log in

```bash
curl -s -X POST localhost:3013/users -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada","password":"correct horse battery"}'
# 201 {"user":{"id":"...","email":"ada@example.com","name":"Ada","createdAt":"..."}}

curl -s -X POST localhost:3013/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery"}'
# 200 {"user":{...}}
```

### The exploit this example blocks

```bash
curl -s -X POST localhost:3013/login -H 'content-type: application/json' \
  -d '{"email":{"$gt":""},"password":{"$ne":null}}'
```

```json
{"error":"validation failed","issues":[{"expected":"string","code":"invalid_type","path":["email"],"message":"Invalid input: expected string, received object"},{"expected":"string","code":"invalid_type","path":["password"],"message":"Invalid input: expected string, received object"}]}
```

`400`, before a single query is built — which is why this response comes back even when
MongoDB is not running at all.

## The security point — NoSQL operator injection

MongoDB filters are **documents**, not strings. There is no query text for a quote to
break out of, so the classic SQL-injection payloads do nothing. The equivalent attack is
different and subtler: get an *operator* where the application expected a *value*.

`express.json()` will parse this body without complaint:

```json
{"email": {"$gt": ""}, "password": {"$ne": null}}
```

A login route that trusts `req.body` sends the driver this filter:

```js
// DO NOT COPY — this is the vulnerable version
await users.findOne({ email: req.body.email, password: req.body.password })
// → { email: { $gt: '' }, password: { $ne: null } }
```

That is a valid query meaning *"any user whose email sorts above the empty string and
whose password is not null"* — in other words, every user in the collection. `findOne`
returns the first one, and the attacker is authenticated as them without knowing a
single character of a password. Swap in `{"$regex":"^a"}` and the same route becomes an
oracle for extracting a real value one character at a time.

Three things stop it here, in order of importance:

1. **Validate and coerce before the value can reach a filter.** `Credentials.parse()`
   runs `z.string()` over `email` and `password`. Zod rejects objects and arrays
   outright, so the request is a `400` before any query exists. This is the actual fix —
   the other two are defence in depth.
2. **Say `$eq` explicitly.** `{ email: { $eq: email } }` compares the value as a literal.
   If a non-string ever reached that line, it would be matched as data instead of being
   interpreted as an operator document.
3. **Never put the password in the query at all.** The filter selects on email; the
   password is compared to a stored hash in Node, in constant time. A password that is
   part of a query is a password an attacker can probe with `$regex`.

The same rule covers `$where`, `$expr` and `mapReduce`: they accept JavaScript, and
nothing user-controlled belongs anywhere near them.

`PATCH /users/:id` shows the other half of the same idea — `$set: { name }` rather than
`$set: req.body`. Spreading a request body into `$set` is mass assignment, and lets a
client write `passwordHash` or `role` directly.

## Production considerations

- One `MongoClient`, created once. It owns the pool and the topology monitor; per-request
  clients mean per-request server discovery.
- `serverSelectionTimeoutMS` defaults to 30 seconds. That is 30 seconds of hung requests
  when the primary disappears — lower it (3s here, with a matching `connectTimeoutMS`)
  so failures are fast and visible. Every operation waits on server selection, so this
  number is the worst-case latency of every route during an outage.
- Map the driver's unreachable-database errors to `503` in one place, in the error
  handler. Express 5 forwards rejected promises there by itself, so one branch covers
  every route — and a `503` tells a load balancer to take the instance out of rotation,
  which a `500` does not.
- Do not exit the process because a dependency is down unless something will restart it.
  A process that answers `503` is diagnosable; a closed port is not.
- `createIndex` is idempotent, but building an index on a large existing collection
  blocks writes. Create indexes in a migration for anything real, not at boot.
- A `unique` index is the only thing that makes uniqueness true. Application-level
  "check then insert" always loses the race.
- Mongo has no foreign keys and no `ON DELETE CASCADE`. `DELETE /users/:id` deletes the
  posts explicitly; if that consistency matters, do both in a transaction (which needs a
  replica set — a single `mongo:8` container is not one).
