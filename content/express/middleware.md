---
title: Middleware
description: How the Express 5 middleware stack executes, how to write your own, and what next(), next('route') and next('router') actually do.
status: current
updated: 2026-09-08
---

Middleware is a function with the signature `(req, res, next)` that sits in the same ordered stack as your routes. Everything Express does beyond raw routing — body parsing, authentication, logging, compression, error handling — is middleware, and all of it is governed by one rule: layers run in the order you registered them, until something responds.

## Why it exists

Middleware is how you factor out the work that is identical across many routes without inheriting it invisibly. A request id, an auth check and a rate limit are cross-cutting; putting them in each controller would be duplication, and putting them in a base class would hide the order in which they run. A stack makes the order explicit and greppable.

## Basic example

```js title="src/app.js"
import express from 'express'

const app = express()

// 1. Runs for every request.
app.use((req, res, next) => {
  req.id = crypto.randomUUID()
  res.setHeader('X-Request-Id', req.id)
  next()
})

// 2. Runs for every request with a JSON content type.
app.use(express.json({ limit: '100kb' }))

// 3. Runs only under /admin.
app.use('/admin', requireAdmin)

// 4. Runs only for this one route, before its handler.
app.get('/books/:id', cacheFor(60), getBook)
```

Four registration styles, one stack. `app.use()` without a path matches every request; `app.use(path, fn)` matches that path prefix; a function passed to `app.get()` and friends runs only for that route and method.

## How it works

Each layer gets `(req, res, next)` and must do exactly one of three things:

| The layer… | Effect |
| --- | --- |
| responds (`res.json`, `res.end`, `res.sendFile`, …) | the walk stops; nothing below runs |
| calls `next()` | control passes to the next matching layer |
| calls `next(err)` | control jumps to the next **error** handler, skipping normal layers |

A layer that does none of these hangs the request. A layer that responds *and* calls `next()` usually produces `ERR_HTTP_HEADERS_SENT` further down. The habit that avoids both: `return` every terminal call.

```js
function requireAuth(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer /, '')
  if (!token) return res.status(401).json({ error: 'unauthenticated' })
  req.user = verify(token)
  return next()
}
```

### Terminal versus pass-through

A **pass-through** middleware enriches the request and calls `next()` — a logger, a body parser, a request-id generator. A **terminal** middleware may answer the request itself — a rate limiter returning 429, an auth guard returning 401, `express.static()` when the file exists.

The distinction matters when you order the stack. Everything a terminal middleware needs must already be on `req` when it runs. A rate limiter that keys on `req.user.id` must be registered *after* authentication; one that keys on `req.ip` can run first, and should, because rejecting early costs less.

```js
app.use(requestId)        // cheap, needed by everything below
app.use(pinoHttp())       // logs even the requests that get rejected
app.use(helmet())         // sets headers on every response
app.use(ipRateLimit)      // terminal: rejects before any parsing happens
app.use(express.json())   // parsing costs memory — do it after the cheap rejects
app.use(authenticate)     // populates req.user
app.use('/api', apiRouter)
```

### Error middleware has four arguments

Express distinguishes an error handler from an ordinary middleware **by arity alone**:

```js
app.use((err, req, res, next) => {
  // handles errors
})
```

Four parameters means error handler; three means normal middleware. This is why you sometimes see `next` declared and never used — dropping it silently turns the function into a normal middleware that never runs on errors. Error handlers are covered fully in [Error handling](error-handling.md).

### Async middleware needs no wrapper

Express 5 forwards a rejected promise returned by any handler or middleware to the error stack automatically.

```js
app.use(async (req, res, next) => {
  req.session = await sessions.load(req.cookies.sid)   // a rejection lands in the error handler
  next()
})
```

That is new in Express 5. In Express 4 the router ignored return values, so an async middleware that rejected produced an unhandled rejection and the request hung — the reason hand-rolled `asyncHandler()` wrappers and wrapper packages existed. On Express 5 they wrap a feature the router already provides; remove them.

:::deprecated
`express-async-handler` is unnecessary on Express 5. The router forwards rejected promises to your error middleware by itself.
:::

:::warning
Only the returned promise is watched. If you write `async (req, res, next) => { … next() }` and then `await` something *after* calling `next()`, a later rejection has nowhere to go — the response may already be sent. Do the awaiting first, call `next()` last.
:::

### `next('route')` and `next('router')`

Two special string arguments change where the walk resumes:

| Call | Where it is legal | Effect |
| --- | --- | --- |
| `next()` | anywhere | next matching layer |
| `next(err)` | anywhere | next error handler |
| `next('route')` | handlers of a `app.get`/`app.post`/… route | skip the rest of **this route's** handlers, continue matching other routes |
| `next('router')` | any middleware in a router | leave **this router entirely**, continue in the parent |

```js
// next('route'): try the next matching route instead of this one.
app.get('/books/:id',
  (req, res, next) => (/^\d+$/.test(req.params.id) ? next() : next('route')),
  getBookById,
)
app.get('/books/:slug', getBookBySlug)
```

```js
// next('router'): a router that opts out of handling the request at all.
const apiRouter = express.Router()

apiRouter.use((req, res, next) => {
  if (!req.get('x-api-key')) return next('router')   // let the HTML routes have it
  next()
})
```

`next('router')` is the escape hatch for "this whole subtree does not apply". Use it sparingly — it makes control flow harder to follow than a plain path prefix.

## Common patterns

### Writing your own

The useful shape is a factory: a function that takes options and returns the middleware. It keeps configuration out of the request path and makes the middleware testable in isolation.

```js title="src/middleware/require-role.js"
export function requireRole(...roles) {
  const allowed = new Set(roles)

  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(new UnauthorizedError())
    if (!allowed.has(req.user.role)) return next(new ForbiddenError())
    next()
  }
}
```

```js
app.delete('/books/:id', requireAuth, requireRole('admin', 'editor'), deleteBook)
```

Give the returned function a name — it shows up in stack traces and in `DEBUG=express:*,router,router:*` output, and an anonymous arrow tells you nothing when the stack is twenty layers deep.

### Mounting paths, `req.baseUrl` and `req.originalUrl`

When middleware is mounted at a path, Express strips that prefix from `req.url` before the layer runs, so mounted code can be written as if it lived at the root.

```js
app.use('/api/v1', (req, res, next) => {
  console.log(req.originalUrl) // '/api/v1/books/42?full=1'  — never modified
  console.log(req.baseUrl)     // '/api/v1'                  — the mount path
  console.log(req.url)         // '/books/42?full=1'         — rewritten
  console.log(req.path)        // '/books/42'
  next()
})
```

| Property | Contains | Use it for |
| --- | --- | --- |
| `req.originalUrl` | the full path and query as received | logging, metrics, redirects back to self |
| `req.baseUrl` | the prefix this layer was mounted at | building absolute URLs for links |
| `req.url` | the remaining path, prefix stripped | rarely — prefer `req.path` |
| `req.path` | `req.url` without the query string | routing decisions inside middleware |

Log `req.originalUrl`. Logging `req.url` from inside a mounted router silently drops the prefix, and every `/books/42` line in your logs becomes ambiguous.

### Body parsers and the 100kb limit

`express.json()` defaults to a **100kb** limit. That default is a denial-of-service control: without it, a single request could ask Node to buffer an arbitrary amount of JSON in memory, and parsing is synchronous CPU work that blocks the event loop for every other connection.

```js
// Global default stays small.
app.use(express.json({ limit: '100kb' }))

// Raise it only where it is genuinely needed.
app.post('/import', express.json({ limit: '5mb' }), importBatch)
```

An over-limit request produces a 413 with `err.type === 'entity.too.large'`, which your error handler can translate into a clear message. Raise the limit per route, never globally — one endpoint that accepts a 5 MB document should not make every endpoint a memory amplifier.

The parsers only run when the request's `Content-Type` matches (`application/json` for `express.json()`, `application/x-www-form-urlencoded` for `express.urlencoded()`). When no parser ran, `req.body` is `undefined` in Express 5 — see [Request and response](request-and-response.md).

### Router-level middleware

`router.use()` scopes middleware to a subtree without repeating a path prefix:

```js title="src/routes/admin.js"
const router = express.Router()

router.use(requireAuth)          // every route in this file
router.use(requireRole('admin'))

router.get('/users', listUsers)
router.post('/users', createUser)

export default router
```

That is safer than adding a guard to each route, because a route added next month inherits the guard by construction rather than by memory.

## Common mistakes

- **Registering a parser or a guard after the routes that need it.** `app.use(express.json())` below `app.post('/books')` leaves `req.body` undefined in that handler. Order is everything.
- **Forgetting the fourth parameter on an error handler.** Three arguments makes it a normal middleware, and errors sail straight past it to Express's default handler.
- **Calling `next()` after responding.** The next layer that writes gets `ERR_HTTP_HEADERS_SENT`. `return` your terminal calls.
- **Keeping an async wrapper.** Express 5 forwards rejected promises itself, so homemade `asyncHandler()` helpers and wrapper packages are obsolete.
- **Awaiting after `next()`.** The response may already be finished; a rejection then has nowhere to go. Await first, `next()` last.
- **Raising the JSON limit globally** because one upload endpoint needed it. Scope it to that route.
- **Logging `req.url` inside a mounted router.** The mount prefix is stripped — log `req.originalUrl`.
- **Putting expensive middleware above cheap rejections.** Parse bodies after rate limiting and authentication, not before.
- **Mutating `req.query`.** It is a getter in Express 5 and assignment fails. Write sanitized values to a new property.

## Related topics

- [Routing](routing.md) — routes and middleware share one ordered stack.
- [Error handling](error-handling.md) — the four-argument signature, in depth.
- [Request and response](request-and-response.md) — `req.body`, `req.query`, `req.ip` and the rest.
- [Routers and modularity](routers-and-modularity.md) — `router.use()` and mount paths at scale.
- [Static files](static-files.md) — `express.static()` is middleware with a fallthrough rule worth knowing.
- [Rate limiting](../express-libraries/rate-limiting.md) — the canonical terminal middleware.
- [Logging](../express-libraries/logging.md) — where in the stack a request logger belongs.
- [Security headers with Helmet](../express-libraries/security-headers-helmet.md) — middleware that must run before anything can respond.
