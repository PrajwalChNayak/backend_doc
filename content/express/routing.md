---
title: Routing
description: How Express 5 matches a method and path to a handler, and how to organize routes so the matching stays predictable.
status: current
updated: 2026-09-08
---

A route is a method, a path, and one or more handler functions. Express walks its router stack in the order you registered things and calls the first layer whose method and path match; whether the request goes any further is decided by the handler, not by Express. Understanding that "first match wins, in registration order" rule explains almost every routing surprise.

## Basic example

```js title="src/app.js"
import express from 'express'

const app = express()
app.use(express.json())

app.get('/books', (req, res) => {
  res.json([{ id: 1, title: 'Dune' }])
})

app.post('/books', (req, res) => {
  res.status(201).json({ id: 2, ...req.body })
})

app.get('/books/:id', (req, res) => {
  res.json({ id: Number(req.params.id) })
})

app.delete('/books/:id', (req, res) => {
  res.sendStatus(204)
})

export default app
```

`app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`, `app.head` and `app.options` map onto HTTP methods. `app.all(path, handler)` matches every method at that path — useful for a catch-all or a per-path guard, and the only method helper that is not an HTTP verb.

:::note
The Express 4 `del` alias was removed in Express 5. Use `app.delete()`. See the [migration reference](../reference/express-4-to-5-migration.md) for the full list of removals.
:::

## How it works

Every `app.get(...)`, `app.use(...)` and router mount pushes a **layer** onto a stack. On each request Express walks that stack from the top:

1. If the layer's path does not match, skip it.
2. If it is a route (`app.get`, `app.post`, …) and the method does not match, skip it.
3. Otherwise call the handler with `(req, res, next)`.
4. The handler either responds, or calls `next()` to continue walking, or calls `next(err)` to jump to the error handlers.

If the walk ends with nobody responding, Express's default handler sends a 404. Nothing in Express forces a response — a handler that neither responds nor calls `next()` leaves the request hanging until the client times out.

Order therefore matters. These two registrations behave differently:

```js
// Correct: the literal path is registered first.
app.get('/books/featured', listFeatured)
app.get('/books/:id', getBook)
```

Registered the other way round, `/books/featured` matches `/books/:id` first and `getBook` receives `req.params.id === 'featured'`.

### Async handlers need no wrapper

This is the biggest day-to-day change in Express 5: **a handler that returns a rejected promise is routed to your error middleware automatically**, exactly as if it had called `next(err)`.

```js title="src/routes/books.js"
app.get('/books/:id', async (req, res) => {
  const book = await books.findById(req.params.id)   // may reject
  if (!book) throw new NotFoundError('book not found')
  res.json(book)
})
```

No `try/catch`, no `.catch(next)`, and no `asyncHandler()` helper. In Express 4 the router ignored the handler's return value, so a rejection became an unhandled promise rejection that crashed the process — which is the only reason those wrappers ever existed. In Express 5 they are dead weight: they add a stack frame, obscure the handler signature, and do nothing the router does not already do.

:::deprecated
The `express-async-handler` package exists solely to work around the Express 4 behavior described above. On Express 5 it is unnecessary — remove it from `package.json` and unwrap the handlers.
:::

:::warning
The automatic forwarding covers the promise the handler *returns*. It does not cover work you start and forget — a `setTimeout` callback, an event listener, or a stream `'error'` event. Those still need their own handling:

```js
import { pipeline } from 'node:stream/promises'

app.get('/report.csv', async (req, res) => {
  // awaited, so a stream error rejects here and Express catches it
  await pipeline(buildReportStream(), res)
})
```
:::

## Common patterns

### Multiple handlers on one route

Handlers can be passed as extra arguments or as an array. Each one runs in order until something responds.

```js
app.post('/books', requireAuth, validateBody(bookSchema), createBook)
```

That reads as a pipeline: authenticate, validate, act. Anything shared by several routes belongs here rather than repeated inside each controller.

### `app.route()` for one path, many methods

```js
app.route('/books/:id')
  .get(getBook)
  .put(replaceBook)
  .patch(updateBook)
  .delete(deleteBook)
```

The path is written once, so a typo cannot make `PUT` and `PATCH` disagree about where they live.

### `next('route')` to bail out of a route

Inside a route handler, `next('route')` skips the remaining handlers *of that route* and resumes matching at the next route. It only works in handlers registered with a method helper, not in `app.use()` middleware.

```js
app.get('/books/:id',
  (req, res, next) => {
    // Numeric ids are handled here; anything else falls through to the slug route.
    if (!/^\d+$/.test(req.params.id)) return next('route')
    next()
  },
  getBookById,
)

app.get('/books/:slug', getBookBySlug)
```

### Terminal 404 and error handlers, registered last

```js
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

app.use((err, req, res, next) => {
  // four arguments = error handler
})
```

Both are ordinary layers, which is why they must be registered after every route: the stack is walked top-down, so a 404 handler registered early would swallow everything below it.

### Method not allowed

Express answers an unmatched method with a 404, not a 405. If you need the stricter behavior — mostly for public APIs held to a spec — add it explicitly per path:

```js
app.route('/books/:id')
  .get(getBook)
  .delete(deleteBook)
  .all((req, res) => {
    res.set('Allow', 'GET, DELETE').sendStatus(405)
  })
```

### Case and trailing slashes

By default routing is case-insensitive and a trailing slash is ignored, so `/Books` and `/books/` both hit `/books`. Two app settings change that:

| Setting | Default | Effect when enabled |
| --- | --- | --- |
| `app.set('case sensitive routing', true)` | off | `/Books` no longer matches `/books` |
| `app.set('strict routing', true)` | off | `/books/` no longer matches `/books` |

Leave both off unless you have a reason. Turning on strict routing without also emitting canonical URLs everywhere produces avoidable 404s.

:::tip
`app.router` is back in Express 5 as a reference to the app's base router. It is handy for introspection, but wire your routes with [routers](routers-and-modularity.md) rather than poking at the stack.
:::

## Common mistakes

- **Registering a parameterized path before a literal one.** `/books/:id` registered first shadows `/books/featured`. Literal paths go above parameterized paths.
- **Adding an async wrapper.** A hand-rolled `asyncHandler()` solves an Express 4 problem. On Express 5 it is pure noise — delete it when you upgrade.
- **Responding twice.** Calling `next()` after `res.json()` continues the walk; the next handler that responds throws `ERR_HTTP_HEADERS_SENT`. Always `return res.json(...)` or `return next()`.
- **Putting the 404 handler before the routes.** It is just another layer; anything registered after it is unreachable.
- **Expecting a 405.** Express sends 404 for a path that exists under a different method unless you add an `.all()` fallback.
- **Assuming `next('route')` works inside `app.use()`.** It only has meaning inside a method-based route's handler chain; from middleware, use `next('router')` to leave the current router.
- **Doing real work in the route file.** A route file should read as a table of contents. Business logic belongs in a service — see [Layered architecture](layered-architecture.md).

## Related topics

- [Route parameters and path syntax](route-parameters-and-path-syntax.md) — what may legally appear in a path string in Express 5.
- [Middleware](middleware.md) — the other kind of layer on the same stack.
- [Routers and modularity](routers-and-modularity.md) — splitting this file up before it reaches a thousand lines.
- [Error handling](error-handling.md) — where a thrown or rejected handler ends up.
- [Request and response](request-and-response.md) — the objects every handler receives.
- [Validation](../express-libraries/validation.md) — the `validateBody` middleware sketched above, for real.
- [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) — the removed method aliases and signature changes.
