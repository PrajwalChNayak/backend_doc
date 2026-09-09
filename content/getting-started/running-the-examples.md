---
title: Running the examples
description: How the examples directory is laid out, how to install and start each app, which ones need a database, and how to run the site's own validators.
status: current
updated: 2026-09-08
---

Every non-trivial snippet on this site has a runnable counterpart under `examples/`. Each one is a self-contained application with its own `package.json`, its own lockfile and its own README — nothing is shared, so you can copy a directory out and it still works.

## How the directory works

```text
examples/
  minimal-express-api/
    package.json        "type": "module", pinned deps, engines.node >= 24
    package-lock.json
    README.md           what it shows, how to run it, what to curl
    src/
      server.js
  layered-api/
  file-upload/
  db-sqlite/
  vulnerable-sql-injection/
  fixed-sql-injection/
  …
```

Three rules hold for every example:

- **ESM.** `"type": "module"` and `import`. No CommonJS, no build step, unless the example is specifically about TypeScript.
- **Pinned.** Dependency versions come from the site's verified table in [Library index](../reference/library-index.md). `scripts/check-deps.mjs` fails if an example drifts from it.
- **Runnable or explicit.** It either runs on Node 24 with no external service, or its README states the service it needs and gives you a `docker run` one-liner.

Start with these:

| Example | What it demonstrates |
| --- | --- |
| [`minimal-express-api`](../../examples/minimal-express-api/README.md) | The smallest correct Express 5 server — JSON body parsing, an async route, a 404, an error handler. |
| [`layered-api`](../../examples/layered-api/README.md) | Route → controller → service → repository, with validation at the edge. |
| [`file-upload`](../../examples/file-upload/README.md) | multer 2.x with size limits, magic-byte checking and a safe storage path. |
| [`db-sqlite`](../../examples/db-sqlite/README.md) | Parameterised queries against `node:sqlite`. No external service. |
| [`vulnerable-sql-injection`](../../examples/vulnerable-sql-injection/README.md) | A deliberately broken app, with an exploit you run yourself. |
| [`fixed-sql-injection`](../../examples/fixed-sql-injection/README.md) | The same app, corrected, with the same exploit now failing. |

:::danger
`examples/vulnerable-sql-injection` is exploitable on purpose. It exists so you can see the attack succeed before you see the fix. Run it on `localhost`, never expose it, and never copy code out of it. Directories whose names start with `vulnerable-` are the only ones exempt from the site's SQL-injection linter.
:::

## Installing and starting one

```bash
cd examples/minimal-express-api
npm ci
node --run start
```

Then, in another terminal:

```bash
curl -i http://localhost:3000/health
```

Each README lists the routes and the exact `curl` commands worth trying, including the ones that are supposed to fail.

### `npm ci` vs `npm install`

Use **`npm ci`**. It is not a faster alias for `npm install` — the two do different things.

| | `npm ci` | `npm install` |
| --- | --- | --- |
| Source of truth | `package-lock.json` only | `package.json`, resolving new versions |
| Existing `node_modules` | Deleted first | Reused and patched |
| Modifies the lockfile | Never | Yes, when it resolves something new |
| Fails when lockfile and manifest disagree | Yes | No — it fixes the lockfile |
| Use it for | Running an example, CI, Docker builds | Adding or upgrading a dependency |

The point of `npm ci` is that you get the exact tree the example was tested with. `npm install` may silently pull a newer minor of a transitive dependency, so a failure you hit is not a failure anyone else can reproduce. In CI and in a Dockerfile, `npm ci` is the only correct choice — see [Continuous integration](../production/ci.md) and [Dockerfile](../production/dockerfile.md).

### `node --run start`

Node 24 can run a `package.json` script directly:

```bash
node --run start
node --run test
```

`npm run start` also works and does the same thing. `node --run` skips npm's own startup, so it is noticeably faster, and it does **not** add `node_modules/.bin` to `PATH` or run pre/post scripts — which is a feature, since it means the script does what it says.

:::note
`node --run` runs scripts from the nearest `package.json`. It does not walk up looking for a workspace root, so run it from inside the example directory.
:::

### `node --env-file=.env`

Examples that need configuration ship a `.env.example`. Copy it and let Node load it — no `dotenv` dependency:

```bash
cp .env.example .env
node --env-file=.env src/server.js
```

Use `--env-file-if-exists=.env` when you want the same command to work with or without the file, which is what the examples' `start` scripts do so they run in CI where there is no `.env`.

Rules worth knowing before you are surprised by them:

- A real environment variable **wins** over one in the file. That is deliberate: it lets your platform override a development default.
- The parser handles `KEY=value`, `#` comments and quoted values. It is not a shell — there is no command substitution and no variable expansion.
- The file is read once at startup. Editing it needs a restart.

`.env` is for **development**. In production, inject real environment variables from your platform's secret store — see [Configuration](../production/configuration.md) and [Secrets management](../security/secrets-management.md). Every `.env` is in `.gitignore`; every `.env.example` is committed and contains only placeholder values.

## Examples that need no external service

These run on a clean machine with only Node 24 installed:

- [`minimal-express-api`](../../examples/minimal-express-api/README.md)
- [`layered-api`](../../examples/layered-api/README.md)
- [`file-upload`](../../examples/file-upload/README.md) — writes to a temporary directory
- [`db-sqlite`](../../examples/db-sqlite/README.md) — `node:sqlite`, a file on disk
- [`vulnerable-sql-injection`](../../examples/vulnerable-sql-injection/README.md) and [`fixed-sql-injection`](../../examples/fixed-sql-injection/README.md) — both SQLite-backed

Database examples default to SQLite for exactly this reason: `node scripts/run-examples.mjs` has to boot every app unattended in CI, and it cannot start a Postgres server.

## Examples that need a database

Where an example needs a real server, its README says so and repeats the relevant command below. Each one binds to `localhost`, uses a throwaway password, and disappears on exit because of `--rm`.

:::tabs
@tab PostgreSQL

```bash
docker run --rm -d --name pg \
  -e POSTGRES_PASSWORD=app \
  -e POSTGRES_USER=app \
  -e POSTGRES_DB=app \
  -p 5432:5432 \
  postgres:18-alpine
```

```env title=".env"
DATABASE_URL=postgres://app:app@localhost:5432/app
```

Check it: `psql "postgres://app:app@localhost:5432/app" -c "select 1;"`

@tab MySQL

```bash
docker run --rm -d --name mysql \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=app \
  -e MYSQL_USER=app \
  -e MYSQL_PASSWORD=app \
  -p 3306:3306 \
  mysql:9
```

```env title=".env"
DATABASE_URL=mysql://app:app@localhost:3306/app
```

MySQL takes noticeably longer than Postgres to become ready on first start. Wait for the log line, or retry the connection.

@tab Redis

```bash
docker run --rm -d --name redis \
  -p 6379:6379 \
  redis:8-alpine
```

```env title=".env"
REDIS_URL=redis://localhost:6379
```

Check it: `docker exec redis redis-cli ping` returns `PONG`.

@tab MongoDB

```bash
docker run --rm -d --name mongo \
  -p 27017:27017 \
  mongo:8
```

```env title=".env"
MONGODB_URL=mongodb://localhost:27017/app
```

A single container is a standalone server, so **transactions do not work** — they need a replica set. The MongoDB pages say where that matters.

:::

Stop a container with `docker stop pg` (or `mysql`, `redis`, `mongo`). Because of `--rm` the container and its data are removed, which is what you want for an example and emphatically not what you want for anything real.

:::warning
These commands publish a database on `localhost` with a trivial password and no TLS. That is acceptable for a container that lives for ten minutes on your laptop. It is not a template for anything else — if `0.0.0.0` is reachable from your network, you have just published an open database.
:::

## Running the site's own validators

The handbook validates itself. All five scripts are plain Node ESM with zero npm dependencies, and they run from the repository root.

| Command | What it checks |
| --- | --- |
| `node scripts/build.mjs` | Generates `docs/` from `content/`. Fails on malformed front matter or an unknown directive. |
| `node scripts/check.mjs` | Page structure, required sections, relative links and anchors, orphan pages, and forbidden Express 4 APIs. |
| `node scripts/lint-sql.mjs` | SQL built by concatenation or interpolation, in `content/` fences and `examples/` source. |
| `node scripts/check-deps.mjs` | That every package named exists on npm and that examples match the verified version table. |
| `node scripts/run-examples.mjs` | Boots each example app and exercises its routes. |

```bash
node scripts/check.mjs
node scripts/lint-sql.mjs
node scripts/check-deps.mjs
node scripts/run-examples.mjs
node scripts/build.mjs
```

Run `check.mjs` and `lint-sql.mjs` freely — they only read. `check-deps.mjs` reaches the npm registry, so it needs network. `run-examples.mjs` binds ports, so stop anything already listening on 3000.

:::warning
`node scripts/build.mjs` **writes** to `docs/`, which is the published site. Do not run it while other people are editing content — the repository convention is that the build runs once, by the coordinator, at the end. Never hand-edit anything under `docs/`; it is generated and your change will be overwritten.
:::

CI runs the same commands and fails the job if `docs/` is dirty after a build, which catches a regenerated site that was never committed. The workflow is in [Continuous integration](../production/ci.md).

## Common mistakes

- **`npm install` instead of `npm ci`.** You get a different dependency tree from the one the example was tested with, and the lockfile changes under you.
- **Running `node --run start` from the repository root.** It reads the nearest `package.json`. `cd` into the example first.
- **Expecting `.env` to override the environment.** It is the other way round: a real environment variable wins. That is what makes the same command work locally and in production.
- **Treating `--env-file` as a shell.** No `$VAR` expansion, no command substitution, no `export`.
- **Copying a `docker run` line into a server.** Trivial password, no TLS, published port, `--rm` so the data is destroyed. It is a laptop tool.
- **Expecting MongoDB transactions from a single container.** Standalone servers do not support them; you need a replica set.
- **Copying from `vulnerable-sql-injection`.** It is broken on purpose. Take the fix from [`fixed-sql-injection`](../../examples/fixed-sql-injection/README.md) and read [SQL injection](../security/sql-injection.md).
- **Running `scripts/build.mjs` mid-edit.** It rewrites `docs/` and produces a diff nobody asked for.

## Related topics

- [Prerequisites](prerequisites.md) — installing Node 24, Docker and a database client.
- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file` in full.
- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — `node --run` and the fields examples rely on.
- [The built-in test runner](../node/built-in-test-runner.md) — `node --test`, used by the examples' test scripts.
- [Configuration](../production/configuration.md) — what replaces `.env` in production.
- [Continuous integration](../production/ci.md) — the workflow that runs these validators.
- [SQLite](../databases/sqlite.md) — why the database examples default to it.
- [SQL injection](../security/sql-injection.md) — the exploit the vulnerable example demonstrates.
- [Library index](../reference/library-index.md) — the versions the examples pin.
