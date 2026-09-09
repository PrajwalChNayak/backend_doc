# orm-sequelize — Sequelize 6 over SQLite

An Express 5 API over `sequelize@6` with a `users` / `posts` one-to-many
relation. Five sibling examples (`orm-prisma`, `orm-drizzle`, `orm-typeorm`,
`orm-knex`, `orm-mongoose`) expose the **same routes over the same domain**, so
you can diff them against each other.

> Sequelize **7 is still alpha**. 6.37.8 is the current stable line and is what
> this example pins.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `sequelize.define()` models with `underscored` snake_case columns | `src/models.js` |
| `hasMany` / `belongsTo` with an explicit `as` alias on both sides | `src/models.js` |
| One `Sequelize` instance per process, plus SQLite pragmas | `src/db.js` |
| `sync()` for development, and why it is not a migration | `src/db.js` |
| Idempotent seed data, at boot and via `npm run seed` | `src/seed.js` |
| CRUD with `findAll` / `findByPk` / `create` / `update` / `destroy` | `src/app.js` |
| `fields: [...]` — mass-assignment protection on write | `POST /users`, `PATCH /users/:id` |
| Eager loading with `include`, including a `where` on the joined model | `GET /users/:id`, `GET /posts` |
| A nested create (`include` on `create()`) inside a transaction | `POST /users-with-posts` |
| **`replacements` vs `bind`** in `sequelize.query()` | `GET /stats/authors` |
| `UniqueConstraintError` / `ValidationError` mapped to 409 / 400 | error handler in `src/app.js` |

## Prerequisites

Node 24. **No database server** — SQLite is a file, written to `data/app.db`.

Sequelize 6's SQLite dialect uses the `sqlite3` package (not `better-sqlite3`),
so that is what is installed here. `sqlite3@6` ships prebuilt binaries; no C++
toolchain is needed on common platforms.

## Install and run

```bash
cd examples/orm-sequelize
npm install
npm start          # authenticate, sync the schema, seed, then listen
```

Default port **3023**; override with `PORT`. `DATABASE_FILE` moves the database.

```bash
npm run seed       # re-run the seed by hand (no-op if rows exist)
```

`sequelize.sync()` creates any missing table from the model definitions. Like
TypeORM's `synchronize`, it is a development convenience: it will not write the
migration you have to review, and `sync({ alter: true })` can drop a column it
does not recognise. Production uses `sequelize-cli@6.6.5` migrations.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + a row count |
| GET | `/users?sort=&direction=&limit=` | list, allow-listed sort column |
| POST | `/users` | create one |
| GET | `/users/:id` | fetch one **with its posts** (`include`) |
| PATCH | `/users/:id` | rename |
| DELETE | `/users/:id` | delete (cascades to posts) |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users/:id/posts` | add a post via the association mixin |
| GET | `/posts?authorEmail=&limit=` | posts with the author eager-loaded |
| POST | `/users-with-posts` | user + posts in one transaction |
| GET | `/stats/authors?minPosts=` | `sequelize.query()` with `bind` |

### Health

```bash
curl -s localhost:3023/health
```

```json
{"status":"ok","orm":"sequelize","users":2}
```

### Eager loading

```bash
curl -s localhost:3023/users/1
```

```json
{"orm":"sequelize","user":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-09T10:06:27.145Z","updatedAt":"2026-09-09T10:06:27.145Z","posts":[{"id":1,"title":"Note G","body":"The first published algorithm.","createdAt":"2026-09-09T10:06:27.160Z","updatedAt":"2026-09-09T10:06:27.160Z","userId":1},{"id":2,"title":"On the Analytical Engine","body":"","createdAt":"2026-09-09T10:06:27.160Z","updatedAt":"2026-09-09T10:06:27.160Z","userId":1}]}}
```

`include` is one query with a LEFT JOIN. The N+1 is `findAll()` with no
`include`, then `await user.getPosts()` inside a loop — one query per row, which
looks fine on ten rows and falls over on ten thousand.

A `where` on an include turns the LEFT JOIN into an INNER JOIN:

```bash
curl -s "localhost:3023/posts?authorEmail=grace@example.com"
```

```json
{"orm":"sequelize","posts":[{"id":3,"title":"Compilers","body":"A compiler translates, it does not interpret.","createdAt":"2026-09-09T10:06:27.167Z","updatedAt":"2026-09-09T10:06:27.167Z","userId":2,"author":{"id":2,"email":"grace@example.com","name":"Grace Hopper"}}]}
```

### Create, and the unique constraint as a 409

```bash
curl -s -X POST localhost:3023/users -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan Turing"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"sequelize","user":{"id":3,"email":"alan@example.com","name":"Alan Turing","updatedAt":"2026-09-09T10:06:41.911Z","createdAt":"2026-09-09T10:06:41.911Z"}} [201]
```

Repeat it:

```json
{"error":"constraint violation","detail":"email must be unique"} [409]
```

Sequelize normalises driver errors into its own classes, so the same
`UniqueConstraintError` check works on SQLite, Postgres and MySQL. Note the
ordering in the error handler: `UniqueConstraintError` **extends**
`ValidationError`, so it has to be tested first or every 409 becomes a 400.

### The transaction

```bash
curl -s -X POST localhost:3023/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"edsger@example.com","name":"Edsger","posts":[{"title":"GOTO"},{"title":"Shortest path","body":"1956"}]}' \
  -w ' [%{http_code}]\n'
```

```json
{"orm":"sequelize","user":{"id":4,"email":"edsger@example.com","name":"Edsger","posts":[{"id":4,"title":"GOTO","body":"","userId":4,"updatedAt":"2026-09-09T10:06:42.330Z","createdAt":"2026-09-09T10:06:42.330Z"},{"id":5,"title":"Shortest path","body":"1956","userId":4,"updatedAt":"2026-09-09T10:06:42.330Z","createdAt":"2026-09-09T10:06:42.330Z"}],"updatedAt":"2026-09-09T10:06:42.325Z","createdAt":"2026-09-09T10:06:42.325Z"}} [201]
```

Sequelize has **no ambient transaction**. Every query inside the callback must be
passed `{ transaction }` explicitly; one that forgets runs on a different
connection and is not rolled back with the rest. (`cls-hooked` can make it
implicit, at the cost of a global.)

### The raw query

```bash
curl -s "localhost:3023/stats/authors?minPosts=1"
```

```json
{"orm":"sequelize","authors":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","post_count":2},{"id":4,"email":"edsger@example.com","name":"Edsger","post_count":2},{"id":2,"email":"grace@example.com","name":"Grace Hopper","post_count":1}]}
```

## The SQL-safety point — `replacements` vs `bind`

`sequelize.query()` has two parameter mechanisms. Both are injection-safe. They
are not the same thing, and the difference decides which one you want.

| | `replacements` | `bind` |
| --- | --- | --- |
| Placeholder | `:name` or `?` | `$1`, `$2` (`$name` also works) |
| Who substitutes | **Sequelize**, into the SQL string, escaping per dialect | **the database driver**, values sent separately |
| Statement sent | one finished string containing your data | SQL text + a parameter list |
| Expands a list (`IN (:ids)`) | yes | no |
| Usable where the driver forbids a placeholder | yes | no |
| Plan caching | weaker — the text differs per call | stronger — same text every call |

```js good title="bind — src/app.js"
await sequelize.query(
  'SELECT … FROM users u … HAVING COUNT(p.id) >= $1 …',
  { bind: [minPosts], type: QueryTypes.SELECT },
)
```

```js good title="replacements — the same query, equally safe"
await sequelize.query(
  'SELECT … FROM users u … HAVING COUNT(p.id) >= :minPosts …',
  { replacements: { minPosts }, type: QueryTypes.SELECT },
)
```

You cannot mix the two in one call.

What is *not* safe, with either option present in the object, is building the
string yourself:

```js vulnerable title="DO NOT COPY"
const email = req.query.email
const rows = await sequelize.query(
  `SELECT * FROM users WHERE email = '${email}'`,
  { type: QueryTypes.SELECT },
)
// ?email=x' OR '1'='1  returns every user
```

```js good title="the fix"
const rows = await sequelize.query(
  'SELECT * FROM users WHERE email = $1',
  { bind: [email], type: QueryTypes.SELECT },
)
```

### The model layer, and the one thing you still have to check

`where: { email }` is parameterised, so the ordinary model API is not injectable.
The gap is the `order` clause: it is an **identifier**, which SQL cannot bind.
Sequelize quotes what you give it, but quoting is not validation — a client could
still name a column you never meant to sort by, or force a scan on an unindexed
one. Check it first:

```js title="src/models.js"
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])
```

```bash
curl -s "localhost:3023/users?sort=name;DROP+TABLE+users"
```

```json
{"error":"unsortable column: name;DROP TABLE users"}
```

The other write-side control is `fields`: `User.create(body, { fields: ['email',
'name'] })` pins exactly which columns a request may set. Without it,
`User.create(req.body)` accepts any attribute the model has — `id` included.
