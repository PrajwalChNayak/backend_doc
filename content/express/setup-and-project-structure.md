---
title: Setup and project structure
description: How to start an Express 5 project on Node 24 with ESM, and why the app and the server belong in separate files.
status: current
updated: 2026-09-08
---

An Express project is just a Node project with one dependency. The decisions that matter are made in the first ten minutes: module system, how you run the process in development, and whether the app object can be created without opening a socket. Get those right and testing, configuration and deployment all stay easy.

## Creating the project

Target Node 24 LTS. Express 5.2.1 declares `engines.node: ">= 18"`, but Node 20 and below are end of life, so build against 24.

:::tabs
@tab npm
```bash
mkdir my-api && cd my-api
npm init -y
npm install express@5
```
@tab pnpm
```bash
mkdir my-api && cd my-api
pnpm init
pnpm add express@5
```
@tab yarn
```bash
mkdir my-api && cd my-api
yarn init -y
yarn add express@5
```
:::

Then edit `package.json`. Two fields do most of the work: `"type": "module"` switches the whole package to ESM so `import` works without a build step, and `engines` documents the runtime you tested against.

```json title="package.json"
{
  "name": "my-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch --env-file-if-exists=.env src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^5.2.1"
  }
}
```

`node --watch` restarts the process when a loaded file changes; it is stable since Node 22 and replaces `nodemon` for ordinary work. `node --env-file=.env` loads environment variables without `dotenv`; `--env-file-if-exists` is the variant that does not fail when the file is missing, which is what you want in a `dev` script that teammates run before creating their `.env`.

:::warning
`--env-file` is a startup flag, not a runtime API. Variables are in `process.env` before your code runs, but nothing reloads them later, and the file is not read in production images — pass real environment variables there instead.
:::

## Basic example

The single most useful structural decision in an Express codebase: **`app.js` builds and exports the app, `server.js` listens.** Nothing in `app.js` binds a port, reads `process.argv`, or calls `process.exit()`.

```js title="src/app.js"
import express from 'express'

export function createApp() {
  const app = express()

  app.use(express.json({ limit: '100kb' }))

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' })
  })

  // No path: runs when no route matched.
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  // Four arguments — this is what makes it an error handler.
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
    if (status >= 500) console.error(err)
    res.status(status).json({
      error: status >= 500 ? 'Internal Server Error' : err.message,
    })
  })

  return app
}
```

```js title="src/server.js"
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 3000)
const app = createApp()

const server = app.listen(port, (err) => {
  if (err) {
    console.error('failed to bind port', port, err)
    process.exit(1)
  }
  console.log(`listening on http://localhost:${port}`)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
```

That `(err)` parameter is new in Express 5. In Express 4 a bind failure such as `EADDRINUSE` surfaced as an `'error'` event on the underlying server and crashed the process with an unhandled event; Express 5 forwards it to the `listen` callback instead. If you ignore the argument you silently lose the "port already in use" message.

## How it works

`createApp()` returns a plain request handler — the same thing `http.createServer()` accepts. That is what makes the split pay off:

```js title="test/health.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

test('GET /healthz returns ok', async () => {
  const res = await request(createApp()).get('/healthz')

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})
```

`supertest` (7.2.2) binds an ephemeral port itself, so tests never collide on 3000 and never need a running server. Run them with `node --test`. If `app.js` called `listen()` at import time this test would start a real server as a side effect of `import`, and running two test files in parallel would fail.

The same split gives you one more thing: `createApp()` can take arguments. Pass in the database handle, the clock, or the logger and every layer below becomes substitutable in tests without module mocking.

```js title="src/app.js — injectable form"
export function createApp({ db, logger = console } = {}) {
  const app = express()
  app.locals.db = db
  app.locals.logger = logger
  // …
  return app
}
```

## Common patterns

A layout that scales from one file to a hundred:

```text
my-api/
├─ package.json
├─ .env                    # local only, git-ignored
├─ src/
│  ├─ app.js               # builds and exports the app — never listens
│  ├─ server.js            # reads config, calls app.listen()
│  ├─ config.js            # reads process.env once, validates, exports frozen object
│  ├─ routes/              # path -> controller wiring only
│  ├─ controllers/         # HTTP in, HTTP out
│  ├─ services/            # business rules, no req/res
│  ├─ repositories/        # database access, no business rules
│  ├─ middleware/          # auth, validation, request id
│  └─ lib/                 # framework-free helpers
└─ test/
```

Group by layer while the app is small, and by feature (`src/features/orders/…`) once you have more than about six resources — at that point "all the controllers" stops being a useful drawer. See [Layered architecture](layered-architecture.md) for what belongs in each box.

Read configuration in exactly one place so a missing variable fails at boot rather than on the first request that needs it:

```js title="src/config.js"
function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const config = Object.freeze({
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
})
```

:::best-practice
Keep `src/app.js` free of anything environment-specific. Everything that differs between your laptop and production — port, credentials, log format, trust-proxy setting — is passed in from `server.js` or `config.js`. That is what makes the production app and the tested app the same object.
:::

## Common mistakes

- **Calling `app.listen()` in `app.js`.** Importing the app for a test then starts a server, ports leak between test files, and you end up adding `--test-concurrency=1` to hide it.
- **Forgetting `"type": "module"`** and then writing `import` statements. Node reports `Cannot use import statement outside a module`. Add the field, or name files `.mjs`.
- **Ignoring the `err` argument of `app.listen()`.** New in Express 5: bind errors are delivered there, not thrown. Without the check the process appears to start and then serves nothing.
- **Installing `body-parser`.** It has been bundled since Express 4.16 — use `express.json()` and `express.urlencoded()`.
- **Reaching for `nodemon` and `dotenv` reflexively.** `node --watch` and `node --env-file` cover both on Node 24 with zero dependencies to audit.
- **Committing `.env`.** Add it to `.gitignore` on the first commit, before there is anything secret in it to leak.
- **Pinning Node 18 or 20 in a Dockerfile or CI matrix.** Both are past end of life; new projects target Node 24 LTS.

## Related topics

- [Routing](routing.md) — the next thing you add to `createApp()`.
- [Layered architecture](layered-architecture.md) — what goes in each directory above.
- [Middleware](middleware.md) — why the order of `app.use()` calls in `app.js` decides everything.
- [Error handling](error-handling.md) — turning that four-argument handler into something production-worthy.
- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file` in depth.
- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — fields, ranges and script conventions.
- [Testing](../express-libraries/testing.md) — supertest and `node:test` against the exported app.
- [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) — upgrading an existing project instead of starting one.
