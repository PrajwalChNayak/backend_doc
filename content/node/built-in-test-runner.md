---
title: The built-in test runner
description: Writing and running tests with node:test and node:assert on Node 24 — mocking, coverage, concurrency, and in-memory fixtures with node:sqlite.
status: current
updated: 2026-09-08
---

Node ships a test runner. `node --test` finds your test files, runs them in parallel processes, reports results in several formats and measures coverage — with no dependency, no config file, and no transform step. For a backend service it is enough, and every package you do not install is a package you do not have to audit.

## Basic example

```js title="src/total.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'

import { total } from './total.js'

test('sums line items', () => {
  assert.equal(total([{ price: 100, qty: 2 }, { price: 50, qty: 1 }]), 250)
})

test('rejects a negative quantity', () => {
  assert.throws(() => total([{ price: 100, qty: -1 }]), /quantity/)
})
```

```bash
node --test
```

Use `node:assert/strict` rather than `node:assert`. The strict variant makes `equal` behave like `deepStrictEqual`, so `'1'` never passes a comparison against `1`.

### File discovery

With no path argument, `node --test` walks the working directory and runs files whose names match `*.test.js`, `*-test.js`, `*_test.js`, `test-*.js` and `test.js`, plus everything inside a `test/` directory. The same patterns apply to `.mjs`, `.cjs`, and — on Node 24 — `.ts`. Narrow the run by passing paths:

```bash
node --test src/billing/          # only this directory
node --test src/total.test.js     # one file
```

## Structuring tests

`describe` / `it` group; `test` nests. Both styles work, and they interoperate.

```js title="src/users.test.js"
import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

describe('user repository', () => {
  let repo

  before(async () => { repo = await createRepo() })
  beforeEach(async () => { await repo.reset() })
  after(async () => { await repo.close() })

  it('creates a user', async () => {
    const user = await repo.create({ email: 'ada@example.com' })
    assert.equal(user.email, 'ada@example.com')
    assert.ok(user.id)
  })

  it('rejects a duplicate email', async () => {
    await repo.create({ email: 'ada@example.com' })
    await assert.rejects(
      () => repo.create({ email: 'ada@example.com' }),
      (err) => err.code === 'duplicate_email',
    )
  })
})
```

`assert.rejects` is the async counterpart of `assert.throws`. Writing `try { await x() } catch { /* passed */ }` instead means a test that never throws also "passes".

:::warning
**Await your subtests.** A subtest created inside a `test` callback that you do not `await` may be cancelled when the parent finishes, and its failure can be reported against the wrong test — or not at all. Always `await t.test(...)`, and return or await every promise you create in a test body.
:::

### The test context

The callback receives a `TestContext` with per-test facilities:

```js title="src/context.test.js"
import test from 'node:test'

test('uses the context', async (t) => {
  t.plan(1)                                     // fail unless exactly one assertion runs
  t.diagnostic('setting up')                    // emitted as a reporter diagnostic
  t.after(() => cleanup())                      // teardown scoped to this test

  const res = await fetch(url, { signal: t.signal })   // aborted if the test times out
  t.assert.equal(res.status, 200)
})

test('not ready yet', { skip: 'waiting on the API' }, () => {})
test('planned work', { todo: true }, () => {})
test('slow one', { timeout: 30_000 }, async () => {})
```

`t.signal` is the useful one: it aborts when the test times out, so a hung `fetch` fails the test instead of hanging the run.

## Mocking

`node:test` has its own mock implementation — no `jest.fn()`, no `sinon`.

```js title="src/notify.test.js"
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

import * as mailer from './mailer.js'
import { notifyOverdue } from './notify.js'

test('emails each overdue account once', async (t) => {
  const send = t.mock.method(mailer, 'send', async () => ({ id: 'msg_1' }))

  await notifyOverdue([{ email: 'a@example.com' }, { email: 'b@example.com' }])

  assert.equal(send.mock.callCount(), 2)
  assert.deepEqual(send.mock.calls[0].arguments[0], { email: 'a@example.com' })
})
```

Mocks created through `t.mock` are restored automatically when the test ends. Mocks created through the top-level `mock` export are not — call `mock.restoreAll()` in an `afterEach` if you use them.

| API | Purpose |
| --- | --- |
| `mock.fn(original?, impl?)` | a standalone spy; call data on `fn.mock` |
| `mock.method(obj, 'name', impl?)` | replace a method, keep a handle to restore it |
| `mock.getter` / `mock.setter` | replace accessors |
| `mock.timers` | fake `setTimeout`, `setInterval`, `Date`, and more |
| `mock.reset()` / `mock.restoreAll()` | undo |

### Fake timers

```js title="src/retry.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'

test('backs off before retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const promise = retryWithBackoff(failTwiceThenSucceed)
  t.mock.timers.tick(100)
  t.mock.timers.tick(200)

  assert.equal(await promise, 'ok')
})
```

Without fake timers this test takes 300 ms of real time, and a suite full of them takes minutes. `tick()` advances the fake clock instantly.

:::note
Mocking an **ES module's** exports is still experimental and requires `--experimental-test-module-mocks`. Prefer dependency injection: pass collaborators into your functions or constructors, and the mocking problem disappears along with the flag.
:::

## Running tests

### Reporters

```bash
node --test --test-reporter=spec                     # human readable
node --test --test-reporter=dot                      # compact
node --test --test-reporter=tap                      # machine readable
node --test --test-reporter=junit \
            --test-reporter-destination=results.xml  # for CI test reporting
```

`spec` is the default on a TTY, `tap` otherwise. The flags can be repeated to write several formats at once — one to the console, one to a file for the CI system to ingest.

### Concurrency

Test **files** run in separate processes, in parallel. `--test-concurrency=<n>` sets how many at once; by default it is the number of available CPU cores minus one.

```bash
node --test --test-concurrency=4
```

Turn it down to `1` when your tests share a resource they cannot isolate — a single database, a fixed port, a temp directory with a fixed name. Turning it down is a workaround, though; the real fix is to give each file its own resource, which is what `port: 0` and `mkdtemp` and per-file schemas are for.

Tests **inside** a file run sequentially by default. Opt individual ones into parallelism with `{ concurrency: true }` when they are genuinely independent.

### Watch mode

```bash
node --test --watch
```

Re-runs affected tests on save. This is the fastest feedback loop available, and it needs no extra tooling.

### Filtering

```bash
node --test --test-name-pattern="overdue"    # regex against test names
node --test --test-only                      # only tests marked { only: true }
```

### Coverage

```bash
node --test --experimental-test-coverage
```

Prints a per-file line/branch/function summary. Node 24 can also fail the run on a threshold, which is what you want in CI:

```bash
node --test --experimental-test-coverage \
  --test-coverage-lines=80 \
  --test-coverage-branches=70 \
  --test-coverage-functions=80 \
  --test-coverage-exclude='**/*.test.js'
```

`--test-coverage-include` and `--test-coverage-exclude` take glob patterns and can be repeated. Add `--test-reporter=lcov` when you want to upload to a coverage service.

:::tip
Set a threshold slightly below where you are today, and raise it when it is comfortably exceeded. A threshold you routinely bypass teaches the team that CI failures are advisory.
:::

## Common patterns

### Testing an HTTP server

Listen on port `0` so the OS picks a free port — that is what makes the file safe to run concurrently with every other test file.

```js title="src/app.test.js"
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'

import { createApp } from './app.js'

let server, baseUrl

before(async () => {
  server = createApp().listen(0)
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

test('GET /health', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'ok' })
})

test('POST /users validates the body', async () => {
  const res = await fetch(`${baseUrl}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' }),
  })
  assert.equal(res.status, 400)
})
```

`supertest` 7.2.2 does the same thing with a fluent API and without an explicit `listen`; both are fine. More in [Testing](../express-libraries/testing.md).

### A real database, in memory, with no dependency

`node:sqlite` is bundled with Node 24 — no native build, no install, and no flag needed. That makes it an excellent test fixture even when production runs Postgres, as long as your queries are portable.

```js title="src/repo.test.js"
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

let db

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (
      id    INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
  `)
})

test('finds a user by email', () => {
  db.prepare('INSERT INTO users (email) VALUES (?)').run('ada@example.com')

  const row = db.prepare('SELECT id, email FROM users WHERE email = ?').get('ada@example.com')

  assert.equal(row.email, 'ada@example.com')
})
```

Note the placeholders. `node:sqlite` prepares statements and binds parameters, so user input never becomes SQL — the same rule as every other driver. See [SQL injection](../security/sql-injection.md).

:::warning
SQLite is not Postgres. Types, `RETURNING` support, JSON functions, upsert syntax and concurrency behavior all differ. Use it for unit-level repository tests, and run at least a smoke suite against the real engine in CI — see [Testing with a database](../orms/testing-with-a-database.md).
:::

### Wiring it to npm scripts

```json title="package.json"
{
  "scripts": {
    "test": "node --test",
    "test:watch": "node --test --watch",
    "test:ci": "node --test --test-reporter=spec --test-reporter=junit --test-reporter-destination=stdout --test-reporter-destination=results.xml --experimental-test-coverage --test-coverage-lines=80"
  }
}
```

### When to use something else

`node:test` covers unit and integration testing of a backend well. Reach for `vitest` 5.0.0 if you need browser-environment emulation, an extensive snapshot workflow, or first-class in-source module mocking today. For a Node API service, the built-in runner is usually the whole answer.

## Common mistakes

- **Using `assert` instead of `assert/strict`.** Loose equality lets `'1' == 1` pass.
- **Not awaiting subtests or async assertions.** Failures land in the wrong place or disappear.
- **`try/catch` instead of `assert.rejects`.** A function that stops throwing silently passes.
- **Sharing one database or a fixed port across test files.** Files run in parallel processes; use `:memory:`, `port: 0`, or per-file isolation.
- **Fixing flaky parallelism with `--test-concurrency=1`.** It hides the shared-state bug and makes CI slow.
- **Using real timers for backoff and retry logic.** Use `t.mock.timers`.
- **Mocking modules when injection would do.** Module mocking is experimental; constructor and parameter injection is not.
- **Forgetting `mock.restoreAll()` for top-level mocks.** Leaks a stub into the next test in the file.
- **Setting a coverage threshold nobody meets.** Either the number moves or the team learns to ignore CI.

## Related topics

- [Error handling](./error-handling.md) — `node:assert`, custom error codes, and testing failure paths.
- [Async/await and promises](./async-await-and-promises.md) — why unawaited promises break tests quietly.
- [package.json and npm scripts](./package-json-and-npm-scripts.md) — `npm test` and `node --run test`.
- [Native TypeScript support](./native-typescript-support.md) — running `.ts` test files without a build step.
- [Testing](../express-libraries/testing.md) — supertest and testing Express apps end to end.
- [Testing with a database](../orms/testing-with-a-database.md) — fixtures, transactions and rollback strategies.
- [Continuous integration](../production/ci.md) — reporters, coverage gates and sharding in CI.
