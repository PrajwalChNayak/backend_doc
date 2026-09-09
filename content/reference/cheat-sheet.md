---
title: Cheat sheet
description: Express 5 and Node 24 on one page — middleware order, request and response API, route syntax, parameterized queries, validation, shutdown and CLI flags.
status: current
updated: 2026-09-08
---

Everything you look up twice a week, in tables. Express `5.2.1` on Node `24` LTS. Each section links to the page that explains the *why*.

## Bootstrap

:::tabs
@tab npm
```bash
npm init -y
npm pkg set type=module engines.node=">=24"
npm install express@5 helmet@8 cors@2 compression@1 cookie-parser@1 express-rate-limit@8 pino@10 pino-http@11 zod@4
npm install -D pino-pretty@13 supertest@7
```
@tab pnpm
```bash
pnpm init
npm pkg set type=module engines.node=">=24"
pnpm add express@5 helmet@8 cors@2 compression@1 cookie-parser@1 express-rate-limit@8 pino@10 pino-http@11 zod@4
pnpm add -D pino-pretty@13 supertest@7
```
@tab yarn
```bash
yarn init -y
npm pkg set type=module engines.node=">=24"
yarn add express@5 helmet@8 cors@2 compression@1 cookie-parser@1 express-rate-limit@8 pino@10 pino-http@11 zod@4
yarn add -D pino-pretty@13 supertest@7
```
:::

```json title="package.json"
{
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "node --watch --env-file=.env src/server.js",
    "start": "node src/server.js",
    "test": "node --test --experimental-test-coverage"
  }
}
```

## The `app.js` / `server.js` split

`app.js` exports a configured app and never listens. `server.js` owns the port, the signals and the process. Tests import `app.js` and never bind a socket.

```js title="src/app.js"
import express from 'express'
import routes from './routes/index.js'
import { errorHandler, notFound } from './middleware/errors.js'

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '100kb' }))
  app.use('/api', routes)
  app.use(notFound)
  app.use(errorHandler)
  return app
}
```

```js title="src/server.js"
import { createApp } from './app.js'

const app = createApp()
const server = app.listen(Number(process.env.PORT ?? 3000), (err) => {
  if (err) throw err                      // Express 5 passes listen errors here
  console.log(`up on ${JSON.stringify(server.address())}`)
})
```

## Built-in middleware

`body-parser` is bundled — never install it separately.

| Middleware | Parses | Key options |
| --- | --- | --- |
| `express.json()` | `application/json` | `limit`, `type`, `strict`, `reviver`, `inflate`, `verify` |
| `express.urlencoded()` | `application/x-www-form-urlencoded` | `limit`, `extended` (**defaults to `false`**), `parameterLimit`, `type` |
| `express.text()` | `text/plain` | `limit`, `type`, `defaultCharset` |
| `express.raw()` | any, into a `Buffer` | `limit`, `type` |
| `express.static()` | serves a directory | `dotfiles` (**defaults to `'ignore'`**), `root`, `maxAge`, `immutable`, `etag`, `index`, `fallthrough`, `redirect` |
| `express.Router()` | mountable router | `mergeParams`, `caseSensitive`, `strict` |

All four body parsers accept `gzip`, `deflate` and **Brotli** (`br`) request bodies. The `limit` applies to the *decompressed* size.

```js
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))

// Raw body for a webhook signature check, before the JSON parser sees it.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handler)

// Serve a dot-directory explicitly; the default now hides it.
app.use('/.well-known', express.static('public/.well-known', { dotfiles: 'allow' }))
app.use(express.static('public', { maxAge: '1h', etag: true }))
```

## App settings

| Setting | Values | Why |
| --- | --- | --- |
| `trust proxy` | `false`, `true`, `1`, `'loopback'`, a CIDR list | Makes `req.ip` and `req.protocol` reflect `X-Forwarded-*`. Set to the **number of proxies**, never `true` in production. |
| `query parser` | `'simple'` (default), `'extended'`, `false`, a function | `'extended'` restores Express 4 bracket nesting. |
| `env` | `process.env.NODE_ENV` | Controls the default error-handler verbosity. |
| `etag` | `'weak'` (default), `'strong'`, `false` | |
| `json spaces` | number | Pretty-prints JSON responses; leave off in production. |
| `case sensitive routing` | boolean | Off by default: `/Foo` matches `/foo`. |
| `strict routing` | boolean | Off by default: `/foo` matches `/foo/`. |
| `x-powered-by` | boolean | Set `false`, or let Helmet remove it. |

## Route path syntax (path-to-regexp v8)

| Construct | Meaning | Example | `req.params` |
| --- | --- | --- | --- |
| `:name` | one segment | `/books/:id` | `{ id: '42' }` |
| `*name` | one or more segments, **array** | `/files/*path` | `{ path: ['a','b.txt'] }` |
| `{ … }` | optional group | `/books{/:id}` | `{}` when absent |
| `\` | escape a reserved char | `/prices/\$:amount` | |
| `:"name"` | non-identifier param name | `/r/:"report-id"` | `req.params['report-id']` |

`(`, `)`, `[`, `]`, `?`, `+`, `!` are reserved and throw at registration unless escaped.

| Want | Write |
| --- | --- |
| catch-all including `/` | `'/{*splat}'` |
| catch-all excluding `/` | `'/*splat'` |
| optional extension | `'/:file{.:ext}'` |
| optional trailing id | `'/books{/:id}'` |
| several paths, one handler | `['/discussion/:slug', '/page/:slug']` |
| a real regex | `/^\/api\/v(\d+)$/` |

`req.params` has a **null prototype** for string paths — use `Object.hasOwn(req.params, 'id')`. Unmatched params are **omitted**, not `undefined`.

## `req`

| Member | Type / note |
| --- | --- |
| `req.params` | null-prototype object; wildcards are arrays; unmatched keys omitted |
| `req.query` | **getter, not writable**; `'simple'` parser by default |
| `req.body` | **`undefined`** until a matching parser runs |
| `req.headers` / `req.get(name)` | case-insensitive lookup |
| `req.cookies` / `req.signedCookies` | needs `cookie-parser` |
| `req.ip` / `req.ips` | honors `trust proxy` |
| `req.protocol` / `req.secure` | honors `trust proxy` |
| `req.host` | **includes the port** in Express 5 |
| `req.hostname` | no port |
| `req.originalUrl` / `req.baseUrl` / `req.path` | full / mount / remainder |
| `req.method`, `req.url` | raw Node values |
| `req.accepts(types)` | content negotiation |
| `req.acceptsCharsets/Encodings/Languages()` | **plural only** in Express 5 |
| `req.is(type)` | `Content-Type` test, e.g. `req.is('json')` |
| `req.xhr`, `req.fresh`, `req.stale`, `req.subdomains` | |
| `req.socket` | underlying socket |

## `res`

| Member | Note |
| --- | --- |
| `res.status(code)` | integers **100–999** only; throws otherwise |
| `res.sendStatus(code)` | status + its standard text body |
| `res.json(obj)` / `res.jsonp(obj)` | status goes first: `res.status(201).json(obj)` |
| `res.send(body)` | string, Buffer, object or array — **not** a bare number |
| `res.end()` | no body |
| `res.redirect([status,] url)` | **status first** in Express 5; default 302 |
| `res.location(url)` | sets `Location` without a status |
| `res.sendFile(path, opts)` | `root`, `dotfiles`, `maxAge`, `headers`, `lastModified` |
| `res.download(path, filename, opts)` | sets `Content-Disposition: attachment` |
| `res.attachment(filename)` | header only |
| `res.set(field, value)` / `res.get(field)` | |
| `res.type(t)` | `Content-Type` shorthand |
| `res.vary(field)` | **throws** with no argument |
| `res.cookie(name, value, opts)` | `httpOnly`, `secure`, `sameSite`, `maxAge`, `signed`, `path`, `domain` |
| `res.clearCookie(name, opts)` | `maxAge`/`expires` are **ignored**; `path`/`domain`/`secure`/`sameSite` must match |
| `res.render(view, locals, cb)` | **always asynchronous** in Express 5 |
| `res.links(obj)`, `res.append(field, value)` | |
| `res.locals` | per-request view/handler data |
| `res.headersSent` | check before writing a second response |

## Error handling

Four arguments, always. Register it **last**. `async` handler rejections arrive here automatically — no wrapper needed.

```js title="src/middleware/errors.js"
export function notFound(req, res) {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl })
}

// The 4-arity signature is what makes Express treat it as an error handler.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)          // delegate to Node's default
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
    ? err.status
    : 500
  req.log?.error({ err }, 'request failed')
  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.message,
    requestId: req.id,
  })
}
```

| Signal | Meaning |
| --- | --- |
| `next()` | run the next middleware |
| `next(err)` | jump to the error handler |
| `next('route')` | skip the rest of *this* route's handlers |
| `next('router')` | exit the current router entirely |
| `throw` in an `async` handler | same as `next(err)` in Express 5 |
| `.on('error', next)` on a stream | still required — not a promise |

## Middleware order

Order is behavior, not style. Each line says why it sits where it does.

```js title="src/app.js"
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import pinoHttp from 'pino-http'

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)                 // 1. req.ip must be right before anything uses it
app.use(helmet())                         // 2. headers must be on error responses too
app.use(cors({ origin: ['https://app.example.com'], credentials: true }))
                                          // 3. preflights must answer before auth rejects them
app.use(compression())                    // 4. wraps res.write; must precede any body writer
app.use(express.json({ limit: '100kb' })) // 5. limits reject huge bodies before you touch them
app.use(express.urlencoded({ extended: false, limit: '100kb' }))
app.use(cookieParser(process.env.COOKIE_SECRET))
                                          // 6. sessions and CSRF read req.cookies
app.use(rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false }))
                                          // 7. after trust proxy (needs real ip), before route work
app.use(pinoHttp({ logger }))             // 8. logs every request including the ones limited above
app.use('/api', routes)                   // 9. the application
app.use(notFound)                         // 10. only reached when nothing matched
app.use(errorHandler)                     // 11. last, 4 arguments
```

| Position | Consequence of getting it wrong |
| --- | --- |
| `trust proxy` after rate limiting | every client shares the proxy's IP; one user can exhaust the limit for all |
| Helmet after routes | error and 404 responses ship without security headers |
| CORS after auth | the browser sees an opaque failure instead of a 401 |
| Compression after the router | responses are written before it can wrap them |
| Body parser without `limit` | a single large POST buffers into memory |
| Rate limit after the route | you do the expensive work, then refuse to return it |
| Error handler not last, or 3 arguments | Express treats it as normal middleware and errors fall through to the default handler |

## Parameterized queries

Never build SQL with template literals or `+`.

:::tabs
@tab PostgreSQL
```js
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])
const { rows: made } = await pool.query(
  'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id',
  [email, name],
)
```
@tab MySQL
```js
import mysql from 'mysql2/promise'

const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10 })
const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id])
const [res] = await pool.execute('INSERT INTO users (email, name) VALUES (?, ?)', [email, name])
```
@tab SQLite
```js
// node:sqlite — bundled, synchronous, no native build (Node 24)
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('app.db')
const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
db.prepare('INSERT INTO users (email, name) VALUES (?, ?)').run(email, name)

// better-sqlite3 — same shape, native build
import Database from 'better-sqlite3'

const bdb = new Database('app.db')
const one = bdb.prepare('SELECT * FROM users WHERE email = ?').get(email)
const named = bdb.prepare('SELECT * FROM users WHERE id = :id').get({ id })
```
:::

Placeholders bind **values**, never identifiers. A dynamic column or sort direction must come from an allow-list:

```js
const SORTABLE = new Set(['created_at', 'name'])
if (!SORTABLE.has(sort)) throw new BadRequest('bad sort column')
// lint-sql:allow sort is checked against the SORTABLE allow-list above
const sql = `SELECT * FROM users ORDER BY ${sort} ASC`
```

## Validation middleware (Zod 4)

Zod 4 puts format checks at the top level: `z.email()`, not `z.string().email()`.

```js title="src/middleware/validate.js"
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    req.valid = { ...req.valid, [source]: result.data }
    next()
  }
}
```

```js title="src/routes/users.js"
import { z } from 'zod'
import { validate } from '../middleware/validate.js'

const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(1).max(80),
  age: z.number().int().min(0).optional(),
}).strict()                                  // reject unknown keys — stops mass assignment

router.post('/users', validate(CreateUser), async (req, res) => {
  const user = await users.create(req.valid.body)   // never req.body after this point
  res.status(201).json(user)
})
```

Validate `req.params` and `req.query` the same way — both are attacker-controlled strings. `req.query` values are strings, so use `z.coerce.number()` there.

## Graceful shutdown

```js title="src/server.js"
import { createApp } from './app.js'
import { pool } from './db.js'

const server = createApp().listen(Number(process.env.PORT ?? 3000), (err) => {
  if (err) throw err
})

server.keepAliveTimeout = 65_000        // must exceed the load balancer's idle timeout
server.headersTimeout = 66_000          // must exceed keepAliveTimeout

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, draining`)

  const force = setTimeout(() => process.exit(1), 10_000).unref()

  server.close(async () => {            // stop accepting, let in-flight finish
    try {
      await pool.end()                  // then close outbound resources
    } finally {
      clearTimeout(force)
      process.exit(0)
    }
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => { throw reason })
process.on('uncaughtException', (err) => {
  console.error(err)
  process.exit(1)                       // let the supervisor restart a poisoned process
})
```

Add a readiness flag that flips to `false` at the top of `shutdown()` so the load balancer stops routing before `server.close()` runs.

## Node 24 CLI flags

| Flag | Use |
| --- | --- |
| `--env-file=.env` | load env vars without `dotenv`; `--env-file-if-exists=.env.local` tolerates a missing file |
| `--watch` | restart on change; `--watch-path=src` to scope it. Replaces `nodemon` |
| `--test` | run `node:test`; add `--test-reporter=spec`, `--test-name-pattern`, `--test-concurrency` |
| `--experimental-test-coverage` | coverage from the built-in runner |
| `--run <script>` | run a `package.json` script without npm's startup cost |
| `--enable-source-maps` | map stack traces back through TypeScript or a bundler |
| `--inspect` / `--inspect-brk` | attach a debugger on 9229; `--inspect-wait` pauses until one attaches |
| `--cpu-prof` | write a `.cpuprofile` on exit; `--heap-prof` for memory |
| `--max-old-space-size=<MB>` | raise the V8 heap cap in a container |
| `--experimental-transform-types` | needed only for `enum`, `namespace` and decorators; plain type-stripping is on by default |

```bash
node --env-file=.env --watch src/server.js
node --test --experimental-test-coverage
node --run dev
node --cpu-prof --cpu-prof-dir=./prof src/server.js
```

## HTTP status codes

| Code | Name | Use it when |
| --- | --- | --- |
| 200 | OK | a successful `GET`, `PUT` or `PATCH` returning a body |
| 201 | Created | a `POST` created a resource — set `Location` |
| 202 | Accepted | queued for later processing |
| 204 | No Content | success with no body, typically `DELETE` |
| 206 | Partial Content | a satisfied `Range` request |
| 301 / 308 | Moved Permanently / Permanent Redirect | permanent move; 308 preserves the method |
| 302 / 307 | Found / Temporary Redirect | temporary; 307 preserves the method |
| 304 | Not Modified | the client's `ETag`/`If-Modified-Since` still matches |
| 400 | Bad Request | malformed JSON, missing field, unparseable value |
| 401 | Unauthorized | no credentials, or they are invalid — send `WWW-Authenticate` |
| 403 | Forbidden | authenticated, but not allowed |
| 404 | Not Found | no such resource — also use it to hide existence from a non-owner |
| 405 | Method Not Allowed | path exists, method does not — send `Allow` |
| 409 | Conflict | unique constraint, version mismatch, duplicate submit |
| 410 | Gone | deliberately removed and not coming back |
| 413 | Content Too Large | body exceeded a parser `limit` |
| 415 | Unsupported Media Type | wrong `Content-Type` for the endpoint |
| 422 | Unprocessable Content | syntactically valid, semantically wrong (schema failure) |
| 429 | Too Many Requests | rate limited — send `Retry-After` |
| 500 | Internal Server Error | an unhandled error; never leak the stack |
| 502 | Bad Gateway | upstream returned garbage, or the proxy hit a closed keep-alive socket |
| 503 | Service Unavailable | shutting down, or a dependency is down — send `Retry-After` |
| 504 | Gateway Timeout | upstream did not answer in time |

## Common mistakes

- **Reading `req.body` without a parser or a guard.** It is `undefined` in Express 5, so destructuring throws.
- **Registering the error handler with three arguments.** Express only recognizes the four-argument form.
- **Setting `trust proxy` to `true`.** Set it to the number of proxies in front of you; `true` lets a client forge `X-Forwarded-For` and defeat rate limiting.
- **Omitting `limit` on body parsers.** The default is 100kb for JSON, but be explicit — and remember it applies after decompression.
- **Interpolating anything into SQL.** Even "just" a column name needs an allow-list plus a `// lint-sql:allow` justification.
- **Using `res.send(status)` or two-argument `res.json`.** Both are removed; put the status first.
- **Calling `res.status(err.status)` when `err.status` is `undefined`.** Express 5 throws outside 100–999.

## Related topics

- [Express 4 → 5 migration](express-4-to-5-migration.md) — why half of this page differs from what you remember.
- [Troubleshooting](troubleshooting.md) — the same material indexed by error message.
- [Library index](library-index.md) — the version to pin for every package named here.
- [Middleware](../express/middleware.md) — the long-form version of the ordering table.
- [Graceful shutdown](../production/graceful-shutdown.md) — the reasoning behind the skeleton above.
