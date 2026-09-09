# orm-typeorm — TypeORM 1 with the decorator-free `EntitySchema` API

An Express 5 API over `typeorm@1` with a `users` / `posts` one-to-many relation.
Five sibling examples (`orm-prisma`, `orm-drizzle`, `orm-sequelize`, `orm-knex`,
`orm-mongoose`) expose the **same routes over the same domain**, so you can diff
them against each other.

> **TypeORM is at 1.1.1, not 0.3.x.** The long 0.3 line ended; anything you read
> that says "TypeORM 0.3" predates the 1.0 release. Two changes bite immediately:
> the callback-based `sqlite` (node-sqlite3) driver is **gone** — the SQLite
> drivers that ship now are `better-sqlite3` and `sqljs` — and the package
> declares `better-sqlite3` as a `peerOptional` at `^12.0.0`.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `EntitySchema` — entities as plain objects, **no decorators, no build step** | `src/entities.js` |
| A one-to-many / many-to-one pair with `inverseSide` and a `joinColumn` | `src/entities.js` |
| One `DataSource` per process, with `synchronize` for development | `src/data-source.js` |
| better-sqlite3 pragmas through `prepareDatabase` | `src/data-source.js` |
| Idempotent seed data, at boot and via `npm run seed` | `src/seed.js` |
| Repository CRUD: `find` / `findOne` / `save` / `update` / `delete` | `src/app.js` |
| Eager loading with `relations: { posts: true }` | `GET /users/:id` |
| The query builder with `leftJoinAndSelect` / `innerJoinAndSelect` | `GET /posts` |
| **Named bind parameters** — `.where('x = :id', { id })` | `GET /posts` |
| A managed transaction (`dataSource.transaction(manager => …)`) | `POST /users-with-posts` |
| `dataSource.query()` with positional parameters | `GET /stats/authors` |

## Why `EntitySchema` instead of decorators

The decorator form (`@Entity()`, `@Column()`) needs `experimentalDecorators` and
`emitDecoratorMetadata`, which means a TypeScript compile step. Node 24's
built-in type stripping deliberately refuses decorators — it removes types, and
decorators *emit* code — so decorator entities cannot run unbuilt.

`EntitySchema` is the same metadata expressed as plain objects. The runtime
behaviour is identical (the decorators build one of these), and the example runs
with `node src/server.js` and nothing else.

## Prerequisites

Node 24. **No database server** — SQLite is a file, written to `data/app.db`.

`better-sqlite3@13` publishes Node-API prebuilt binaries, so `npm install` needs
no C++ toolchain. TypeORM 1.1.1's peer range asks for `better-sqlite3@^12`, and
v12 has **no prebuilt binary for Node 24 on Windows** — installing it fails with

```text
prebuild-install warn install No prebuilt binaries found (target=…)
gyp ERR! find VS You need to install the latest version of Visual Studio
```

so this example carries

```json
"overrides": { "typeorm": { "better-sqlite3": "^13.0.3" } }
```

which satisfies the peer with one prebuilt v13. Without it `npm install` stops at
`ERESOLVE … Conflicting peer dependency: better-sqlite3@12.11.1`.

## Install and run

```bash
cd examples/orm-typeorm
npm install
npm start          # creates the schema and seeds at boot, then listens
```

Default port **3022**; override with `PORT`. `DATABASE_FILE` moves the database.

```bash
npm run seed       # re-run the seed by hand (no-op if rows exist)
```

`synchronize: true` in `src/data-source.js` is what creates the tables. It is a
**development** setting: it diffs the entities against the live schema and ALTERs
to match, which includes dropping a column it does not recognise. Real
deployments use `migrations` + `migrationsRun` and set `synchronize: false`.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + a row count |
| GET | `/users?sort=&direction=&limit=` | list, allow-listed sort column |
| POST | `/users` | create one |
| GET | `/users/:id` | fetch one **with its posts** |
| PATCH | `/users/:id` | rename |
| DELETE | `/users/:id` | delete (cascades to posts) |
| GET | `/users/:id/posts` | that user's posts |
| POST | `/users/:id/posts` | add a post |
| GET | `/posts?authorEmail=&limit=` | posts joined to their author, filtered by a **bind parameter** |
| POST | `/users-with-posts` | user + posts in one transaction |
| GET | `/stats/authors?minPosts=` | `dataSource.query()` with positional parameters |

### Health

```bash
curl -s localhost:3022/health
```

```json
{"status":"ok","orm":"typeorm","users":2}
```

### Eager loading

```bash
curl -s localhost:3022/users/1
```

```json
{"orm":"typeorm","user":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-09T10:03:38.000Z","posts":[{"id":1,"title":"Note G","body":"The first published algorithm.","createdAt":"2026-09-09T10:03:38.000Z"},{"id":2,"title":"On the Analytical Engine","body":"","createdAt":"2026-09-09T10:03:38.000Z"}]}}
```

`relations: { posts: true }` and `leftJoinAndSelect('user.posts', 'post')` do the
same thing — one statement with a JOIN. The N+1 is `find()` **without**
`relations`, then reading `user.posts` in a loop: TypeORM has no lazy loading for
plain properties, so that gives you `undefined` rather than a silent query storm,
which is the better failure.

### The query builder and its bind parameter

```bash
curl -s "localhost:3022/posts?authorEmail=grace@example.com"
```

```json
{"orm":"typeorm","posts":[{"id":3,"title":"Compilers","body":"A compiler translates, it does not interpret.","createdAt":"2026-09-09T10:03:38.000Z","author":{"id":2,"email":"grace@example.com","name":"Grace Hopper","createdAt":"2026-09-09T10:03:38.000Z"}}]}
```

### Create, and the unique constraint as a 409

```bash
curl -s -X POST localhost:3022/users -H 'content-type: application/json' \
  -d '{"email":"alan@example.com","name":"Alan Turing"}' -w ' [%{http_code}]\n'
```

```json
{"orm":"typeorm","user":{"email":"alan@example.com","name":"Alan Turing","id":3,"createdAt":"2026-09-09T10:03:51.000Z"}} [201]
```

Repeat it:

```json
{"error":"constraint violation","detail":"UNIQUE constraint failed: users.email"} [409]
```

### The transaction

```bash
curl -s -X POST localhost:3022/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"edsger@example.com","name":"Edsger","posts":[{"title":"GOTO"},{"title":"Shortest path","body":"1956"}]}' \
  -w ' [%{http_code}]\n'
```

```json
{"orm":"typeorm","user":{"email":"edsger@example.com","name":"Edsger","id":3,"createdAt":"2026-09-09T10:05:14.000Z"},"posts":[{"title":"GOTO","body":"","id":4,"createdAt":"2026-09-09T10:05:14.000Z","userId":3},{"title":"Shortest path","body":"1956","id":5,"createdAt":"2026-09-09T10:05:14.000Z","userId":3}]} [201]
```

Two rules inside `dataSource.transaction(async (manager) => …)`:

- **Use the `manager` it hands you for every write.** A repository taken from the
  DataSource uses a different connection, so its writes are not rolled back.
- **Pass the entity target.** With decorators an entity is a class instance and
  `manager.save(obj)` can infer the target; with `EntitySchema` the rows are
  plain objects, so `manager.save(obj)` throws
  `CannotDetermineEntityError: Cannot save, given value must be instance of
  entity class`. Write `manager.save(Post, rows)`.

### The raw query

```bash
curl -s "localhost:3022/stats/authors?minPosts=1"
```

```json
{"orm":"typeorm","authors":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","post_count":2},{"id":2,"email":"grace@example.com","name":"Grace Hopper","post_count":1}]}
```

## The SQL-safety point

The query builder's `.where()` argument **is raw SQL**. It is not escaped for
you. What makes it safe is the binding:

```js good title="src/app.js"
qb.andWhere('author.email = :authorEmail', { authorEmail })
// TypeORM rewrites :authorEmail into the driver's placeholder and sends the
// value separately. It never becomes part of the statement text.
```

Concatenate instead and you have an injection, in exactly the place people
assume an ORM is protecting them:

```js vulnerable title="DO NOT COPY"
const email = req.query.email
const user = await repo
  .createQueryBuilder('user')
  .where(`user.email = '${email}'`)   // or .where('user.email = ' + email)
  .getOne()
// ?email=x' OR '1'='1  matches the first user in the table
```

```js good title="the fix"
const user = await repo
  .createQueryBuilder('user')
  .where('user.email = :email', { email })
  .getOne()
```

The same rule applies to every method that takes a SQL fragment: `andWhere`,
`orWhere`, `having`, `Raw()`, and `dataSource.query()` — which takes positional
parameters as its second argument:

```js good title="src/app.js"
await dataSource.query('SELECT … HAVING COUNT(p.id) >= ?', [minPosts])
```

`minPosts` is a number only because Zod coerced it two lines earlier. "It is a
number" is never a reason to skip the binding — it is a string from the query
string until something makes it otherwise.

### The one thing you cannot bind

`orderBy()`'s first argument is an **identifier**, and SQL has no placeholder for
identifiers. TypeORM puts whatever you pass into the statement, so a
client-chosen sort column has to be checked against a fixed list first:

```js title="src/entities.js"
export const SORTABLE_USER_COLUMNS = new Set(['id', 'email', 'name', 'created_at'])
```

```bash
curl -s "localhost:3022/users?sort=name;DROP+TABLE+users"
```

```json
{"error":"unsortable column: name;DROP TABLE users"}
```

The `Set` is the security control. Nothing else in this example interpolates
anything into SQL.
