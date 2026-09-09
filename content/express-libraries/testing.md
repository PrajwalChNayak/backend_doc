---
title: Testing
description: Testing an Express 5 API with the built-in node:test runner and supertest, the app/server split that makes it possible, and why integration tests should not mock the database.
status: current
updated: 2026-09-08
---

Node 24 ships a test runner, an assertion library, a mocking API and a coverage reporter. For an Express API, the only thing you need to add is `supertest`, which drives your app over a real HTTP socket without you managing a port.

## Why it exists

The value of an API test is in the parts you did not write: the router's path matching, the body parser's limits, the middleware order, the error handler's status mapping, the serializer's output. A unit test that calls your service function directly exercises none of that.

Testing through HTTP tests the thing you actually deploy.

## Installation

:::tabs
@tab npm
```bash
npm install --save-dev supertest@7
```
@tab pnpm
```bash
pnpm add -D supertest@7
```
@tab yarn
```bash
yarn add -D supertest@7
```
:::

Nothing else. `node:test`, `node:assert` and the coverage reporter are built in on Node 24.

## The app.js / server.js split

This is the structural decision that makes everything else possible: the module that **builds** the app must not be the module that **listens**.

```js title="src/app.js"
import express from 'express'
import helmet from 'helmet'
import usersRouter from './routes/users.js'
import { errorHandler } from './middleware/error-handler.js'

export function createApp({ db } = {}) {
  const app = express()

  app.use(helmet())
  app.use(express.json({ limit: '100kb' }))

  app.locals.db = db

  app.use('/users', usersRouter)

  app.use((req, res) => res.status(404).json({ error: 'not_found' }))
  app.use(errorHandler)

  return app
}
```

```js title="src/server.js"
import { createApp } from './app.js'
import { createDb } from './db.js'

const db = await createDb(process.env.DATABASE_URL)
const app = createApp({ db })

const server = app.listen(Number(process.env.PORT ?? 3000), (err) => {
  if (err) throw err
  console.log(`listening on ${server.address().port}`)
})
```

Note the Express 5 `app.listen` signature: a server `'error'` is passed **to the callback** rather than thrown, so the `if (err) throw err` line is not optional.

Why this matters for tests:

- Importing `app.js` starts nothing. No port is bound, no database connection opens, no test hangs because a listener kept the process alive.
- `createApp` takes its dependencies as arguments, so a test can pass a database pointed at a temporary schema.
- `supertest` binds an ephemeral port per request, so tests run in parallel without port collisions.

If your `app.js` calls `app.listen()` at the bottom, every test that imports it starts a server. That is the single most common reason Express test suites hang on exit.

## A first test

```js title="test/users.test.js"
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createTestDb, destroyTestDb } from './helpers/db.js'

describe('POST /users', () => {
  let app
  let db

  before(async () => {
    db = await createTestDb()
    app = createApp({ db })
  })

  after(async () => {
    await destroyTestDb(db)
  })

  beforeEach(async () => {
    await db.exec('DELETE FROM users')
  })

  it('creates a user', async () => {
    const res = await request(app)
      .post('/users')
      .send({ email: 'ada@example.com', displayName: 'Ada' })
      .expect('Content-Type', /json/)
      .expect(201)

    assert.equal(res.body.email, 'ada@example.com')
    assert.ok(res.body.id)
    assert.equal(res.body.password, undefined, 'must not leak the password field')
  })

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/users')
      .send({ email: 'not-an-email', displayName: 'Ada' })
      .expect(400)

    assert.equal(res.body.error, 'validation_failed')
    assert.ok(res.body.issues.some((i) => i.path === 'email'))
  })

  it('rejects unknown fields', async () => {
    await request(app)
      .post('/users')
      .send({ email: 'ada@example.com', displayName: 'Ada', role: 'admin' })
      .expect(400)
  })
})
```

`request(app)` accepts an Express app directly — supertest calls `listen(0)` on it, issues the request, and closes the server. `.expect(201)` asserts and throws on mismatch; `.expect('Content-Type', /json/)` asserts a header.

Awaiting the chain gives you the response, so you can mix supertest's assertions with `node:assert` for the body.

## Running tests

```json title="package.json"
{
  "scripts": {
    "test": "node --test",
    "test:watch": "node --test --watch",
    "test:coverage": "node --test --experimental-test-coverage",
    "test:one": "node --test --test-name-pattern"
  }
}
```

`node --test` with no arguments discovers files matching the runner's default patterns — `*.test.js`, `*-test.js`, `test.js`, and everything under a `test/` directory. Pass paths or globs to narrow it.

Flags worth knowing:

| Flag | What it does |
| --- | --- |
| `--test` | Run the discovered test files, each in its own process |
| `--watch` | Re-run on change; replaces `nodemon` for tests |
| `--test-reporter=spec` | Human-readable output (`tap`, `dot`, `junit`, `lcov` also available) |
| `--test-name-pattern='creates a user'` | Run only matching tests |
| `--test-only` | Run only tests marked `{ only: true }` |
| `--test-concurrency=N` | Cap parallel test files |
| `--experimental-test-coverage` | Collect coverage |
| `--test-coverage-lines=80` | Fail when line coverage falls below the threshold |
| `--env-file=.env.test` | Load test environment variables without `dotenv` |

Each test **file** runs in its own process, which is why one file's `process.env` mutation or module mock cannot leak into another. Tests *within* a file share a process and run in order unless you set `concurrency`.

Coverage thresholds (`--test-coverage-lines`, `--test-coverage-functions`, `--test-coverage-branches`) make the number enforceable in CI rather than decorative. Set them at whatever you have today and ratchet upward; a threshold you immediately lower is worse than none.

## Mocking with `t.mock`

The test context's `mock` is scoped to the test and restored automatically when it ends — which is the property that stops mocks leaking between tests.

```js title="test/notifications.test.js"
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import * as mailer from '../src/mailer.js'
import { createApp } from '../src/app.js'

describe('POST /users', () => {
  it('sends a welcome email', async (t) => {
    const send = t.mock.method(mailer, 'send', async () => ({ id: 'msg_1' }))

    await request(createApp({ db })).post('/users').send({ /* … */ }).expect(201)

    assert.equal(send.mock.callCount(), 1)
    assert.equal(send.mock.calls[0].arguments[0].to, 'ada@example.com')
  })
})
```

`t.mock.method(object, 'name', implementation)` replaces a method and records calls in `.mock.calls` and `.mock.callCount()`. `t.mock.fn(impl)` creates a standalone spy. `t.mock.timers.enable({ apis: ['setTimeout'] })` gives you controllable timers via `t.mock.timers.tick(ms)` — useful for retry and backoff logic without real waiting.

Mock at the **edges**: outbound HTTP, email, payment providers, the clock. Everything inside your own process should run for real.

## Test the error paths

A suite that only covers the happy path tells you your API works for well-behaved clients. Every interesting bug is on the other side.

```js title="test/errors.test.js"
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

describe('error handling', () => {
  const app = createApp({ db })

  it('returns 404 for an unknown route', async () => {
    await request(app).get('/nope').expect(404)
  })

  it('returns 400 for malformed JSON', async () => {
    await request(app)
      .post('/users')
      .set('Content-Type', 'application/json')
      .send('{"email": ') // deliberately broken
      .expect(400)
  })

  it('returns 413 for an over-sized body', async () => {
    await request(app)
      .post('/users')
      .send({ displayName: 'x'.repeat(200_000) })
      .expect(413)
  })

  it('returns 401 without a token', async () => {
    await request(app).get('/users/me').expect(401)
  })

  it('returns 403 for another user\'s resource', async () => {
    await request(app)
      .get(`/users/${otherUserId}`)
      .set('Authorization', `Bearer ${tokenForUserA}`)
      .expect(403)
  })

  it('does not leak the stack trace on a 500', async (t) => {
    t.mock.method(db, 'query', () => {
      throw new Error('connection reset by peer')
    })

    const res = await request(app).get('/users').expect(500)

    assert.equal(res.body.error, 'internal_error')
    assert.equal(res.body.stack, undefined)
    assert.ok(!JSON.stringify(res.body).includes('connection reset'))
  })
})
```

That last test is the one people skip and the one that catches a real leak. An error handler that returns `err.message` in production hands attackers your internals; a test asserting it does not is cheap and permanent.

Express 5 makes the async-rejection path easy to test: a handler that throws reaches the error middleware without a wrapper, so you can force a rejection with a mock and assert the resulting status.

Other error paths worth a test each: a validation failure per schema, a duplicate-key conflict returning 409, a rate limiter returning 429 with `Retry-After`, an upload over `fileSize` returning 413, and an unauthenticated request to every protected route.

## Do not mock the database in integration tests

The tempting shortcut is a fake repository that returns canned objects. It makes tests fast and it makes them worthless for the class of bug they are supposed to catch.

What a mocked database cannot tell you:

- Whether the SQL is valid, or whether the query matches the schema after a migration.
- Whether a unique constraint fires and whether your handler maps it to a 409.
- Whether a `NOT NULL` column is actually being populated.
- Whether a transaction rolls back correctly on a partial failure.
- Whether your ORM emits the query you think it does — including whether it emits N of them.
- Whether a type coercion (a `DATE`, a `NUMERIC`, a `JSONB`) round-trips as you expect.

Every one of those fails only against a real engine. A mock encodes your *assumptions* about the database and then verifies your code against those assumptions, which is a tautology.

Run integration tests against a real database:

- **SQLite** (`node:sqlite`, built in on Node 24) when the SQL is portable. It needs no service, starts instantly, and works unattended in CI.
- **A container** — Postgres or MySQL via `docker run` — when you use engine-specific features. Same engine as production is the goal.
- **Isolation per test file**: a fresh schema, a fresh database, or a transaction rolled back after each test. The runner puts each file in its own process, so per-file isolation is natural.

Migrate the test database with the *same* migration files as production. A hand-written `CREATE TABLE` in a test helper drifts from the real schema and hides exactly the failures you built the tests to catch.

Mocking is still right for things you do not own and cannot run: the payment provider, the email service, the third-party API with a rate limit. Those are edges, not your data layer.

Details of the per-engine setup, transactional rollback, and fixtures are in [Testing with a database](../orms/testing-with-a-database.md).

## Structuring the suite

| Layer | What it covers | Speed | How many |
| --- | --- | --- | --- |
| Unit | Pure functions: a price calculator, a formatter, a policy check | Microseconds | Many |
| Integration (HTTP + database) | A route end to end through the real middleware stack and a real database | Milliseconds | Most of your value lives here |
| End-to-end | Multiple services, a browser | Seconds | A handful of critical paths |

For an API, invert the usual advice and put the weight on the integration layer. The bugs that reach production in an Express app are middleware ordering, status codes, validation gaps, authorization gaps and SQL — none of which a unit test sees.

Some practical rules:

- **Test the contract, not the implementation.** Assert on status, headers and body shape. A test that asserts which internal function was called breaks on every refactor and catches nothing.
- **No shared mutable state between tests.** Reset in `beforeEach`, not in `before`.
- **No sleeps.** Await the thing you are waiting for, or use `t.mock.timers`.
- **One assertion subject per test.** "Creates a user" and "sends a welcome email" are two tests.
- **Name tests as sentences about behavior.** `rejects a malformed email`, not `test2`.

## Security considerations

**Test the authorization matrix, not just authentication.** For every protected resource: anonymous → 401, wrong user → 403 or 404, right user → 200. This is the only reliable defense against IDOR, which is invisible to type checkers and code review.

**Assert on what is absent.** `assert.equal(res.body.passwordHash, undefined)` catches a serializer that started returning the whole row. Absence assertions are the ones that survive refactors.

**Test that errors do not leak internals.** No stack traces, no SQL, no file paths, no upstream error text in a 500 body.

**Test the security middleware is actually applied.** `await request(app).get('/').expect('X-Content-Type-Options', 'nosniff')` fails the day someone moves `helmet()` below the routes.

**Test the limits.** Body size, upload size, rate limit, and pagination maximums. A limit with no test silently disappears.

**Use fake credentials only.** Test fixtures end up in the repository, in CI logs, and in error output. Never a real key, never real customer data.

**Point tests at a disposable database.** A test suite with `DELETE FROM users` and a production `DATABASE_URL` in the environment is one misconfiguration from a very bad day. Fail loudly if the test database name does not look like a test database.

**Run `npm audit` in CI** alongside the tests — see [Dependency auditing](../security/dependency-auditing.md).

## Production considerations

**Run the same command locally and in CI.** `npm test` with no environment-specific flags. Divergence is how "works on my machine" survives.

**Use `--env-file=.env.test`** rather than a `dotenv` dependency and a conditional import.

**Seed deterministically.** Fixed IDs, fixed timestamps (or a mocked clock). A test that depends on the current date fails at a month boundary, at 23:59, or in another timezone.

**Set `TZ=UTC` in CI** and ideally in production, so date behavior is one less variable.

**Keep the suite fast enough that people run it.** Beyond a few minutes, developers stop running it locally and start relying on CI, which lengthens the feedback loop to the point where the tests stop preventing bugs.

**Set coverage thresholds and ratchet them.** Coverage is a floor, not a goal — 100% coverage of happy paths is worse than 70% that includes the error paths.

**Emit a machine-readable report in CI.** `--test-reporter=junit --test-reporter-destination=test-results.xml` alongside `--test-reporter=spec --test-reporter-destination=stdout`, so the CI UI can annotate failures.

**Fail the build on a flaky test rather than retrying it.** A retry that hides a race in your connection pool is the retry that lets the race reach production.

## Common mistakes

- **Calling `app.listen()` in the module the tests import.** The suite hangs at exit and ports collide.
- **Not exporting a factory.** With a module-level app you cannot inject a test database.
- **Mocking the database in integration tests.** You test your assumptions, not your SQL.
- **Only testing happy paths.** The 400s, 401s, 403s, 409s, 413s and 429s are where the bugs are.
- **Forgetting to await the supertest chain.** The assertion runs after the test ends and the failure is silent.
- **Sharing state between tests.** Order-dependent tests that pass locally and fail in CI.
- **`setTimeout` waits.** Slow, and flaky anyway. Use `t.mock.timers` or await the real thing.
- **Restoring mocks by hand.** `t.mock` restores automatically; a manual `afterEach` that misses one leaks into the next test.
- **Building the test schema by hand** instead of running the real migrations.
- **Asserting on internal calls instead of the HTTP response.** Brittle and low value.
- **A test database that is not obviously a test database.** One environment mix-up and the `DELETE FROM` runs somewhere real.
- **Chasing a coverage number** while never testing an error path.

## Related topics

- [Testing with a database](../orms/testing-with-a-database.md) — real-engine setup, transactional isolation and fixtures.
- [The built-in test runner](../node/built-in-test-runner.md) — the runner's own API in more depth.
- [Error handling](../express/error-handling.md) — the error paths these tests assert on.
- [Setup and project structure](../express/setup-and-project-structure.md) — where the app/server split fits in a real layout.
- [Continuous integration](../production/ci.md) — running this suite on every push.
- [Validation](validation.md) — the schemas whose failure modes deserve a test each.
- [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md) — the authorization matrix worth testing exhaustively.
