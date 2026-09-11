---
title: Repository vs active record
description: TypeORM 1.1.1 supports both patterns — why static entity methods fight a DI container, how a repository provider gives you a test seam and a transaction boundary, and how to keep ORM types out of your services.
status: current
updated: 2026-09-11
---

Active record puts persistence on the entity: `user.save()`, `User.findOne(...)`. The repository pattern — TypeORM calls it data mapper — puts it on a separate object: `usersRepository.save(user)`. TypeORM supports both, Mongoose documents are active-record-shaped, and Prisma, Drizzle and raw drivers only do the second. Inside Nest the choice is not a matter of taste, because one of the two has no injection token.

## Why it exists

A Nest application is a graph of providers. Everything the framework gives you — constructor injection, `overrideProvider` in tests, module boundaries, request-scoped context, interceptors that wrap a provider — operates on **instances the container built**. A static method on a class is none of those things. It is reachable from anywhere, it is bound to whatever `DataSource` somebody assigned it at bootstrap, and nothing can substitute it.

That is the entire argument, and everything below is a consequence of it.

:::note How the examples are written
Nest's constructor injection is usually written with the parameter-property shorthand, `constructor(private readonly users: Repository<User>) {}`. The snippets here declare the field and assign it, because the site's snippet checker type-strips every `ts` block. The two forms are equivalent — use the shorthand in your own code.
:::

## The two styles in TypeORM

### Active record

The entity extends `BaseEntity` and gains statics (`find`, `findOne`, `create`, `update`, `delete`) and instance methods (`save`, `remove`, `softRemove`, `recover`, `reload`).

```ts title="src/users/user.entity.ts"
import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'users' })
export class User extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string

  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash!: string
}
```

```ts title="src/users/users.controller.ts"
// The persistence API is on the entity itself.
const user = await User.findOne({ where: { id } })
user.email = 'new@example.com'
await user.save()
```

It reads beautifully, and in a Rails-shaped application it is a perfectly good pattern. In Nest it has a wiring problem before it has a design problem: those statics need a `DataSource`, and `@nestjs/typeorm` hands you the `DataSource` as a **provider**, not as a global. You have to bind it yourself, at bootstrap, before anything queries:

```ts title="src/database/active-record.bootstrap.ts"
import { Injectable, OnModuleInit } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { BaseEntity, DataSource } from 'typeorm'

@Injectable()
export class ActiveRecordBootstrap implements OnModuleInit {
  private readonly dataSource: DataSource

  constructor(
    @InjectDataSource()
    dataSource: DataSource,
  ) {
    this.dataSource = dataSource
  }

  onModuleInit() {
    // Every BaseEntity static now runs against this DataSource. It is process
    // -wide, ambient state — the thing Nest's container exists to avoid.
    BaseEntity.useDataSource(this.dataSource)
  }
}
```

That provider is the whole problem in miniature: a lifecycle hook whose job is to install a global, so that code which does not participate in the container can work anyway.

### Repository (data mapper)

The entity is data. A `Repository<User>` arrives through the constructor.

```ts title="src/users/users.service.ts"
import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { User } from './user.entity.js'

@Injectable()
export class UsersService {
  private readonly users: Repository<User>

  constructor(
    @InjectRepository(User)
    users: Repository<User>,
  ) {
    this.users = users
  }

  async changeEmail(id: number, email: string) {
    const result = await this.users.update({ id }, { email })
    if (!result.affected) throw new NotFoundException(`User ${id} not found`)
  }
}
```

Same query, same SQL. The difference is that `UsersService` now *declares* what it needs, and the container decides what to give it.

## What you actually lose with active record in Nest

Five specific things, in the order they bite.

**1. There is no test seam.** `User.findOne()` resolves through the class, not through the injector, so `Test.createTestingModule()` has nothing to override. Every unit test of a service that calls a static needs a real database, or a module-mocking hack that breaks the moment somebody renames the file. With a repository, one line replaces it:

```ts title="src/users/users.service.spec.ts"
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { User } from './user.entity.js'
import { UsersService } from './users.service.js'

const repo = { update: async () => ({ affected: 1 }) }

const moduleRef = await Test.createTestingModule({
  providers: [UsersService, { provide: getRepositoryToken(User), useValue: repo }],
}).compile()
```

No database, no container, no fixtures. [Mocking providers](../nestjs-testing/mocking-providers.md).

**2. Transactions cannot include it.** This is the serious one. A `BaseEntity` static runs on the bound `DataSource`, which means the **pool** — not the transaction your service just opened:

```ts vulnerable title="DO NOT COPY — the second write is not in the transaction"
await this.dataSource.transaction(async (manager) => {
  await manager.update(Order, orderId, { status: 'paid' })
  // Runs on a DIFFERENT connection. It will not roll back, and it can
  // deadlock against the rows the transaction above is holding.
  await User.update({ id: userId }, { lastPaidAt: new Date() })
})
```

Nothing fails loudly. It passes review, it passes a happy-path test, and it produces a support ticket six weeks later. The repository form has the same trap with an injected repository — the fix in both cases is that everything inside the callback goes through the callback's `manager`, which an entity static structurally cannot do. See [Transactions](../nestjs-databases/transactions.md).

**3. Module boundaries stop meaning anything.** `forFeature([User])` deliberately scopes `Repository<User>` to the module that imported it, so a controller cannot reach past a service into another aggregate's storage. An importable entity class with statics on it is globally callable, so that boundary is decorative.

**4. Multiple databases get dangerous.** `BaseEntity.useDataSource()` sets one data source for the statics. With a primary and a reporting connection, entity statics go to whichever was bound last — and the failure mode is queries silently hitting the wrong database.

**5. Nothing can wrap it.** A repository is a provider, so you can decorate it: add caching, add query counting, add tenant scoping, swap it for a fake in an end-to-end test. A static is a static.

:::best-practice
Use the repository style in Nest. Active record is not a bad pattern — it is a pattern for a framework whose unit of composition is the class rather than the container, and Nest's is the container. If you are porting a codebase that uses `BaseEntity`, the migration is mechanical: inject `Repository<T>` and change `Entity.find(x)` to `this.repo.find(x)`.
:::

## Mongoose sits in between, and the module fixes it

A Mongoose document is active-record-shaped: `doc.save()`, `doc.deleteOne()`. But `@nestjs/mongoose` does not give you the *statics* — it gives you the `Model`, injected:

```ts title="src/users/users.service.ts"
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { User, UserDocument } from './user.schema.js'

@Injectable()
export class UsersService {
  private readonly users: Model<UserDocument>

  constructor(
    @InjectModel(User.name)
    users: Model<UserDocument>,
  ) {
    this.users = users
  }
}
```

`Model` is repository-shaped — it is an injected object with query methods — even though the documents it returns are active-record-shaped. That is a workable middle ground, with one caveat: a hydrated document's `save()` reaches the connection directly, so inside a transaction it needs `doc.$session(session)` or the write escapes the transaction, exactly like a `BaseEntity` static. Read paths that only serialize should use `.lean()`, which returns a plain object and removes the temptation entirely. See [Mongoose](./mongoose.md).

Prisma, Drizzle and raw drivers do not offer active record at all. Their results are plain data, which is why the rest of this page applies to them as a design choice rather than a correction.

## Keeping ORM types out of your services

The repository style solves the container problem. It does not automatically solve the *coupling* problem, and that is a separate decision with its own cost.

### Level 1 — the ORM repository, injected

`UsersService` holds a `Repository<User>`. TypeORM types live in the service, and `UsersModule` exports the service rather than the repository so they do not spread further.

This is the right default. It is what [TypeORM](./typeorm.md) shows, it is honest about what the service does, and it costs nothing.

### Level 2 — a repository provider per aggregate

When a service accumulates query-builder chains, move them into a class of their own. The service then reads as business logic and the SQL lives in one file:

```ts title="src/users/users.repository.ts"
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, Repository } from 'typeorm'
import { User } from './user.entity.js'

@Injectable()
export class UsersRepository {
  private readonly users: Repository<User>

  constructor(
    @InjectRepository(User)
    users: Repository<User>,
  ) {
    this.users = users
  }

  /** Every read on this aggregate goes through here, so the soft-delete
   *  predicate and the column projection exist in exactly one place. */
  findActiveByEmail(email: string) {
    return this.users.findOne({
      where: { email, deletedAt: IsNull() },
      select: { id: true, email: true, name: true },
    })
  }
}
```

The payoff is not abstraction for its own sake. It is that "did we remember the tenant filter, the soft-delete predicate and the projection?" becomes a question about one file instead of forty call sites.

### Level 3 — a port and an adapter

When you want the service to depend on *nothing* from the data layer, declare an interface and a token, and provide an implementation.

```ts title="src/users/users.port.ts"
/** The domain's view of a user. No decorators, no ORM types, no `id` from a
 *  driver — just what the business logic needs. */
export interface UserRecord {
  id: number
  email: string
  displayName: string | null
}

export interface UsersPort {
  findByEmail(email: string): Promise<UserRecord | null>
  create(input: { email: string; displayName: string | null; passwordHash: string }): Promise<UserRecord>
}

export const USERS_PORT = Symbol('USERS_PORT')
```

```ts title="src/users/users.typeorm.adapter.ts"
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { User } from './user.entity.js'
import { UserRecord, UsersPort } from './users.port.js'

@Injectable()
export class TypeOrmUsersAdapter implements UsersPort {
  private readonly users: Repository<User>

  constructor(
    @InjectRepository(User)
    users: Repository<User>,
  ) {
    this.users = users
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.users.findOne({
      where: { email },
      select: { id: true, email: true, name: true },
    })
    return row ? { id: row.id, email: row.email, displayName: row.name } : null
  }

  async create(input: { email: string; displayName: string | null; passwordHash: string }) {
    const saved = await this.users.save(
      this.users.create({ email: input.email, name: input.displayName, passwordHash: input.passwordHash }),
    )
    return { id: saved.id, email: saved.email, displayName: saved.name }
  }
}
```

```ts title="src/users/users.module.ts"
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from './user.entity.js'
import { USERS_PORT } from './users.port.js'
import { TypeOrmUsersAdapter } from './users.typeorm.adapter.js'
import { UsersService } from './users.service.js'

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService, { provide: USERS_PORT, useClass: TypeOrmUsersAdapter }],
  exports: [UsersService],
})
export class UsersModule {}
```

`UsersService` now injects `@Inject(USERS_PORT) users: UsersPort` and imports nothing from `typeorm`. Swapping to Prisma is a second adapter and a one-line change in the module.

**The cost is real and you should price it before adopting it:** a mapping function per aggregate that has to be maintained, a second set of types, and a loss of the ORM's more expressive reads — a port that exposes `findMany(options)` has just re-exported the ORM with extra steps, and a port that does not means every new query is a new method.

:::best-practice
Default to level 1, move to level 2 when a service's query construction outgrows it, and adopt level 3 only when you have a concrete reason: a planned ORM migration, a domain model that genuinely differs from the table shape, or a policy that the domain layer has no infrastructure imports. "It is more testable" is not a reason on its own — level 1 is already fully testable through `getRepositoryToken`.
:::

## Never return an entity from a controller

Whichever level you stop at, this rule is unconditional. An entity is a database row with relations attached and, in the active-record case, with persistence methods attached.

```ts vulnerable title="DO NOT COPY"
@Get(':id')
findOne(@Param('id', ParseIntPipe) id: number) {
  // Every loaded column, every eagerly loaded relation, and whatever the
  // schema gains next quarter.
  return this.users.findOne({ where: { id } })
}
```

Three separate problems. **Your schema becomes your public API**, so adding a column changes the response. **A removed `select: false` silently starts shipping a hash.** And **an eager relation added for one endpoint changes every endpoint's payload**.

Map to a DTO in the service, or use a serialization interceptor — [Serialization](../nestjs-validation/serialization.md).

## Security considerations

**A repository is where cross-cutting query predicates live, and cross-cutting query predicates are security controls.** Tenant scoping, soft-delete filtering, owner checks and column projections are all "must be on every query" rules, and "every query" is only enforceable when there is one place queries are written. With active record, every call site is a place a query is written.

```ts good title="src/orders/orders.repository.ts"
/** The tenant is a constructor-level fact, not a parameter a caller can
 *  forget. Every method below is scoped by construction. */
findForTenant(tenantId: number, id: number) {
  return this.orders.findOne({
    where: { id, tenantId, deletedAt: IsNull() },
    select: { id: true, status: true, totalCents: true },
  })
}
```

**Do the authorization check inside the query, not before it.** Loading a row in a guard and acting on it later is a time-of-check/time-of-use race — the row can change in between. Folding `ownerId: user.id` into the `WHERE` clause proves the fact about the row you are actually reading. A repository makes that the only available shape; a static invites `User.findOne({ where: { id } })` followed by a check. See [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

**Active record makes mass assignment easier to reach.** `Object.assign(user, req.body); await user.save()` is two lines and writes `role`. The repository form at least forces the write through a method you wrote. Neither is a substitute for the global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`, plus constructing the write from named fields. [Mass assignment](../security/mass-assignment.md).

**Entity statics bypass module boundaries, which bypasses your review surface.** A controller in an unrelated feature can import `User` and query it. The repository provider is only visible where the module exports it, so "who can read the users table?" is answerable from the module graph.

**A leaked entity leaks more than columns.** In the active-record case the object handed to a serializer carries `save()` and `remove()`. Anything that walks it — a generic serializer, a logging interceptor, a caching layer — is walking a live persistence handle. `.lean()` (Mongoose) and DTO mapping (everywhere) both remove that.

**Raw SQL belongs in the repository.** When a query has to drop to `dataSource.query()`, `$queryRaw` or a `pg` statement, keeping it in one file is what makes the parameterisation reviewable. A raw query written inline in a controller is one that nobody will read again. [SQL injection](../nestjs-security/sql-injection.md).

## Production considerations

- **One place to instrument.** A repository provider is where you add query counting, a slow-query log with the aggregate name attached, or a per-request query budget. Statics scattered across controllers give you a flat query log with no attribution. [Observability](../nestjs-production/observability.md).
- **One place to fix an N+1.** When a list endpoint turns out to be issuing fifty-one queries, a repository is a single method to rewrite. [Avoiding N+1](./avoiding-n-plus-one.md).
- **One place to add caching.** A cache-aside wrapper around a repository is a decorator provider; a cache around a static is a monkey patch.
- **Transaction boundaries stay in the service layer.** Not the controller (the transaction would then span validation and response serialization) and not the repository (two individually atomic methods are not atomic together, which is the whole requirement).
- **Export the service, not the repository.** Once two modules inject the same `Repository<User>`, the entity's invariants are enforced in two places — and `forFeature` has to be repeated in both.
- **Budget the port layer honestly.** Level 3 costs a mapper per aggregate forever. Adopt it for a reason you can name, not as a default.
- **Keep the row interfaces next to the queries** when you use raw drivers. Nothing checks them against the database, so proximity plus an integration test is the only defence. [Database fixtures](../nestjs-testing/database-fixtures.md).
- **Measure the abstraction's cost in queries, not in lines.** A port that forces `findAll()` where the ORM would have expressed `findMany({ where, take })` is a performance regression wearing a design pattern.

## Common mistakes

- **Using `BaseEntity` statics inside a `dataSource.transaction()` callback.** They run on the pool, not the transaction, and nothing warns you.
- **Calling `BaseEntity.useDataSource()` in a second module.** The statics now point at whichever data source was bound last.
- **Assuming an injected `Repository<User>` is transaction-aware.** It is bound to the pool too — use the callback's `manager`.
- **Testing a service that calls entity statics.** There is no token to override; you end up needing a database.
- **Exporting the repository from a module instead of the service.** ORM types spread, and `forFeature` has to be repeated.
- **Returning entities from controllers.** Your schema becomes your API contract, and `select: false` is one refactor away from leaking.
- **`Object.assign(entity, body)` then `save()`.** Mass assignment in two lines.
- **Writing a port that mirrors the ORM's query options.** That is the ORM with extra steps and a mapper to maintain.
- **Adopting the port layer "for testability"** when `getRepositoryToken` already gives you the seam.
- **Scattering the tenant filter across call sites.** One omission is a cross-tenant disclosure.
- **Putting the transaction in the repository.** Two atomic methods are not one atomic operation.
- **Mixing the styles.** Half the codebase on statics and half on repositories means neither rule can be enforced in review.

## Related topics

- [TypeORM](./typeorm.md) — `forFeature`, `@InjectRepository`, extending a repository, and the 1.0 removals.
- [Mongoose](./mongoose.md) — injected `Model`, hydrated documents and `.lean()`.
- [Prisma](./prisma.md) — a service that *is* the client, and what that changes.
- [Raw drivers](./raw-drivers.md) — the repository pattern with no ORM underneath.
- [Choosing an ORM](./choosing-an-orm.md) — which tools offer a choice of style at all.
- [Comparison table](./comparison.md) — test seams and injection forms side by side.
- [Avoiding N+1](./avoiding-n-plus-one.md) — why one place to write the query matters.
- [Providers and services](../nestjs/providers-and-services.md) — what a provider is and how tokens resolve.
- [Dependency injection](../nestjs/dependency-injection.md) — `useClass`, `useValue` and `Symbol` tokens for ports.
- [Modules](../nestjs/modules.md) — `exports` as a visibility boundary.
- [Transactions](../nestjs-databases/transactions.md) — why the boundary belongs in the service layer.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — overriding a repository token in a testing module.
- [Serialization](../nestjs-validation/serialization.md) — mapping entities to DTOs before they reach a response.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — putting the ownership check in the `WHERE` clause.
