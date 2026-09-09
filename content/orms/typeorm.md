---
title: TypeORM
description: TypeORM 1.1.1 — the post-1.0 DataSource API, decorators or EntitySchema, migrations, and named parameters in the query builder.
status: current
updated: 2026-09-08
---

TypeORM is a classic Data Mapper / Active Record ORM with decorator-defined entities, a repository API, a full query builder, and hand-written migrations. Version 1.0 arrived in May 2026 after years on `0.3.x` and removed a long list of deprecated APIs, so most tutorials you find online are describing a different library.

This page documents **TypeORM 1.1.1**.

:::warning
Do not follow `0.3.x` material. TypeORM 1.0 removed `Connection`, `ConnectionOptions`, `ConnectionManager`, and every global helper — `createConnection()`, `getConnection()`, `getManager()`, `getRepository()`, `createQueryBuilder()`. If a snippet calls any of those, it predates 1.0.

There is an official codemod for most of it:

```bash
npx @typeorm/codemod v1 src/
```
:::

## Why it exists

TypeORM is the option that looks like the ORMs people learned in other ecosystems: entities as classes, a repository per entity, relations as object properties, and a query builder for everything else. If your team is coming from Hibernate, Doctrine or Entity Framework, this is the smallest conceptual jump on this page.

It also has the broadest driver list here — PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, SAP HANA, CockroachDB, Spanner and MongoDB — which matters if "which database" is not entirely your decision.

## When to use it

- **Class-based domain models with behaviour.** Entities are real classes; methods on them are natural.
- **You need a database TypeScript ORMs usually skip.** Oracle, SAP HANA, Spanner, MSSQL.
- **Single-table inheritance, embedded entities, tree structures.** TypeORM has first-class support; most alternatives have none.
- **You want to hand-write migrations but still have them generated as a starting point.** `migration:generate` diffs entities against the database and writes a TypeScript migration class you then edit.

## When not to use it

- **You want end-to-end type inference.** TypeORM's types are decent, not exact. `find({ select: { id: true } })` does not narrow the return type the way Prisma or Drizzle do — you still get the entity type.
- **You cannot use decorators.** Decorators need `experimentalDecorators` and `emitDecoratorMetadata`, which rules out Node's built-in type stripping. `EntitySchema` is the escape hatch (see below), but you lose the ergonomics that made you pick TypeORM.
- **Small serverless functions.** The entity metadata system builds a full model graph at startup. Cold starts are noticeably slower than Drizzle's.
- **You want `synchronize: true` to be a migration strategy.** It is not, and TypeORM's docs say so.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install typeorm@1.1.1 reflect-metadata pg
```
@tab pnpm
```bash
pnpm add typeorm@1.1.1 reflect-metadata pg
```
@tab yarn
```bash
yarn add typeorm@1.1.1 reflect-metadata pg
```
:::

TypeORM 1.1.1 declares `engines.node: ^20.19.0 || ^22.13.0 || >=24.11.0`. Note what that means on the Active LTS line: **Node 24.11.0 or newer**, not just "Node 24". A 24.10 runtime does not satisfy the range.

The driver is a peer dependency. TypeORM 1.0 dropped the legacy `mysql` package (use `mysql2`) and the `sqlite3` package (use `better-sqlite3`); MongoDB requires driver v7+.

:::note
TypeORM 1.1.1's peer range for `better-sqlite3` is `^12.0.0`, while the current `better-sqlite3` release is 13.0.3. npm will warn about the peer conflict. Install `better-sqlite3@12` for a clean tree, or accept the warning and test carefully — a peer range is a claim about what was tested, not a hard incompatibility.
:::

### tsconfig

```json title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "outDir": "dist"
  }
}
```

`import 'reflect-metadata'` must be the first import in your entry file.

### Entities

```ts title="src/entities/User.ts"
import {
  Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn,
} from 'typeorm'
import { Post } from './Post.js'

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string

  @Column({ type: 'text', nullable: true })
  name!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[]
}
```

```ts title="src/entities/Post.ts"
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { User } from './User.js'

@Entity({ name: 'posts' })
@Index(['authorId', 'published'])
export class Post {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'text' })
  title!: string

  @Column({ type: 'boolean', default: false })
  published!: boolean

  @Column({ name: 'author_id' })
  authorId!: number

  @ManyToOne(() => User, (user) => user.posts, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_id' })
  author!: User
}
```

### DataSource

```ts title="src/data-source.ts"
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { Post } from './entities/Post.js'
import { User } from './entities/User.js'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [User, Post],
  migrations: ['dist/migrations/*.js'],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
  maxQueryExecutionTime: 200,
  poolSize: 10,
})
```

Initialize once at startup:

```ts title="src/server.ts"
import express from 'express'
import { AppDataSource } from './data-source.js'
import users from './routes/users.js'

await AppDataSource.initialize()

const app = express()
app.use(express.json())
app.use(users)
app.listen(3000, (err) => { if (err) throw err })
```

### CRUD

```ts title="src/routes/users.ts"
import express from 'express'
import { AppDataSource } from '../data-source.js'
import { User } from '../entities/User.js'

const router = express.Router()
const users = AppDataSource.getRepository(User)

router.post('/users', async (req, res) => {
  const user = users.create({ email: req.body.email, name: req.body.name })
  await users.save(user)
  res.status(201).json({ id: user.id, email: user.email, name: user.name })
})

router.get('/users/:id', async (req, res) => {
  const user = await users.findOne({
    where: { id: Number(req.params.id) },
    select: { id: true, email: true, name: true },
  })
  if (!user) return res.status(404).json({ error: 'not found' })
  res.json(user)
})

router.patch('/users/:id', async (req, res) => {
  await users.update({ id: Number(req.params.id) }, { name: req.body.name })
  res.json(await users.findOneBy({ id: Number(req.params.id) }))
})

router.delete('/users/:id', async (req, res) => {
  await users.delete({ id: Number(req.params.id) })
  res.status(204).end()
})

export default router
```

`dataSource.getRepository(Entity)` is a method on the DataSource — the standalone `getRepository()` global was removed in 1.0.

Full runnable version: [`examples/orm-typeorm`](../../examples/orm-typeorm/README.md).

## How it works

### Relations and eager loading

Three ways, in increasing order of control.

```ts
// 1. Find options — object syntax is required since 1.0
const users = await repo.find({
  relations: { posts: true },
  select: { id: true, email: true, posts: { id: true, title: true } },
})

// 2. Query builder — you choose the join type and alias
const user = await repo
  .createQueryBuilder('user')
  .leftJoinAndSelect('user.posts', 'post', 'post.published = :published', { published: true })
  .where('user.id = :id', { id })
  .getOne()

// 3. eager: true on the relation — loads on every find. Avoid it.
```

:::warning
**1.0 changed join semantics for non-nullable relations.** A relation declared `nullable: false` now uses `INNER JOIN` instead of `LEFT JOIN`. If your data has orphaned foreign keys — rows pointing at a deleted parent, which happens without a real FK constraint — those parent rows now silently disappear from results that used to include them.
:::

String arrays for `select` and `relations` were removed. `relations: ['posts']` is now `relations: { posts: true }`.

`relationLoadStrategy` on the DataSource (or per query) switches between `'join'` (one statement, duplicated parent rows) and `'query'` (a second statement per relation, no duplication). `'query'` is usually faster for one-to-many with wide parents; measure rather than guess.

### Transactions

```ts title="src/services/transfer.ts"
import { AppDataSource } from '../data-source.js'
import { Account } from '../entities/Account.js'

export async function transfer(fromId: number, toId: number, cents: number) {
  return AppDataSource.transaction('SERIALIZABLE', async (manager) => {
    const from = await manager.findOneOrFail(Account, {
      where: { id: fromId },
      lock: { mode: 'pessimistic_write' },
    })
    if (from.balance < cents) throw new Error('insufficient funds')

    await manager.decrement(Account, { id: fromId }, 'balance', cents)
    await manager.increment(Account, { id: toId }, 'balance', cents)
  })
}
```

Use the `manager` passed into the callback for everything inside. A repository obtained from `AppDataSource` uses a different connection and is not part of the transaction.

`decrement` / `increment` push the arithmetic into SQL, which is what makes this safe against concurrent transfers. The row lock plus `SERIALIZABLE` handles the check-then-act.

For manual control, `dataSource.createQueryRunner()` gives you explicit `startTransaction` / `commitTransaction` / `rollbackTransaction` — remember `release()` in a `finally`.

### Migrations

TypeORM migrations are TypeScript classes with `up` and `down`.

```bash
# Diff entities against the database and write a migration
npx typeorm-ts-node-esm migration:generate src/migrations/AddPostsIndex -d src/data-source.ts

# Write an empty migration to fill in by hand
npx typeorm-ts-node-esm migration:create src/migrations/BackfillSlugs

# Apply / revert / inspect
npx typeorm migration:run -d dist/data-source.js
npx typeorm migration:revert -d dist/data-source.js
npx typeorm migration:show -d dist/data-source.js
```

The package ships three binaries: `typeorm` (compiled JS), `typeorm-ts-node-esm` and `typeorm-ts-node-commonjs` (run the CLI against TypeScript sources). Generate against sources, run against compiled output in production.

```ts title="src/migrations/1725800000000-AddPostsIndex.ts"
import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPostsIndex1725800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS posts_author_published_idx ON posts (author_id, published)',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS posts_author_published_idx')
  }
}
```

`migrationsTransactionMode` controls wrapping: `'all'` (one transaction for the whole run, the default), `'each'` (one per migration), or `'none'`. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so that migration needs `'none'` or `'each'` with the transaction disabled for it.

:::danger
`synchronize: true` alters your schema to match your entities on every startup. It will drop columns and tables whose entity definitions changed. It is a prototyping convenience and it must be `false` in every environment that holds data you care about.
:::

### TypeScript story

Entities are classes, so the model types are yours and are as good as you write them. Where TypeORM falls short of Prisma and Drizzle is *query* typing: `find({ select: { id: true } })` still returns `User`, not `{ id: number }`, so the compiler thinks fields are present that are not on the object at runtime.

Treat that as a real hazard on `select`ed queries. If you rely on the type, do not use partial select; if you use partial select, map to a DTO immediately.

`await using` works on the query builder from TypeScript 5.2, which cleans up query runners without a `finally`.

**Avoiding decorators.** If you cannot enable `emitDecoratorMetadata` — for example because you want to run TypeScript directly on Node — define entities with `EntitySchema` instead:

```ts title="src/entities/user.schema.ts"
import { EntitySchema } from 'typeorm'

export const UserSchema = new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    email: { type: String, length: 255, unique: true },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
  },
  relations: {
    posts: { type: 'one-to-many', target: 'Post', inverseSide: 'author' },
  },
})
```

It is more verbose and it is plain JavaScript objects, so no decorator support is needed anywhere in the toolchain.

### Connection pooling

`poolSize` on the DataSource sets the driver's maximum pool size. Anything the driver supports that TypeORM does not expose goes in `extra`, which is passed straight through:

```ts title="src/data-source.ts"
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  poolSize: Number(process.env.DB_POOL_MAX ?? 10),
  extra: {
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'api',
  },
  maxQueryExecutionTime: 200,
})
```

`maxQueryExecutionTime` does not cancel anything — it logs a warning for queries slower than the threshold. Useful, but it is not a timeout. A real timeout is `statement_timeout` at the database, set via `extra`.

## Common patterns

### Repository extension instead of custom repositories

`@EntityRepository`, `AbstractRepository` and `getCustomRepository()` were all removed in 1.0. The replacement is `.extend()`:

```ts title="src/repos/users.ts"
import { AppDataSource } from '../data-source.js'
import { User } from '../entities/User.js'

export const UserRepository = AppDataSource.getRepository(User).extend({
  findActiveByEmail(email: string) {
    return this.createQueryBuilder('user')
      .where('user.email = :email', { email })
      .andWhere('user.deletedAt IS NULL')
      .getOne()
  },
})
```

### Renamed find methods

| Removed in 1.0 | Use instead |
| --- | --- |
| `findByIds(ids)` | `findBy({ id: In(ids) })` |
| `findOneById(id)` | `findOneBy({ id })` |
| `repository.exist()` | `repository.exists()` |
| `@RelationCount` | `@VirtualColumn` with a sub-query |
| `join` find option | the query builder |

## Security considerations

### Named parameters in the query builder

The query builder takes a SQL fragment plus a parameter object. The fragment is a string, so **it is your job to keep user input out of it**.

```ts vulnerable title="DO NOT COPY"
// GET /users?id=1%20OR%201%3D1
const users = await repo
  .createQueryBuilder('user')
  .where('user.id = ' + req.query.id)
  .getMany()
```

The `+` is the bug. Everything after `user.id = ` is SQL. `1 OR 1=1` returns the whole table; a subquery returns whatever the attacker wants.

```ts good title="src/repos/users.ts"
const users = await repo
  .createQueryBuilder('user')
  .where('user.id = :id', { id: req.query.id })
  .getMany()
```

`:id` is a placeholder. TypeORM replaces it with a driver-level bind parameter, so the value can never become syntax.

Array parameters use the spread form, which expands to one placeholder per element:

```ts good
await repo
  .createQueryBuilder('user')
  .where('user.id IN (:...ids)', { ids: [1, 2, 3] })
  .getMany()
```

Parameter names must be unique across the whole builder chain. Two `.andWhere()` calls both using `:id` silently overwrite each other — name them `:sheepId` and `:cowId`.

### dataSource.query() takes parameters

The raw escape hatch is `query(sql, parameters?)`. The second argument is the parameter array; the placeholder syntax is the driver's (`$1` for Postgres, `?` for MySQL and SQLite).

```ts vulnerable title="DO NOT COPY"
const rows = await AppDataSource.query(
  `SELECT id, email FROM users WHERE email = '${req.body.email}'`,
)
```

```ts good title="src/repos/search.ts"
const rows = await AppDataSource.query<Array<{ id: number; email: string }>>(
  'SELECT id, email FROM users WHERE email = $1',
  [req.body.email],
)
```

`setParameter()` / `setParameters()` on the query builder do the same job when the value is not available at `where()` time.

### What parameterization does not cover

Table names, column names and `ORDER BY` targets are syntax, not values, so no placeholder can carry them. TypeORM's `orderBy()` takes a string, which means it is an injection point:

```ts vulnerable title="DO NOT COPY"
await repo.createQueryBuilder('user').orderBy(req.query.sort, 'ASC').getMany()
```

TypeORM 1.0 added validation of `orderBy` conditions specifically to blunt this, and 1.0 also parameterizes and escapes database/schema/table/column names across drivers. **Neither of those is a substitute for an allow-list** — validation stops you injecting syntax, it does not stop you sorting by, or exposing, a column you never meant to expose.

```ts good title="src/repos/posts.ts"
const SORT_COLUMNS = new Map([
  ['created_at', 'post.createdAt'],
  ['title', 'post.title'],
])

export async function listPosts(sort: string, dir: string, limit: number) {
  const column = SORT_COLUMNS.get(sort)
  const direction = dir === 'asc' ? 'ASC' : 'DESC'
  if (!column) throw new Error('invalid sort')

  return AppDataSource.getRepository(Post)
    .createQueryBuilder('post')
    .orderBy(column, direction)
    .limit(limit)
    .getMany()
}
```

The map values are aliases you wrote. The request only ever selects between them.

For the common case, the find-options form is safer still, because its keys are entity properties by construction:

```ts good
await repo.find({ order: { createdAt: 'DESC' }, take: limit })
```

### Invalid where values now throw

`invalidWhereValuesBehavior` defaults to `'throw'` in 1.0. Passing `undefined` or `null` into a `where` condition raises an error instead of being silently dropped.

This is a security improvement, not just ergonomics. In `0.3.x`, `findOneBy({ resetToken: req.query.token })` with a missing query parameter became `findOneBy({})` — which returns the *first user in the table*. That pattern was a real account-takeover bug in real applications. Now it throws. Use `IsNull()` when you actually mean `IS NULL`.

### Mass assignment

```ts vulnerable title="DO NOT COPY"
const user = users.create(req.body)   // sets role, isAdmin, anything
await users.save(user)
```

`create()` copies every matching property from the object you give it. Validate first, then construct from named fields. See [Mass assignment](../security/mass-assignment.md).

## Production considerations

**`synchronize: false`, always.** Migrations are the only safe schema mechanism. Consider failing startup if `synchronize` is true and `NODE_ENV` is production.

**Do not use `migrationsRun: true`.** It runs migrations on `initialize()`, which means every replica races on deploy. Run `typeorm migration:run` as a release step. See [Migration strategy](./migration-strategy.md).

**Read every generated migration.** `migration:generate` diffs entities against the database and cannot know a rename from a drop-plus-add.

**Set `migrationsTransactionMode` deliberately.** The default wraps the whole run in one transaction, which is right for most changes and impossible for `CREATE INDEX CONCURRENTLY`.

**Enable `maxQueryExecutionTime`.** A logged warning at 200ms is the cheapest slow-query detector available, and TypeORM's generated SQL is worth watching.

**Set a real `statement_timeout` via `extra`.** `maxQueryExecutionTime` only logs.

**Audit for the `INNER JOIN` change after upgrading from 0.3.x.** Non-nullable relations join differently now. Rows can disappear.

**Pin Node 24.11+ in your Docker image.** The engines range excludes earlier 24.x releases.

**Watch startup time.** Entity metadata is built at `initialize()`. On a large schema this is tens to hundreds of milliseconds, which matters for readiness probes and not much else.

**Close the DataSource on shutdown.** `await AppDataSource.destroy()` on `SIGTERM`.

## Common mistakes

- **Following a `0.3.x` tutorial.** `createConnection`, `getRepository()` as a global, `getManager()` and `@EntityRepository` are all gone.
- **`relations: ['posts']`.** String arrays were removed; use `{ posts: true }`.
- **Leaving `synchronize: true` on.** It silently drops columns.
- **`migrationsRun: true` with multiple replicas.** Migration race on every deploy.
- **Concatenating into `.where()`.** `.where('id = ' + id)` is injectable; `.where('id = :id', { id })` is not.
- **Reusing a parameter name** across `.where()` and `.andWhere()`. The second silently wins.
- **Putting `req.query.sort` into `orderBy()`.** Allow-list it.
- **`repo.create(req.body)`.** Mass assignment.
- **Trusting the return type of a partial `select`.** You get the entity type, not the narrowed one.
- **Using the repository instead of the callback `manager` inside a transaction.** Different connection.
- **Expecting `maxQueryExecutionTime` to cancel a query.** It only logs.

## Related topics

- [Comparison table](./comparison.md) — TypeORM against the other five.
- [Prisma](./prisma.md) — if you want exact query types and generated migrations.
- [Drizzle](./drizzle.md) — if you want the SQL to stay visible.
- [Migration strategy](./migration-strategy.md) — why `migrationsRun` on boot is a trap.
- [Testing with a database](./testing-with-a-database.md) — DataSource per test worker, rollback isolation.
- [SQL injection](../security/sql-injection.md) — the threat behind the `:named` parameter rules.
- [Transactions](../databases/transactions.md) — isolation levels and locking.
- [Mass assignment](../security/mass-assignment.md) — why `create(req.body)` is a hole.
- [`examples/orm-typeorm`](../../examples/orm-typeorm/README.md) — the runnable version of this page.
