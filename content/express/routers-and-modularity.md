---
title: Routers and modularity
description: Splitting an Express 5 app into mountable routers, and how mount paths, mergeParams and router-scoped middleware behave.
status: current
updated: 2026-09-08
---

`express.Router()` creates a mini-application: it has its own middleware stack, its own routes, and its own `param` handlers, but no server and no settings. Mounting one with `app.use(path, router)` grafts that stack into the parent at a prefix. This is how an Express app stays readable past a few hundred lines.

## Why it exists

Two problems appear as soon as an app grows. Route files get long enough that nobody reads them, and cross-cutting rules ("everything under `/admin` needs a role check") end up copy-pasted onto individual routes where the next person will forget them.

A router solves both. The prefix is written once at the mount point, the guard is written once at the top of the router, and every route added later inherits it by construction.

## Basic example

```js title="src/routes/books.js"
import express from 'express'
import * as controller from '../controllers/books.js'

const router = express.Router()

router.get('/', controller.list)
router.post('/', controller.create)
router.get('/:id', controller.get)
router.patch('/:id', controller.update)
router.delete('/:id', controller.remove)

export default router
```

```js title="src/routes/index.js"
import express from 'express'
import booksRouter from './books.js'
import authorsRouter from './authors.js'

const router = express.Router()

router.use('/books', booksRouter)
router.use('/authors', authorsRouter)

export default router
```

```js title="src/app.js"
import apiRouter from './routes/index.js'

app.use('/api/v1', apiRouter)
```

`GET /api/v1/books/42` now reaches `controller.get`. Notice that `books.js` never mentions `/books` or `/api/v1` — it describes a resource, and the mount points describe where that resource lives. Moving the whole API to `/api/v2` is a one-line change.

## How it works

A router is itself middleware. `app.use('/api/v1', apiRouter)` pushes one layer onto the app's stack; when that layer matches, Express strips the prefix from `req.url` and walks the router's own stack.

That prefix-stripping is why routers compose. Inside `booksRouter`, `req.url` is `/42`, so the router can be written as if it were the whole app. The original stays available:

```js
router.get('/:id', (req, res) => {
  req.originalUrl   // '/api/v1/books/42'
  req.baseUrl       // '/api/v1/books'
  req.path          // '/42'
  res.json({ self: `${req.baseUrl}/${req.params.id}` })
})
```

Build links from `req.baseUrl` rather than a hard-coded string, so a remount does not break every `Location` header and `rel="next"` link in the API.

### Router-scoped middleware

```js title="src/routes/admin.js"
const router = express.Router()

router.use(requireAuth)
router.use(requireRole('admin'))

router.get('/users', listUsers)
router.post('/users/:id/suspend', suspendUser)

export default router
```

Everything below those two `use` calls is guarded. A route added in six months is guarded too — which is the actual security argument for routers over per-route guards.

Order inside a router follows the same top-down rule as the app. Middleware registered after a route does not run for it.

### `mergeParams` — inheriting the parent's params

By default a router only sees the parameters matched by *its own* paths. Nest a router under a parameterized prefix and the parent's params are missing:

```js title="src/routes/reviews.js"
// Mounted at /books/:bookId/reviews
const router = express.Router({ mergeParams: true })

router.get('/', (req, res) => {
  res.json(listReviews(req.params.bookId))   // undefined without mergeParams
})

export default router
```

```js title="src/routes/books.js"
router.use('/:bookId/reviews', reviewsRouter)
```

`mergeParams: true` copies the parent's `req.params` into the child's. On a name collision the child wins, so avoid reusing a parameter name across nesting levels — `:id` at both levels is a bug waiting to happen. Name them `:bookId` and `:reviewId`.

### Router options

| Option | Default | Effect |
| --- | --- | --- |
| `mergeParams` | `false` | inherit `req.params` from the parent |
| `caseSensitive` | `false` | `/Books` stops matching `/books` |
| `strict` | `false` | `/books/` stops matching `/books` |

A router does not inherit the app's `case sensitive routing` or `strict routing` settings — pass the options explicitly if you rely on them.

### `router.param()`

Parameter middleware is scoped to the router that declares it, which is exactly where an entity lookup belongs:

```js title="src/routes/books.js"
router.param('id', async (req, res, next, id) => {
  const book = await books.findById(id)
  if (!book) return next(new NotFoundError('book not found'))
  req.book = book
  next()
})

router.get('/:id', (req, res) => res.json(req.book))
router.patch('/:id', (req, res) => res.json(update(req.book, req.body)))
```

The one-argument form and the array-of-names form of `router.param` were both removed in Express 5 — call it once per name. (`app.param()` still accepts an array.)

### Leaving a router early with `next('router')`

```js
apiRouter.use((req, res, next) => {
  if (!req.get('x-api-key')) return next('router')   // hand back to the parent
  next()
})
```

`next('router')` abandons the current router entirely and resumes in the parent stack, which is how a router declines a request rather than rejecting it. `next('route')`, by contrast, only skips the remaining handlers of the current route.

## Common patterns

### Feature folders

Group by layer while the app is small; group by feature once you have more than a handful of resources:

```text
src/
├─ app.js
├─ routes/index.js          # mounts every feature router
└─ features/
   ├─ books/
   │  ├─ books.routes.js
   │  ├─ books.controller.js
   │  ├─ books.service.js
   │  └─ books.repository.js
   └─ authors/
      └─ …
```

The router file is the feature's public interface: reading it tells you every URL the feature owns. See [Layered architecture](layered-architecture.md) for what belongs in the other three files.

### Versioning by mount point

```js
app.use('/api/v1', v1Router)
app.use('/api/v2', v2Router)
```

Because routers carry no prefix of their own, v2 can reuse v1's routers for the endpoints that did not change and swap only the ones that did.

### A router factory for dependencies

If you inject dependencies rather than importing singletons, export a factory:

```js title="src/features/books/books.routes.js"
export function createBooksRouter({ bookService }) {
  const router = express.Router()
  router.get('/', async (req, res) => res.json(await bookService.list(req.query)))
  return router
}
```

Tests then mount the router with a fake service and no database.

### Router-level error handlers

A router may have its own four-argument handler, useful when one subtree needs a different response shape (HTML for a web section, JSON for the API):

```js
htmlRouter.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  res.status(err.statusCode ?? 500).render('error', { message: err.message })
})
```

Anything it passes to `next(err)` continues to the app-level handler, so keep one global handler as the backstop.

## Common mistakes

- **Repeating the prefix inside the router.** Writing `router.get('/books/:id')` and mounting at `/books` gives you `/books/books/:id`. The router owns the paths *below* its mount point.
- **Forgetting `mergeParams`** on a nested router, then debugging why `req.params.bookId` is `undefined`.
- **Reusing `:id` at two nesting levels.** With `mergeParams` the inner value shadows the outer one, silently.
- **Registering `router.use(guard)` after the routes.** Only routes below it are protected.
- **Building URLs from a hard-coded prefix.** Use `req.baseUrl` so a remount does not break every generated link.
- **Expecting a router to inherit `strict routing` or `case sensitive routing`** from the app. Pass the options to `express.Router()`.
- **Using the removed `router.param` array form.** One call per parameter name in Express 5.
- **Mounting a router with `app.use(router)` when you meant `app.use(path, router)`.** Without a path it matches everything, and the first route inside it that matches wins regardless of the resource it was written for.

## Related topics

- [Routing](routing.md) — the matching rules a router inherits.
- [Middleware](middleware.md) — `req.baseUrl`, `req.originalUrl` and `next('router')`.
- [Route parameters and path syntax](route-parameters-and-path-syntax.md) — parameter naming, which nesting makes matter.
- [Layered architecture](layered-architecture.md) — what lives beside the router file in a feature folder.
- [Error handling](error-handling.md) — router-level versus app-level error handlers.
- [Setup and project structure](setup-and-project-structure.md) — where `routes/` sits in the tree.
- [API documentation](../express-libraries/api-documentation.md) — generating a spec from routers.
- [Testing](../express-libraries/testing.md) — mounting one router with fake dependencies.
