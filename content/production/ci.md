---
title: Continuous integration
description: A GitHub Actions workflow for a Node 24 service — cached npm ci, lint, node --test, a Postgres service container, npm audit, and a docs build that fails on a dirty tree.
status: current
updated: 2026-09-08
---

CI exists to catch, before merge, the things that are expensive to catch after. For a Node service that means four questions: does it install from the lockfile, does it lint, do the tests pass against a real database, and does the artifact you are about to ship actually boot.

## The workflow

```yaml title=".github/workflows/ci.yml"
name: CI

on:
  push:
    branches: [main]
  pull_request:

# Cancel superseded runs on the same branch — a PR with six pushes
# should not occupy six runners.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test
        ports:
          - 5432:5432
        # Without this, the first test connects before Postgres is listening.
        options: >-
          --health-cmd "pg_isready -U app"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      NODE_ENV: test
      DATABASE_URL: postgres://app:app@localhost:5432/app_test
      JWT_SECRET: ci-only-not-a-real-secret-at-least-32-chars
      SESSION_SECRET: ci-only-not-a-real-secret-at-least-32-chars

    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          # Reads the version from the repo, so CI and laptops cannot drift.
          node-version-file: .nvmrc
          cache: npm

      # ci, not install: exactly the lockfile, and it fails if the
      # lockfile and package.json disagree.
      - run: npm ci

      - run: npx eslint .

      - run: npm run migrate
      - run: node --test

      # Only production dependencies matter for what you ship.
      - run: npm audit --omit=dev --audit-level=high

  docs:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc

      # This repository's own validators. Zero npm dependencies.
      - run: node scripts/check.mjs
      - run: node scripts/lint-sql.mjs

      - run: node scripts/build.mjs

      # The generated site is committed. If building changed anything,
      # someone edited content/ without rebuilding — fail the job.
      - name: Fail if docs/ is out of date
        run: |
          if ! git diff --exit-code --stat -- docs/; then
            echo "::error::docs/ is out of date. Run 'node scripts/build.mjs' and commit the result."
            exit 1
          fi
```

:::note
`actions/checkout@v7` (v7.0.1) and `actions/setup-node@v7` (v7.0.0) were the current majors on 2026-09-09. Newer majors are released regularly — check each action's repository rather than assuming these are still latest. Pin the major at minimum; pin the full commit SHA if your threat model includes a compromised action.
:::

## Checkout and setup-node

`actions/setup-node` does two jobs, and the second is the one people skip.

```yaml
- uses: actions/setup-node@v7
  with:
    node-version-file: .nvmrc
    cache: npm
```

**`node-version-file: .nvmrc`** instead of a hardcoded `node-version: 24`. One file is then the source of truth for your laptop, your version manager and CI. A team that hardcodes the version in the workflow eventually tests on a version nobody develops against. See [Prerequisites](../getting-started/prerequisites.md).

**`cache: npm`** caches the npm download cache — not `node_modules` — keyed on `package-lock.json`. Restore is fast and correctness is preserved, because `npm ci` still resolves from the lockfile rather than reusing an installed tree. Caching `node_modules` directly is the version of this that goes wrong: a stale tree survives a lockfile change and CI tests something that does not exist.

Set `cache-dependency-path` if your lockfile is not at the repository root.

## `npm ci`, never `npm install`

`npm ci` deletes `node_modules`, installs exactly what `package-lock.json` specifies, and **fails** if the lockfile and `package.json` disagree. `npm install` resolves ranges and quietly rewrites the lockfile.

In CI that difference is the whole point. With `npm install`, a job can pass against a dependency tree that exists nowhere else — not in your repository, not on anyone's machine, not in the image you deploy. The lockfile-mismatch failure is a feature too: it catches the pull request where someone edited `package.json` by hand.

## Lint

```yaml
- run: npx eslint .
```

ESLint 10.10.0 uses flat config (`eslint.config.js`). Run it on the whole tree, not on changed files — a rule change affects everything, and partial linting hides that.

Keep lint in the same job as the tests unless it is slow. A separate job costs another checkout and another install for a step that usually takes seconds.

Add `--max-warnings=0` if you want warnings to be blocking. Warnings that never block accumulate until nobody reads them.

## Tests with a Postgres service container

Unit tests with a mocked repository do not tell you whether your SQL is correct, whether your migration applies, or whether a constraint fires. Service containers give you a real Postgres for the length of the job.

```yaml
services:
  postgres:
    image: postgres:18-alpine
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U app"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
```

Three details decide whether this works:

- **The health check is mandatory.** Without `--health-cmd`, the job proceeds as soon as the container *starts*, which is before Postgres is accepting connections. You get an intermittent `ECONNREFUSED` on roughly one run in five — the worst kind of flake, because it looks like a test problem.
- **`ports: 5432:5432`** publishes it to the runner, so `localhost:5432` works from your test process. Steps run on the runner host, not inside a container, unless the job specifies a container.
- **Migrate before you test.** An empty database fails every test with a confusing "relation does not exist".

Credentials here are throwaway and local to the runner. That is fine — and it is also why they must never resemble a real credential. Anything genuinely secret goes in `secrets` and is injected as an environment variable; see [Secrets management](../security/secrets-management.md).

```yaml
env:
  STRIPE_SECRET: ${{ secrets.STRIPE_TEST_KEY }}
```

:::warning
Secrets are **not** available to workflows triggered by `pull_request` from a fork. That is deliberate — otherwise anyone could open a PR that prints them. Design your test suite so the core of it runs without secrets, or fork contributions will fail for reasons unrelated to their change.
:::

### `node --test`

Node 24's built-in runner needs no dependency:

```yaml
- run: node --test
```

It discovers `*.test.js` and `test/` by convention. Useful additions:

```bash
node --test --test-reporter=spec        # readable output in the log
node --test --test-concurrency=1        # serialize DB tests that share state
node --test --experimental-test-coverage
```

Tests that share one database cannot run in parallel unless each has its own schema or transaction. Either serialize them, or wrap each test in a transaction that rolls back. See [Testing with a database](../orms/testing-with-a-database.md) and [Testing](../express-libraries/testing.md).

## `npm audit --omit=dev`

```yaml
- run: npm audit --omit=dev --audit-level=high
```

`--omit=dev` restricts the report to dependencies that actually run in production. A vulnerability in your test framework is worth fixing eventually; it is not worth blocking a deploy, and a report full of them is a report nobody reads.

`--audit-level=high` sets the threshold for a non-zero exit. Failing on `low` means failing on everything forever, and the team will add `|| true` within a week — which is strictly worse than not running it.

:::warning
`npm audit` is a floor, not a security programme. It only knows about advisories in the npm database, it says nothing about a dependency that is unmaintained or has quietly changed owners, and it has a real false-positive rate for paths your code never reaches. Pair it with Dependabot for updates and a container scan for the base image. See [Dependency auditing](../security/dependency-auditing.md).
:::

Add `npm audit signatures` if you want to verify registry provenance, and consider `npm ci --ignore-scripts` in untrusted contexts — install scripts are arbitrary code execution at install time.

## Building the docs site and failing on a dirty tree

This repository generates `docs/` from `content/` and commits the result, because GitHub Pages serves it. That creates a specific failure: someone edits `content/`, does not rebuild, and the published site silently lags the source.

The check is three lines:

```yaml
- run: node scripts/build.mjs
- name: Fail if docs/ is out of date
  run: |
    if ! git diff --exit-code --stat -- docs/; then
      echo "::error::docs/ is out of date. Run 'node scripts/build.mjs' and commit the result."
      exit 1
    fi
```

`git diff --exit-code` exits non-zero when there is a difference. So: build, then assert nothing changed. If the build produced different output from what was committed, the tree is dirty and the job fails with an actionable message.

The same pattern applies to anything generated and committed — an OpenAPI document, a generated client, a Prisma client, a formatted lockfile. Generate it in CI and assert it matches.

### This repository's own validators

They are plain Node ESM with zero npm dependencies, so they run straight after checkout:

| Command | Fails on |
| --- | --- |
| `node scripts/check.mjs` | Missing required sections, dangling relative links or anchors, orphan pages, Express 4 APIs outside a `:::legacy` callout. |
| `node scripts/lint-sql.mjs` | SQL built by concatenation or template interpolation, in `content/` fences and `examples/` source. |
| `node scripts/check-deps.mjs` | A package that does not exist on npm, or an example that drifted from the verified version table. Needs network. |
| `node scripts/run-examples.mjs` | An example app that does not boot or whose routes do not respond. |

`check.mjs` and `lint-sql.mjs` are pure and fast — always run them. `check-deps.mjs` reaches the registry, so it is a good fit for a scheduled job rather than every push, where a registry hiccup would become a red build on an unrelated PR.

:::danger
`lint-sql.mjs` is the one that matters most. It fails the build on string-interpolated SQL anywhere in the repository, which is exactly the pattern that produces [SQL injection](../security/sql-injection.md). Do not add exemptions to make a build pass; fix the query. The only legitimate exemptions are a fence marked `vulnerable`, a directory named `vulnerable-*`, and an explicit `// lint-sql:allow` on a proven-safe identifier allow-list.
:::

## Deploying the site to GitHub Pages

Pages deployment is a separate workflow on `main`, using the Pages actions rather than pushing to a branch.

```yaml title=".github/workflows/pages.yml"
name: Deploy docs

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# Never let two deploys race. Do not cancel one in progress.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc

      - run: node scripts/check.mjs
      - run: node scripts/build.mjs

      # The three Pages actions are versioned independently of each other.
      # Majors below were current on 2026-09-09 — re-check before copying.
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: docs
      - id: deployment
        uses: actions/deploy-pages@v5
```

Notes on that workflow:

- **Assuming the action majors move in lockstep.** `checkout`, `setup-node` and the three Pages actions are released independently. Take each current major from its own repository rather than copying one number across all five.
- **`permissions` must include `pages: write` and `id-token: write`.** The deploy action uses OIDC; without `id-token` it fails with a permissions error that does not mention OIDC.
- **`concurrency` without `cancel-in-progress`.** Two Pages deployments racing produces an ambiguous published state; queueing is correct.
- **The `environment` block** is what gives you the deployment URL in the run summary and lets you require an approval.
- **Enable Pages with "GitHub Actions" as the source** in the repository settings first, or the deploy step fails.
- **Run the validators before deploying**, so a broken link never reaches the published site.

## Security considerations

- **Set `permissions` explicitly.** The default token can be write-capable depending on repository settings. Declare `contents: read` at the workflow level and widen it per job only where needed.
- **`pull_request_target` runs with secrets and write permissions in the base repository's context.** Combined with checking out the PR's code, it is remote code execution against your repository. Use plain `pull_request` unless you fully understand the alternative.
- **Never `echo` a secret.** Actions masks known secret values in logs, but a transformed one — base64-encoded, substringed, embedded in JSON — is not masked.
- **Pin actions.** A major tag is mutable; a compromised action publishing a new `v4` runs in your workflow with your token. Pin the full commit SHA for anything that touches secrets.
- **Third-party actions are code you are running with your credentials.** Read them, or do the work in a `run` step.
- **`npm ci` executes install scripts.** In a workflow that handles secrets, consider `--ignore-scripts` plus an explicit rebuild of the packages that need it.
- **Never put a production credential in CI.** Test keys, test databases, scoped tokens. The test database must not be able to reach production data.
- **Scan the container image** as well as the dependency tree; most CVEs in a Node image live in the base OS. See [Dockerfile](dockerfile.md).
- **Fork PRs do not get secrets.** That is the correct behaviour — do not work around it.

## Production considerations

- **Fast feedback beats complete feedback.** Order steps cheapest-first: lint, then unit tests, then integration tests. A five-minute pipeline gets used; a forty-minute one gets bypassed.
- **`concurrency` with `cancel-in-progress` on PR branches.** Six pushes should not occupy six runners.
- **`timeout-minutes` on every job.** The default is six hours; a hung test should not hold a runner for an afternoon.
- **Boot the built image before pushing it.** A misplaced `dependencies`/`devDependencies` entry only fails at runtime, and `--omit=dev` is exactly when it bites. Start the container, hit `/livez`, stop it.
- **Verify signal handling in CI if you can.** `docker stop` completing in under two seconds proves `SIGTERM` reaches Node — see [Dockerfile](dockerfile.md).
- **Build the image once and promote it.** Rebuilding per environment means production runs an artifact staging never saw.
- **Tag images with the git SHA.** `latest` makes "what is running" and "roll back to what" unanswerable.
- **Do not tolerate a flaky test.** Quarantine or fix it immediately. One accepted flake teaches everyone to re-run red builds, and the pipeline stops meaning anything.
- **Run migrations as a deploy step, not from application startup.** Multiple replicas starting at once will race. See [Migrations](../databases/migrations.md).
- **Schedule the network-dependent checks.** `npm audit` and `check-deps.mjs` on a nightly cron surface new advisories without turning an unrelated PR red because the registry was slow.
- **Cache deliberately.** `cache: npm` is safe. Caching `node_modules` or build output keyed on anything but a lockfile hash produces stale, unreproducible runs.

## Common mistakes

- **`npm install` in CI.** You test a dependency tree that is not in your lockfile.
- **Caching `node_modules`.** A stale tree survives a lockfile change and CI validates something that no longer exists.
- **Hardcoding `node-version: 24` in the workflow.** Use `node-version-file: .nvmrc` so one file governs everywhere.
- **A service container with no health check.** Intermittent `ECONNREFUSED` that looks like a flaky test.
- **Forgetting to migrate before testing.** Every test fails with "relation does not exist".
- **`npm audit` with no `--audit-level`.** It fails on every low-severity advisory in a transitive dev dependency, and someone adds `|| true`.
- **`npm audit` without `--omit=dev`.** You block deploys on vulnerabilities in code that never ships.
- **Building generated output but not asserting it is committed.** The published site drifts from the source silently.
- **No `permissions` block.** The workflow token is broader than it needs to be.
- **`pull_request_target` with a checkout of the PR head.** Arbitrary code execution with your secrets.
- **Floating action references.** A mutable tag is a supply-chain dependency you did not review.
- **No `timeout-minutes`.** A hung job holds a runner for six hours.
- **Testing only against SQLite while production runs Postgres.** The dialects differ in exactly the places that matter — types, constraints, concurrency.
- **Skipping the image smoke test.** `MODULE_NOT_FOUND` in production for a dependency in the wrong section of `package.json`.
- **Migrations that run on application boot.** N replicas start, N migrations race.

## Related topics

- [Dockerfile](dockerfile.md) — building, scanning and smoke-testing the artifact CI produces.
- [Configuration](configuration.md) — supplying config to a test job without committing it.
- [Testing](../express-libraries/testing.md) — `node:test` and supertest against an Express 5 app.
- [Testing with a database](../orms/testing-with-a-database.md) — isolating tests that share a Postgres instance.
- [Migrations](../databases/migrations.md) — running them as a deploy step rather than at boot.
- [Dependency auditing](../security/dependency-auditing.md) — what `npm audit` does and does not cover.
- [Secrets management](../security/secrets-management.md) — CI secrets and why fork PRs do not get them.
- [Running the examples](../getting-started/running-the-examples.md) — the validators this workflow runs.
- [The built-in test runner](../node/built-in-test-runner.md) — `node --test` in detail.
- [Deployment checklist](deployment-checklist.md) — what CI should be proving before you ship.
