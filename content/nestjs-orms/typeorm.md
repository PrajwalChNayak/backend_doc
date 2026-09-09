---
title: TypeORM
description: TypeORM 1.1.1 inside NestJS 12 with @nestjs/typeorm 12.0.1 — forRootAsync, forFeature, injected repositories, transactions, migrations and keeping the query builder parameterised.
status: current
updated: 2026-09-09
---

`@nestjs/typeorm` is the first-party module that turns a TypeORM `DataSource` into a Nest provider and every entity repository into an injectable token. Almost everything else — entities, relations, the query builder, migrations — is plain TypeORM, documented in depth on [TypeORM](../orms/typeorm.md). This page covers the Nest half: wiring, injection, transaction boundaries in a DI container, and the escape hatches you have to keep parameterised.

This page documents **`@nestjs/typeorm` 12.0.1** with **`typeorm` 1.1.1**.

:::warning
TypeORM is on the **1.x** line. `createConnection()`, `getConnection()`, `getManager()`, `getRepository()` as a global, `@EntityRepository` and string arrays for `relations` were all removed in 1.0. If a Nest tutorial calls any of those, it predates the current library — see [TypeORM](../orms/typeorm.md) for the full removal list and the codemod.
:::

## Why it exists

Without the module you would construct a `DataSource`, call `initialize()` somewhere in `main.ts`, and import a repository singleton into every service. That works, and it makes those services untestable without a database, because the repository is a module-level import rather than a constructor dependency.

`@nestjs/typeorm` gives you three things instead. `forRoot`/`forRootAsync` register the `DataSource` as a provider and let Nest own its lifecycle — connect on bootstrap, `destroy()` on shutdown. `forFeature` registers one provider per entity so a repository arrives through the constructor. And because they are ordinary providers, `Test.createTestingModule().overrideProvider(getRepositoryToken(User))` replaces them in a unit test with no database at all.

## When to use it

- **Class-based entities with relations as object properties**, especially if the team is coming from Hibernate, Doctrine or Entity Framework.
- **A database the TypeScript-first ORMs skip** — Oracle, SAP HANA, Spanner, MSSQL.
- **You want a first-party Nest module.** TypeORM and Mongoose are the only two ORMs with one; everything else is a custom provider you maintain.

## When not to use it

- **You want exact query types.** `find({ select: { id: true } })` still returns the entity type. [Prisma](./prisma.md) and [Drizzle](./drizzle.md) narrow it.
- **You cannot enable decorators.** Entities need `experimentalDecorators` and `emitDecoratorMetadata`. In a Nest project you already have both, so this rarely bites — but it does rule out running the app with Node's type stripping.
- **Cold-start-sensitive deployments.** Entity metadata is built at `initialize()` and startup cost scales with schema size.

## Basic example

### Install

:::tabs
@tab npm
```bash
npm install @nestjs/typeorm@12.0.1 typeorm@1.1.1 pg@8.23.0
```
@tab pnpm
```bash
pnpm add @nestjs/typeorm@12.0.1 typeorm@1.1.1 pg@8.23.0
```
@tab yarn
```bash
yarn add @nestjs/typeorm@12.0.1 typeorm@1.1.1 pg@8.23.0
```
:::

`@nestjs/typeorm@12.0.1` declares `engines.node: ">=20.19.0"`. `typeorm@1.1.1` is stricter — `^20.19.0 || ^22.13.0 || >=24.11.0` — so on the Active LTS line you need **Node 24.11.0 or newer**, not merely "Node 24". This handbook targets Node 24 LTS, which satisfies both.

The driver is a peer dependency: `pg` for PostgreSQL, `mysql2` for MySQL/MariaDB, `better-sqlite3` for SQLite. TypeORM 1.0 dropped the legacy `mysql` and `sqlite3` packages.

:::note
Snippets on this site assign injected dependencies to explicit fields rather than using constructor parameter properties, because the site's snippet checker type-strips rather than compiles. In your own project `constructor(private readonly users: Repository<User>) {}` is equivalent, idiomatic and works — Nest compiles with `tsc`, which handles parameter properties.
:::

### Register the DataSource

Never inline credentials. `forRootAsync` lets the options come from `ConfigService`, so config validation and the database wiring share one source of truth — see [Configuration](../nestjs/configuration.md).

```ts title="src/app.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
        poolSize: config.get<number>('DB_POOL_MAX') ?? 10,
        maxQueryExecutionTime: 200,
        logging: ['error', 'warn', 'migration'],
        retryAttempts: 5,
        retryDelay: 3000,
        extra: {
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
          application_name: 'api',
        },
      }),
    }),
    UsersModule,
  ],
})
export class AppModule {}
```

Four of those options are `@nestjs/typeorm`'s own rather than TypeORM's:

| Option | Default | What it does |
| --- | --- | --- |
| `autoLoadEntities` | `false` | Every entity passed to `forFeature` is added to the DataSource automatically |
| `retryAttempts` | `10` | Connection attempts before bootstrap fails |
| `retryDelay` | `3000` | Milliseconds between attempts |
| `verboseRetryLog` | `false` | Logs the underlying error on each retry, not just the attempt number |

`autoLoadEntities: true` is worth turning on. Without it you maintain a central `entities` array that every feature module has to be added to, and the failure mode — "EntityMetadataNotFound" at runtime, in one endpoint — is a bad one.

`retryAttempts` matters in Docker Compose and Kubernetes, where the app usually starts before the database is accepting connections. Five attempts three seconds apart covers the normal case; a database that is down for a minute should fail the pod so the orchestrator can act, not hang the bootstrap forever.

### Entities

Entities are plain TypeORM — no Nest decorators involved.

```ts title="src/users/user.entity.ts"
import {
  Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn,
} from 'typeorm'
import { Post } from '../posts/post.entity.js'

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string

  @Column({ type: 'text', nullable: true })
  name!: string | null

  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash!: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[]
}
```

`select: false` on `passwordHash` keeps it out of `find()` results unless a query asks for it explicitly. It is the cheapest defence against leaking a hash through a controller that returns the entity directly.

```ts title="src/posts/post.entity.ts"
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'
import { User } from '../users/user.entity.js'

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

### forFeature and @InjectRepository

`TypeOrmModule.forFeature([User])` registers a `Repository<User>` provider **in that module's injector**. Its scope is the module, not the application: another module that wants the same repository calls `forFeature([User])` too.

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from './user.entity.js'
import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Export `UsersService`, not the repository. That keeps `Repository<User>` — and TypeORM itself — inside the module that owns the entity; see [Repository vs active record](./repository-vs-active-record.md).

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { User } from './user.entity.js'
import { CreateUserDto } from './dto/create-user.dto.js'

@Injectable()
export class UsersService {
  private readonly users: Repository<User>

  constructor(
    @InjectRepository(User)
    users: Repository<User>,
  ) {
    this.users = users
  }

  async create(dto: CreateUserDto): Promise<User> {
    const user = this.users.create({ email: dto.email, name: dto.name ?? null })
    return this.users.save(user)
  }

  async findOne(id: number): Promise<User> {
    const user = await this.users.findOne({
      where: { id },
      select: { id: true, email: true, name: true, createdAt: true },
    })
    if (!user) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  async list(limit: number, offset: number): Promise<User[]> {
    return this.users.find({
      select: { id: true, email: true, name: true },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    })
  }

  async remove(id: number): Promise<void> {
    const result = await this.users.delete({ id })
    if (!result.affected) throw new NotFoundException(`User ${id} not found`)
  }
}
```

`@InjectRepository(User)` resolves to the token `getRepositoryToken(User)`. You need that name in tests:

```ts title="src/users/users.service.spec.ts"
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { User } from './user.entity.js'
import { UsersService } from './users.service.js'

const repo = {
  findOne: async () => ({ id: 1, email: 'a@example.com' }),
  create: (input: Partial<User>) => input,
  save: async (input: Partial<User>) => ({ id: 1, ...input }),
}

const moduleRef = await Test.createTestingModule({
  providers: [UsersService, { provide: getRepositoryToken(User), useValue: repo }],
}).compile()

const service = moduleRef.get(UsersService)
```

No database, no container, no fixtures. That is the whole reason for injecting the repository rather than importing it. More in [Mocking providers](../nestjs-testing/mocking-providers.md).

## How it works

### Injecting the DataSource and the EntityManager

Two more tokens, for the cases a repository cannot cover:

```ts title="src/reports/reports.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectDataSource, InjectEntityManager } from '@nestjs/typeorm'
import { DataSource, EntityManager } from 'typeorm'

@Injectable()
export class ReportsService {
  private readonly dataSource: DataSource
  private readonly manager: EntityManager

  constructor(
    @InjectDataSource()
    dataSource: DataSource,
    @InjectEntityManager()
    manager: EntityManager,
  ) {
    this.dataSource = dataSource
    this.manager = manager
  }
}
```

With multiple databases, every decorator takes the connection name: `forRoot({ name: 'analytics', … })`, then `@InjectDataSource('analytics')`, `@InjectRepository(Event, 'analytics')` and `forFeature([Event], 'analytics')`. Mixing the names up produces a repository that queries the wrong database and no error at all, so name connections after the database, not after the feature.

### Relations, eager and lazy loading

Three mechanisms, and only two of them are safe defaults.

```ts
// 1. Find options — object syntax, required since TypeORM 1.0
const users = await this.users.find({
  relations: { posts: true },
  select: { id: true, email: true, posts: { id: true, title: true } },
})

// 2. Query builder — you choose the join and the alias
const user = await this.users
  .createQueryBuilder('user')
  .leftJoinAndSelect('user.posts', 'post', 'post.published = :published', { published: true })
  .where('user.id = :id', { id })
  .getOne()
```

The third is `eager: true` on the relation, which loads it on **every** `find` on that entity, everywhere in the application. It is a decision made in the entity file that changes the cost of queries in files you have never opened. Prefer `relations` per query.

Lazy relations — typing a property as `Promise<Post[]>` — are worse in a Nest service, because the query fires on property access. A `for` loop over users that touches `user.posts` is then N+1 with no visible query call. See [Avoiding N+1](./avoiding-n-plus-one.md).

`relationLoadStrategy` switches between `'join'` (one statement, duplicated parent rows) and `'query'` (a second statement per relation). Set it per query when a wide parent with many children is duplicating a lot of bytes.

:::warning
TypeORM 1.0 changed join semantics for relations declared `nullable: false`: they now use `INNER JOIN` instead of `LEFT JOIN`. If your data has rows pointing at a deleted parent, those rows silently vanish from results that used to include them. Audit list endpoints after upgrading from `0.3.x`.
:::

### Transactions

A transaction is a connection, and Nest's DI container hands out repositories bound to the pool — not to your transaction. So the rule is: **everything inside the callback goes through the `manager` the callback gives you.**

```ts title="src/billing/transfer.service.ts"
import { Injectable, BadRequestException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { Account } from './account.entity.js'

@Injectable()
export class TransferService {
  private readonly dataSource: DataSource

  constructor(
    @InjectDataSource()
    dataSource: DataSource,
  ) {
    this.dataSource = dataSource
  }

  async transfer(fromId: number, toId: number, cents: number): Promise<void> {
    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const from = await manager.findOneOrFail(Account, {
        where: { id: fromId },
        lock: { mode: 'pessimistic_write' },
      })
      if (from.balance < cents) throw new BadRequestException('Insufficient funds')

      await manager.decrement(Account, { id: fromId }, 'balance', cents)
      await manager.increment(Account, { id: toId }, 'balance', cents)
    })
  }
}
```

`increment`/`decrement` push the arithmetic into SQL, so two concurrent transfers cannot lose an update. Throwing rolls back — including a thrown `BadRequestException`, which then becomes a 400 through the normal exception filter.

The awkward part in Nest is a transaction that must span **several services**. Three options:

1. **Pass the `EntityManager` down.** Give each service method an optional `manager?: EntityManager` parameter and default to the injected one. Explicit, ugly, and it always works.
2. **Put the transaction in one service.** Often the right answer: if two services must commit together, that is a hint they are one unit of work.
3. **Carry it in `AsyncLocalStorage`.** A middleware or interceptor opens the transaction, stores the manager in an ALS store, and repositories read it. It keeps signatures clean at the cost of a hidden dependency, and it is the mechanism the community transaction decorators are built on.

```ts title="src/database/transaction.context.ts"
import { AsyncLocalStorage } from 'node:async_hooks'
import type { EntityManager } from 'typeorm'

export const transactionStorage = new AsyncLocalStorage<EntityManager>()

export function currentManager(fallback: EntityManager): EntityManager {
  return transactionStorage.getStore() ?? fallback
}
```

Whichever you pick, decide once and write it down. Half a codebase passing managers and half relying on ambient state is how a "transaction" ends up committing three statements and leaving the fourth outside it. See [Transactions](../nestjs-databases/transactions.md).

### Migrations

The TypeORM CLI cannot read your Nest module graph, so it needs its own `DataSource` file. Build both from one options object so they cannot drift:

```ts title="src/database/data-source.ts"
import 'reflect-metadata'
import { DataSource, type DataSourceOptions } from 'typeorm'

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/migrations/*.js'],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
}

export default new DataSource(dataSourceOptions)
```

```bash
# Diff entities against the database and write a migration
npx typeorm-ts-node-commonjs migration:generate src/migrations/AddPostsIndex -d src/database/data-source.ts

# Apply / revert / inspect, against compiled output
npx typeorm migration:run -d dist/database/data-source.js
npx typeorm migration:revert -d dist/database/data-source.js
npx typeorm migration:show -d dist/database/data-source.js
```

The package ships `typeorm` (compiled JS), `typeorm-ts-node-commonjs` and `typeorm-ts-node-esm` — pick the last one if your Nest project is ESM.

`migration:generate` diffs entities against the database. It cannot tell a rename from a drop-plus-add, so **read every generated file before applying it**. Details and the expand/contract pattern are in [Migrations](../nestjs-databases/migrations.md) and [Migration strategy](../orms/migration-strategy.md).

:::danger
`synchronize: true` alters your schema to match your entities on every application start. It drops columns and tables whose definitions changed, without asking and without a migration file. In production that is **data loss waiting to happen** — a renamed property is a dropped column and the data in it is gone. Set `synchronize: false` in every environment that holds data you would miss, and consider failing bootstrap if the flag is ever true outside development.
:::

Do not use `migrationsRun: true` either. It runs migrations from `initialize()`, so on a three-replica deploy all three race the same migration.

## Common patterns

### Extending a repository

`@EntityRepository` and `getCustomRepository()` were removed in TypeORM 1.0. Register the extended repository as a Nest provider instead:

```ts title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'
import { User } from './user.entity.js'

@Injectable()
export class UsersRepository extends Repository<User> {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
  ) {
    super(User, dataSource.createEntityManager())
  }

  findActiveByEmail(email: string): Promise<User | null> {
    return this.createQueryBuilder('user')
      .where('user.email = :email', { email })
      .andWhere('user.deletedAt IS NULL')
      .getOne()
  }
}
```

Add it to the module's `providers` and inject it like any other service. You get the full `Repository<User>` API plus your own methods, and it is still overridable in a test.

### Do not return entities from controllers

An entity is a database row with relations attached. Returning it from a controller ships every loaded column, and a later `select: false` removal or a new relation silently changes your public API. Map to a DTO, or use a serialization interceptor — see [Serialization](../nestjs-validation/serialization.md).

## Security considerations

TypeORM's find options and repository API are parameterised by construction. Every hole below is in the string-taking parts: `where()` fragments, `orderBy()`, and `query()`.

### Named parameters in the query builder

`.where()` takes a **SQL string**. Whatever you concatenate into it is SQL.

```ts vulnerable title="DO NOT COPY"
// GET /users?id=1%20OR%201%3D1
@Get()
async find(@Query('id') id: string) {
  return this.users
    .createQueryBuilder('user')
    .where('user.id = ' + id)
    .getMany()
}
```

`1 OR 1=1` returns the whole table. A subquery returns whatever the attacker asks for — including `password_hash`.

```ts good title="src/users/users.service.ts"
async find(id: number) {
  return this.users
    .createQueryBuilder('user')
    .where('user.id = :id', { id })
    .getMany()
}
```

`:id` becomes a driver-level bind parameter, so the value can never be parsed as syntax. Arrays use the spread form, which expands to one placeholder per element:

```ts good
await this.users
  .createQueryBuilder('user')
  .where('user.id IN (:...ids)', { ids })
  .getMany()
```

Parameter names must be unique across the whole builder chain. Two `.andWhere()` calls both using `:id` overwrite each other silently — name them for what they hold.

Pair this with the global `ValidationPipe` so `id` is a number before it ever reaches the service. A validated DTO plus a bind parameter is two independent controls; either alone is enough, and having both means a mistake in one is not a breach.

### dataSource.query() takes a parameter array

```ts vulnerable title="DO NOT COPY"
const rows = await this.dataSource.query(
  `SELECT id, email FROM users WHERE email = '${email}'`,
)
```

```ts good title="src/reports/reports.service.ts"
const rows = await this.dataSource.query<Array<{ id: number; email: string }>>(
  'SELECT id, email FROM users WHERE email = $1',
  [email],
)
```

The placeholder syntax is the driver's: `$1` for PostgreSQL, `?` for MySQL and SQLite. `setParameter()` / `setParameters()` do the same job on the query builder when the value is not available at `where()` time.

### What parameterisation does not cover

Bind parameters are **value slots**. Table names, column names and `ORDER BY` targets are syntax, so no placeholder can carry them — in TypeORM that means `orderBy()` is an injection point:

```ts vulnerable title="DO NOT COPY"
// GET /posts?sort=(SELECT+password_hash+FROM+users+LIMIT+1)
await this.posts.createQueryBuilder('post').orderBy(sort, 'ASC').getMany()
```

TypeORM 1.0 added validation of `orderBy` conditions and escapes identifiers across drivers. That blunts the syntax attack; it does not stop a caller sorting by — and inferring the contents of — a column you never meant to expose. Use an allow-list:

```ts good title="src/posts/posts.service.ts"
const SORT_COLUMNS = new Map([
  ['created_at', 'post.createdAt'],
  ['title', 'post.title'],
])

async list(sort: string, dir: string, limit: number) {
  const column = SORT_COLUMNS.get(sort)
  if (!column) throw new BadRequestException('Invalid sort column')
  const direction = dir === 'asc' ? 'ASC' : 'DESC'

  return this.posts
    .createQueryBuilder('post')
    .orderBy(column, direction)
    .limit(limit)
    .getMany()
}
```

The map values are aliases you wrote; the request only ever picks between them. Better still, when the shape allows it, use find options — their keys are entity properties by construction:

```ts good
await this.posts.find({ order: { createdAt: 'DESC' }, take: limit })
```

Same rule for a dynamic table name in a raw query: validate against a `Set` you control, and mark the line so the linter knows you did.

```ts good title="src/reports/reports.service.ts"
const REPORT_TABLES = new Set(['orders_daily', 'orders_monthly'])

async rollup(table: string, limit: number) {
  if (!REPORT_TABLES.has(table)) throw new BadRequestException('Unknown report')
  // lint-sql:allow table is checked against the REPORT_TABLES allow-list above
  const sql = `SELECT bucket, total FROM ${table} ORDER BY bucket DESC LIMIT $1`
  return this.dataSource.query(sql, [limit])
}
```

The `LIMIT` stays a real bind parameter. Only the identifier is interpolated, and only after the allow-list check.

Full threat model, with exploits and verification: [SQL injection](../nestjs-security/sql-injection.md).

### Invalid where values throw in 1.0

`invalidWhereValuesBehavior` defaults to `'throw'`. In `0.3.x`, `findOneBy({ resetToken: query.token })` with a missing parameter became `findOneBy({})` — which returns the *first row in the table*. That was a real account-takeover bug in real applications. It now throws. Use `IsNull()` when you actually mean `IS NULL`.

### Mass assignment

```ts vulnerable title="DO NOT COPY"
@Post()
async create(@Body() body: Partial<User>) {
  return this.users.save(this.users.create(body))   // sets role, isAdmin, anything
}
```

`create()` copies every property that matches a column. A validated DTO with `whitelist: true` and `forbidNonWhitelisted: true` on the global `ValidationPipe` strips unknown fields before they reach the service — and the service should still construct the entity from named fields, because a DTO can legitimately contain fields the entity must not take from a request. See [The ValidationPipe](../nestjs-validation/validation-pipe.md) and [Mass assignment](../security/mass-assignment.md).

### Do not leak columns

`findOne({ where: { id } })` with no `select` returns every column. `select: false` on the entity property is the durable fix for secrets; explicit `select` on read paths is the fix for everything else.

## Production considerations

**`synchronize: false`, everywhere that holds real data.** Assert it at bootstrap if you can.

**`migrationsRun: false`.** Run `typeorm migration:run` as a release step, once, not from N replicas on boot.

**`autoLoadEntities: true`** unless you have a specific reason. The alternative is a central array that eventually goes stale.

**Set `retryAttempts` and `retryDelay` for your orchestrator.** The default of ten attempts hides a genuinely dead database for half a minute.

**Size the pool against the database.** `poolSize` × replica count is your real connection count. See [Connection pooling](../nestjs-databases/connection-pooling.md).

**Set `extra.connectionTimeoutMillis`.** Without it a request that cannot get a connection waits forever, turning pool exhaustion into an outage rather than fast 503s.

**`maxQueryExecutionTime` only logs.** A 200ms warning is the cheapest slow-query detector you have, but the real timeout is `statement_timeout` at the database, passed through `extra`.

**Enable shutdown hooks.** `app.enableShutdownHooks()` in `main.ts` is what lets `@nestjs/typeorm` destroy the DataSource on `SIGTERM` — otherwise in-flight queries are cut off mid-flight. See [Graceful shutdown](../nestjs-production/graceful-shutdown.md).

**Pin Node 24.11+ in your image.** `typeorm@1.1.1`'s engines range excludes earlier 24.x releases, and npm will tell you about it after the deploy, not before.

**Watch bootstrap time.** Entity metadata is built at `initialize()`. On a large schema that is tens to hundreds of milliseconds before the readiness probe can pass.

## Common mistakes

- **Following a `0.3.x` tutorial.** `createConnection`, global `getRepository()`, `@EntityRepository` and `relations: ['posts']` are all gone.
- **Leaving `synchronize: true` on.** It drops columns to match entities. This is the single most expensive mistake on this page.
- **`migrationsRun: true` with multiple replicas.** Every replica races the same migration on deploy.
- **Forgetting `forFeature` in a second module** and getting "Nest can't resolve dependencies of UsersService" — the repository provider is module-scoped, not global.
- **Exporting the repository instead of the service.** Now TypeORM types are in three modules instead of one.
- **Using the injected repository inside `dataSource.transaction()`.** It runs on a different connection and does not roll back.
- **Concatenating into `.where()`.** `.where('id = ' + id)` is injectable; `.where('id = :id', { id })` is not.
- **Reusing a parameter name** across `.where()` and `.andWhere()`. The second silently wins.
- **Putting a query parameter into `orderBy()`.** Allow-list it.
- **`this.users.create(body)`** with an unvalidated body. Mass assignment.
- **Trusting the return type of a partial `select`.** You get the entity type, not the narrowed shape — map to a DTO immediately.
- **Setting `eager: true` to fix one endpoint.** It changes every query on that entity.
- **Returning entities from controllers.** Your database schema becomes your public API contract.

## Related topics

- [TypeORM](../orms/typeorm.md) — the library itself: entity options, find syntax, the 1.0 removals and the codemod.
- [Choosing an ORM](./choosing-an-orm.md) — whether TypeORM is the right pick for this project.
- [Repository vs active record](./repository-vs-active-record.md) — the two styles TypeORM supports, and which one survives a DI container.
- [Avoiding N+1](./avoiding-n-plus-one.md) — why `eager` and lazy relations make it easy.
- [Comparison table](./comparison.md) — TypeORM against Prisma, Mongoose, Drizzle and raw drivers inside Nest.
- [SQL injection](../nestjs-security/sql-injection.md) — the threat behind the named-parameter rules.
- [Transactions](../nestjs-databases/transactions.md) — transaction boundaries across services.
- [Migrations](../nestjs-databases/migrations.md) — running `migration:run` in a deploy pipeline.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — how `forRootAsync` fits the module system.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — `getRepositoryToken` in a testing module.
- [Graceful shutdown](../nestjs-production/graceful-shutdown.md) — why the DataSource needs `enableShutdownHooks`.
