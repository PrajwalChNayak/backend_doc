---
title: Testing with a database
description: Testing Nest services against a real database — overriding the datasource in Test.createTestingModule, throwaway SQLite versus disposable Postgres, per-test isolation by transaction rollback, and migrations in the test bootstrap.
status: current
updated: 2026-09-11
---

A mocked repository proves that your service calls the methods you told it to call. It cannot prove that the query is valid SQL, that the column exists, that the unique constraint fires, that the transaction rolls back, or that the migration you wrote last week matches the entity. Those are the bugs that reach production, and the only thing that catches them is a real database. Nest makes this cheap: `Test.createTestingModule` is the same container with a seam for substituting the connection.

## Mock the boundary, not the database

There is a real place for mocks — the payment provider, the email service, the clock. The database is not one of them.

| Test | Mocked repository | Real database |
| --- | --- | --- |
| Service calls `findOne` | passes | passes |
| The SQL is valid | not tested | fails at the query |
| The column exists | not tested | fails at the query |
| A unique constraint rejects the duplicate | not tested | 23505 |
| A transaction rolls back on throw | not tested | row is absent |
| The migration matches the entity | not tested | fails at bootstrap |
| `ON DELETE CASCADE` behaves | not tested | tested |
| An N+1 happened | not tested | visible in a query count |

The mock's whole output is a restatement of the test's own setup. See [Mocking providers](../nestjs-testing/mocking-providers.md) for where mocks *do* earn their place.

## Throwaway SQLite or disposable Postgres

Both are legitimate; they buy different things.

| | SQLite (`:memory:` or a temp file) | Postgres in a container |
| --- | --- | --- |
| Start-up | milliseconds | seconds |
| Parallel test files | trivial — one database each | one schema or one database each |
| CI dependencies | none | a service container or Docker |
| Dialect fidelity | **different engine** | identical to production |
| Catches | invalid SQL, missing columns, constraint logic, rollback | all of that, plus everything below |

What SQLite cannot catch, when production is Postgres:

- **Types.** SQLite has no real `BOOLEAN`, `DATE`, `NUMERIC`, `UUID`, `JSONB`, or array type. A `DECIMAL` column is a float, `true` is `1`, and a timestamp is a string. Rounding and comparison bugs hide here.
- **Postgres-only SQL.** `ON CONFLICT`, `RETURNING`, window functions, CTEs, `ILIKE`, `generate_series`, `ANY($1::bigint[])`, `LATERAL`. A repository that uses any of them cannot run under SQLite at all.
- **Concurrency.** One writer, no `FOR UPDATE`, no deadlocks, no isolation levels. Every test on this page about locking is untestable.
- **Constraint timing.** Deferred constraints, partial and expression indexes, exclusion constraints.
- **Case and collation.** Identifier folding and `ORDER BY` collation differ.

The practical split that works:

- **SQLite for service-level tests** where the query surface is plain CRUD and the point is the business logic. Fast enough to run on save.
- **Postgres for repository tests, migration tests and anything transactional.** Run them in CI on every push, and locally when you touch that layer.

A repository that has to be written twice to satisfy both is a signal you are testing the wrong thing with SQLite. Do not degrade production SQL to keep the fast suite happy.

```bash
# One container, reused across runs, tuned for throughput over durability.
docker run -d --name test-pg -p 55432:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=app_test \
  postgres:17 -c fsync=off -c full_page_writes=off -c synchronous_commit=off
```

`fsync=off` is dangerous and entirely appropriate here: the data is disposable, and turning off durability makes the suite meaningfully faster. Never copy that line into anything else.

## The testing module

`Test.createTestingModule` builds the same container your application builds. The substitution happens through `overrideProvider`, so the code under test is unchanged.

```ts title="test/users.service.spec.ts"
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { Test, TestingModule } from '@nestjs/testing'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { User } from '../src/users/user.entity.js'
import { UsersModule } from '../src/users/users.module.js'
import { UsersService } from '../src/users/users.service.js'
import { MailerService } from '../src/mailer/mailer.service.js'

let moduleRef: TestingModule
let dataSource: DataSource
let users: UsersService

before(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      // The test's own connection, replacing the one AppModule would build.
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
        entities: [User],
        synchronize: false,
      }),
      UsersModule,
    ],
  })
    // The external boundary IS mocked. The database is not.
    .overrideProvider(MailerService)
    .useValue({ send: async () => undefined })
    .compile()

  dataSource = moduleRef.get(DataSource)
  users = moduleRef.get(UsersService)
})

after(async () => {
  // Closes the module, which runs every onModuleDestroy — including the pool.
  await moduleRef.close()
})

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
})

test('rejects a duplicate email at the database level', async () => {
  await users.create({ email: 'a@example.invalid', displayName: 'A' })
  await assert.rejects(
    () => users.create({ email: 'a@example.invalid', displayName: 'B' }),
    (err: { code?: string }) => err.code === '23505',
  )
})
```

`moduleRef.close()` rather than letting the process exit is what closes the pool. Without it the test runner hangs waiting for an open handle, and the usual "fix" — `process.exit(0)` — hides real teardown bugs.

### Overriding by token

When you want the application's own `DatabaseModule` but pointed somewhere else, override the token rather than reconstructing the module:

```ts title="test/orders.repository.spec.ts"
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import { AppModule } from '../src/app.module.js'
import { Order } from '../src/orders/order.entity.js'

const testDataSource = new DataSource({
  type: 'postgres',
  url: process.env.TEST_DATABASE_URL,
  entities: [Order],
})
await testDataSource.initialize()

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(getDataSourceToken())
  .useValue(testDataSource)
  .overrideProvider(getRepositoryToken(Order))
  .useValue(testDataSource.getRepository(Order))
  .compile()
```

`getDataSourceToken()` with no argument returns the default connection's token; `getDataSourceToken('reporting')` returns a named one. `getRepositoryToken(Order)` is the token `@InjectRepository(Order)` resolves. Knowing the token names is what makes overriding possible at all — the same applies to `getModelToken(User.name)` and `getConnectionToken()` from `@nestjs/mongoose`, and to any `Symbol` token you defined yourself, like the `PG_POOL` in [Connections and DI](connections-and-di.md).

For a custom provider the override is direct:

```ts title="test/pg.spec.ts"
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(PG_POOL)
  .useFactory({
    factory: () => new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }),
  })
  .compile()
```

Keep the test pool small (`max: 2`). A suite with ten test files each opening a pool of ten is a hundred connections against a container sized for a laptop, and the failure is a confusing "too many clients already" halfway through CI.

## Migrations in the test bootstrap

Run the **real migrations** against the test database, not `synchronize: true`. Synchronising from entities tests the entities against themselves; running migrations tests that the migrations produce the schema the entities expect — which is the bug that actually reaches production, because the entity and the migration are edited in two separate commits.

```ts title="test/setup.ts"
import { DataSource } from 'typeorm'
import { buildDataSourceOptions } from '../src/database/data-source-options.js'

export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    ...buildDataSourceOptions(process.env),
    url: process.env.TEST_DATABASE_URL,
    // Same migration files the deploy pipeline runs.
    migrationsRun: false,
    synchronize: false,
    logging: false,
  })

  await dataSource.initialize()
  await dataSource.runMigrations({ transaction: 'each' })
  return dataSource
}
```

Run it once per test *process*, not once per file. With the Node test runner's default of one process per file, that means a schema per worker — or a shared, already-migrated database with per-test isolation, which is the next section.

For Prisma the equivalent is `prisma migrate deploy` against `TEST_DATABASE_URL` in a global setup step. Not `migrate dev`, which needs a shadow database and will offer to reset.

A migration test is worth writing on its own:

```ts title="test/migrations.spec.ts"
test('migrations produce the schema the entities expect', async () => {
  const dataSource = await createTestDataSource()
  // A pending diff means an entity changed without a migration.
  const sqlInJournal = await dataSource.driver.createSchemaBuilder().log()
  assert.equal(sqlInJournal.upQueries.length, 0, 'entities have drifted from the migrations')
  await dataSource.destroy()
})
```

That one test catches the most common TypeORM deployment failure: an entity edited, `synchronize` on in development papering over it, and a production deploy that has no migration for the new column.

## Per-test isolation

Tests that share a database must not share state. Three approaches, in order of speed.

### 1. Transaction rollback

Wrap each test in a transaction and roll it back. Nothing is ever committed, so cleanup is free and perfectly reliable.

```ts title="test/isolation.ts"
import { DataSource, EntityManager, QueryRunner } from 'typeorm'

export interface TestTx {
  manager: EntityManager
  rollback: () => Promise<void>
}

export async function beginIsolated(dataSource: DataSource): Promise<TestTx> {
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
```

```ts title="test/orders.service.spec.ts"
let tx: TestTx

beforeEach(async () => {
  tx = await beginIsolated(dataSource)
})

afterEach(async () => {
  await tx.rollback()
})

test('creating an order reserves stock', async () => {
  const order = await orders.create(1, [{ sku: 'ABC', qty: 2 }], tx.manager)
  const level = await tx.manager.findOneOrFail(StockLevel, { where: { sku: 'ABC' } })
  assert.equal(level.available, 8)
})
```

This is fast and clean, and it has one hard constraint: **every statement in the test must run on `tx.manager`.** Code that reaches for an injected repository runs on a different connection, outside the transaction, and it will not be rolled back — so it leaks into the next test and the failure appears somewhere else entirely.

Which means this technique only works if the code under test already threads the unit of work explicitly, or reads it from `AsyncLocalStorage`. That is a real argument for the explicit style in [Transactions](transactions.md): a codebase that passes `tx` is a codebase whose tests isolate for free.

It also cannot test code that manages its own transaction, because nested `BEGIN` is not a transaction — you would need savepoints, and a rollback to a savepoint does not exercise the same paths as a real rollback. Test those against a truncated database instead.

### 2. Truncate between tests

Slower, and it works regardless of how the code manages transactions.

```ts title="test/truncate.ts"
import { DataSource } from 'typeorm'

let cachedTables: string[] | null = null

export async function truncateAll(dataSource: DataSource) {
  if (!cachedTables) {
    const rows: { tablename: string }[] = await dataSource.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> $1`,
      ['typeorm_migrations'],
    )
    cachedTables = rows.map((r) => r.tablename)
  }
  if (cachedTables.length === 0) return

  // The table list comes from the database's own catalog, never from input.
  // lint-sql:allow identifiers come from pg_tables, not from any user input
  const list = cachedTables.map((t) => `"${t}"`).join(', ')
  await dataSource.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}
```

`CASCADE` handles the foreign-key ordering; `RESTART IDENTITY` resets sequences so an id-dependent assertion is stable. One `TRUNCATE` for every table is far faster than one per table, because it is a single lock acquisition.

That template literal is the one place in this section where an identifier is interpolated. It is safe because the names come from `pg_tables` — the database's own catalog — and never from a request. The `// lint-sql:allow` comment is the proof a reviewer reads next to the code; without it the repository's SQL linter fails the build, which is the behaviour you want.

### 3. A database per worker

The most isolated and the slowest to set up: each test process creates its own database (or its own schema) from a migrated template.

```bash
# Create once, from the migrated template, per worker
createdb -T app_test_template "app_test_$WORKER_ID"
```

Worth it when tests genuinely conflict — testing migrations themselves, testing `LOCK TABLE` behaviour, or testing anything that truncates.

## End-to-end tests

An e2e test goes through the full pipeline: guards, pipes, interceptors, filters and the real database. That is what makes it able to catch a `ValidationPipe` that was never registered — the exact failure that leaves an operator-injection hole open in [MongoDB](mongodb.md).

```ts title="test/app.e2e-spec.ts"
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

let app: INestApplication

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  // Register EXACTLY what main.ts registers, or the test proves nothing
  // about production. Better still: export a configure(app) from main.ts
  // and call it from both.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  await app.init()
})

after(async () => {
  await app.close()
})

test('rejects an operator payload with 400', async () => {
  await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: { $ne: null }, password: { $ne: null } })
    .expect(400)
})

test('creates and reads back a user', async () => {
  const created = await request(app.getHttpServer())
    .post('/users')
    .send({ email: 'e2e@example.invalid', displayName: 'E2E' })
    .expect(201)

  const read = await request(app.getHttpServer()).get(`/users/${created.body.id}`).expect(200)
  assert.equal(read.body.email, 'e2e@example.invalid')
})
```

`app.init()` is required — `createNestApplication()` alone does not start the underlying HTTP adapter, and `getHttpServer()` returns a server that has not been configured. `app.close()` runs the shutdown hooks, which is what closes the pool.

The comment about `main.ts` is the important part. A global pipe, filter or interceptor registered in `main.ts` does **not** exist in a testing module, because `NestFactory.create` never runs. Extract the configuration into a function both call, or you will ship an e2e suite that passes against a configuration production does not have.

Providers registered with `APP_PIPE`, `APP_GUARD`, `APP_FILTER` and `APP_INTERCEPTOR` tokens *are* part of the module graph and do appear in the testing module — which is a good reason to prefer them over `useGlobal*` calls.

## Security considerations

**Test fixtures are credentials.** A test that creates `admin@test.com` with a known password is one careless `NODE_ENV` away from doing it in production. Guard the fixture builders the same way you guard seeds — an environment check inside the code, not in the shell wrapper. See [Seeding](seeding.md).

**Never point a test suite at a production or staging database.** `TRUNCATE TABLE … CASCADE` in a `beforeEach` against production is an unrecoverable afternoon. Two defences, and use both: a separate variable name (`TEST_DATABASE_URL`, never `DATABASE_URL`), and a refusal in the setup code:

```ts title="test/setup.ts"
const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (!/(_test|localhost|127\.0\.0\.1)/.test(url)) {
  throw new Error('refusing to run destructive tests against a non-test database')
}
```

**Never load a production dump into a test database.** It puts real personal data on every developer laptop and CI runner, which is a reportable incident in most jurisdictions. Generate volume; mask irreversibly if you need realistic shapes.

**Write a regression test for every security fix.** The fix for an injection or an IDOR usually lives far from the code it protects — a pipe in `main.ts`, a `WHERE` clause in a repository — and it is exactly what a refactor removes. The test is what makes the fix durable: [SQL injection](../nestjs-security/sql-injection.md), [NoSQL injection](../nestjs-security/nosql-injection.md).

**Test the authorization path with a real database.** A mocked repository returns whatever the mock was told to return, so an ownership check that does nothing still passes. Insert two users' rows and assert that one cannot read the other's.

**Keep test credentials out of the repository.** A container password of `test` on a port bound to localhost is fine. A real connection string in `.env.test` committed to git is not.

**Redact in test logs too.** CI logs are widely readable and retained. A failing test that dumps the connection options has published the password.

## Production considerations

- **Run the real migrations in the test bootstrap**, never `synchronize: true`. Testing the entities against themselves proves nothing about the deploy.
- **Assert that no schema diff is pending.** It is one test and it catches the most common TypeORM deployment failure.
- **Run the Postgres suite in CI on every push.** A fast SQLite suite locally is fine; it must not be the only gate.
- **Keep test pools small** (`max: 2`). Ten files × ten connections exhausts a test container.
- **Always `await moduleRef.close()` or `app.close()`.** Otherwise the runner hangs on an open handle and someone adds `process.exit`.
- **Prefer transaction rollback for isolation**, truncate where the code manages its own transactions, a database per worker where tests genuinely conflict.
- **Pin the database major to production's.** Behaviour around `ONLY_FULL_GROUP_BY`, JSON functions and collation differs between majors.
- **Run one migration/e2e job against a container with real durability settings** as well as the fast one, so nothing depends on `fsync=off`.
- **Extract global pipe and filter registration into a shared `configure(app)`** so e2e tests exercise production's configuration.
- **Use `APP_PIPE`-style provider tokens** where you can; they appear in a testing module automatically.
- **Count queries in a test** to catch an N+1 before it ships — [Avoiding N+1](../nestjs-orms/avoiding-n-plus-one.md).
- **Test the rollback path explicitly.** Throw inside a transaction and assert the row is absent; it is the path that never runs in development.

## Common mistakes

- **Mocking the repository and calling it a test.** It asserts your own setup back at you.
- **`synchronize: true` in the test bootstrap.** The migrations are never exercised.
- **Testing only against SQLite when production is Postgres.** Types, `ON CONFLICT`, `RETURNING`, locking and isolation all differ.
- **Rewriting production SQL so it runs under SQLite.** You degraded the application to keep the fast suite happy.
- **Forgetting `app.init()`.** `getHttpServer()` returns an unconfigured server and every request 404s.
- **Forgetting `close()`.** The suite hangs; `process.exit(0)` hides the real problem.
- **Registering the global `ValidationPipe` only in `main.ts`.** The e2e suite tests a configuration production does not have — and vice versa.
- **Transaction-rollback isolation with code that uses injected repositories.** Those writes commit and leak into the next test.
- **A test pool of ten per file.** "Too many clients already" halfway through CI.
- **Truncating without `CASCADE` or `RESTART IDENTITY`.** Foreign-key errors, and id-dependent assertions that drift.
- **Interpolating a table name without the `lint-sql:allow` proof.** Even when it is safe, the next reader cannot tell.
- **Pointing tests at `DATABASE_URL`.** One misconfigured environment away from truncating production.
- **A production dump as test data.** Personal data on every laptop and CI runner.
- **No regression test for a security fix.** The next refactor removes the fix silently.

## Related topics

- [Database fixtures](../nestjs-testing/database-fixtures.md) — building test data through the container, and factory patterns.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — supertest, the full pipeline and what a testing module does not inherit from `main.ts`.
- [Mocking providers](../nestjs-testing/mocking-providers.md) — where mocks do belong: the boundaries you do not own.
- [Testing with a database](../orms/testing-with-a-database.md) — the same problem outside Nest, with the isolation trade-offs in more depth.
- [Transactions](transactions.md) — why explicit `tx` passing makes rollback isolation possible.
- [Migrations](migrations.md) — the migrations the test bootstrap replays.
- [Seeding](seeding.md) — reference data in tests, and keeping fixture credentials out of production.
- [Connections and DI](connections-and-di.md) — the tokens you override, and why the connection is a provider at all.
- [SQL injection](../nestjs-security/sql-injection.md) — the regression test that keeps a fix in place.
- [Continuous integration](../nestjs-production/ci.md) — service containers, the migration job and what runs on every push.
