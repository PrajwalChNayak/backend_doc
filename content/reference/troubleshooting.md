---
title: Troubleshooting
description: Node 24 and Express 5 errors indexed by the exact message, with the cause and the fix for each.
status: current
updated: 2026-09-08
---

Find the error text, read the cause, apply the fix. Every entry links to the page that explains the underlying mechanism properly — this page is a lookup table, not a substitute for understanding.

## Modules and startup

### `Error [ERR_REQUIRE_ESM]: require() of ES Module … not supported`

```text
Error [ERR_REQUIRE_ESM]: require() of ES Module /app/node_modules/file-type/index.js
from /app/src/upload.js not supported.
```

**Cause.** A CommonJS file is `require()`-ing an ESM-only package. Node 24 *can* `require()` an ES module, but only one with no top-level `await` anywhere in its graph — so this now appears mainly for packages that use top-level `await`, or on older runtimes. `file-type` and `nanoid` are the two you will meet most often.

**Fix.** Move your project to ESM, which is where everything is heading anyway:

```json title="package.json"
{ "type": "module" }
```

Then convert `require()` to `import`. If one file must stay CommonJS, use a dynamic import, which always works:

```js
const { fileTypeFromBuffer } = await import('file-type')
```

More: [ESM vs CommonJS](../node/esm-vs-commonjs.md).

### `SyntaxError: Cannot use import statement outside a module`

```text
import express from 'express'
^^^^^^
SyntaxError: Cannot use import statement outside a module
```

**Cause.** The opposite direction: a `.js` file containing `import` is being parsed as CommonJS, because the nearest `package.json` has no `"type": "module"`.

**Fix.** Add `"type": "module"` to `package.json`, or rename the file to `.mjs`. Do not "fix" it by rewriting `import` to `require` — that trades a one-line fix for a permanent constraint.

```bash
npm pkg set type=module
```

More: [ESM vs CommonJS](../node/esm-vs-commonjs.md).

### `ReferenceError: __dirname is not defined in ES module scope`

```text
ReferenceError: __dirname is not defined in ES module scope
```

**Cause.** `__dirname`, `__filename`, `require` and `module` are CommonJS wrapper variables. ES modules do not have them.

**Fix.** On Node 24 use `import.meta.dirname` and `import.meta.filename`:

```js
import path from 'node:path'

const publicDir = path.join(import.meta.dirname, '..', 'public')
app.use(express.static(publicDir))
```

The portable form, if you need to support an older runtime:

```js
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
```

More: [Files and paths](../node/fs-and-path.md).

## Routing

### `TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError`

```text
TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError
    at name (/app/node_modules/path-to-regexp/dist/index.js:…)
```

**Cause.** An Express 4 route pattern reached `path-to-regexp@8`. A `*` or `:` with nothing usable after it — almost always the old catch-all `'/*'`, or a stray `:` in a literal path. The number is the character offset in the path string. This throws while the route is being **registered**, so the process dies at boot and no error middleware can catch it.

**Fix.** Name the wildcard, and wrap it in a group if it must also match the mount root:

| Old | New |
| --- | --- |
| `'/*'` | `'/{*splat}'` (matches `/` too) or `'/*splat'` (does not) |
| `'/files/*'` | `'/files/*path'` — `req.params.path` is an **array** |

```js
// Catch-all / SPA fallback, Express 5:
app.get('/{*splat}', (req, res) => {
  res.sendFile('index.html', { root: 'public' })
})
```

More: [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md), [Express 4 → 5 migration](express-4-to-5-migration.md).

### `TypeError: Unexpected ? at 7, expected END: https://git.new/pathToRegexpError`

```text
TypeError: Unexpected ? at 7, expected END: https://git.new/pathToRegexpError
TypeError: Unexpected [ at 1, expected END: https://git.new/pathToRegexpError
TypeError: Unexpected ( at 9, expected END: https://git.new/pathToRegexpError
```

**Cause.** `(`, `)`, `[`, `]`, `?`, `+` and `!` are reserved in path-to-regexp v8. The `?` suffix modifier, inline regex groups and the `'/[a|b]/:slug'` alternation spelling are all gone.

**Fix.**

| Old | New |
| --- | --- |
| `'/:file.:ext?'` | `'/:file{.:ext}'` |
| `'/books/:id?'` | `'/books{/:id}'` |
| `'/[discussion\|page]/:slug'` | `['/discussion/:slug', '/page/:slug']` |
| `'/product/(\\d+)'` | a real `RegExp`, or validate in the handler |
| a literal `(` in the URL | escape it: `'/reports/\\(draft\\)'` |

More: [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md).

### `TypeError: argument name must be a string`

**Cause.** `router.param()` no longer accepts an array of parameter names. (`app.param()` still does.)

**Fix.** One call per name:

```js
const toNumber = (req, res, next, value) => { req.value = Number(value); next() }
router.param('id', toNumber)
router.param('page', toNumber)
```

More: [Routers and modularity](../express/routers-and-modularity.md).

## Request bodies

### `TypeError: Cannot read properties of undefined (reading 'email')`

```text
TypeError: Cannot read properties of undefined (reading 'email')
    at /app/src/routes/users.js:12:29
```

**Cause.** `req.body` is `undefined`. In Express 4 an unparsed body was `{}`, so `req.body.email` quietly returned `undefined`; in Express 5 it is `undefined` and the property read throws. Either no body parser is mounted, or one is mounted but did not match this request.

**Fix.** Mount the parser, and still guard the read:

```js
app.use(express.json({ limit: '100kb' }))

app.post('/users', (req, res) => {
  const { email } = req.body ?? {}
  if (!email) return res.status(400).json({ error: 'email is required' })
  // …
})
```

The durable fix is schema validation in front of the handler, so the handler never sees an unvalidated shape. More: [Validation](../express-libraries/validation.md), [Express 4 → 5 migration](express-4-to-5-migration.md).

### `req.body` is empty even though the parser is mounted

**Cause.** Body parsers are `Content-Type`-gated. `express.json()` only runs for `application/json`; `express.urlencoded()` only for `application/x-www-form-urlencoded`. A client sending `text/plain`, `application/x-www-form-urlencoded` to a JSON parser, or no `Content-Type` at all, sails straight past it and leaves `req.body` `undefined`.

**Fix.** Send the right header:

```bash
# Wrong: no Content-Type → req.body is undefined
curl -X POST localhost:3000/users -d '{"email":"a@b.c"}'

# Right
curl -X POST localhost:3000/users \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.c"}'
```

If you genuinely must accept an unusual type, widen the parser rather than guessing:

```js
app.use(express.json({ type: ['application/json', 'application/csp-report'] }))
```

Reject the rest explicitly with **415 Unsupported Media Type** so the caller learns what went wrong:

```js
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' })
  }
  next()
})
```

More: [Middleware](../express/middleware.md), [Request and response](../express/request-and-response.md).

### `PayloadTooLargeError: request entity too large` (HTTP 413)

```text
PayloadTooLargeError: request entity too large
    at readStream (/app/node_modules/raw-body/index.js:…)
  expected: 2483027, length: 2483027, limit: 102400, type: 'entity.too.large'
```

**Cause.** The request body exceeded a parser's `limit` (100kb by default for `express.json()`). Note that with `Content-Encoding: gzip`, `deflate` or `br`, the limit applies to the **decompressed** size, so a tiny upload can still trip it.

**Fix.** Raise the limit only for the routes that need it, never globally, and turn the error into a clean 413:

```js
app.use(express.json({ limit: '100kb' }))
app.post('/imports', express.json({ limit: '5mb' }), importHandler)

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large', limit: err.limit })
  }
  next(err)
})
```

File uploads should not go through a body parser at all — stream them. More: [File uploads](../express-libraries/file-uploads.md), [Error handling](../express/error-handling.md).

## Static files

### `/.well-known/…` returns 404 after upgrading to Express 5

```bash
curl -i http://localhost:3000/.well-known/acme-challenge/TOKEN
# HTTP/1.1 404 Not Found
```

**Cause.** `express.static()` now defaults to `dotfiles: 'ignore'`, and the check applies to hidden **directories** in the path, not just filenames. Anything under a `.`-prefixed directory disappears. The usual casualty is ACME HTTP-01 validation, so certificate renewal starts failing silently.

**Fix.** Mount the dot-directory explicitly, before the general static mount:

```js
app.use('/.well-known', express.static('public/.well-known', { dotfiles: 'allow' }))
app.use(express.static('public'))
```

Do **not** set `dotfiles: 'allow'` on the whole tree — that also serves `.env`, `.git` and editor backups if any ever land in the directory.

More: [Static files](../express/static-files.md), [Secrets management](../security/secrets-management.md).

## CORS

All of these appear in the browser console, not in your server logs. The server usually returns 200; the browser refuses to hand the response to JavaScript.

### `No 'Access-Control-Allow-Origin' header is present on the requested resource`

```text
Access to fetch at 'https://api.example.com/users' from origin 'https://app.example.com'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
on the requested resource.
```

**Cause.** No CORS middleware ran for this request, or it ran but the request's `Origin` did not match your allow-list, so no header was emitted.

**Fix.**

```js
app.use(cors({ origin: ['https://app.example.com'], credentials: true }))
```

Mount it **before** authentication and before the routes — an auth middleware that returns 401 first produces a response with no CORS headers, and the browser reports it as a CORS failure rather than an auth failure.

### `Response to preflight request doesn't pass access control check`

```text
Access to fetch at 'https://api.example.com/users' from origin 'https://app.example.com'
has been blocked by CORS policy: Response to preflight request doesn't pass access
control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**Cause.** The browser's `OPTIONS` preflight did not get a successful, CORS-headed response. Something in front of your CORS middleware answered it — a rate limiter, an auth guard, or a 404 handler.

**Fix.** Put `cors()` above everything that can reject a request, and make sure nothing else claims `OPTIONS`.

### `The value of the 'Access-Control-Allow-Origin' header … must not be the wildcard '*' when the request's credentials mode is 'include'`

**Cause.** You set `origin: '*'` (or `cors()` with no options) while the client sends cookies or `Authorization` with `credentials: 'include'`. The spec forbids that combination.

**Fix.** Echo a specific allowed origin instead of the wildcard:

```js
const ALLOWED = new Set(['https://app.example.com'])
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED.has(origin)),
  credentials: true,
}))
```

:::danger
Never reflect `req.headers.origin` back unconditionally with `credentials: true`. That makes every site on the internet a trusted origin for authenticated requests. See [CORS misconfiguration](../security/cors-misconfiguration.md).
:::

### `Request header field authorization is not allowed by Access-Control-Allow-Headers in preflight response`

**Cause.** The client sends a header your preflight response does not list.

**Fix.** `allowedHeaders: ['Content-Type', 'Authorization']`.

### `Method PATCH is not allowed by Access-Control-Allow-Methods in preflight response`

**Cause.** Same thing for the method.

**Fix.** `methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']`.

### A response header your client code cannot read

**Cause.** Only a short safelist of response headers is exposed to JavaScript by default. `X-Total-Count`, `X-Request-Id` and `RateLimit-*` are not on it.

**Fix.** `exposedHeaders: ['X-Total-Count', 'RateLimit-Remaining']`.

More: [CORS](../express-libraries/cors.md), [CORS misconfiguration](../security/cors-misconfiguration.md).

## Process and network

### `Error: listen EADDRINUSE: address already in use :::3000`

```text
Error: listen EADDRINUSE: address already in use :::3000
    at Server.setupListenHandle [as _listen2] (node:net:…)
```

**Cause.** Another process holds the port — usually a previous run that did not exit, or a `--watch` restart racing the old process.

**Fix.**

```bash
# Which process?
lsof -i :3000            # macOS / Linux
netstat -ano | findstr :3000    # Windows, then: taskkill /PID <pid> /F
```

In Express 5 this error is delivered to the `app.listen()` **callback** instead of being thrown, so a callback that ignores its first argument turns a hard failure into a server that appears to start and never serves anything:

```js
const server = app.listen(3000, (err) => {
  if (err) throw err
  console.log(`listening on ${JSON.stringify(server.address())}`)
})
```

More: [Express 4 → 5 migration](express-4-to-5-migration.md), [Graceful shutdown](../production/graceful-shutdown.md).

### `Error: connect ECONNREFUSED 127.0.0.1:5432`

```text
Error: connect ECONNREFUSED 127.0.0.1:5432
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:…)
  errno: -111, code: 'ECONNREFUSED', syscall: 'connect', port: 5432
```

**Cause.** Nothing is listening at that address and port. Common variants: the database container is not up; you are inside Docker and used `localhost` instead of the service name; the host is right but the port is the container-internal one; the database only binds to a Unix socket.

**Fix.** Check the address before you check your code:

```bash
docker compose ps
pg_isready -h 127.0.0.1 -p 5432
```

Inside Compose, the host is the **service name**, not `localhost`:

```env title=".env"
DATABASE_URL=postgres://app:secret@db:5432/app
```

Then fail fast at boot rather than on the first request — a readiness probe that checks the pool ([Health checks](../databases/health-checks.md)) turns this into a deploy failure instead of a user-facing 500.

More: [Connection pooling](../databases/connection-pooling.md), [Retries and timeouts](../databases/retries-and-timeouts.md).

### `Error: timeout exceeded when trying to connect` (pool exhaustion)

```text
Error: timeout exceeded when trying to connect
    at Timeout._onTimeout (/app/node_modules/pg-pool/index.js:…)
```

**Cause.** Every pooled connection is checked out and none came back within `connectionTimeoutMillis`. Almost always a leak: a `pool.connect()` whose `client.release()` never runs because an error path returned early. It can also be a genuine capacity problem — `max` too small for your concurrency, or a slow query holding connections.

**Fix.** Release in `finally`, always:

```js
const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, id])
  await client.query('COMMIT')
} catch (err) {
  await client.query('ROLLBACK')
  throw err
} finally {
  client.release()          // runs on every path, including the throw
}
```

For a single statement, use `pool.query()` — it checks out and releases for you. Set a non-zero `connectionTimeoutMillis` so exhaustion surfaces as an error rather than a hang, and cap `max` so *all* your instances together stay under the server's connection limit.

```js
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
})
```

More: [Connection pooling](../databases/connection-pooling.md), [Transactions](../databases/transactions.md).

### `Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client`

```text
Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client
    at ServerResponse.setHeader (node:_http_outgoing:…)
```

**Cause.** Two responses for one request. The usual shapes: a missing `return` before `res.json(...)` in a guard clause; calling `next()` after responding; responding in a handler *and* in the error handler.

**Fix.** Return every response, and check `res.headersSent` in the error handler:

```js
app.get('/users/:id', async (req, res) => {
  const user = await users.find(req.params.id)
  if (!user) return res.status(404).json({ error: 'Not Found' })  // note the return
  res.json(user)
})

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)   // hand off to Node's default handler
  res.status(500).json({ error: 'Internal Server Error' })
}
```

More: [Error handling](../express/error-handling.md).

### An unhandled rejection kills the process

```text
node:internal/process/promises:…
        triggerUncaughtException(err, true /* fromPromise */);
        ^
[UnhandledPromiseRejection: This error originated either by throwing inside of an
async function without a catch block, or by rejecting a promise which was not
handled with .catch().]
```

**Cause.** A promise rejected with nobody listening. Since Node 15 the default is to crash. In an Express app it is nearly always a promise created **outside** the request lifecycle — a fire-and-forget `sendEmail(...)` with no `await`, a `setTimeout` callback that awaits something, or a background job kicked off from a handler.

**Fix.** Inside a handler, Express 5 already forwards rejections to the error middleware, so plain `async` handlers are safe with no wrapper. For work you deliberately do not await, attach a handler at the call site:

```js
// Fire-and-forget must still be handled.
sendWelcomeEmail(user).catch((err) => req.log.error({ err }, 'welcome email failed'))
```

Then make the process fail loudly rather than limp on:

```js
process.on('unhandledRejection', (reason) => { throw reason })
process.on('uncaughtException', (err) => { console.error(err); process.exit(1) })
```

More: [Async/await and promises](../node/async-await-and-promises.md), [Error handling](../node/error-handling.md).

### Intermittent 502s behind a load balancer

```text
502 Bad Gateway         # ALB / nginx / Cloudflare, no matching entry in your app log
```

**Cause.** A keep-alive race. The proxy reuses an idle connection at the same moment Node closes it, and the request dies with no server-side trace. Node's default `keepAliveTimeout` is 5 seconds — shorter than most load balancers' idle timeout (AWS ALB defaults to 60), so Node always closes first.

**Fix.** Make Node's timeouts *longer* than the proxy's idle timeout, and keep `headersTimeout` above `keepAliveTimeout`:

```js
const server = app.listen(3000)
server.keepAliveTimeout = 65_000   // > ALB idle timeout (60s)
server.headersTimeout = 66_000     // > keepAliveTimeout
```

If the 502s coincide with deploys instead of being random, it is shutdown ordering, not keep-alive: stop advertising readiness before you call `server.close()`. More: [Graceful shutdown](../production/graceful-shutdown.md), [Performance](../production/performance.md).

### `ValidationError: The 'X-Forwarded-For' header is set but the Express 'trust proxy' setting is false (default)`

```text
ValidationError: The 'X-Forwarded-For' header is set but the Express 'trust proxy'
setting is false (default).
  code: 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'
```

**Cause.** You are behind a proxy, so every request arrives from the proxy's IP. `req.ip` is that one address for everybody, so `express-rate-limit` buckets all traffic together — one noisy client can exhaust the limit for the entire user base. The symptom without the warning is "rate limiting fires for everyone at once", or `req.ip` logged as `::ffff:10.0.0.5` for every request.

**Fix.** Tell Express exactly how many proxies sit in front of it:

```js
app.set('trust proxy', 1)   // one proxy (ALB, nginx, Cloudflare — count them)
```

:::danger
Never `app.set('trust proxy', true)`. That trusts the whole `X-Forwarded-For` chain, including the part a client can forge, so an attacker rotates a fake left-most IP and bypasses rate limiting entirely. Use the hop count, or a specific CIDR list.
:::

Verify what Express actually sees:

```bash
curl -H 'X-Forwarded-For: 1.2.3.4' http://localhost:3000/whoami
```

```js
app.get('/whoami', (req, res) => res.json({ ip: req.ip, ips: req.ips }))
```

More: [Rate limiting](../express-libraries/rate-limiting.md), [Rate limiting and abuse](../security/rate-limiting-and-abuse.md).

## Native modules

### `gyp ERR!` / `Error: Could not locate the bindings file` on Alpine

```text
npm error gyp ERR! find Python
npm error gyp ERR! stack Error: Could not find any Python installation to use
```

```text
Error: Could not locate the bindings file. Tried:
 → /app/node_modules/better-sqlite3/build/better_sqlite3.node
```

**Cause.** `argon2`, `bcrypt`, `better-sqlite3` and `sharp` ship native code. Alpine uses **musl** libc, so the glibc prebuilds do not apply and npm falls back to compiling — which needs a toolchain the slim image does not have. The second message means the install "succeeded" without ever producing a binary, or that `node_modules` was copied between images with different architectures or libc.

**Fix.** Easiest: use a Debian-based image, where prebuilds exist.

```dockerfile title="Dockerfile"
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
```

If you must stay on Alpine, install the toolchain in a build stage and copy only the result:

```dockerfile title="Dockerfile"
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
CMD ["node", "src/server.js"]
```

Never `COPY node_modules` from your host into the image — the native binaries are built for your machine, not the container.

For SQLite specifically, the whole problem disappears if you use the bundled `node:sqlite` instead of `better-sqlite3`. More: [SQLite](../databases/sqlite.md), [Dockerfile](../production/dockerfile.md), [Password hashing](../express-libraries/password-hashing.md).

## Authentication

### `JsonWebTokenError: invalid signature`

```text
JsonWebTokenError: invalid signature
    at /app/node_modules/jsonwebtoken/verify.js:…
```

**Cause.** The token was signed with a different key than the one verifying it, or with a different algorithm. In practice: the secret changed between deploys, a token from staging was used against production, `process.env.JWT_SECRET` is `undefined` in one environment, or an RS256 token is being verified with an HS256 secret.

**Fix.** Assert the secret at boot rather than per request, and pin the algorithm:

```js
import jwt from 'jsonwebtoken'

const SECRET = process.env.JWT_SECRET
if (!SECRET || SECRET.length < 32) throw new Error('JWT_SECRET missing or too short')

const claims = jwt.verify(token, SECRET, {
  algorithms: ['HS256'],     // never omit — stops algorithm-confusion attacks
  issuer: 'api.example.com',
  audience: 'app.example.com',
})
```

:::danger
Omitting `algorithms` lets an attacker choose it. Always pass an explicit single-element list. See [JWT pitfalls](../security/jwt-pitfalls.md).
:::

### `JsonWebTokenError: jwt malformed`

**Cause.** The string you passed is not three base64url segments separated by dots. Usually the `Bearer ` prefix was not stripped, the header was absent so `undefined` reached `verify()`, or a cookie value was truncated.

**Fix.**

```js
const header = req.get('authorization') ?? ''
const [scheme, token] = header.split(' ')
if (scheme !== 'Bearer' || !token) {
  return res.status(401).json({ error: 'Missing bearer token' })
}
```

### `TokenExpiredError: jwt expired`

**Cause.** Working as designed: `exp` is in the past. If it happens far too early, the two machines' clocks disagree.

**Fix.** Return 401 with a distinguishable code so the client knows to refresh rather than to log the user out:

```js
try {
  req.user = jwt.verify(token, SECRET, { algorithms: ['HS256'] })
} catch (err) {
  const expired = err.name === 'TokenExpiredError'
  return res.status(401).json({ error: expired ? 'token_expired' : 'token_invalid' })
}
```

Use short-lived access tokens plus a refresh token; do not paper over it with a huge `expiresIn`. More: [Authentication](../express-libraries/authentication.md), [Authentication and session security](../security/authentication-and-session-security.md).

## SQLite

### `SqliteError: database is locked` / `SQLITE_BUSY`

```text
SqliteError: database is locked
  code: 'SQLITE_BUSY'
```

**Cause.** SQLite allows one writer at a time. In the default rollback-journal mode a writer also blocks readers, so any concurrency produces this immediately. It also appears when a transaction is left open — an error path that never runs `COMMIT` or `ROLLBACK` — or when several processes share one file over a network mount.

**Fix.** Turn on WAL mode and set a busy timeout at startup:

```js
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('app.db')
db.exec('PRAGMA journal_mode = WAL')      // readers no longer block on the writer
db.exec('PRAGMA busy_timeout = 5000')     // wait up to 5s instead of failing instantly
db.exec('PRAGMA foreign_keys = ON')
```

Then keep write transactions short, and always close them:

```js
const insert = db.prepare('INSERT INTO events (name, payload) VALUES (?, ?)')
db.exec('BEGIN IMMEDIATE')
try {
  for (const e of events) insert.run(e.name, JSON.stringify(e.payload))
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}
```

WAL requires a real local filesystem. On NFS or a network volume, or with more than a couple of writing processes, move to PostgreSQL. More: [SQLite](../databases/sqlite.md), [Transactions](../databases/transactions.md).

## Common mistakes

- **Fixing the symptom instead of the address.** `ECONNREFUSED` and `EADDRINUSE` are almost never code bugs — check what is actually listening before editing anything.
- **Reading CORS errors as server errors.** The server returned 200; the browser withheld it. Your server log will show nothing.
- **Setting `trust proxy` to `true` to silence the rate-limiter warning.** That converts a warning into a bypassable rate limiter.
- **Raising body-parser limits globally** to stop a 413, rather than raising it on the one route that needs it.
- **Allowing all dotfiles** to fix a `/.well-known/` 404, which also exposes `.env` and `.git`.
- **Wrapping `async` handlers to catch rejections.** Express 5 already forwards them; a wrapper only hides where errors flow.
- **Swallowing `ERR_HTTP_HEADERS_SENT`.** It means a request produced two responses; find the missing `return`.
- **Copying `node_modules` into a container.** Native modules are built per platform and libc.

## Related topics

- [Express 4 → 5 migration](express-4-to-5-migration.md) — the upgrade that causes most of the errors on this page.
- [Cheat sheet](cheat-sheet.md) — the correct configuration, without the failure story.
- [Library index](library-index.md) — the version to be on before you debug anything.
- [Error handling](../express/error-handling.md) — turning any of these into a clean HTTP response.
- [Deployment checklist](../production/deployment-checklist.md) — the pre-flight pass that catches most of them before users do.
