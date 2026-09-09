# orm-mongoose — Mongoose 9, and operator injection

An Express 5 API over `mongoose@9` with a `users` / `posts` one-to-many relation.
Five sibling examples (`orm-prisma`, `orm-drizzle`, `orm-typeorm`,
`orm-sequelize`, `orm-knex`) expose the **same routes over the same domain**, so
you can diff them against each other.

This is the one example in the set that needs a running server, and the one where
the injection story is different: there is no SQL to inject into. The equivalent
attack is **operator injection**, and it is easier to hit, because the payload is
just JSON.

## What it demonstrates

| Thing | Where |
| --- | --- |
| Schemas with `strict: 'throw'`, a unique index and a `toJSON` transform | `src/models.js` |
| A **virtual populate** (`posts` is a reverse lookup, not a stored field) | `src/models.js` |
| One connection for the process, with fail-fast timeouts | `src/db.js` |
| `mongoose.set('sanitizeFilter', true)` | `src/db.js` |
| Awaiting `createIndexes()` so the unique index really exists before traffic | `src/db.js` |
| Idempotent seed data, at boot and via `npm run seed` | `src/seed.js` |
| CRUD, with `$set` on a named field instead of spreading `req.body` | `src/app.js` |
| Eager loading with `populate()` — and why it is a second query, not a join | `GET /users/:id`, `GET /posts` |
| A **manual cascade** — MongoDB has no `ON DELETE` | `DELETE /users/:id` |
| A multi-document transaction with `session.withTransaction()` | `POST /users-with-posts` |
| The "raw" hatch: an aggregation pipeline built from validated primitives | `GET /stats/authors` |
| **Operator injection, and the three layers that stop it** | `POST /users/search` |
| E11000 mapped to 409, `CastError` to 400, no stack traces to clients | error handler in `src/app.js` |

## Prerequisites

Node 24 **and a running MongoDB server**.

```bash
docker run --rm -p 27017:27017 mongo:8
```

`POST /users-with-posts` is a multi-document transaction, and MongoDB supports
those only on a **replica set** or a sharded cluster. A standalone server is
neither, so start it as a one-node replica set if you want that route to work:

```bash
docker run --rm -p 27017:27017 mongo:8 --replSet rs0 --bind_ip_all
docker exec -it $(docker ps -qf ancestor=mongo:8) mongosh --eval 'rs.initiate()'
```

Against a standalone server the route answers **501** with that command in the
body, rather than a 500 — it is a deployment fact, not a bad request.

Defaults: `MONGODB_URL=mongodb://127.0.0.1:27017`, database
`orm_mongoose_example` (`MONGODB_DB`).

### When MongoDB is not running

The process prints a block you can act on and exits 1 — no stack trace:

```text
orm-mongoose listening on http://localhost:3024

  Cannot reach MongoDB — orm-mongoose needs a running server.

    MONGODB_URL : mongodb://127.0.0.1:27017
    database    : orm_mongoose_example
    error       : MongooseServerSelectionError — connect ECONNREFUSED 127.0.0.1:27017

  Start one with Docker:

    docker run --rm -p 27017:27017 mongo:8
  …
```

Set `DEGRADED_OK=1` to keep the process up instead: `/health` answers
`503 {"status":"degraded"}` and every other route answers 503. That is the shape
a readiness probe wants — a process that refuses connections looks dead rather
than "not ready yet".

## Install and run

```bash
cd examples/orm-mongoose
npm install
npm start
```

Default port **3024**; override with `PORT`.

```text
orm-mongoose listening on http://localhost:3024
[mongoose] connected to mongodb://127.0.0.1:27017/orm_mongoose_example
  seed:         inserted fixtures
  transactions: available (replica set)
```

```bash
npm run seed       # re-run the seed by hand (no-op if documents exist)
```

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | ping; 503 when Mongo is down |
| GET | `/users?sort=&direction=&limit=` | list, allow-listed sort field |
| POST | `/users` | create one |
| POST | `/users/search` | **the operator-injection demonstration** |
| GET | `/users/:id` | fetch one **with its posts** (`populate`) |
| PATCH | `/users/:id` | rename (`$set`, one field) |
| DELETE | `/users/:id` | delete + manual cascade to posts |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users/:id/posts` | add a post |
| GET | `/posts?authorEmail=&limit=` | posts with the author populated |
| POST | `/users-with-posts` | user + posts in one transaction (needs a replica set) |
| GET | `/stats/authors?minPosts=` | an aggregation pipeline |

### Health

```bash
curl -s localhost:3024/health
```

```json
{"status":"ok","orm":"mongoose","users":2}
```

### Eager loading with populate

```bash
curl -s localhost:3024/users/6aa131146e20ad19896f6167
```

```json
{"orm":"mongoose","user":{"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-09T10:12:36.352Z","updatedAt":"2026-09-09T10:12:36.352Z","posts":[{"title":"Note G","body":"The first published algorithm.","author":"6aa131146e20ad19896f6167","createdAt":"2026-09-09T10:12:36.369Z","updatedAt":"2026-09-09T10:12:36.369Z","id":"6aa131146e20ad19896f6168"},{"title":"On the Analytical Engine","body":"","author":"6aa131146e20ad19896f6167","createdAt":"2026-09-09T10:12:36.369Z","updatedAt":"2026-09-09T10:12:36.369Z","id":"6aa131146e20ad19896f6169"}],"id":"6aa131146e20ad19896f6167"}}
```

`populate()` is a **second query**, not a join — MongoDB has no joins outside the
aggregation framework. Populate the whole result set in one call, as `GET /posts`
does; populating inside a loop is the N+1 here.

### Create, and the unique index as a 409

```bash
curl -s -X POST localhost:3024/users -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan Turing"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"mongoose","user":{"email":"alan@example.com","name":"Alan Turing","createdAt":"2026-09-09T10:12:48.982Z","updatedAt":"2026-09-09T10:12:48.982Z","id":"6aa131206e20ad19896f616c"}} [201]
```

Repeat it:

```json
{"error":"constraint violation","detail":"duplicate email"} [409]
```

`unique: true` in a Mongoose schema is **not a validator** — it asks Mongoose to
build a unique index, and MongoDB is what rejects the duplicate (E11000). Two
consequences: the index has to actually exist — `src/db.js` awaits
`Model.createIndexes()` at boot — and a document written by any other client
bypasses every other schema rule you set.

> `mongoose.set('autoCreate', false)` is deliberate. With `bufferCommands: false`
> and models compiled before the connection opens, mongoose 9.9.5's autoCreate
> path throws `TypeError: Cannot read properties of undefined (reading
> 'createCollection')`. MongoDB creates the collection on first insert anyway;
> `createIndexes()` does the part that matters.

### The manual cascade

```bash
curl -s -X DELETE localhost:3024/users/6aa1315fe8667b01b27b3d87
```

```json
{"orm":"mongoose","deleted":{"user":1,"posts":2}}
```

MongoDB has no foreign keys and no `ON DELETE CASCADE`. Delete a user without
deleting their posts and you have documents whose `author` points at nothing —
the most common data-integrity bug in a Mongoose codebase, and one nothing will
warn you about.

### The transaction

```bash
curl -s -X POST localhost:3024/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"edsger@example.com","name":"Edsger","posts":[{"title":"GOTO"},{"title":"Shortest path","body":"1956"}]}' \
  -w ' [%{http_code}]\n'
```

```json
{"orm":"mongoose","user":{"email":"edsger@example.com","name":"Edsger","createdAt":"2026-09-09T10:13:51.547Z","updatedAt":"2026-09-09T10:13:51.547Z","id":"6aa1315fe8667b01b27b3d87"},"posts":[{"title":"GOTO","body":"","author":"6aa1315fe8667b01b27b3d87",…}]} [201]
```

On a standalone server:

```json
{"error":"transactions require a replica set","hint":"docker run --rm -p 27017:27017 mongo:8 --replSet rs0, then rs.initiate()"} [501]
```

Three things the API forces on you:

- `withTransaction()` **retries the whole callback** on a transient error, so the
  callback must be idempotent and must not touch anything outside the session.
- Every write inside takes `{ session }`. There is no ambient session.
- `Model.create([...], { session })` with more than one document also needs
  `ordered: true`, or Mongoose 9 throws
  *"Cannot call `create()` with a session and multiple documents unless
  `ordered: true` is set"*.
- `session.endSession()` belongs in a `finally`. An unended session holds
  server-side state.

## The safety point — operator injection

There is no SQL here, so there is no SQL injection. The equivalent hole is that
**JSON can carry an object where your code expected a string**, and in MongoDB an
object is a query operator.

```js vulnerable title="DO NOT COPY"
// POST /login  { "email": "ada@example.com", "password": { "$ne": null } }
const user = await User.findOne({ email: req.body.email, password: req.body.password })
if (user) return issueSession(user)
// `$ne: null` means "any password that is not null". The attacker is logged in.
```

Try it against this example, which does validate:

```bash
curl -s -X POST localhost:3024/users/search -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"mongoose","user":{"email":"ada@example.com","name":"Ada Lovelace",…}} [200]
```

```bash
curl -s -X POST localhost:3024/users/search -H 'content-type: application/json' \
  -d '{"email":{"$ne":null}}' -w ' [%{http_code}]\n'
```

```json
{"error":"validation failed","issues":[{"expected":"string","code":"invalid_type","path":["email"],"message":"Invalid input: expected string, received object"}]} [400]
```

Three independent layers produce that 400, and you want all three:

| Layer | Where | What it stops |
| --- | --- | --- |
| 1. Validate to a **primitive** | `z.object({ email: z.string() })` in `src/app.js` | an object ever reaching a filter |
| 2. State the operator | `{ email: { $eq: email } }` | a value supplying its own operator |
| 3. `sanitizeFilter` | `mongoose.set('sanitizeFilter', true)` in `src/db.js` | leftovers in routes that forgot 1 and 2 |

Layer 1 is the one that matters — the others are what save you the day someone
adds a route and forgets it. `sanitizeFilter` wraps any `$`-keyed object it finds
in a filter *value* with `$eq`, so `{"$ne": null}` becomes a search for a document
whose email literally equals that object, which matches nothing.

### What `sanitizeFilter` does not cover

- **`$where`.** It executes JavaScript on the server, and it really is string
  injection: `Model.find({ $where: "this.email === '" + email + "'" })` is
  remote code execution against your database. Never let user input near it.
- **Aggregation pipelines you assemble from request data.** A stage is a
  document; `Model.aggregate([{ $match: req.body }])` is the same hole in a
  different shape. `GET /stats/authors` builds its pipeline from a Zod-coerced
  number and nothing else.
- **Filters whose *keys* come from the client**, e.g. `Model.find(req.query)`.
  Allow-list the keys, not just the values.
- **Sort fields.** `?sort=` is a field name, not an operator, so it cannot inject
  — but it can expose a field you never meant to sort by or force a collection
  scan. It is allow-listed:

```bash
curl -s "localhost:3024/users?sort=%24where"
```

```json
{"error":"unsortable field: $where"}
```

Finally, `strict: 'throw'` on both schemas rejects a write containing an
undeclared field instead of silently dropping it, and `PATCH /users/:id` uses
`$set: { name }` rather than passing `req.body` — which would accept `$rename`,
`$unset` or any other update operator the client felt like sending.
