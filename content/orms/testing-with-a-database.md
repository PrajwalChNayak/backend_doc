---
title: Testing with a database
description: Testing against a real database instead of mocks — SQLite vs disposable Postgres, transaction rollback vs truncation, testcontainers, fixtures, and parallel isolation.
status: current
updated: 2026-09-08
---

Tests that mock the database verify that your mocks match your assumptions. They do not verify that your query is valid SQL, that the column exists, that the unique constraint fires, or that the transaction rolls back. Run your data-layer tests against a real database — it is faster to set up than most people expect and it catches an entirely different class of bug.

## Why it exists

A mocked repository asserts that `findUser` was called with `{ id: 1 }`. That test passes when the column was renamed, when the index is missing, when the foreign key cascades the wrong way, when the ORM generates a syntactically invalid query, and when a `NOT NULL` constraint would reject the insert.

Every one of those is a production incident, and none of them is catchable without a database.

The historical objection was speed. That argument is largely gone: a Postgres container starts in a couple of seconds, and per-test isolation by transaction rollback costs microseconds. A suite of several hundred data-layer tests runs in seconds.

Mocks still have a place — mock the *payment provider*, not your own database. The line is ownership: mock things you do not control, use the real thing for things you do.

## When to use it

- **Repository and query-layer tests.** Always. This is the whole point.
- **Integration tests through HTTP.** Supertest against a real app with a real database is the highest-value test you can write.
- **Migration tests.** Run every migration from empty on every CI run.
- **Anything involving constraints, transactions or concurrency.** These are database behaviours; no mock reproduces them.

## When not to use it

- **Pure unit tests of business logic.** If a function takes a domain object and returns a decision, do not give it a database.
- **Tests of code that only orchestrates.** A controller that validates input and delegates can be tested with a stubbed service.
- **Third-party integrations.** Mock those.

## Basic example

The whole setup, using `node:test` and PostgreSQL.

### Test bootstrap

```js title="test/helpers/db.js"
import { after, before } from 'node:test'
import knexFactory from 'knex'

export let db

before(async () => {
  db = knexFactory({
    client: 'pg',
    connection: process.env.TEST_DATABASE_URL,
    pool: { min: 1, max: 5 },
    migrations: { directory: './src/db/migrations' },
  })

  // Run migrations, not sync()/push(). Test the schema you ship.
  await db.migrate.latest()
})

after(async () => {
  await db.destroy()
})
```

### A test

```js title="test/repos/users.test.js"
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { db } from '../helpers/db.js'
import { createUser, findUserByEmail } from '../../src/repos/users.js'

describe('users repository', () => {
  beforeEach(async () => {
    await db.raw('TRUNCATE users, posts RESTART IDENTITY CASCADE')
  })

  it('stores and finds a user by email', async () => {
    await createUser(db, { email: 'a@example.com', name: 'A' })
    const found = await findUserByEmail(db, 'a@example.com')
    assert.equal(found.name, 'A')
  })

  it('rejects a duplicate email', async () => {
    await createUser(db, { email: 'a@example.com', name: 'A' })
    await assert.rejects(
      () => createUser(db, { email: 'a@example.com', name: 'B' }),
      /unique/i,
    )
  })
})
```

The second test is the one a mock cannot write. It asserts that a constraint you declared in a migration actually exists in the database.

Run it:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/test node --test
```

## How it works

### SQLite vs a disposable Postgres

The tempting shortcut is SQLite — `node:sqlite` is built in, it needs no container, and it can run entirely in memory. Sometimes that is right and often it is a trap.

**Use SQLite for tests when SQLite is what you run in production.** Otherwise you are testing a different database than the one you deploy.

Here is where the dialects diverge in ways that break tests or, worse, let broken code pass:

| Behaviour | PostgreSQL | SQLite | Consequence |
| --- | --- | --- | --- |
| Types | Strictly enforced | Dynamic by default (`STRICT` tables opt in) | SQLite accepts `'abc'` in an integer column. Your validation bug passes. |
| `ILIKE`, `~`, `DISTINCT ON` | Yes | No | Query fails only in production. |
| `jsonb` operators (`->>`, `@>`) | Yes | Different JSON functions | Every JSON query differs. |
| Arrays, `enum`, `uuid`, `interval` | Yes | None | Whole columns unrepresentable. |
| `RETURNING` | Yes | Modern versions | Older setups differ. |
| Concurrent writes | MVCC, row locks | One writer at a time, database-level lock | Concurrency tests are meaningless. |
| `SELECT … FOR UPDATE` | Yes | Parsed as a no-op or an error | Locking bugs pass. |
| Case sensitivity in `LIKE` | Case-sensitive | Case-insensitive for ASCII | Search tests give the wrong answer. |
| Foreign keys | Always on | **Off by default** — needs `PRAGMA foreign_keys = ON` | Cascades and FK violations silently do not happen. |
| Transactional DDL | Yes | Yes | — |
| Timestamps with time zone | Real type | Stored as text/number | Time-zone bugs invisible. |

That foreign-key row is the sharpest one: by default SQLite does not enforce foreign keys at all, so a test suite can pass with referential integrity completely broken.

:::warning
"It works on SQLite" and "it works on PostgreSQL" are different claims. If you deploy to PostgreSQL, test on PostgreSQL. The savings from SQLite are a few seconds of container startup; the cost is a class of bug that only appears in production.
:::

SQLite is still a fine choice for the examples in this handbook, and for a small project that genuinely deploys SQLite. It is not a stand-in for Postgres.

The middle ground worth knowing about: `pg-mem` (3.0.14) is an in-memory PostgreSQL emulation. It is fast and it implements a substantial subset — but it is an emulation, so the same "different database" caveat applies, just less severely.

### Getting a disposable Postgres

**Docker Compose** — simplest, one long-lived container shared by everyone:

```yaml title="docker-compose.test.yml"
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: test
    ports: ['55432:5432']
    tmpfs: ['/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 1s
      retries: 30
```

`tmpfs` puts the data directory in RAM. Nothing needs to survive a restart, and it is measurably faster.

Port 55432 rather than 5432 so it cannot collide with a local Postgres.

**Testcontainers** — a container per test run, managed from the test process:

```js title="test/helpers/container.js"
import { PostgreSqlContainer } from '@testcontainers/postgresql'

export async function startPostgres() {
  const container = await new PostgreSqlContainer('postgres:17').start()
  return {
    url: container.getConnectionUri(),
    stop: () => container.stop(),
  }
}
```

`@testcontainers/postgresql` (12.1.0) sits on `testcontainers` (12.1.0); `@testcontainers/mongodb` does the same job for a MongoDB replica set, which you need because Mongoose transactions do not work on a standalone `mongod`.

The trade-off is straightforward: testcontainers gives every run a guaranteed-clean database with no shared state and no setup instructions, and costs a few seconds of startup plus a hard requirement on a Docker daemon in CI. Compose is faster and requires everyone to remember to start it.

**GitHub Actions services** — usually the best answer in CI:

```yaml title=".github/workflows/test.yml"
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 1s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
      - run: node --test
        env:
          TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
```

### Running migrations in the test bootstrap

Migrate. Do not `sync()`, `push` or `db push`.

```js
await db.migrate.latest()                    // Knex
await migrate(drizzleDb, { migrationsFolder: './drizzle' })  // Drizzle
// npx prisma migrate deploy                 // Prisma
await AppDataSource.runMigrations()          // TypeORM
```

The reason is not purity. `sync()` and `push` build the schema from your *model definitions*, and production is built from your *migrations*. If those two have drifted, a schema-sync test suite passes and production breaks. Migrating in tests makes every test run a migration test.

It also means an ordering bug — a migration that only works because your dev database already had the table — fails in CI rather than on deploy.

Migrate **once per run**, not per test. A full migration run per test is the usual reason people conclude that database tests are slow.

```js title="test/helpers/db.js"
import { before } from 'node:test'

let migrated = false

before(async () => {
  if (!migrated) {
    await db.migrate.latest()
    migrated = true
  }
})
```

### Per-test isolation: rollback vs truncation

Every test must start from a known state. Two techniques.

#### Transaction rollback

Open a transaction before the test, run everything inside it, roll it back afterwards. Nothing is ever committed.

```js title="test/helpers/tx.js"
import { afterEach, beforeEach } from 'node:test'
import { db } from './db.js'

export let trx

beforeEach(async () => {
  trx = await db.transaction()
})

afterEach(async () => {
  await trx.rollback()
})
```

```js title="test/repos/users.test.js"
import { trx } from '../helpers/tx.js'

it('creates a user', async () => {
  const user = await createUser(trx, { email: 'a@example.com' })
  assert.ok(user.id)
})   // rolled back — the row never existed
```

**Fast** — a rollback is essentially free, and it is perfectly isolated.

**The catch:** the code under test must accept the transaction handle. Anything that opens its own connection from the pool sees an empty database, because the data was never committed. That is a real constraint on your code structure — it means passing a `db`/`trx`/`tx` parameter down through your repositories rather than importing a module-level singleton.

That is good design anyway, and it is the reason to choose this technique. Some ORMs additionally support nested transactions via savepoints, which lets code under test open its own transaction inside the outer one.

**It does not work through HTTP.** A Supertest request goes through your real server, which uses the real pool, which cannot see uncommitted data. Use truncation for those.

#### Truncation

Delete everything between tests.

```js title="test/helpers/truncate.js"
import { beforeEach } from 'node:test'
import { db } from './db.js'

let tables

beforeEach(async () => {
  tables ??= (
    await db.raw(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')
    `)
  ).rows.map((r) => r.tablename)

  if (tables.length === 0) return
  // lint-sql:allow table names come from pg_tables in the current schema, never from input
  await db.raw(
    `TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
})
```

Discover the table list from the catalog once and cache it. A hard-coded list rots the moment somebody adds a table, and the failure is a test that passes because it did not clean up.

**Slower** than rollback, but still fast — a `TRUNCATE` of empty tables is close to instantaneous. **Works everywhere**, including through HTTP, because the data is really committed.

`RESTART IDENTITY` resets sequences, so ids are deterministic across tests. `CASCADE` handles foreign keys.

:::tip
Use both. Transaction rollback for repository and service tests, truncation for the HTTP integration tests. They are not in competition — they solve the same problem at different layers.
:::

#### What not to do

Do not use `DELETE FROM` in a hand-maintained order (fragile against foreign keys and slow), and do not drop and recreate the schema between tests (that is a migration run per test).

### Seeding fixtures

Two kinds of test data, and confusing them causes most fixture pain.

**Reference data** — things every test needs: plan tiers, country codes, roles. Insert once after migrating, before any test. It never changes, so it does not need cleaning up.

**Test-specific data** — the rows this test is about. Create them **inside the test**, with a factory, so the test is readable on its own.

```js title="test/factories.js"
import { randomUUID } from 'node:crypto'

export async function makeUser(db, overrides = {}) {
  const [user] = await db('users')
    .insert({
      email: `${randomUUID()}@example.test`,
      name: 'Test User',
      ...overrides,
    })
    .returning('*')
  return user
}

export async function makePost(db, overrides = {}) {
  const author = overrides.author_id ? null : await makeUser(db)
  const [post] = await db('posts')
    .insert({
      title: 'Test post',
      body: 'body',
      published: true,
      author_id: overrides.author_id ?? author.id,
      ...overrides,
    })
    .returning('*')
  return post
}
```

```js
it('lists only published posts', async () => {
  const author = await makeUser(trx)
  await makePost(trx, { author_id: author.id, published: true, title: 'visible' })
  await makePost(trx, { author_id: author.id, published: false, title: 'hidden' })

  const posts = await listPublishedPosts(trx)
  assert.deepEqual(posts.map((p) => p.title), ['visible'])
})
```

The factory generates unique values for unique columns, so tests never collide on an email. The test states exactly the data it depends on — no reader has to go find a shared fixture file to understand it.

:::warning
A large shared fixture file is the classic trap. Every test comes to depend on invisible details of it, so nobody can change it without breaking twenty unrelated tests. Factories with per-test overrides scale; a shared "seed the world" script does not.
:::

### Parallel test isolation

`node --test` runs test **files** in parallel by default, one process per file. Every one of those processes shares your test database, so file A truncating `users` while file B is asserting on it produces failures that look random.

Three ways out, in increasing order of isolation.

**One database per worker.** Create numbered databases up front and hand each worker one:

```js title="test/helpers/db.js"
// node:test sets TEST_WORKER_ID-style variables via your runner config;
// with plain `node --test`, derive a slot from the process id.
const slot = Number(process.env.TEST_WORKER_INDEX ?? process.pid % 8)

export const db = knexFactory({
  client: 'pg',
  connection: `${process.env.TEST_DATABASE_URL_BASE}/test_${slot}`,
  pool: { min: 1, max: 5 },
})
```

Complete isolation. Costs a full migration run per database — do that once in a global setup step, not per file.

**One schema per worker.** Cheaper, same effect on PostgreSQL. Each worker gets its own schema and sets its `search_path`:

```js title="test/helpers/schema.js"
const slot = Number(process.env.TEST_WORKER_INDEX ?? process.pid % 8)
const schema = `test_${slot}`

export const db = knexFactory({
  client: 'pg',
  connection: process.env.TEST_DATABASE_URL,
  pool: {
    min: 1,
    max: 5,
    // Every pooled connection lands in this worker's schema
    afterCreate: (conn, done) => {
      // lint-sql:allow schema is derived from the worker index, never from test input
      conn.query(`SET search_path TO ${schema}`, (err) => done(err, conn))
    },
  },
  migrations: { directory: './src/db/migrations', schemaName: schema },
})
```

One database, N schemas, no cross-talk. The schema name comes from a worker index you control — never from anything a test can influence.

**Run serially.** `node --test --test-concurrency=1`. The blunt instrument. Correct, and it throws away your parallelism.

Whichever you choose, create the databases or schemas and migrate them **once** in a global setup step, then let the workers connect.

### ORM-specific notes

| Tool | Test bootstrap | Isolation notes |
| --- | --- | --- |
| Prisma | `prisma migrate deploy` against `TEST_DATABASE_URL` | Rollback isolation needs `$transaction` interactive form and passing `tx` down |
| Drizzle | `migrate(db, { migrationsFolder })` | `db.transaction(tx => …)`; pass `tx` into repositories |
| TypeORM | `AppDataSource.runMigrations()`, `synchronize: false` | A `QueryRunner` per test with a manual rollback |
| Sequelize | `sequelize-cli db:migrate` — **not `sync()`** | Pass `{ transaction: t }` everywhere; easy to miss one |
| Knex | `db.migrate.latest()` | `db.transaction()` + `trx.rollback()` is the cleanest of the set |
| Mongoose | Indexes via `syncIndexes()`; data via `migrate-mongo` | No transactions on a standalone `mongod` — use a single-node replica set |

For Mongoose, per-test isolation is usually "drop the collections", since transaction-rollback isolation requires the replica set anyway:

```js
beforeEach(async () => {
  const collections = await mongoose.connection.db.collections()
  await Promise.all(collections.map((c) => c.deleteMany({})))
})
```

## Common patterns

### Assert on query count

The cheapest N+1 detector there is. Count queries around a call and assert the number:

```js title="test/perf/n-plus-one.test.js"
it('lists posts with authors in a bounded number of queries', async () => {
  let count = 0
  const onQuery = () => { count += 1 }
  db.on('query', onQuery)

  await makePost(db); await makePost(db); await makePost(db)
  count = 0
  await listPostsWithAuthors(db)
  db.off('query', onQuery)

  assert.ok(count <= 2, `expected at most 2 queries, got ${count}`)
})
```

This test fails the day somebody introduces a lazy load in a loop, which is exactly when you want to know.

### Test the constraints, not just the happy path

Unique violations, foreign key violations, `NOT NULL` rejections, check constraints. These are the assertions that justify using a real database — write at least one per constraint you rely on.

### Test the migrations from empty on every CI run

A fresh container plus a full migration run is the only thing that catches "this migration only works because my dev database already had that column".

### Keep the test database configuration in one place

One helper module that reads `TEST_DATABASE_URL`, builds the client, migrates once, and exports it. Every test file imports that. Config duplicated across test files drifts.

## Security considerations

**Never point the test suite at a production or staging database.** Test bootstraps run `TRUNCATE` and `migrate:latest`. Guard it in code, not just in documentation:

```js title="test/helpers/db.js"
const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (!/localhost|127\.0\.0\.1|test/.test(url)) {
  throw new Error('refusing to run tests against a non-test database')
}
```

This has saved people. Add it.

**Do not seed real user data.** A production dump in a test fixture puts real PII into your repository, your CI logs and every developer's laptop. Generate synthetic data with a factory. If you must test against production-shaped data, anonymize it in a job that runs inside your production boundary.

**Test credentials are still credentials.** `postgres:postgres` on a container bound to localhost is fine; the same container with `ports: ['0.0.0.0:5432:5432']` on a shared CI runner is not. Bind test services to localhost.

**Write tests for your injection defenses.** They are cheap and they are regression protection for the highest-severity bug class you have:

```js title="test/security/injection.test.js"
it('treats a SQL metacharacter payload as a literal value', async () => {
  await makeUser(trx, { email: 'real@example.com' })
  const found = await findUserByEmail(trx, "' OR '1'='1")
  assert.equal(found, undefined)
})

it('rejects an ORDER BY column outside the allow-list', async () => {
  await assert.rejects(() => listPosts(trx, { sort: 'id; DROP TABLE users--' }))
})
```

For MongoDB, the equivalent test posts an operator object where a string is expected:

```js title="test/security/nosql-injection.test.js"
it('rejects an operator object in the login body', async () => {
  const res = await request(app)
    .post('/login')
    .send({ email: 'admin@example.com', password: { $ne: null } })
  assert.equal(res.status, 400)
})
```

That test fails if somebody turns `sanitizeFilter` off or removes the validation. See [NoSQL injection](../security/nosql-injection.md).

**Do not log query parameters in the test reporter.** Test output goes to CI logs, which usually have wider access than production logs.

## Production considerations

**Run the database suite on every pull request.** A schema test that only runs nightly tells you about the breakage after it merged.

**Use the CI runner's service containers.** They start in parallel with checkout and are faster than starting containers from inside the test process.

**Cache nothing about the database.** A cached volume between runs reintroduces exactly the shared state you are trying to eliminate.

**Pin the database image to the major you run in production.** Testing on `postgres:17` and deploying to 15 means testing features you do not have.

**Keep the suite under a couple of minutes.** The moment it is slow, people stop running it locally, and the value collapses. Migrate once, isolate with rollback where you can, and parallelize by schema.

**Run migrations in CI against an empty database as a separate check.** It is a different assertion from "the tests pass" and it catches ordering bugs. See [Migration strategy](./migration-strategy.md).

**Give the test database a small pool.** `max: 5` per worker, times the worker count, still has to fit inside the container's `max_connections` (100 by default). Eight workers at `max: 10` is 80 connections plus overhead, which is uncomfortably close.

**Make failures reproducible.** Print the seed for any randomized data and the worker slot in the failure output. "Passes locally, fails in CI" is almost always shared-state contamination between parallel workers.

## Common mistakes

- **Mocking the database and calling it a data-layer test.** It asserts your mocks match your assumptions.
- **Testing on SQLite while deploying PostgreSQL.** Different type strictness, no `ILIKE`, no arrays, and foreign keys off by default.
- **Forgetting `PRAGMA foreign_keys = ON`** when you do use SQLite. Referential integrity silently does not exist.
- **Using `sync()` / `push` to build the test schema.** You then never test your migrations, and drift is invisible.
- **Running migrations per test** instead of once per run. This is why people think database tests are slow.
- **Sharing one database across parallel workers.** Random failures that reproduce only under load.
- **A hand-maintained truncation table list.** It rots, and tests silently stop cleaning up.
- **Transaction-rollback isolation with code that grabs its own connection.** It cannot see uncommitted data.
- **Expecting rollback isolation to work through Supertest.** Real server, real pool, committed data only.
- **One giant shared fixture.** Every test depends on invisible details; nobody can change it.
- **Fixtures with hard-coded ids and emails.** They collide the moment tests run in parallel.
- **No guard against a non-test `DATABASE_URL`.** One environment-variable mistake truncates something that matters.
- **Real user data in fixtures.** PII in the repository and in CI logs.
- **Expecting Mongoose transactions on a standalone `mongod`.** Needs a replica set.

## Related topics

- [Testing](../express-libraries/testing.md) — the wider testing setup: `node:test`, Supertest, structure.
- [Migration strategy](./migration-strategy.md) — why the test bootstrap migrates instead of syncing.
- [Migrations](../databases/migrations.md) — the mechanics of the migrations you are running here.
- [Seeding](../databases/seeding.md) — reference data versus test fixtures.
- [SQLite](../databases/sqlite.md) — what SQLite does and does not do, in detail.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md) — the target dialect for most of this page.
- [N+1 queries](../databases/n-plus-one-queries.md) — the failure the query-count assertion catches.
- [SQL injection](../security/sql-injection.md) / [NoSQL injection](../security/nosql-injection.md) — the defenses worth a regression test.
- [Continuous integration](../production/ci.md) — wiring service containers into the pipeline.
- [Comparison table](./comparison.md) — per-ORM test bootstrap differences.
