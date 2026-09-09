---
title: Express 4 → 5 migration
description: The complete Express 4 to Express 5 upgrade reference — every removed API, every changed behavior, the official codemods, and a step-by-step procedure.
status: legacy
updated: 2026-09-08
---

Express `5.2.1` is the current release; `express@4` (4.22.2) is still published but is legacy here. This page is the only place on the site where Express 4 APIs appear — everywhere else the build fails on them. Work through it top to bottom when you upgrade: removals first (they throw or 404), then changed behavior (it silently does something different), then the procedure and the done-checklist at the end.

:::note
Facts on this page were verified on 2026-09-08 against the official [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html) and the npm registry.
:::

## Before you start

| Thing | Value |
| --- | --- |
| Current Express | `5.2.1` (published 2025-12-01) |
| Last Express 4 | `4.22.2` |
| Express 5 `engines.node` | `>= 18` |
| Node this handbook targets | **24 LTS** (`24.20.0`) |
| Router / path matcher | `router` package, `path-to-regexp@8` |
| Types | `@types/express@5.0.6` |

`express@5.2.1` only *requires* Node 18, but Node 18 and Node 20 are both end-of-life. Upgrade Express and Node in the same change if you can, and land on Node 24 LTS — see [Prerequisites](../getting-started/prerequisites.md).

`body-parser` is bundled. If your Express 4 app installed it separately, delete the dependency and use `express.json()`, `express.urlencoded()`, `express.text()` and `express.raw()`.

:::tabs
@tab npm
```bash
npm install express@5
```
@tab pnpm
```bash
pnpm add express@5
```
@tab yarn
```bash
yarn add express@5
```
:::

## Run the official codemods first

Express publishes codemods that mechanically apply most of the removals below. Run the umbrella recipe, commit the result on its own, then read the rest of this page for what a codemod cannot see.

```bash
npx codemod@latest @expressjs/v5-migration-recipe
```

The individual codemods, if you want to apply them one at a time:

| Codemod | What it rewrites |
| --- | --- |
| `@expressjs/route-del-to-delete` | `app.del()` → `app.delete()` |
| `@expressjs/pluralize-method-names` | singular `accepts*` request methods → plural |
| `@expressjs/explicit-request-params` | `req.param(name)` → `req.params` / `req.body` / `req.query` |
| `@expressjs/status-send-order` | `res.send`/`res.json`/`res.jsonp` status-argument forms |
| `@expressjs/redirect-arg-order` | `res.redirect(url, status)` → `res.redirect(status, url)` |
| `@expressjs/back-redirect-deprecated` | the `'back'` magic string |
| `@expressjs/camelcase-sendfile` | `res.sendfile()` → `res.sendFile()` |
| `@expressjs/sendfile-options` | `res.sendFile()` `hidden`/`from` options |
| `@expressjs/static-dotfiles` | `express.static()` dotfile options |
| `@expressjs/static-mime` | `express.static.mime` → `mime-types` |

:::warning
Codemods do not touch route path strings, do not remove async wrappers, and cannot know whether your app relied on `req.body` being `{}`. Those four are the changes that actually break production, and they are all manual.
:::

## Removed APIs

Everything in this section throws, 404s, or silently no-ops on Express 5.

| Removed | Replacement |
| --- | --- |
| `app.del()` | `app.delete()` |
| `app.param(fn)` (one-arg form) | `app.param(name, fn)` |
| leading `:` in `app.param(':name', fn)` | `app.param('name', fn)` |
| `req.acceptsCharset/Encoding/Language()` | `req.acceptsCharsets/Encodings/Languages()` |
| `req.param(name)` | read `req.params` / `req.body` / `req.query` explicitly |
| `res.json(obj, status)` | `res.status(status).json(obj)` |
| `res.jsonp(obj, status)` | `res.status(status).jsonp(obj)` |
| `res.send(body, status)` | `res.status(status).send(body)` |
| `res.send(status)` (a number) | `res.sendStatus(status)` |
| `res.redirect(url, status)` | `res.redirect(status, url)` — **order flipped** |
| `res.redirect('back')`, `res.location('back')` | `res.redirect(req.get('Referrer') ?? '/')` |
| `res.sendfile()` | `res.sendFile()` |
| `hidden` / `from` options | `dotfiles` / `root` |
| `express.static.mime` | the `mime-types` package |
| `router.param(fn)` | `router.param(name, fn)` |
| `router.param([names], fn)` | one `router.param(name, fn)` per name |

### `app.del()`

`delete` is a valid property name in modern JavaScript, so the alias has no reason to exist.

:::deprecated Express 4 — removed in Express 5
```js
app.del('/users/:id', (req, res) => {
  res.send(`DELETE /users/${req.params.id}`)
})
```
:::

```js good
app.delete('/users/:id', (req, res) => {
  res.send(`DELETE /users/${req.params.id}`)
})
```

Codemod: `@expressjs/route-del-to-delete`.

### `app.param(fn)`

The one-argument form let you replace how `app.param()` itself worked. It was deprecated in 4.11.0 and is gone.

:::deprecated Express 4 — removed in Express 5
```js
// One-arg form: a factory that customized param handling globally.
app.param((name, fn) => (req, res, next, value) => {
  if (fn(value)) return next()
  next('route')
})
```
:::

```js good
// Express 5: one named param handler, one name.
app.param('bookId', async (req, res, next, id) => {
  const book = await books.findById(id)
  if (!book) return next(new NotFoundError('book not found'))
  req.book = book
  next()
})
```

See [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) for how `app.param()` fits into a request.

### The leading colon in `app.param(':name', fn)`

An Express 3 remnant. Express 4 accepted it with a deprecation notice; Express 5 **silently ignores the colon** and uses the bare name. Nothing breaks, but the spelling is wrong and it hides intent — fix it while you are here.

:::legacy Express 4 — colon accepted with a deprecation notice
```js
app.param(':bookId', (req, res, next, id) => next())
```
:::

```js good
app.param('bookId', (req, res, next, id) => next())
```

### `req.acceptsCharset()` / `acceptsEncoding()` / `acceptsLanguage()`

All three are now plural, matching `req.accepts()`'s siblings.

:::deprecated Express 4 — removed in Express 5
```js
app.get('/report', (req, res) => {
  if (!req.acceptsCharset('utf-8')) return res.sendStatus(406)
  const enc = req.acceptsEncoding(['br', 'gzip'])
  const lang = req.acceptsLanguage(['en', 'fr'])
  res.json({ enc, lang })
})
```
:::

```js good
app.get('/report', (req, res) => {
  if (!req.acceptsCharsets('utf-8')) return res.sendStatus(406)
  const enc = req.acceptsEncodings(['br', 'gzip'])
  const lang = req.acceptsLanguages(['en', 'fr'])
  res.json({ enc, lang })
})
```

Codemod: `@expressjs/pluralize-method-names`.

### `req.param(name)`

It searched `req.params`, then `req.body`, then `req.query`, in that order. That is a security problem as much as a clarity one: a query string could shadow a route parameter and change what your handler authorized against.

:::deprecated Express 4 — removed in Express 5
```js
app.post('/users/:id', (req, res) => {
  const id = req.param('id')        // params? body? query? who knows
  const role = req.param('role')    // an attacker can supply ?role=admin
  res.json({ id, role })
})
```
:::

```js good
app.post('/users/:id', (req, res) => {
  const id = req.params.id
  const role = req.body?.role
  res.json({ id, role })
})
```

Codemod: `@expressjs/explicit-request-params`. Related reading: [Mass assignment](../security/mass-assignment.md).

### `res.json(obj, status)` and `res.jsonp(obj, status)`

:::deprecated Express 4 — removed in Express 5
```js
res.json({ id: 1 }, 201)
res.jsonp({ id: 1 }, 201)
```
:::

```js good
res.status(201).json({ id: 1 })
res.status(201).jsonp({ id: 1 })
```

Codemod: `@expressjs/status-send-order`.

### `res.send(body, status)` and `res.send(status)`

Two separate removals with the same cause: overloading the argument list by type.

:::deprecated Express 4 — removed in Express 5
```js
res.send({ ok: true }, 200)   // body + status
res.send(404)                 // a bare number meant "status"
```
:::

```js good
res.status(200).send({ ok: true })
res.sendStatus(404)           // sends the status and its text body
res.send('404')               // if you actually wanted the string "404"
```

Codemod: `@expressjs/status-send-order`.

### `res.redirect(url, status)` — the argument order flipped

This one is dangerous because the old call does not throw a helpful error; it just does the wrong thing.

:::deprecated Express 4 — removed in Express 5
```js
res.redirect('/users', 301)
```
:::

```js good
res.redirect(301, '/users')

// Unchanged: the single-argument form still defaults to 302.
res.redirect('/dashboard')
```

Codemod: `@expressjs/redirect-arg-order`.

### `res.redirect('back')` and `res.location('back')`

The `'back'` magic string is gone. Express 5 treats it as a literal path, so you would redirect to `/back`.

:::deprecated Express 4 — removed in Express 5
```js
app.post('/comments', (req, res) => {
  saveComment(req.body)
  res.redirect('back')
})
```
:::

```js good
app.post('/comments', async (req, res) => {
  await saveComment(req.body)
  res.redirect(req.get('Referrer') ?? '/')
})
```

:::danger
`Referrer` is attacker-controlled. Redirecting to it unchecked is an open redirect. Accept it only if it is same-origin, otherwise fall back to a fixed path:

```js
function safeBack(req) {
  const ref = req.get('Referrer')
  if (!ref) return '/'
  try {
    const url = new URL(ref, `${req.protocol}://${req.get('host')}`)
    return url.host === req.get('host') ? url.pathname + url.search : '/'
  } catch {
    return '/'
  }
}
```
:::

Codemod: `@expressjs/back-redirect-deprecated`.

### `res.sendfile()`

Casing only.

:::deprecated Express 4 — removed in Express 5
```js
res.sendfile('/var/www/app/report.pdf')
```
:::

```js good
res.sendFile('report.pdf', { root: '/var/www/app' })
```

Codemod: `@expressjs/camelcase-sendfile`.

### The `hidden` and `from` options

`res.sendFile()` and `express.static()` both dropped `hidden` and `from`. `hidden: true` becomes `dotfiles: 'allow'`; `from` becomes `root`. The dotfile check now also applies to hidden **directories** anywhere in the path, not just the final filename.

:::deprecated Express 4 — removed in Express 5
```js
res.sendFile(req.params.name, { hidden: true, from: '/uploads' })
app.use(express.static('public', { hidden: true }))
```
:::

```js good
res.sendFile(req.params.name, { dotfiles: 'allow', root: '/uploads' })
app.use(express.static('public', { dotfiles: 'allow' }))

// A path containing a hidden directory now needs the opt-in too:
res.sendFile('/var/www/app/.cache/index.html', { dotfiles: 'allow' })
// …or move the dot-segment into root, where it is not checked:
res.sendFile('index.html', { root: '/var/www/app/.cache' })
```

Codemods: `@expressjs/sendfile-options`, `@expressjs/static-dotfiles`. The **default** for `dotfiles` also changed — see "Changed behavior" below.

### `router.param(fn)` and `router.param([names], fn)`

The one-argument form is removed, and `router.param()` no longer accepts an array of names — it throws `TypeError: argument name must be a string`. `app.param()` **does** still accept an array.

:::deprecated Express 4 — removed in Express 5
```js
router.param(['id', 'page'], (req, res, next, value) => {
  req.value = Number(value)
  next()
})
```
:::

```js good
const toNumber = (req, res, next, value) => {
  req.value = Number(value)
  next()
}

router.param('id', toNumber)
router.param('page', toNumber)

// app.param() still takes an array:
app.param(['id', 'page'], toNumber)
```

### `express.static.mime`

The re-export is gone. Install `mime-types` directly.

:::deprecated Express 4 — removed in Express 5
```js
const type = express.static.mime.lookup('report.json')
```
:::

```bash
npm install mime-types
```

```js good
import mime from 'mime-types'

const type = mime.lookup('report.json') // 'application/json'
```

Codemod: `@expressjs/static-mime`.

## Changed behavior

Nothing here throws a "you used a removed API" error. These are the changes that pass your build and fail in production.

### Route path syntax (path-to-regexp v8)

Express 5 compiles path strings with `path-to-regexp@8`. The grammar is much smaller, and invalid patterns throw at **registration time** — the process dies at boot rather than serving a broken route.

| Express 4 pattern | Express 5 equivalent | Note |
| --- | --- | --- |
| `'/*'` | `'/*splat'` | named wildcard; does **not** match `/` |
| `'/*'` (catch-all incl. root) | `'/{*splat}'` | the group makes it optional, so `/` matches |
| `'/files/*'` | `'/files/*path'` | `req.params.path` is an **array** |
| `'/:file.:ext?'` | `'/:file{.:ext}'` | `?` is reserved; the group is the optional unit |
| `'/books/:id?'` | `'/books{/:id}'` | the slash goes **inside** the group |
| `'/:foo+'` | `'/*foo'` | one or more segments |
| `'/:foo*'` | `'{/*foo}'` | zero or more segments |
| `'/[a\|b]/:slug'` | `['/a/:slug', '/b/:slug']` | pass an array of paths |
| `'/product/(\\d+)'` | a real `RegExp`, or validate in the handler | inline regex groups are gone |
| `'/users/:user-id'` | `'/users/:"user-id"'` | names must be JS identifiers, or quoted |

`(`, `)`, `[`, `]`, `?`, `+` and `!` are **reserved**. To match one literally, escape it with a backslash (`'\\('` in a JavaScript string literal).

:::legacy Express 4 — these all throw on Express 5
```js
app.get('/*', handler)                       // Missing parameter name
app.get('/:file.:ext?', handler)             // Unexpected ? …
app.get('/[discussion|page]/:slug', handler) // Unexpected [ …
app.get('/reports/(draft)', handler)         // Unexpected ( …
app.get('/users/:user-id', handler)          // invalid parameter name
```
:::

```js good
app.get('/{*splat}', handler)                       // true catch-all, root included
app.get('/:file{.:ext}', handler)                   // optional extension
app.get(['/discussion/:slug', '/page/:slug'], handler)
app.get('/reports/\\(draft\\)', handler)            // escaped literal parens
app.get('/users/:"user-id"', handler)               // quoted parameter name
```

The error you get for a bad pattern looks like this, and always ends with the same URL:

```text
TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError
```

Full grammar and every failure mode: [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md).

### Rejected promises are forwarded automatically

An `async` handler that throws, or that awaits a rejected promise, now reaches your error middleware exactly as if you had called `next(err)`. This is the single biggest quality-of-life change in Express 5 — and it means the wrappers you installed for Express 4 are now dead weight.

:::legacy Express 4 — a rejection here crashed the process or hung the request
```js
// Manual .catch(next)
app.get('/users/:id', (req, res, next) => {
  getUserById(req.params.id)
    .then((user) => res.json(user))
    .catch(next)
})

// Or the wrapper package
import asyncHandler from 'express-async-handler'

app.get('/users/:id', asyncHandler(async (req, res) => {
  res.json(await getUserById(req.params.id))
}))
```
:::

```js good
// Express 5: nothing to wrap.
app.get('/users/:id', async (req, res) => {
  const user = await getUserById(req.params.id)
  if (!user) throw new NotFoundError('user not found')
  res.json(user)
})
```

**Delete the wrappers.** The diff you are aiming for:

```text
- import asyncHandler from 'express-async-handler'
-
- app.get('/users/:id', asyncHandler(async (req, res) => {
+ app.get('/users/:id', async (req, res) => {
    const user = await getUserById(req.params.id)
    res.json(user)
- }))
+ })
```

:::legacy Remove the dependency too
```bash
npm uninstall express-async-handler
```
:::

:::warning
This does **not** mean every `.catch(next)` is wrong. A rejection inside a *non-async* callback — a stream `'error'` listener, a `setTimeout` body, an event emitter handler — is still invisible to Express, because it happens after your handler returned. Keep `next(err)` there.

```js
app.get('/download/:id', (req, res, next) => {
  const stream = createReadStream(pathFor(req.params.id))
  stream.on('error', next)   // still required
  stream.pipe(res)
})
```
:::

See [Error handling](../express/error-handling.md) for where these errors land.

### `express.urlencoded()` defaults to `extended: false`

Express 4 warned you to pass `extended` explicitly; Express 5 picks `false`, which uses the simple query parser. Nested bracket syntax (`a[b]=1`) stops producing nested objects.

:::legacy Express 4 — implicit extended: true
```js
app.use(express.urlencoded())
// 'user[name]=ada' → { user: { name: 'ada' } }
```
:::

```js good
// Express 5 default: 'user[name]=ada' → { 'user[name]': 'ada' }
app.use(express.urlencoded({ limit: '100kb' }))

// Opt back in only if a form really posts nested keys:
app.use(express.urlencoded({ extended: true, limit: '100kb' }))
```

### `express.static()` defaults to `dotfiles: 'ignore'`

The default flipped, and the check now applies to hidden **directories** in the path. The classic casualty is ACME/Let's Encrypt HTTP-01 validation and every other `/.well-known/` resource: it returns **404** after the upgrade, and your certificate renewal fails.

:::legacy Express 4 — /.well-known/ was served
```js
app.use(express.static('public'))
// GET /.well-known/acme-challenge/TOKEN → 200
```
:::

```js good
// Express 5: mount the dot-directory explicitly, first.
app.use('/.well-known', express.static('public/.well-known', { dotfiles: 'allow' }))
app.use(express.static('public'))
```

Mount the specific path rather than setting `dotfiles: 'allow'` on the whole tree — a blanket allow also exposes a stray `.env` or `.git` that ends up in the served directory.

Verify with:

```bash
curl -i http://localhost:3000/.well-known/acme-challenge/test
```

More: [Static files](../express/static-files.md), [Secrets management](../security/secrets-management.md).

### `req.body` is `undefined`, not `{}`

Express 4 gave you `{}` when no body parser ran. Express 5 leaves it `undefined`, so every unguarded destructure throws `TypeError: Cannot read properties of undefined`.

:::legacy Express 4 — this was safe even with no parser mounted
```js
app.post('/users', (req, res) => {
  const { name } = req.body      // {} in Express 4
  res.json({ name })
})
```
:::

```js good
app.use(express.json({ limit: '100kb' }))

app.post('/users', (req, res) => {
  const { name } = req.body ?? {}
  if (!name) return res.status(400).json({ error: 'name is required' })
  res.status(201).json({ name })
})
```

Note that a parser only populates `req.body` for a matching `Content-Type`. `express.json()` with a `text/plain` request leaves `req.body` `undefined` even though the parser is mounted. Schema validation at the edge ([Validation](../express-libraries/validation.md)) handles both cases in one place.

### `req.host` now includes the port

Express 4 stripped the port from `req.host`, which made it a confusing duplicate of `req.hostname`. Express 5 returns the real `Host` header value.

:::legacy Express 4
```js
// Host: example.com:8080
req.host      // 'example.com'
req.hostname  // 'example.com'
```
:::

```js good
// Host: example.com:8080  (Express 5)
req.host      // 'example.com:8080'
req.hostname  // 'example.com'
```

Anything comparing `req.host` against an allow-list of bare hostnames must switch to `req.hostname`.

### `req.params`: null prototype, arrays, omissions

Three changes at once.

:::legacy Express 4
```js
app.get('/*', (req, res) => {
  // GET /
  console.dir(req.params)          // { '0': '' }
})

app.get('/:file.:ext?', (req, res) => {
  // GET /image
  console.dir(req.params)          // { file: 'image', ext: undefined }
})
```
:::

```js good
app.get('/{*splat}', (req, res) => {
  // GET /foo/bar
  console.dir(req.params)
  // [Object: null prototype] { splat: [ 'foo', 'bar' ] }
  // GET /  →  [Object: null prototype] {}   (omitted, not '')
  res.end()
})

app.get('/:file{.:ext}', (req, res) => {
  // GET /image → [Object: null prototype] { file: 'image' }  (no `ext` key)
  console.dir(req.params)
  res.end()
})
```

- **Null prototype** for string paths: `req.params.hasOwnProperty(...)` throws. Use `Object.hasOwn(req.params, 'id')`. A `RegExp` path still yields an ordinary object.
- **Wildcards are arrays**: join them yourself (`req.params.splat.join('/')`), and never hand the result to the filesystem without a containment check.
- **Unmatched params are omitted** entirely, so `'id' in req.params` is `false` and `Object.keys(req.params).length` is `0`.

### `req.query` is a getter, and the default parser changed

`req.query` is no longer writable — assigning to it, or to a key on it, fails. The default query parser also changed from `'extended'` to `'simple'`, so bracket and nested syntax no longer produces nested objects.

:::legacy Express 4 — mutating req.query was a common sanitization trick
```js
app.use((req, res, next) => {
  req.query.page = Number(req.query.page) || 1   // no longer possible
  next()
})
```
:::

```js good
// Put the normalized values somewhere you own.
app.use((req, res, next) => {
  req.parsed = { page: Number(req.query.page) || 1 }
  next()
})

// Opt back into the old parser only if you need a[b]=c nesting:
app.set('query parser', 'extended')
```

### `res.clearCookie()` ignores `maxAge` and `expires`

Both options are dropped, because the browser rule for clearing a cookie is that name, `path`, `domain`, `secure` and `sameSite` must match the cookie that set it. Only those matter.

:::legacy Express 4
```js
res.clearCookie('sid', { maxAge: 0, expires: new Date(0) })
```
:::

```js good
res.clearCookie('sid', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' })
```

More: [Cookies](../express-libraries/cookies.md).

### `res.status()` accepts only 100–999

Anything else — a non-integer, `0`, `99`, `1000`, a string — throws instead of writing a nonsense status line.

:::legacy Express 4 — accepted silently
```js
res.status(err.statusCode).send()   // err.statusCode was undefined → 'undefined'
```
:::

```js good
res.status(Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500).json({ error: 'Internal Server Error' })
```

This bites most often in a generic error handler, where `err.status` is frequently `undefined`. Default it before you pass it in — see [Error handling](../express/error-handling.md).

### `res.vary()` throws on a missing argument

Express 4 printed a console warning. Express 5 throws.

:::legacy Express 4 — warned
```js
res.vary()
```
:::

```js good
res.vary('Accept-Encoding')
```

### `app.listen()` passes errors to the callback

A server `'error'` (typically `EADDRINUSE`) now reaches the listen callback as its first argument instead of being thrown.

:::legacy Express 4
```js
app.listen(3000, () => console.log('listening'))
// EADDRINUSE surfaced as an uncaught 'error' event
```
:::

```js good
const server = app.listen(3000, '0.0.0.0', (err) => {
  if (err) throw err
  console.log(`listening on ${JSON.stringify(server.address())}`)
})
```

If your callback ignores its arguments, a port clash now looks like a server that started and then does nothing. Always check `err`.

### `app.router` is back

`app.router` exists again and returns a reference to the base router. Unlike Express 3, you do not have to load it explicitly; unlike Express 4, reading it is no longer an error that tells you to remove it.

### `res.render()` is always asynchronous

Express 5 enforces async behavior for every view engine, even one whose implementation is synchronous. Code that relied on the callback having already run by the next line breaks.

:::legacy Express 4 — a synchronous engine could call back inline
```js
let html
res.render('page', { user }, (err, out) => { html = out })
console.log(html)   // sometimes defined in Express 4
```
:::

```js good
res.render('page', { user }, (err, out) => {
  if (err) return next(err)
  res.send(out)
})
```

More: [Templating](../express/templating.md).

### MIME type changes

Express 4 pinned `mime-db@1.52.0`; Express 5 uses a newer one. The visible change is that `.js` is now served as `text/javascript` instead of `application/javascript`. Tests that assert on `Content-Type` will fail.

```bash
curl -sI http://localhost:3000/app.js | grep -i content-type
# Express 4: application/javascript; charset=UTF-8
# Express 5: text/javascript; charset=UTF-8
```

MIME mappings can change in a minor or patch release of `mime-db`, so do not assert exact content types for static assets unless you have a reason to.

### Debug namespaces moved

Routing lives in the separate `router` package now, so `express:router*` no longer exists.

| Express 4 | Express 5 |
| --- | --- |
| `express:router` | `router` |
| `express:router:layer` | `router:layer` |
| `express:router:route` | `router:route` |

:::legacy Express 4
```bash
DEBUG=express:* node index.js
```
:::

```bash
DEBUG=express:*,router,router:* node index.js
```

## Improvements worth knowing

### Brotli request bodies

`express.json()`, `express.urlencoded()`, `express.text()` and `express.raw()` now decompress **Brotli** (`Content-Encoding: br`) request bodies in addition to `gzip` and `deflate`. No configuration needed.

```bash
printf '{"name":"ada"}' | brotli -c > body.br
curl -X POST http://localhost:3000/users \
  -H 'Content-Type: application/json' \
  -H 'Content-Encoding: br' \
  --data-binary @body.br
```

:::warning
A compressed body makes your `limit` option apply to the *decompressed* size, so a small `br` payload can still expand past it and return 413. Keep an explicit `limit` on every parser.
:::

## The migration procedure

1. **Upgrade Node first if you are below 24.** Node 18 and 20 are EOL. Get onto Node 24 LTS so you are not debugging two migrations at once.
2. **Install Express 5 and matching types.** `npm install express@5 && npm install -D @types/express@5` if you use TypeScript. Remove a separate `body-parser` dependency.
3. **Run the codemod recipe** — `npx codemod@latest @expressjs/v5-migration-recipe` — and commit it alone so the mechanical diff is reviewable.
4. **Boot the app.** Path-to-regexp errors throw at registration, so the process dies immediately with the offending pattern. Fix every path against the table above until it starts.
5. **Run the test suite.** Expect failures in three clusters: status/redirect argument order, `Content-Type` assertions on static assets, and anything asserting `req.body` is `{}`.
6. **Delete the async wrappers.** Remove `asyncHandler`-style wrappers and the `.catch(next)` tails on `async` handlers, then uninstall the package. Leave `next(err)` in non-async callbacks alone.
7. **Re-check static file serving.** Curl `/.well-known/...` and anything else under a dot-directory. Add the explicit mount if it 404s.
8. **Add `req.body` guards.** Every handler that destructures `req.body` needs `?? {}`, a validation middleware, or a parser guaranteed to have matched.
9. **Grep for the silent ones.** `req.host`, `req.query` assignment, `res.clearCookie` options, `res.vary()`, and `app.listen` callbacks that ignore their first argument.
10. **Run behind your real proxy and TLS setup** before you ship — see [Deployment checklist](../production/deployment-checklist.md).

## You are done when

Tick every line before you call the upgrade finished.

- The app boots on Node 24 with `express@5.2.1` and no `path-to-regexp` error.
- No route string contains a bare `*`, a `?` after a `:param`, or an unescaped `(`, `)`, `[`, `]`, `+` or `!`.
- The removed-API grep is clean:

  ```bash
  grep -rnE "app\.del\(|req\.param\(|res\.sendfile\(|express\.static\.mime|acceptsCharset\(|acceptsEncoding\(|acceptsLanguage\(|redirect\('back'\)|location\('back'\)" src/
  ```

- Every two-argument `res.redirect(` puts the status first.
- No async wrapper package is installed, and no `async` route handler ends in `.catch(next)`.
- `body-parser` is not a dependency.
- Every `express.json()` / `express.urlencoded()` call has an explicit `limit`.
- `curl -i /.well-known/acme-challenge/test` returns something other than 404 if you use ACME.
- Every handler that reads `req.body` tolerates `undefined`.
- Every `app.listen()` callback checks its error argument.
- Host allow-lists use `req.hostname`, not `req.host`.
- The test suite passes, and a smoke test covers one route per HTTP method.

## Common mistakes

- **Trusting the codemods to finish the job.** They do not touch route path strings, async wrappers, `req.body` guards, or the `dotfiles` default — the four changes most likely to break production.
- **Flipping `res.redirect` arguments only where tests cover it.** The old order does not throw; it redirects to a URL named after a number. Grep for every `res.redirect(` with two arguments.
- **Setting `dotfiles: 'allow'` on the whole static root** to fix `/.well-known/`. That also serves `.env`, `.git` and editor backups if they ever land in the directory. Mount the dot-directory explicitly instead.
- **Leaving `.catch(next)` on `async` handlers** "just in case". It is now dead code that hides where errors actually flow, and reviewers copy it into new handlers.
- **Removing `next(err)` from stream and event callbacks.** Automatic forwarding only covers the promise your handler returns. A `'error'` event after you returned is still yours to handle.
- **Porting `'/*'` to `'/*splat'` for a catch-all.** That leaves `GET /` unmatched, which is invisible until someone hits the root. Use `'/{*splat}'`.
- **Assuming a mounted body parser means `req.body` exists.** A mismatched `Content-Type` leaves it `undefined`, parser or not.
- **Comparing `req.host` to a bare hostname** after the upgrade. It now carries the port, so the comparison silently fails and your host check passes nothing (or everything, depending on which way you wrote it).
- **Upgrading Express and staying on Node 18** because `engines` allows it. Node 18 is end-of-life and gets no security patches.

## Related topics

- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the full path-to-regexp v8 grammar, which is where most of the upgrade time goes.
- [Error handling](../express/error-handling.md) — where automatically forwarded rejections end up, and how to shape the response.
- [Middleware](../express/middleware.md) — ordering, and the built-in parsers that replaced `body-parser`.
- [Request and response](../express/request-and-response.md) — the current shape of `req.body`, `req.query`, `req.params` and `res`.
- [Static files](../express/static-files.md) — `dotfiles`, `root`, and serving a dot-directory safely.
- [Setup and project structure](../express/setup-and-project-structure.md) — the `app.js` / `server.js` split that makes the `app.listen` change easy to absorb.
- [Troubleshooting](troubleshooting.md) — the exact error strings this upgrade produces, by symptom.
- [Cheat sheet](cheat-sheet.md) — the Express 5 API surface on one page, once you are through.
- [Library index](library-index.md) — current versions for everything you touch during the upgrade.
