# nest-prisma — Prisma 7 in NestJS 12

A NestJS 12 API over `@prisma/client@7.10.0` and SQLite: the `PrismaService`
lifecycle pattern, a driver adapter, a one-to-many relation, an interactive
transaction, and the `$queryRaw` tagged-template escape hatch.

> ### Pin Prisma 7 explicitly
>
> The npm `latest` dist-tag for `prisma` currently points at **`8.0.0-rc.13`**, a
> release candidate. `npm install prisma` with no range installs a pre-release.
> This example pins `prisma@^7.10.0` and `@prisma/client@^7.10.0`, the current
> stable line. The CLI prints an "Update available 7.10.0 → 8.0.0-rc.13" banner
> on every command — ignore it.

## What it demonstrates

| Thing | Where |
| --- | --- |
| `PrismaService extends PrismaClient` with `OnModuleInit` / `OnModuleDestroy` | `src/prisma/prisma.service.ts` |
| A `@Global()` module so one client is injectable everywhere | `src/prisma/prisma.module.ts` |
| Prisma 7's **driver adapter** (`@prisma/adapter-better-sqlite3`) | `src/prisma/prisma.service.ts` |
| `prisma.config.js` — the URL is no longer in `schema.prisma` | `prisma.config.js` |
| A generator configured to emit code a Nest CommonJS build can compile | `prisma/schema.prisma` |
| A committed SQL migration, applied with `migrate deploy` | `prisma/migrations/` |
| Eager loading with `include`, and `select` inside it | `GET /users/:id`, `GET /posts` |
| A nested write (`posts: { create: [...] }`) — one implicit transaction | `src/seed.ts` |
| An **interactive transaction** (`$transaction(async (tx) => …)`) | `POST /users-with-posts` |
| `$queryRaw` as a tagged template, with a bound `${minPosts}` | `GET /stats/authors` |
| `P2002` → 409 instead of 500 | `src/users/users.service.ts` |
| SQLite `$queryRaw` integers are **BigInt** | `src/health.controller.ts` |

## Prerequisites

Node **20.19+ / 22.12+ / 24 LTS**. No database server — SQLite writes to
`prisma/dev.db`.

`@prisma/adapter-better-sqlite3` depends on `better-sqlite3`, a native addon.
Its own range asks for `^12`, which has no prebuilt binary for Node 24 on
Windows, so this example carries

```json
"overrides": { "better-sqlite3": "^13.0.3" }
```

and one prebuilt v13 is used everywhere. Remove it and `npm install` drops into
`node-gyp` and fails without Visual Studio.

## Install, migrate, run

```bash
cd examples/nest-prisma
npm install
npm run setup     # prisma migrate deploy && prisma generate && npm run build
npm run seed
npm start
```

```
seed complete: 3 users, 3 posts in ...\examples\nest-prisma\prisma\dev.db
nest-prisma listening on http://localhost:3034 (db: ...\prisma\dev.db)
```

Port **3034** (`PORT`); `DATABASE_FILE` moves the database; `PRISMA_LOG=query`
logs every statement Prisma generates.

`npm run setup` is **not** optional here: the Prisma client is generated code,
and `src/generated/` is git-ignored. Without `prisma generate` there is nothing
to compile.

## Why the generator block looks like that

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"

  generatedFileExtension = "ts"
  importFileExtension    = "js"
  moduleFormat           = "cjs"
  runtime                = "nodejs"
}
```

Prisma 7's `prisma-client` generator writes TypeScript **into your project**
rather than patching `node_modules`. That output then has to survive your own
`tsc` run, which is what the last three options are for:

- `importFileExtension = "js"` — TypeScript 7 rejects `.ts` import specifiers
  unless you set `allowImportingTsExtensions`, which requires `noEmit`. A Nest
  build emits, so the generated imports must say `.js`.
- `moduleFormat = "cjs"` matches this package (no `"type": "module"`).
- `runtime = "nodejs"` picks the Node runtime rather than an edge one.

`nest-esm` shows the ESM counterpart of the same three settings.

## Why there is no `url` in `schema.prisma`

Prisma 7 reaches the database through a **driver adapter**, not a Rust query
engine reading a URL out of the schema. The connection string therefore lives in
exactly two places:

- `prisma.config.js` — for the CLI (`migrate`, `generate`, `studio`);
- the adapter in `src/prisma/prisma.service.ts` — for the running app.

## Routes

### `GET /health` and `GET /ready`

```bash
curl -s http://localhost:3034/health
curl -s http://localhost:3034/ready
```

```json
{"status":"ok"}
{"status":"ok","client":"prisma@7"}
```

`/ready` runs `SELECT 1 AS ok` — and had to be written as
`Number(rows[0]?.ok) === 1`. Through the better-sqlite3 adapter, SQLite integers
come back from `$queryRaw` as **BigInt**:

```js
await prisma.$queryRaw`SELECT 1 AS ok`
// [ { ok: 1n } ]   typeof ok === 'bigint'
```

so `=== 1` is false and `JSON.stringify` throws *"Do not know how to serialize a
BigInt"*. Model queries (`findMany`, `count`) return plain numbers; only raw
rows do this. Normalise raw rows at the edge — `GET /stats/authors` does exactly
that with `Number(row.postCount)`.

### `GET /users?sort=&limit=&offset=`

```bash
curl -s 'http://localhost:3034/users?limit=2'
```

```json
{"data":[{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-11T18:36:42.329Z"},{"id":2,"email":"grace@example.com","name":"Grace Hopper","createdAt":"2026-09-11T18:36:42.340Z"}],"meta":{"total":3,"limit":2,"offset":0,"sort":"id"}}
```

```bash
curl -s 'http://localhost:3034/users?sort=nope'
```

```json
{"message":"Cannot sort by nope","error":"Bad Request","statusCode":400}
```

`orderBy` takes a **key of the generated type**, not a SQL fragment, so an
unknown key is a client error and never an injection. The allow-list turns it
into a 400.

### `GET /users/:id` — `include`

```bash
curl -s http://localhost:3034/users/1
```

```json
{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-11T18:36:42.329Z","posts":[{"id":1,"title":"Notes on the Analytical Engine","body":"Note G.","userId":1,"createdAt":"2026-09-11T18:36:42.329Z"},{"id":2,"title":"On bind parameters","body":"Never concatenate.","userId":1,"createdAt":"2026-09-11T18:36:42.329Z"}]}
```

### `GET /users/search?email=`

```bash
curl -s 'http://localhost:3034/users/search?email=ada@example.com'
curl -s "http://localhost:3034/users/search?email=%27%20OR%20%271%27%3D%271"
```

```json
{"data":{"id":1,"email":"ada@example.com","name":"Ada Lovelace","createdAt":"2026-09-11T18:36:42.329Z"}}
{"data":null}
```

`where: { email }` is a value, not a string. There is no code path in which the
payload becomes SQL.

### `GET /posts?limit=` — `include` with `select`

```bash
curl -s 'http://localhost:3034/posts?limit=2'
```

```json
{"data":[{"id":1,"title":"Notes on the Analytical Engine","body":"Note G.","userId":1,"createdAt":"2026-09-11T18:36:42.329Z","author":{"id":1,"name":"Ada Lovelace"}}]}
```

`include: { author: { select: { id: true, name: true } } }` — the author's email
is never loaded, so it cannot leak.

### `GET /stats/authors?minPosts=` — the raw escape hatch

```bash
curl -s 'http://localhost:3034/stats/authors?minPosts=1'
```

```json
{"data":[{"id":1,"name":"Ada Lovelace","postCount":2},{"id":2,"name":"Grace Hopper","postCount":1}]}
```

```ts
this.prisma.$queryRaw`
  SELECT u.id AS id, u.name AS name, COUNT(p.id) AS postCount
  FROM users u LEFT JOIN posts p ON p.user_id = u.id
  GROUP BY u.id HAVING COUNT(p.id) >= ${minPosts}
`
```

`$queryRaw` is a **tagged template**: every `${}` becomes a bind parameter, so
this is safe. The dangerous siblings are `$queryRawUnsafe()` and
`$executeRawUnsafe()` — ordinary function calls whose argument is just a string.
Never build one of those from user input.

### `POST /users` and the transaction

```bash
curl -s -X POST http://localhost:3034/users -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Dup"}'
```

```json
{"message":"ada@example.com is already registered","error":"Conflict","statusCode":409}
```

```bash
curl -s -X POST http://localhost:3034/users-with-posts \
  -H 'content-type: application/json' \
  -d '{"email":"txp@example.com","name":"Tx","posts":[{"title":"one"},{"title":"two","body":"b"}]}'
```

```json
{"id":5,"email":"txp@example.com","name":"Tx","createdAt":"2026-09-11T18:37:00.969Z","posts":[{"id":4,"title":"one","body":"","userId":5,"createdAt":"2026-09-11T18:37:00.976Z"},{"id":5,"title":"two","body":"b","userId":5,"createdAt":"2026-09-11T18:37:00.976Z"}]}
```

Repeat that call and the unique index rejects it — and the posts do not survive:

```bash
curl -s -i -X POST http://localhost:3034/users-with-posts -H 'content-type: application/json' \
  -d '{"email":"txp@example.com","name":"Dup","posts":[{"title":"ghost"}]}' | head -1
curl -s 'http://localhost:3034/posts?limit=100' | grep -c ghost
```

```
HTTP/1.1 409 Conflict
0
```

Inside `$transaction(async (tx) => …)`, **use `tx`**. Calling `this.prisma.*`
in that callback runs on a different connection, outside the transaction, and
survives the rollback.

## The lifecycle pattern, and why it matters

```ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect() }
  async onModuleDestroy() { await this.$disconnect() }
}
```

- `onModuleInit` connects at boot, so the first request does not pay for the
  handshake and a broken configuration fails at startup instead of under load.
- `onModuleDestroy` only runs if you called `app.enableShutdownHooks()` in
  `main.ts`. Without it the process keeps the database handle open on SIGTERM.
- One client for the process. A client per request opens a pool per request,
  which is how a serverless deployment exhausts a database's connection limit.

## Related examples

- `examples/orm-prisma` — the same domain from plain Express 5, no Nest.
- `nest-typeorm` — the same routes over TypeORM 1.1.
- `nest-crud-module` — the request pipeline this example keeps deliberately thin.
