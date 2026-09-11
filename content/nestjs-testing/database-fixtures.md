---
title: Database fixtures
description: Fixture patterns for NestJS tests — typed factories with overrides, building test data through the container, transaction rollback versus truncation versus a schema per worker, seeding reference data once, and running the real migrations in the test bootstrap.
status: current
updated: 2026-09-11
---

A fixture is the data a test needs to be meaningful, and the way you build it decides whether the suite stays readable at two hundred tests or collapses into a pile of copy-pasted inserts. This page is about the fixture layer specifically: factories, isolation strategies and parallelism. The decision to use a real database at all, the connection overrides, and the SQLite-versus-Postgres trade-off are in [Testing with a database](../nestjs-databases/testing-with-a-database.md) — read that first; this page assumes it.

## Fixtures are a design problem, not a setup detail

Three properties decide whether a fixture layer survives.

**Every fixture is valid on its own.** A test about orders should not have to know that an order needs a customer, that a customer needs a tenant, and that a tenant needs a billing plan. The factory knows.

**Every test states only what it cares about.** If the assertion is about a discount threshold, the test should mention a quantity and nothing else. Every other field is noise that hides the point and breaks when a column becomes `NOT NULL`.

**Nothing is shared implicitly.** A row created in `beforeAll` and mutated by test three is how a suite becomes order-dependent. Fixtures are created per test and removed per test.

A fixture file full of `INSERT` statements fails all three. So does a giant `seed.sql` that every test reads from.

## Typed factories with overrides

The pattern that scales is one function per entity: sensible defaults for every required field, a shallow merge of what the caller passed, and a unique value for anything with a unique constraint.

```ts title="test/factories/user.factory.ts"
import { randomUUID } from 'node:crypto'
import type { EntityManager } from 'typeorm'
import { User } from '../../src/users/user.entity.js'

export interface UserOverrides {
  email?: string
  displayName?: string
  roles?: string[]
  tenantId?: string
}

/** A valid, saveable User. Every required field has a default. */
export function buildUser(overrides: UserOverrides = {}): User {
  const user = new User()
  user.email = overrides.email ?? `user-${randomUUID()}@example.invalid`
  user.displayName = overrides.displayName ?? 'Test User'
  user.roles = overrides.roles ?? ['reader']
  user.tenantId = overrides.tenantId ?? randomUUID()
  return user
}

export async function createUser(
  manager: EntityManager,
  overrides: UserOverrides = {},
): Promise<User> {
  return manager.save(buildUser(overrides))
}
```

Two functions, not one, and the split matters. `buildUser` is pure, so a unit test can use it with no database at all. `createUser` persists, so an integration test gets a row.

The `randomUUID()` default on `email` is the part people skip and then spend an afternoon on. A hard-coded `test@example.com` default means the second call in a test file violates the unique index, and the error — `23505` from a factory, not from the code under test — is maximally confusing.

:::tip Use `.invalid` for test email domains
`example.invalid` is reserved by RFC 2606 and can never resolve. A fixture using a real-looking domain is one misconfigured mailer away from sending to a stranger.
:::

### Composing factories

Related entities compose by passing the parent in, not by reaching for a global:

```ts title="test/factories/order.factory.ts"
import { randomUUID } from 'node:crypto'
import type { EntityManager } from 'typeorm'
import { Order } from '../../src/orders/order.entity.js'
import { OrderLine } from '../../src/orders/order-line.entity.js'
import { createUser } from './user.factory.js'

export interface OrderOverrides {
  customerId?: string
  status?: 'draft' | 'placed' | 'shipped'
  lines?: { sku: string; qty: number; unitPrice: number }[]
}

export async function createOrder(
  manager: EntityManager,
  overrides: OrderOverrides = {},
): Promise<Order> {
  const customerId = overrides.customerId ?? (await createUser(manager)).id

  const order = new Order()
  order.id = randomUUID()
  order.customerId = customerId
  order.status = overrides.status ?? 'draft'
  order.lines = (overrides.lines ?? [{ sku: 'SKU-1', qty: 1, unitPrice: 1000 }]).map((input) => {
    const line = new OrderLine()
    line.sku = input.sku
    line.qty = input.qty
    line.unitPrice = input.unitPrice
    return line
  })

  return manager.save(order)
}
```

A test then reads as the sentence it is:

```ts
it('applies the bulk discount at ten units', async () => {
  const order = await createOrder(manager, { lines: [{ sku: 'SKU-1', qty: 10, unitPrice: 1000 }] })

  await expect(pricing.total(order.id)).resolves.toBe(9000)
})
```

Nothing about customers, tenants or statuses, because none of it is the subject.

### Factories that go through the container

Sometimes the row is not the point — the *effect of creating it* is. A user created by `manager.save()` has no hashed password, no audit row and no welcome email, because the service that does all that was bypassed.

```ts title="test/factories/registered-user.factory.ts"
import type { TestingModule } from '@nestjs/testing'
import { UsersService } from '../../src/users/users.service.js'

export async function registerUser(
  moduleRef: TestingModule,
  input: { email: string; password: string },
) {
  // Goes through hashing, validation, the audit trail and the outbox —
  // exactly what production does.
  return moduleRef.get(UsersService).register(input)
}
```

Use the repository factory when you need *a row in a state*. Use the service factory when the state must be one the application can actually produce. A test that asserts on login behavior should create its user through registration, or it is testing against a user shape that cannot exist.

The failure mode of the repository-only approach is subtle and expensive: the test passes with a plaintext password column because `manager.save()` never hashed it, and the bug ships.

### Prisma and Mongoose

The shape is identical; only the persistence call changes.

```ts title="test/factories/user.factory.ts"
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

export function buildUser(overrides: Partial<{ email: string; displayName: string }> = {}) {
  return {
    email: overrides.email ?? `user-${randomUUID()}@example.invalid`,
    displayName: overrides.displayName ?? 'Test User',
  }
}

export async function createUser(prisma: PrismaClient, overrides = {}) {
  return prisma.user.create({ data: buildUser(overrides) })
}
```

```ts title="test/factories/device.factory.ts"
import { randomUUID } from 'node:crypto'
import type { Model } from 'mongoose'
import type { Device } from '../../src/notifications/device.schema.js'

export async function createDevice(model: Model<Device>, overrides: Partial<Device> = {}) {
  return model.create({
    userId: overrides.userId ?? randomUUID(),
    pushToken: overrides.pushToken ?? `tok-${randomUUID()}`,
    platform: overrides.platform ?? 'ios',
  })
}
```

Get the model or the client from the container so the factory writes through the same connection the code under test reads from — `moduleRef.get(PrismaService)`, or `moduleRef.get(getModelToken(Device.name))`. A factory holding its own client is a factory that writes outside the test's transaction, and the rows it creates will be invisible to the code under test.

## Reference data versus test data

Two categories, two lifetimes.

| | Reference data | Test data |
| --- | --- | --- |
| Examples | countries, currencies, plan tiers, permission rows | users, orders, sessions |
| Created | once per database, in the bootstrap | per test, by a factory |
| Removed | never | after every test |
| Owned by | the seed script production also runs | the test |

Reference data belongs in the same seed the deploy pipeline runs, not in a test helper — if the two drift, tests pass against rows production does not have. See [Seeding](../nestjs-databases/seeding.md).

The practical consequence is that your truncation step must **not** wipe reference tables:

```ts title="test/isolation/truncate.ts"
import type { DataSource } from 'typeorm'

const PRESERVED = ['typeorm_migrations', 'countries', 'currencies', 'plan_tiers']

let cachedTables: string[] | null = null

export async function truncateTestTables(dataSource: DataSource): Promise<void> {
  if (!cachedTables) {
    const rows: { tablename: string }[] = await dataSource.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = current_schema()
          AND NOT (tablename = ANY($1::text[]))`,
      [PRESERVED],
    )
    cachedTables = rows.map((row) => row.tablename)
  }
  if (cachedTables.length === 0) return

  // Identifiers come from pg_tables — the database's own catalog, never from input.
  // lint-sql:allow table names are read from pg_tables, not from any request
  const list = cachedTables.map((name) => `"${name}"`).join(', ')
  await dataSource.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}
```

The exclusion list is parameterised (`$1::text[]`), so the only interpolation is the identifier list that came back from the catalog — and that one carries the `lint-sql:allow` proof a reviewer reads next to the code.

Caching the table list is worth it: `pg_tables` is queried once per process instead of once per test, and on a suite of several hundred tests that is seconds.

## Isolation strategies in depth

[Testing with a database](../nestjs-databases/testing-with-a-database.md) introduces the three options. Here is what actually decides between them.

| | Rollback | Truncate | Schema/database per worker |
| --- | --- | --- | --- |
| Cost per test | one `BEGIN`/`ROLLBACK` | one `TRUNCATE` over N tables | zero (cost is per worker) |
| Setup cost | none | none | migrate per worker |
| Works with code that opens its own transaction | no | yes | yes |
| Works with code using injected repositories | only via `AsyncLocalStorage` | yes | yes |
| Survives a test that crashes mid-way | yes | yes | yes |
| Can test `LOCK`, deadlocks, isolation levels | no | partly | yes |
| Parallel files | needs a connection each | needs a database each | that is the point |

### Rollback, and the one thing that breaks it

Rollback is the fastest and the strictest: nothing is ever committed, so cleanup cannot fail. The hard constraint is that **every statement the test causes must run on the same connection as the `BEGIN`**. A service that resolves its repository from the container uses the pool, which hands out a different connection, and those writes commit for real.

Two ways to satisfy the constraint. The explicit one is to thread the manager through, which [Transactions](../nestjs-databases/transactions.md) argues for on its own merits. The ambient one is `AsyncLocalStorage`: the application already stores the active manager there, and the test seeds it.

```ts title="test/isolation/transactional.ts"
import type { DataSource, EntityManager, QueryRunner } from 'typeorm'
import type { AsyncLocalStorage } from 'node:async_hooks'

export interface IsolatedTx {
  manager: EntityManager
  rollback: () => Promise<void>
}

export async function beginIsolated(dataSource: DataSource): Promise<IsolatedTx> {
  const runner: QueryRunner = dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()

  return {
    manager: runner.manager,
    rollback: async () => {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    },
  }
}

/** Runs `fn` with the application's ambient manager pointed at the test's transaction. */
export async function withAmbientTx<T>(
  storage: AsyncLocalStorage<{ manager: EntityManager }>,
  tx: IsolatedTx,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ manager: tx.manager }, fn)
}
```

```ts title="test/orders.service.spec.ts"
beforeEach(async () => {
  tx = await beginIsolated(dataSource)
})

afterEach(async () => {
  await tx.rollback()
})

it('reserves stock when an order is placed', async () => {
  await withAmbientTx(storage, tx, async () => {
    const order = await createOrder(tx.manager, { lines: [{ sku: 'ABC', qty: 2, unitPrice: 500 }] })
    await orders.place(order.id)
  })

  const level = await tx.manager.findOneOrFail(StockLevel, { where: { sku: 'ABC' } })
  expect(level.available).toBe(8)
})
```

The tell that you got it wrong is a test that passes alone and fails in a full run, because a leaked row from an earlier test is still there. When you see that, check which connection the writes went through before you check anything else.

Rollback also cannot test code that manages its own transaction. Nesting `BEGIN` is not a transaction — you would need a savepoint, and a rollback to a savepoint does not exercise the same code paths as a real rollback (deferred constraints do not fire, and `ON COMMIT` behavior never runs). Test those against a truncated database.

### Truncate, and making it fast

Truncation is the pragmatic default. Two details make it much faster than the naive version:

- **One statement for all tables.** `TRUNCATE a, b, c` takes one lock; N separate statements take N.
- **Skip the tables that are still empty.** On a suite where most tests touch three tables, tracking which ones were written and truncating only those is a large win — though it costs you a mechanism to track it, so measure before you build it.

`RESTART IDENTITY` resets sequences, which is what makes an id-dependent assertion stable. `CASCADE` handles foreign-key ordering so you do not have to topologically sort your schema by hand.

`DELETE FROM` is slower than `TRUNCATE` on Postgres for anything non-trivial and leaves sequences alone. Use it only when a foreign key from a preserved reference table makes `TRUNCATE` impossible.

### A schema or database per worker

When files run in parallel — the default for both Vitest and the Node test runner — every worker needs its own data. Two shapes:

**A schema per worker**, cheapest on Postgres, since one server and one connection pool serve all of them:

```ts title="test/setup/worker-schema.ts"
import { DataSource } from 'typeorm'
import { buildDataSourceOptions } from '../../src/database/data-source-options.js'

/** Vitest sets VITEST_WORKER_ID; the Node runner exposes a per-process value you set yourself. */
const workerId = process.env.VITEST_WORKER_ID ?? process.env.TEST_WORKER_ID ?? '1'
const schema = `test_w${workerId}`

export async function createWorkerDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    ...buildDataSourceOptions(process.env),
    url: process.env.TEST_DATABASE_URL,
    schema,
    synchronize: false,
    logging: false,
  })

  await dataSource.initialize()
  await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`) // lint-sql:allow schema name is derived from the worker id, not from input
  await dataSource.runMigrations({ transaction: 'each' })
  return dataSource
}
```

The schema name is built from a worker id the runner controls, never from anything external — and it still carries the marker, because the next reader cannot tell that from the line alone.

**A database per worker**, when schemas are not enough — testing migrations themselves, testing `LOCK TABLE`, or testing anything that truncates the whole schema. Cloning from a migrated template is far faster than re-running migrations:

```bash
# Once, in the CI job's setup step
createdb app_test_template
psql -d app_test_template -f schema.sql     # or: npm run migration:run against it

# Per worker, at start-up — a template clone is a file copy, not a replay
createdb -T app_test_template "app_test_$TEST_WORKER_ID"
```

Postgres refuses `CREATE DATABASE ... TEMPLATE` while another session is connected to the template, so nothing may hold a connection to it. That is the error everyone hits once.

The equivalent for Prisma is `prisma migrate deploy` against each worker's `DATABASE_URL` in a global setup step — **not** `migrate dev`, which wants a shadow database and will offer to reset.

## Migrations in the test bootstrap

Run the real migrations, never `synchronize: true`. Synchronising from entities tests the entities against themselves; running migrations tests that the migrations produce the schema the entities expect, which is the failure that actually reaches production because the entity and the migration are edited in two separate commits. [Testing with a database](../nestjs-databases/testing-with-a-database.md) has the bootstrap and the drift assertion.

The fixture-specific consequence: **a factory must not create the schema.** A helper that quietly runs `CREATE TABLE IF NOT EXISTS` when a table is missing turns a failed migration into a passing test suite, which is precisely backwards. If the table is not there, the test should fail loudly.

## Making fixtures deterministic

A suite that fails at midnight, at a month boundary, or only in CI's timezone has a fixture problem.

- **Freeze the clock.** Inject a `Clock` provider and override it with a fixed instant, or use the runner's fake timers. Never call `new Date()` inside a factory default when an assertion depends on it.
- **Set `TZ=UTC`** in CI and in local test scripts. One less variable.
- **Use fixed ids when the test asserts on ordering**, random ones when it does not. `RESTART IDENTITY` plus an explicit insert order is the reliable combination.
- **Never assert on the row count of a shared table.** It is a promise that no future test will insert into it.
- **Seed randomness from a fixed value** if you use a faker-style generator, and print the seed on failure.

## Security considerations

**Fixture credentials are credentials.** A factory that creates `admin@example.invalid` with a known password is one misread `NODE_ENV` away from doing it somewhere real. Put the environment check inside the code, not in the shell wrapper that calls it — see [Testing with a database](../nestjs-databases/testing-with-a-database.md).

**Never point the fixture layer at a shared database.** `TRUNCATE ... CASCADE` in a `beforeEach` against staging is an unrecoverable afternoon. Read a distinctly named variable (`TEST_DATABASE_URL`, never `DATABASE_URL`) and refuse a URL that does not look disposable.

**Never load a production dump as fixture data.** It puts real personal data on every laptop and CI runner, which is a reportable incident in most jurisdictions. Generate volume; mask irreversibly if you need realistic shapes.

**Give every security fix a fixture and a test.** An ownership check is invisible until two users' rows exist — so create both, and assert that one cannot read the other's. See [Authorization and IDOR](../nestjs-security/authorization-and-idor.md).

## Common mistakes

- **A shared fixture in `beforeAll` that tests mutate.** Order-dependent failures that reproduce only in CI.
- **A hard-coded unique value as a factory default.** The second call in a file violates the index, and the error points at the factory.
- **Spelling out every field in every test.** The assertion drowns, and a new `NOT NULL` column breaks two hundred tests instead of one factory.
- **Creating rows with the repository when the test is about what the service does to them.** You created a state production cannot produce.
- **A factory that holds its own client.** Its writes land outside the test's transaction and the code under test cannot see them.
- **Rollback isolation with code that resolves repositories from the container.** Those writes commit and leak.
- **Truncating the reference tables.** Every subsequent test fails on a missing currency or plan tier.
- **Interpolating a table or schema name without the `lint-sql:allow` proof.** Even when it is safe, the next reader cannot tell — and the SQL linter fails the build, which is the behavior you want.
- **`DELETE FROM` everywhere instead of one `TRUNCATE ... RESTART IDENTITY CASCADE`.** Slower, and sequences drift.
- **One database shared by parallel workers.** Interleaved truncations, and failures that move around.
- **`CREATE TABLE IF NOT EXISTS` in a test helper.** A broken migration becomes a green suite.
- **`new Date()` in a factory default with a time-dependent assertion.** It fails at a month boundary and nowhere else.
- **A production dump as fixture data.** Personal data on every laptop and CI runner.

## Related topics

- [Testing with a database](../nestjs-databases/testing-with-a-database.md) — the connection overrides, SQLite versus Postgres, and the migration bootstrap these fixtures sit on.
- [Seeding](../nestjs-databases/seeding.md) — the reference data the truncation step must preserve.
- [Transactions](../nestjs-databases/transactions.md) — why explicit or ambient unit-of-work passing makes rollback isolation possible.
- [Migrations](../nestjs-databases/migrations.md) — the migrations the test bootstrap replays per worker.
- [End-to-end tests](e2e-tests.md) — the shared application these fixtures reset between requests.
- [Mocking providers](mocking-providers.md) — the boundaries that should still be faked.
- [Unit tests](unit-tests.md) — where `buildUser` is used without a database at all.
- [Prisma](../nestjs-orms/prisma.md) — `migrate deploy` against a per-worker database.
- [Mongoose](../nestjs-orms/mongoose.md) — model tokens and per-test collection cleanup.
- [Authorization and IDOR](../nestjs-security/authorization-and-idor.md) — the two-user fixture every ownership check needs.
- [Testing with a database](../orms/testing-with-a-database.md) — the same isolation trade-offs outside Nest.
