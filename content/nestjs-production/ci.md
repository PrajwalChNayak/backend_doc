---
title: Continuous integration
description: A GitHub Actions workflow for a Nest 12 service on Node 24 — install, lint, nest build, unit tests, e2e tests against a Postgres service container, and npm audit --omit=dev.
status: current
updated: 2026-09-11
---

CI for a Nest service has to answer five questions before merge: does it install from the lockfile, does it lint, does `nest build` produce an artifact, do the unit tests pass, and do the e2e tests pass against a real database. The general reasoning — why `npm ci` and never `npm install`, why a service container needs a health check, what `npm audit` does and does not cover — is in [Continuous integration](../production/ci.md) and is unchanged. This page is the Nest-shaped workflow and the one version constraint that catches people.

## The CLI needs a newer Node than the app

Two floors apply and they are different numbers.

| To do this in CI | Needs Node |
| --- | --- |
| **Run** the built app (`node dist/main.js`, e2e tests) | v20.19+, v22.12+, or v26+ — `@nestjs/core@12.0.1` declares `engines.node: ">= 20"` |
| **Run the CLI** (`nest build`, `nest generate`) | **v22.22.3+, v24.15+, or v26+** — `@nestjs/schematics@12.0.0` declares `>=22.12.0` because of the Angular devkit underneath |

Since the workflow builds, the higher floor is the one that governs. **Node 24 LTS** satisfies both, which is what this handbook targets and what the workflow below pins.

:::warning
A runner pinned to Node 20 or 22.12 installs `@nestjs/cli` successfully and then fails inside a schematic with an engine error naming `@angular-devkit/schematics` — not Nest, not `nest build`. If a CI job dies with an unsupported-engine message about a package you have never heard of, check the Node version first.

Node 20 reached end of life on 2026-04-30. Do not pin it even though `@nestjs/core` still accepts it at runtime.
:::

## The workflow

```yaml title=".github/workflows/ci.yml"
name: CI

on:
  push:
    branches: [main]
  pull_request:

# A PR with six pushes should not occupy six runners.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test
        ports:
          - 5432:5432
        # Without this the first test connects before Postgres is listening.
        options: >-
          --health-cmd "pg_isready -U app"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

      redis:
        image: redis:8-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      # Staging and CI both run NODE_ENV=production semantics in the app;
      # `test` here only selects the test wiring. See the note below.
      NODE_ENV: test
      APP_ENV: ci
      PORT: 3000
      DATABASE_URL: postgres://app:app@localhost:5432/app_test
      REDIS_URL: redis://localhost:6379
      JWT_SECRET: ci-only-not-a-real-secret-at-least-32-characters
      LOG_LEVEL: warn

    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          # One file governs laptops, version managers and CI.
          node-version-file: .nvmrc
          cache: npm

      # ci, not install: exactly the lockfile, and it FAILS if package.json
      # and package-lock.json disagree.
      - run: npm ci

      # Cheapest first. A lint error should not wait behind a database.
      - run: npm run lint

      # The type checker is a separate gate, because `nest build` can be run
      # with --no-type-check and `nest start --watch` often is.
      - run: npx tsc --noEmit

      # Produces dist/. Fails on a missing asset entry or a bad tsconfig.
      - run: npm run build

      - run: npm run migration:run

      - run: npm run test          # unit tests, no database
      - run: npm run test:e2e      # e2e tests, against the services above

      # The artifact only fails at RUNTIME when a dependency is misfiled.
      - name: Smoke-boot the built output
        run: |
          node dist/main.js &
          APP_PID=$!
          for i in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:3000/livez > /dev/null; then break; fi
            sleep 1
          done
          curl -fsS http://127.0.0.1:3000/livez
          kill -TERM $APP_PID
          wait $APP_PID

      # Only what actually ships is worth blocking a merge on.
      - run: npm audit --omit=dev --audit-level=high
```

:::note
`actions/checkout@v7` (v7.0.1) and `actions/setup-node@v7` (v7.0.0) were the current majors on 2026-09-09. Actions release new majors regularly and independently of one another — **check each action's own repository for its current major rather than copying a number across all of them.** Pin the major at minimum; pin the full commit SHA for anything that touches a secret.

The same applies to the service-container images. `postgres:18-alpine` and `redis:8-alpine` were current when this was written; confirm before copying.
:::

### `NODE_ENV` in CI

`NODE_ENV: test` selects test wiring — an in-memory transport, a stub gateway, a shorter token expiry — through your configuration schema. It is not a licence to branch on it inside a provider; that argument is made in [Environment configuration](configuration.md).

The smoke-boot step above deliberately does **not** set `NODE_ENV: test`. It is starting the production artifact, and the whole point is to exercise the code path production takes. Set `NODE_ENV=production` on that step if your configuration schema requires it.

## `npm run lint`

New Nest 12 projects are generated with **oxlint** (1.82.0) rather than ESLint. Existing projects keep whatever they have, because `nest upgrade` does not swap your linter out from under you.

```json title="package.json — the scripts CI calls"
{
  "scripts": {
    "lint": "oxlint .",
    "typecheck": "tsc --noEmit",
    "build": "nest build",
    "start:prod": "node --enable-source-maps dist/main.js",
    "test": "vitest run",
    "test:e2e": "vitest run --config ./test/vitest-e2e.config.ts",
    "migration:run": "typeorm migration:run -d ./dist/data-source.js"
  }
}
```

Run the linter over the whole tree, not changed files — a rule change affects everything, and partial linting hides that. Add `--max-warnings=0` if you want warnings to block; warnings that never block accumulate until nobody reads them.

## `tsc --noEmit` is a separate step, on purpose

This is the Nest-specific CI step that plain Express projects do not need.

The v12 CLI added `--no-type-check` to `nest build` and `nest start`, and it is genuinely useful in `start:dev` — a watch rebuild that skips the checker is dramatically faster. The cost is that a build no longer proves anything about your types.

So the type check becomes its own gate. Keep it even if you never pass `--no-type-check`: it is fast, it fails with better messages than a bundler does, and under `moduleResolution: "nodenext"` it is what turns a missing `.js` extension on a relative import into a compile error instead of an `ERR_MODULE_NOT_FOUND` inside the container. See [ESM vs CommonJS in production](module-format-in-production.md).

## `nest build` in CI

```yaml
- run: npm run build
```

Three failures this catches that nothing else does:

- **A `tsconfig.build.json` that no longer excludes `test`.** Spec files get compiled into the artifact and the entry point silently moves from `dist/main.js` to `dist/src/main.js`, breaking every `CMD` in the repository.
- **A missing `compilerOptions.assets` entry.** A template or `.graphql` file added this week is not copied into `dist/`, and nothing notices until it is rendered in production.
- **A circular import that `tsc` tolerates and Nest does not.** These usually surface at bootstrap rather than compile time, which is exactly what the smoke-boot step is for.

Do not add `--no-type-check` here, and do not add `--silent` unless your logs are genuinely unreadable — the CLI's output is where a missing asset is mentioned.

## e2e tests with a Postgres service container

Unit tests with a mocked repository tell you nothing about whether your query is valid, whether the migration applies, or whether a unique constraint fires. A service container gives you a real Postgres for the length of the job.

Three details decide whether it works:

- **The health check is mandatory.** Without `--health-cmd`, the job proceeds as soon as the container *starts*, which is before Postgres accepts connections. You get an intermittent `ECONNREFUSED` on roughly one run in five — the worst kind of flake, because it looks like a test problem.
- **`ports: 5432:5432`** publishes it to the runner, so `localhost:5432` works from your test process. Steps run on the runner host, not inside a container, unless the job declares one.
- **Migrate before you test.** An empty database fails every test with "relation does not exist".

```ts title="test/app.e2e-spec.ts"
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { ValidationPipe } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'

describe('AppModule (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleRef.createNestApplication()

    // Whatever main.ts registers globally must be registered here too, or the
    // tests exercise a pipeline production does not have.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    app.enableShutdownHooks()

    await app.init()
  })

  afterAll(async () => {
    // Runs the termination hooks. A hook that throws fails HERE, in CI,
    // instead of as a non-zero exit on every production deploy.
    await app.close()
  })

  it('serves liveness', async () => {
    await request(app.getHttpServer()).get('/livez').expect(200)
  })

  it('rejects an invalid payload', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ email: 'not-an-email' })
      .expect(400)
  })
})
```

:::warning
The single most common reason a Nest e2e suite passes while production is broken: `createNestApplication()` does **not** replay `main.ts`. Global pipes, guards, interceptors, filters, `setGlobalPrefix`, versioning and CORS all have to be applied in the test setup as well.

Factor the bootstrap into a function both call. Two copies of that wiring drift, and the drift is always discovered in production.
:::

`afterAll(() => app.close())` is worth calling out separately. It is the cheapest possible test of your shutdown hooks: a hook that closes something twice, or awaits a client that is already gone, throws here — in CI — rather than producing a non-zero exit on every deploy. See [Graceful shutdown](graceful-shutdown.md).

Tests that share one database cannot run in parallel unless each gets its own schema or wraps itself in a transaction that rolls back. Either serialize the e2e project or isolate per test; [Database fixtures](../nestjs-testing/database-fixtures.md) covers both.

## The smoke boot

```yaml
- name: Smoke-boot the built output
  run: |
    node dist/main.js &
    # ... poll /livez, then SIGTERM
```

This step exists because three Nest failures live **only** in the built artifact and pass every test:

| Failure | Symptom |
| --- | --- |
| A runtime dependency in `devDependencies` | `Cannot find module '@nestjs/config'` at container start |
| A missing `.js` extension in an ESM project | `ERR_MODULE_NOT_FOUND` naming a path you never wrote |
| A missing asset entry | the app boots and then 500s when that template renders |

The `kill -TERM` at the end doubles as a shutdown test: if `wait` does not return promptly, `SIGTERM` is not being handled and your hooks are not running.

If you build a container image in the same workflow, boot **that** instead — it additionally catches a wrong-case import that resolves on a developer's case-insensitive filesystem and fails on Linux. See [Docker](docker.md).

## `npm audit --omit=dev`

```yaml
- run: npm audit --omit=dev --audit-level=high
```

`--omit=dev` restricts the report to dependencies that actually ship. For a Nest project that difference is large: `@nestjs/cli`, `@nestjs/schematics`, the Angular devkit underneath them, `typescript` and your test runner are all devDependencies, and an advisory in any of them is worth fixing eventually but is not worth blocking a deploy.

`--audit-level=high` sets the threshold for a non-zero exit. Failing on `low` means failing forever, and someone appends `|| true` within a week — which is strictly worse than not running it.

:::warning
`npm audit` is a floor, not a security programme. It only knows advisories in the npm database, it says nothing about a dependency that is unmaintained or has changed owners, and it has a real false-positive rate for code paths you never reach.

It will also not tell you that you are using a package this handbook names as dead. `@nestjs/microservices` users should confirm they are on `@nats-io/transport-node` 3.4.0 rather than the moved `nats` package, and that nothing has pulled in `subscriptions-transport-ws`. Pair the audit with Dependabot and a container scan; see [Dependency auditing](../nestjs-security/dependency-auditing.md).
:::

Consider running the audit and any other network-dependent check on a nightly schedule rather than on every push, so a new advisory surfaces without turning an unrelated PR red.

## Ordering and cost

Order steps cheapest-first: lint, type check, build, unit tests, e2e tests, smoke boot, audit. A five-minute pipeline gets used; a forty-minute one gets bypassed.

Two Nest-specific cost notes:

- **`cache: npm` on `setup-node`** caches the npm download cache keyed on `package-lock.json`, not `node_modules`. That matters more for a Nest project than an Express one, because the dev dependency tree is large. Never cache `node_modules` directly — a stale tree survives a lockfile change and CI validates something that no longer exists.
- **One job, not five.** Splitting lint, build and test into separate jobs costs another checkout and another `npm ci` each. Split only when a stage is genuinely slow enough to parallelize.

Everything else about workflow hygiene — `permissions`, `timeout-minutes`, pinning actions, why fork PRs do not get secrets, and why `pull_request_target` with a checkout of the PR head is remote code execution — applies identically and is covered in [Continuous integration](../production/ci.md).

## Common mistakes

- **A runner on Node 20 or 22.12.** The app runs there; the CLI's schematics do not, and the error names the Angular devkit.
- **`npm install` in CI.** You test a dependency tree that is in no lockfile and on no machine.
- **Caching `node_modules`.** A stale tree survives a lockfile change.
- **Hardcoding `node-version: 24` in the workflow.** Use `node-version-file: .nvmrc` so one file governs everywhere.
- **No `tsc --noEmit` step.** With `--no-type-check` anywhere in your scripts, nothing checks the types.
- **Not running `nest build` at all.** A missing asset entry and a broken `tsconfig.build.json` both pass every test.
- **`--no-type-check` on the CI build.** It makes the build fast and meaningless.
- **Not booting the built output.** The three artifact-only failures all reach production.
- **A service container with no health check.** Intermittent `ECONNREFUSED` that looks like a flaky test.
- **Forgetting to migrate before the e2e job.** Every test fails with "relation does not exist".
- **`createNestApplication()` without replaying the global pipes, guards and prefix.** The suite tests a pipeline production does not have.
- **Never calling `app.close()` in `afterAll`.** Your shutdown hooks are untested, and the test process may not exit.
- **`npm audit` with no `--omit=dev`.** You block merges on advisories in `@nestjs/cli` and the devkit.
- **`npm audit` with no `--audit-level`.** It fails on everything, and someone adds `|| true`.
- **Running e2e tests in parallel against one shared database.** Non-deterministic failures that look like application bugs.
- **Testing against SQLite while production runs Postgres.** The dialects differ in exactly the places that matter — types, constraints, concurrency.
- **No `timeout-minutes`.** A hung job holds a runner for six hours.

## Related topics

- [Continuous integration](../production/ci.md) — workflow hygiene, secrets, permissions and `npm audit` in depth.
- [Build and deployment](build-and-deployment.md) — what `nest build` produces and the scripts CI calls.
- [Docker](docker.md) — building, scanning and smoke-booting the image.
- [ESM vs CommonJS in production](module-format-in-production.md) — why `tsc --noEmit` is the gate that catches extension mistakes.
- [End-to-end tests](../nestjs-testing/e2e-tests.md) — the testing module and supertest in detail.
- [Database fixtures](../nestjs-testing/database-fixtures.md) — isolating tests that share a Postgres instance.
- [Unit tests](../nestjs-testing/unit-tests.md) — what belongs in the fast job.
- [Migrations](../nestjs-databases/migrations.md) — running them as a pipeline step, not at boot.
- [Graceful shutdown](graceful-shutdown.md) — the hooks `app.close()` exercises in `afterAll`.
- [Dependency auditing](../nestjs-security/dependency-auditing.md) — what the audit does not cover.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — the Node floors and every build flag.
- [Deployment checklist](deployment-checklist.md) — what CI should be proving before you ship.
