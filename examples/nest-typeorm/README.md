# nest-typeorm — @nestjs/typeorm 12 and TypeORM 1.1 over SQLite

A NestJS 12 API backed by TypeORM: two entities with a one-to-many relation,
repository injection, an eager-loaded relation, one real transaction, and not a
single query built by string concatenation.

**SQLite on purpose.** The example must run unattended with no database server.
Point `type` / `host` / `username` in `src/data-source.options.ts` at Postgres
and nothing above that file changes — which is the whole argument for an ORM.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `TypeOrmModule.forRoot()` — one DataSource for the process | `src/app.module.ts` |
| `TypeOrmModule.forFeature([...])` — repositories for a feature module | `src/users/users.module.ts` |
| `@InjectRepository(Entity)` / `@InjectDataSource()` | `src/users/users.service.ts` |
| Entity decorators, `@Index`, `@CreateDateColumn` | `src/users/user.entity.ts` |
| `@OneToMany` / `@ManyToOne` + `@JoinColumn({ name: 'user_id' })` | `src/posts/post.entity.ts` |
| Eager loading with `relations: { posts: true }` | `GET /users/:id` |
| The query builder with **named bind parameters** | `GET /users/search` |
| An aggregate with `HAVING :minPosts` | `GET /stats/authors` |
| A real transaction that rolls back | `POST /users-with-posts` |
| SQLite `PRAGMA foreign_keys = ON` so `onDelete: 'CASCADE'` is not decorative | `src/data-source.options.ts` |
| Unique-violation → 409 instead of 500 | `src/users/users.service.ts` |

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. No database server — the database is the file
`data/nest-typeorm.sqlite`, created on demand.

### One dependency note you will hit

`typeorm@1.1.1` declares `peerOptional better-sqlite3@^12.0.0`, and
`better-sqlite3@12` has **no prebuilt binary for Node 24 on Windows** — a plain
install either fails `ERESOLVE` or drops into `node-gyp`. This example therefore
carries:

```json
"overrides": { "typeorm": { "better-sqlite3": "^13.0.3" } }
```

Version 13 publishes Node-API prebuilds, so `npm install` needs no C++ toolchain.
Without the override the install ends with:

```
npm error Conflicting peer dependency: better-sqlite3@12.11.1
npm error peerOptional better-sqlite3@"^12.0.0" from typeorm@1.1.1
```

## Install, build, seed, run

```bash
cd examples/nest-typeorm
npm install
npm run setup     # = npm run build
npm run seed      # idempotent fixtures
npm start
```

```
seed complete: 3 users, 3 posts in C:\project\backend_doc\examples\nest-typeorm\data\nest-typeorm.sqlite
nest-typeorm listening on http://localhost:3033 (db: ...\data\nest-typeorm.sqlite)
```

Port **3033** (`PORT`), database file overridable with `DATABASE_FILE`, and
`TYPEORM_LOG=query` prints every statement TypeORM generates — the fastest way
to see what a `relations` option actually costs.

> `synchronize: true` is set here because the example is disposable. In
> production you generate migrations and run `migration:run`; `synchronize` will
> happily drop a column to make the schema match the classes.

## Routes

### `GET /health` and `GET /ready`

```bash
curl -s http://localhost:3033/health
curl -s http://localhost:3033/ready
```

```json
{"status":"ok"}
{"status":"ok","driver":"better-sqlite3"}
```

Liveness does not touch the database. Readiness runs `SELECT 1` — a fixed
string with no inputs.

### `GET /users?sort=&limit=&offset=`

```bash
curl -s 'http://localhost:3033/users?limit=2'
```

```json
{"data":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-11T18:32:06.000Z"},{"id":2,"email":"grace@example.com","name":"Grace Hopper","createdAt":"2026-09-11T18:32:06.000Z"}],"meta":{"total":3,"limit":2,"offset":0,"sort":"id"}}
```

`sort` is checked against an allow-list `Set` before it reaches `order`:

```bash
curl -s 'http://localhost:3033/users?sort=nope'
```

```json
{"message":"Cannot sort by nope","error":"Bad Request","statusCode":400}
```

`order` takes an **entity property name**, not a SQL fragment — TypeORM maps and
quotes it. The allow-list exists to turn a typo into a clean 400 rather than an
ORM error, not because interpolation was ever on the table.

### `GET /users/:id` — the relation

```bash
curl -s http://localhost:3033/users/1
```

```json
{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-11T18:32:06.000Z","posts":[{"id":1,"title":"Notes on the Analytical Engine","body":"Note G.","createdAt":"2026-09-11T18:32:06.000Z","userId":1},{"id":2,"title":"On bind parameters","body":"Never concatenate.","createdAt":"2026-09-11T18:32:06.000Z","userId":1}]}
```

Without `relations: { posts: true }`, `user.posts` is `undefined`. TypeORM does
not lazy-load unless the property is declared as a `Promise`.

```bash
curl -s -i http://localhost:3033/users/9999 | head -1
```

```
HTTP/1.1 404 Not Found
```

### `GET /users/search?email=` — bind parameters, demonstrated

```bash
curl -s 'http://localhost:3033/users/search?email=ada@example.com'
```

```json
{"data":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-11T18:32:06.000Z"}}
```

The classic payload, URL-encoded:

```bash
curl -s "http://localhost:3033/users/search?email=%27%20OR%20%271%27%3D%271"
```

```json
{"data":null}
```

`' OR '1'='1` is looked up as an email address and matches nothing, because the
builder sends

```
SELECT ... FROM users user WHERE user.email = ?
```

with the value bound separately. Compare `examples/nest-vulnerable`, where the
same string returns every row.

### `GET /stats/authors?minPosts=`

```bash
curl -s 'http://localhost:3033/stats/authors?minPosts=1'
```

```json
{"data":[{"id":1,"name":"Ada Lovelace","postCount":2},{"id":2,"name":"Grace Hopper","postCount":1}]}
```

`HAVING COUNT(post.id) >= :minPosts` — a bind parameter in a `HAVING` clause,
which is the place people most often give up and concatenate.

### `POST /users`

```bash
curl -s -X POST http://localhost:3033/users -H 'content-type: application/json' \
  -d '{"email":"smoke-typeorm2@example.com","name":"Smoke2"}'
```

```json
{"id":5,"email":"smoke-typeorm2@example.com","name":"Smoke2","createdAt":"2026-09-11T18:32:32.000Z"}
```

A duplicate address is a **409**, not a 500:

```bash
curl -s -X POST http://localhost:3033/users -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Dup"}'
```

```json
{"message":"ada@example.com is already registered","error":"Conflict","statusCode":409}
```

The unique index is the thing that enforces it. A `SELECT` before the `INSERT`
is a race; catching `SQLITE_CONSTRAINT_UNIQUE` is not.

### `POST /users-with-posts` — the transaction

```bash
curl -s -X POST http://localhost:3033/users-with-posts \
  -H 'content-type: application/json' \
  -d '{"email":"tx2@example.com","name":"Tx2","posts":[{"title":"one"}]}'
```

```json
{"id":7,"email":"tx2@example.com","name":"Tx2","createdAt":"2026-09-11T18:32:32.000Z","posts":[{"id":6,"title":"one","body":"","createdAt":"2026-09-11T18:32:32.000Z","userId":7}]}
```

Now force a rollback by reusing the address, with a post attached:

```bash
curl -s -i -X POST http://localhost:3033/users-with-posts \
  -H 'content-type: application/json' \
  -d '{"email":"tx2@example.com","name":"Dup","posts":[{"title":"ghost"}]}' | head -1
curl -s 'http://localhost:3033/posts?limit=100' | grep -c ghost
```

```
HTTP/1.1 409 Conflict
0
```

Zero. The `posts` INSERT and the `users` INSERT were in one transaction, so the
failure took both with it. `dataSource.transaction(async (manager) => …)` commits
when the callback resolves and rolls back when it throws — you never write
`COMMIT` or `ROLLBACK` yourself.

**Use the `manager` the callback gives you.** Calling an injected repository
inside that callback runs on a *different* connection and outside the
transaction, which is the single most common TypeORM transaction bug.

### `GET /posts?limit=`

```bash
curl -s 'http://localhost:3033/posts?limit=2'
```

Each post carries its `author`, loaded through `relations: { author: true }`.

## Validation

The global `ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted` and
`transform`, so entity fields cannot be set from an unexpected body key:

```bash
curl -s -X POST http://localhost:3033/users -H 'content-type: application/json' \
  -d '{"email":"nope","name":"x","isAdmin":true}'
```

```json
{"message":["property isAdmin should not exist","email must be an email"],"error":"Bad Request","statusCode":400}
```

## Related examples

- `examples/orm-typeorm` — the same domain from plain Express 5 using TypeORM's
  decorator-free `EntitySchema` API, for projects with no build step.
- `nest-prisma` — the same routes over Prisma 7.
- `nest-vulnerable` / `nest-fixed` — what happens when the `WHERE` clause is
  built by concatenation instead.
