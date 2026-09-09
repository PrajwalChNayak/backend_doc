---
title: Error handling
description: How errors reach Express 5's error middleware, how to model them with a typed error class, and how to respond without leaking internals.
status: current
updated: 2026-09-08
---

Express routes errors to a special kind of middleware — one that takes four arguments. In Express 5 anything a handler throws, synchronously or from a rejected promise, arrives there automatically. Your job is to decide which errors are the client's fault, which are yours, and what each one is allowed to say.

## Why it exists

Without a central handler, every route re-implements the same `try/catch`, and every one of them gets the status code, the log line and the response shape slightly different. A single error middleware makes the mapping from "domain failure" to "HTTP response" one function you can read, test and change.

## Basic example

```js title="src/middleware/error-handler.js"
export function errorHandler(err, req, res, next) {
  // Four parameters. `next` must be declared even when unused.
  if (res.headersSent) return next(err)

  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
  const expose = err.expose ?? status < 500

  if (status >= 500) req.log?.error({ err }, 'request failed')

  res.status(status).json({
    error: expose ? err.message : 'Internal Server Error',
    requestId: req.id,
  })
}
```

```js title="src/app.js"
app.use('/api', apiRouter)
app.use(notFound)       // no route matched
app.use(errorHandler)   // registered last, after everything
```

Arity is the whole signal: a function with three parameters is normal middleware, one with four is an error handler. Drop the unused `next` and your handler silently stops receiving errors.

## How errors get there

### `next(err)`

The explicit route. Any middleware or handler can call it, and Express skips every remaining normal layer to reach the first error handler.

```js
app.get('/books/:id', (req, res, next) => {
  books.findById(req.params.id, (err, book) => {
    if (err) return next(err)
    if (!book) return next(new NotFoundError('book not found'))
    res.json(book)
  })
})
```

### Throwing synchronously

```js
app.get('/books/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new BadRequestError('id must be numeric')
  res.json(getBook(req.params.id))
})
```

Express wraps handler invocation, so a synchronous throw is caught and forwarded.

### Rejected promises — automatic in Express 5

```js
app.get('/books/:id', async (req, res) => {
  const book = await books.findById(req.params.id)   // rejects -> error handler
  if (!book) throw new NotFoundError('book not found')
  res.json(book)
})
```

**This is new in Express 5 and it is the reason async wrappers are obsolete.** Express 4's router ignored the value a handler returned, so a rejection became an unhandled promise rejection: the request hung and, on modern Node, the process could exit. Every codebase therefore grew an `asyncHandler()` helper or installed a wrapper package. On Express 5 those wrappers intercept a rejection only to hand it to `next(err)` — precisely what the router already does. Delete them; they add a stack frame, hide the real handler signature, and make people think the behavior is opt-in.

:::deprecated
`express-async-handler` should be removed when you upgrade. Its entire job — catching a handler's rejection and calling `next(err)` — is built into the Express 5 router.
:::

:::warning
Automatic forwarding applies to the promise the layer **returns**. It does not apply to:

- callbacks you schedule and forget (`setTimeout`, `queueMicrotask`),
- `'error'` events on a stream or an emitter,
- anything started after you already called `next()` or responded.

For those, handle the error where it happens. A stream is easiest to get right by `await`ing `pipeline()`, which turns the event back into a rejection Express can see.
:::

## A typed error class

Give errors a status and an explicit "may the client see this message" flag. Everything else — Zod failures, driver errors, `TypeError`s — gets normalized into this shape at the boundary.

```js title="src/lib/errors.js"
export class AppError extends Error {
  constructor(message, { statusCode = 500, code, expose, cause } = {}) {
    super(message, { cause })
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    // 4xx messages are written for the client; 5xx messages are for you.
    this.expose = expose ?? statusCode < 500
    Error.captureStackTrace?.(this, new.target)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad Request', options) {
    super(message, { statusCode: 400, ...options })
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', options) {
    super(message, { statusCode: 401, ...options })
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options) {
    super(message, { statusCode: 403, ...options })
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found', options) {
    super(message, { statusCode: 404, ...options })
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', options) {
    super(message, { statusCode: 409, ...options })
  }
}
```

`expose` is the security-relevant field. `new NotFoundError('order 8123 not found')` is safe to show. `new AppError('connect ECONNREFUSED 10.0.3.4:5432')` is not — it leaks internal topology — and defaults to `expose: false` because its status is 500.

If you would rather not maintain a hierarchy, `http-errors` (2.0.1) provides the same `statusCode`/`expose` contract as a dependency Express itself uses.

### Preserving the original with `cause`

`Error`'s `cause` option keeps the low-level failure attached without putting it in the response.

```js title="src/repositories/book-repository.js"
export async function findById(id) {
  try {
    const { rows } = await pool.query('SELECT * FROM books WHERE id = $1', [id])
    return rows[0] ?? null
  } catch (cause) {
    throw new AppError('book lookup failed', { code: 'BOOK_LOOKUP_FAILED', cause })
  }
}
```

The handler logs `{ err }`; a structured logger such as `pino` serializes the chain, so the Postgres error code, the failing query and the original stack all appear in the log while the client sees `"Internal Server Error"`.

:::note
Express 5's default error handler logs the **whole error object**, not just the stack string. That is a genuine improvement for debugging — `cause`, `err.code`, and driver-specific fields such as a Postgres `detail` or a Mongo `writeErrors` array now show up in the output. It is also a reason to install your own handler before production: whatever you attach to an error will be printed.
:::

## Converting validation errors

Validation failures are the most common 4xx in any API. Translate them once, in the error handler, so no route has to.

```js title="src/middleware/error-handler.js"
import { ZodError } from 'zod'

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  // body-parser failures arrive with a `type` and a status.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' })
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' })
  }

  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
  const expose = err.expose ?? status < 500

  if (status >= 500) req.log?.error({ err }, 'unhandled error')

  res.status(status).json({
    error: expose ? err.message : 'Internal Server Error',
    requestId: req.id,
  })
}
```

Because a schema parse throws, a route needs no `try/catch` at all — Express 5 forwards the rejection and the handler above turns it into a 400 with a field-by-field list:

```js
const createBook = z.object({ title: z.string().min(1), authorEmail: z.email() })

app.post('/books', async (req, res) => {
  const input = createBook.parse(req.body)     // throws ZodError -> 400
  res.status(201).json(await books.create(input))
})
```

That uses Zod 4 (4.5.4), where the top-level `z.email()` replaces `z.string().email()`.

## The 404 catch-all

An unmatched request reaching the end of the stack gets Express's built-in 404, which is HTML. For an API you want JSON and the same shape as every other error.

```js title="src/app.js"
import { NotFoundError } from './lib/errors.js'

// Path-less: runs only when no route above responded.
app.use((req, res, next) => {
  next(new NotFoundError(`Cannot ${req.method} ${req.originalUrl}`))
})

app.use(errorHandler)
```

If you prefer an explicit path, use valid Express 5 syntax — the catch-all is `'/{*splat}'`, not the Express 4 spelling:

```js
app.all('/{*splat}', (req, res, next) => {
  next(new NotFoundError(`Cannot ${req.method} ${req.originalUrl}`))
})
```

`'/*splat'` would not match the site root, so `GET /` would fall through to the default HTML 404 while every other path returned JSON. See [Route parameters and path syntax](route-parameters-and-path-syntax.md).

## Not leaking internals

:::danger
A stack trace in a response body tells an attacker your directory layout, your dependency versions, and often your database schema. Never send `err.stack`, and never send the raw message of a 500.

```js vulnerable title="DO NOT COPY"
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message, stack: err.stack })
})
```

```js good
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
  const expose = err.expose ?? status < 500

  req.log?.error({ err, requestId: req.id }, 'request failed')

  res.status(status).json({
    error: expose ? err.message : 'Internal Server Error',
    requestId: req.id,
  })
})
```

Verify it: `curl -i https://api.example.com/boom` must return a body with no `stack`, no file paths, and no SQL.
:::

Return the request id instead. The client can quote it in a support ticket and you can find the full error — stack, `cause`, driver fields — in your logs.

Express also decides its *default* handler's verbosity from `NODE_ENV`: with `NODE_ENV=production` the built-in handler omits the stack from the response. Do not rely on that as your only control — set `NODE_ENV=production` *and* install your own handler.

## Errors after the response started

```js
if (res.headersSent) return next(err)
```

Once bytes are on the wire the status and headers are fixed. Delegating to `next(err)` hands the request to Express's default handler, which closes the connection instead of trying to write a second response. Without that guard your handler throws `ERR_HTTP_HEADERS_SENT` inside the error path, which is a much harder bug to read.

## Process-level safety nets

Error middleware only sees request-scoped errors. A rejection from a background timer or a bug in a listener escapes it, so keep the last-resort handlers — and let the process die rather than continue in an unknown state.

```js title="src/server.js"
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection', reason)
  throw reason
})

process.on('uncaughtException', (err) => {
  console.error('uncaught exception', err)
  server.close(() => process.exit(1))
  setTimeout(() => process.exit(1), 10_000).unref()
})
```

Restarting is the correct response: a supervisor brings up a clean process, whereas a limping one serves corrupt results indefinitely. See [Graceful shutdown](../production/graceful-shutdown.md).

## Common mistakes

- **Writing an error handler with three parameters.** Express identifies it by arity; three arguments means it never receives errors.
- **Registering the error handler before the routes.** It must be last — errors flow forward, not backward.
- **Keeping an `asyncHandler()` wrapper or a wrapper package.** Express 5 forwards rejected promises itself.
- **Assuming the automatic forwarding covers everything.** Stream `'error'` events and detached callbacks still need explicit handling.
- **Sending `err.message` for a 500.** Use an `expose` flag so only messages you wrote for clients escape.
- **Sending `err.stack` in any environment.** Log it, return a request id.
- **Passing a driver error code to `res.status()`.** Values outside 100–999 throw; map codes deliberately.
- **Forgetting the `res.headersSent` guard.** Errors thrown mid-stream otherwise crash the error path itself.
- **Swallowing the original error** instead of attaching it as `cause`. You lose the only line that says *why*.
- **Letting the built-in 404 answer an API in HTML.** Add a path-less 404 middleware that produces your JSON shape.

## Related topics

- [Middleware](middleware.md) — arity, ordering and `next()` semantics.
- [Routing](routing.md) — where errors originate.
- [Route parameters and path syntax](route-parameters-and-path-syntax.md) — the valid catch-all path used above.
- [Request and response](request-and-response.md) — status-code rules and `res.headersSent`.
- [Layered architecture](layered-architecture.md) — which layer is allowed to invent an HTTP status.
- [Validation](../express-libraries/validation.md) — producing the `ZodError` this page converts.
- [Logging](../express-libraries/logging.md) — serializing `err` and its `cause` chain.
- [Error handling](../node/error-handling.md) — the Node-level model beneath all of this.
- [Graceful shutdown](../production/graceful-shutdown.md) — what to do when the process itself is compromised.
- [Logging without leaking PII](../security/logging-without-leaking-pii.md) — what must never reach the log line above.
