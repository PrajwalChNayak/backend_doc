# orm-knex — Knex 3 as a query builder over SQLite

An Express 5 API over `knex@3` with a `users` / `posts` one-to-many relation.
Five sibling examples (`orm-prisma`, `orm-drizzle`, `orm-typeorm`,
`orm-sequelize`, `orm-mongoose`) expose the **same routes over the same domain**,
so you can diff them against each other.

Knex is **not an ORM**. There are no models, no identity map, no lazy loading and
no relations. What it gives you is a dialect-independent way to build
parameterised SQL, plus migrations and seeds. Everything an ORM does for you —
including eager loading — you do by hand, which is more code and far fewer
surprises.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `knexfile.js` shared by the CLI and the app, so they cannot disagree | `knexfile.js` |
| SQLite pragmas in the pool's `afterCreate` hook | `knexfile.js` |
| A migration with a real `down`, using the schema builder | `migrations/20260909000000_init.js` |
| A re-runnable seed, in one transaction | `seeds/01_users_and_posts.js` |
| CRUD with the query builder, and `.returning()` | `src/app.js` |
| **Eager loading by hand** — two queries and a stitch | `GET /users/:id` |
| A `join` with aliased columns for the flat shape | `GET /posts` |
| A managed transaction (`knex.transaction(async trx => …)`) | `POST /users-with-posts` |
| `knex.raw()` with `?` value bindings and `??` identifier quoting | `GET /stats/authors` |

## Prerequisites

Node 24. **No database server** — SQLite is a file, written to `data/app.db`.

The client is `better-sqlite3@13`, a first-class Knex client that ships Node-API
prebuilt binaries, so `npm install` needs no C++ toolchain. The older `sqlite3`
client works too; it is asynchronous and slower for the small queries an API
actually makes.

## Install and run

```bash
cd examples/orm-knex
npm install
npm start          # migrates and seeds at boot, then listens
```

Default port **3025**; override with `PORT`. `DATABASE_FILE` moves the database.

The separate steps:

```bash
npm run migrate    # node src/migrate.js  — apply pending migrations
npm run seed       # node src/seed.js     — wipe and re-insert the fixtures
```

```text
orm-knex: batch 1 applied 1 migration(s): 20260909000000_init.js
orm-knex seed: ran 1 seed file(s): …/seeds/01_users_and_posts.js
```

Both scripts are plain `node` invocations rather than `knex migrate:latest` /
`knex seed:run`. The CLI does the same thing — `npx knex migrate:latest` works
here — but calling the API directly keeps the scripts identical on Windows and
POSIX and removes the CLI's ESM-knexfile resolution from the path. Use whichever
you prefer.

The seed clears `sqlite_sequence` after deleting rows. Deleting from an
`AUTOINCREMENT` table does **not** reset the counter, so without that line a
re-seeded database hands out ids starting at 4 and every fixture that hardcodes
id 1 breaks on the second run.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + a row count |
| GET | `/users?sort=&direction=&limit=` | list, allow-listed sort column |
| POST | `/users` | create one |
| GET | `/users/:id` | fetch one **with its posts** (two queries, stitched) |
| PATCH | `/users/:id` | rename |
| DELETE | `/users/:id` | delete (cascades to posts) |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users/:id/posts` | add a post |
| GET | `/posts?limit=` | posts joined to their author |
| POST | `/users-with-posts` | user + posts in one transaction |
| GET | `/stats/authors?minPosts=` | `knex.raw()` with `?` and `??` |

### Health

```bash
curl -s localhost:3025/health
```

```json
{"status":"ok","orm":"knex","users":2}
```

### Eager loading, the manual way

```bash
curl -s localhost:3025/users/1
```

```json
{"orm":"knex","user":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","created_at":"2026-09-09 10:01:36","posts":[{"id":1,"user_id":1,"title":"Note G","body":"The first published algorithm.","created_at":"2026-09-09 10:01:36"},{"id":2,"user_id":1,"title":"On the Analytical Engine","body":"","created_at":"2026-09-09 10:01:36"}]}}
```

That is two statements and a spread. More code than `include: { posts: true }` —
and the query count is impossible to get wrong by accident, because there is no
configuration that can turn it into N+1 behind your back.

The join form, when you want one flat row per post:

```bash
curl -s localhost:3025/posts
```

```json
{"orm":"knex","posts":[{"id":5,"title":"Shortest path","body":"1956","author":{"id":4,"email":"edsger@example.com","name":"Edsger"}},{"id":4,"title":"GOTO","body":"","author":{"id":4,"email":"edsger@example.com","name":"Edsger"}}]}
```

Alias every selected column in a join. `users.id` and `posts.id` collide in the
result object otherwise, and which one wins is not something you want to depend on.

### Create, and the unique constraint as a 409

```bash
curl -s -X POST localhost:3025/users -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan Turing"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"knex","user":{"id":3,"email":"alan@example.com","name":"Alan Turing","created_at":"2026-09-09 10:01:47"}} [201]
```

Repeat it:

```json
{"error":"constraint violation","detail":"UNIQUE constraint failed: users.email"} [409]
```

Knex prefixes the driver's error with the failing statement **and its bound
values**. `err.message` therefore contains other people's data and your schema —
the error handler sends only the part after the last `" - "`, and logs the rest.

### The transaction

```bash
curl -s -X POST localhost:3025/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"edsger@example.com","name":"Edsger","posts":[{"title":"GOTO"},{"title":"Shortest path","body":"1956"}]}' \
  -w ' [%{http_code}]\n'
```

```json
{"orm":"knex","user":{"id":4,"email":"edsger@example.com","name":"Edsger","created_at":"2026-09-09 10:01:48"},"posts":[{"id":4,"user_id":4,"title":"GOTO","body":"","created_at":"2026-09-09 10:01:48"},{"id":5,"user_id":4,"title":"Shortest path","body":"1956","created_at":"2026-09-09 10:01:48"}]} [201]
```

`knex.transaction(callback)` is the **managed** form: it commits when the
callback resolves and rolls back when it rejects. The unmanaged form —
`const trx = await knex.transaction()` — makes you call `trx.commit()` /
`trx.rollback()` yourself, and a missed rollback holds the SQLite write lock
until the pooled connection is destroyed.

### The raw query

```bash
curl -s "localhost:3025/stats/authors?minPosts=1"
```

```json
{"orm":"knex","authors":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","post_count":2},{"id":4,"email":"edsger@example.com","name":"Edsger","post_count":2},{"id":2,"email":"grace@example.com","name":"Grace Hopper","post_count":1}]}
```

## The SQL-safety point — `?` and `??`

`knex.raw()` takes bindings, and there are two placeholders:

| Placeholder | Binds | Result |
| --- | --- | --- |
| `?` | a **value** | sent to the driver as a parameter; never part of the SQL text |
| `??` | an **identifier** | quoted by Knex as a column or table name |

```js good title="src/app.js"
await knex.raw(
  `SELECT ??, ??, ??, COUNT(p.id) AS post_count
     FROM users u LEFT JOIN posts p ON p.user_id = u.id
    GROUP BY u.id HAVING COUNT(p.id) >= ?`,
  ['u.id', 'u.email', 'u.name', minPosts],
)
// `??` renders `u`.`id`, `u`.`email`, `u`.`name`; `?` binds minPosts.
```

Interpolate instead and the binding is gone:

```js vulnerable title="DO NOT COPY"
const email = req.query.email
const rows = await knex.raw(`SELECT * FROM users WHERE email = '${email}'`)
const same = await knex('users').whereRaw(`email = '${email}'`)
// ?email=x' OR '1'='1  returns every user
```

```js good title="the fix"
const rows = await knex.raw('SELECT * FROM users WHERE email = ?', [email])
const same = await knex('users').where({ email })
```

`whereRaw`, `havingRaw`, `orderByRaw` and `joinRaw` all take the same bindings
array. If a fragment needs a value, it takes a `?`.

### `??` is not a licence to accept a column name from a client

Identifier quoting stops the string breaking out of the identifier. It does not
stop a client naming `users.password_hash`, and it does not stop them forcing a
full scan by sorting on an unindexed column. Validate against a fixed list first:

```js title="src/db.js"
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])
```

```bash
curl -s "localhost:3025/users?sort=name;DROP+TABLE+users"
```

```json
{"error":"unsortable column: name;DROP TABLE users"}
```

Everything else in this example goes through the query builder — `.where({ id })`,
`.insert({ email, name })`, `.update({ name })` — which parameterises values and
quotes identifiers automatically. Note that `.update({ name })` names its column
deliberately: `.update(req.body)` would let a client write any column in the
table.
