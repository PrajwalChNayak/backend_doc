---
title: Route parameters and path syntax
description: How Express 5 matches paths with path-to-regexp v8, what req.params contains, and every pattern that changed from Express 4.
status: current
updated: 2026-09-08
---

Express 5 compiles every string path with **path-to-regexp v8**, a stricter and much smaller grammar than the one Express 4 used. Patterns that used to be merely unusual now throw a `TypeError` at startup, and `req.params` itself behaves differently. This is the single most common source of breakage when moving to Express 5, so it is worth reading the grammar once rather than guessing.

## The grammar

A path string is literal text plus four special constructs.

| Construct | Meaning | Example | Matches |
| --- | --- | --- | --- |
| `:name` | one path segment, captured | `/books/:id` | `/books/42` |
| `*name` | one or more segments, captured as an **array** | `/files/*path` | `/files/a/b.txt` |
| `{ … }` | an optional group | `/books{/:id}` | `/books` and `/books/42` |
| `\` | escape the next character | `/prices/\$:amount` | `/prices/$10` |

Everything else is literal. A `:` or `*` starts a parameter; `(`, `)`, `[`, `]`, `?`, `+` and `!` are **reserved** and throw unless escaped with a backslash.

```js
// Literal parentheses in a path: escape them.
app.get('/reports/\\(draft\\)', handler)
```

In a JavaScript string literal the backslash itself must be escaped, hence `\\(`. Reading the path back with `console.log` shows the single backslash that path-to-regexp actually sees.

### Parameter names

A parameter name must be a valid JavaScript identifier: letters, digits, `_` and `$`, not starting with a digit. Anything else has to be quoted.

```js
app.get('/reports/:"report-id"', (req, res) => {
  res.json({ id: req.params['report-id'] })
})
```

Prefer plain identifiers. The quoted form exists so that URLs you do not control (a legacy path scheme, a vendor spec) can still be expressed; it is not a style choice.

### Optional segments and file extensions

There are no `?`, `+` or `*` suffix modifiers any more. Optionality is expressed by wrapping part of the path in a group:

```js
// Optional trailing id: matches /books and /books/42
app.get('/books{/:id}', (req, res) => {
  if (req.params.id === undefined) return res.json(listBooks())
  res.json(getBook(req.params.id))
})

// Optional extension: matches /avatar and /avatar.png
app.get('/:file{.:ext}', (req, res) => {
  res.json({ file: req.params.file, ext: req.params.ext ?? null })
})
```

The group is the whole optional unit — the `.` and the `:ext` together. Writing `'/:file.:ext?'` (the Express 4 spelling) throws, because `?` is now reserved.

### Wildcards and the root path

`*name` captures one or more segments. Whether it also matches the mount root depends on whether you wrap it:

| Path | Matches `/` | Matches `/a/b` | `req.params.splat` for `/a/b` |
| --- | --- | --- | --- |
| `'/*splat'` | no | yes | `['a', 'b']` |
| `'/{*splat}'` | yes | yes | `['a', 'b']` |

So a true catch-all — the 404 route, or a single-page-app fallback — is `'/{*splat}'`. Using `'/*splat'` for that leaves the site root unmatched, which is a subtle bug because every other URL works.

```js
// SPA fallback: serves index.html for any path the API did not claim.
app.get('/{*splat}', (req, res) => {
  res.sendFile('index.html', { root: 'public' })
})
```

### Several paths for one handler

Regex-in-a-string (`'/[discussion|page]/:slug'`) is gone. Pass an array instead — it is clearer and it is checked at startup.

```js
app.get(['/discussion/:slug', '/page/:slug'], (req, res) => {
  res.json({ slug: req.params.slug })
})
```

### Real regular expressions still work

If the grammar genuinely cannot express what you need, pass an actual `RegExp`. Express hands it to the matcher untouched.

```js
app.get(/^\/api\/v(\d+)\/status$/, (req, res) => {
  res.json({ version: Number(req.params[0]) })
})
```

Unnamed capture groups land on `req.params` under numeric keys, in order. Note the second difference: for a `RegExp` path `req.params` is an ordinary object with `Object.prototype`, whereas for a string path it has a **null prototype**. Code that calls `req.params.hasOwnProperty(...)` will therefore work on one route and throw on the other — another reason to use `Object.hasOwn()` everywhere.

## `req.params` in Express 5

```js
app.get('/users/:userId/files/*path', (req, res) => {
  console.log(Object.getPrototypeOf(req.params)) // null
  console.log(req.params)
  // GET /users/7/files/docs/q3.pdf
  // [Object: null prototype] { userId: '7', path: [ 'docs', 'q3.pdf' ] }
  res.end()
})
```

Three things to internalize:

- **Null prototype.** `req.params.hasOwnProperty`, `req.params.toString` and friends are `undefined`. This is deliberate — it makes `req.params.constructor` and `req.params.__proto__` safe to read from a URL. Use `Object.hasOwn(req.params, 'id')`, `'id' in req.params`, or spread it into a normal object before passing it around.
- **Wildcard params are arrays**, not slash-joined strings. Join them yourself when you need a path: `req.params.path.join('/')`. Never feed the joined value straight to the filesystem — see [Static files](static-files.md) for the traversal rules.
- **Unmatched params are omitted.** With `'/books{/:id}'` and a request to `/books`, `req.params` has no `id` key at all rather than `id: undefined`. `req.params.id` still reads as `undefined`, but `'id' in req.params` is `false` and `Object.keys(req.params)` is empty. Length-based or key-based checks must account for that.

Every value is a **string** (or an array of strings), URL-decoded. A path segment with broken percent-encoding — `GET /books/%E0%A4%A` — never reaches your handler: the router fails to decode it and produces a 400 response.

```js
app.get('/books/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }
  res.json({ id })
})
```

Coerce and validate at the edge. `Number('12abc')` is `NaN`, `Number('')` is `0`, and a database driver handed `'1 OR 1=1'` will do exactly what you fear if you ever interpolate it. Schema validation ([Validation](../express-libraries/validation.md)) is the scalable version of the check above.

### `app.param()` for shared lookups

`app.param(name, fn)` runs once per request for any route that has that parameter, before the route's handlers. It is the right place for "load this entity or 404".

```js
app.param('bookId', async (req, res, next, id) => {
  const book = await books.findById(id)
  if (!book) return next(new NotFoundError('book not found'))
  req.book = book
  next()
})

app.get('/books/:bookId', (req, res) => res.json(req.book))
app.delete('/books/:bookId', (req, res) => { /* req.book is loaded */ })
```

The one-argument form `app.param(fn)` was removed in Express 5, as was `router.param([names], fn)` with an array — call `router.param(name, fn)` once per name. `app.param()` itself still accepts an array of names.

## Express 4 → Express 5 pattern table

Every pattern in the left column throws at startup on Express 5.

| Express 4 pattern | Express 5 equivalent | Note |
| --- | --- | --- |
| `'/*'` | `'/{*splat}'` | also matches `/` |
| `'/*'` (must have a segment) | `'/*splat'` | does **not** match `/` |
| `'/files/*'` | `'/files/*path'` | `req.params.path` is an array |
| `'/:file.:ext?'` | `'/:file{.:ext}'` | `?` is reserved |
| `'/books/:id?'` | `'/books{/:id}'` | the slash goes inside the group |
| `'/:foo*'` | `'{/*foo}'` | zero or more segments |
| `'/:foo+'` | `'/*foo'` | one or more segments |
| `'/[discussion\|page]/:slug'` | `['/discussion/:slug', '/page/:slug']` | array of paths |
| `'/product/(\\d+)'` | a real `RegExp`, or validate in the handler | inline regex groups are gone |
| `'/users/:user-id'` | `'/users/:"user-id"'` | names must be identifiers |

:::tip
Upgrading? Grep the codebase for `'*'` inside route strings, for `?` immediately after a `:param`, and for `(` or `[` in any path. Those three searches find nearly every path that will throw.
:::

## The errors you will actually see

path-to-regexp throws while the route is being registered, so the process dies at boot with a stack trace pointing at your `app.get(...)` call. Every message ends with the same documentation URL, which is the quickest way to recognize the family:

```text
TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError
```

A `*` or `:` with no name after it. The classic cause is the Express 4 catch-all `'/*'`, or a stray `:` in a literal path. The number is the character offset in the path string.

```text
TypeError: Unexpected [ at 1, expected END: https://git.new/pathToRegexpError
```

A reserved character used literally — `(`, `)`, `[`, `]`, `?`, `+` or `!`. Either escape it with a backslash or express the intent with a group or an array of paths. The reported character tells you which one and where.

Two more worth knowing: an unterminated `:"quoted"` name and an unclosed `{` group both throw at registration time as well. In all cases the fix is in the path string, never in the handler.

:::warning
These are startup errors, not request errors. They cannot be caught by your error middleware, and a route that throws takes the whole process down before it ever listens. That is a feature — you find the bad path on your machine instead of in production traffic.
:::

## Common mistakes

- **Using `'/*splat'` as the catch-all.** It does not match the mount root, so `GET /` falls through to a different handler than every other URL. Use `'/{*splat}'`.
- **Treating a wildcard param as a string.** `req.params.splat` is an array; `req.params.splat.startsWith(...)` throws.
- **Calling `req.params.hasOwnProperty(...)`.** The object has a null prototype for string paths. Use `Object.hasOwn()`.
- **Assuming an optional param is present as `undefined`.** It is omitted entirely, so `Object.keys(req.params).length` and `in` checks behave differently than under Express 4.
- **Porting `'/:file.:ext?'` verbatim.** `?` is reserved; the Express 5 spelling is `'/:file{.:ext}'`.
- **Putting a regex inside a path string.** `'/(\\d+)'` throws. Pass a `RegExp` object, or match loosely and validate the value.
- **Trusting a param because it came from the URL.** Path parameters are attacker-controlled strings exactly like body fields. Validate them, and never interpolate them into SQL — see [SQL injection](../security/sql-injection.md).
- **Building a filesystem path from a wildcard.** `req.params.path.join('/')` can contain `..`. Resolve against a root and verify containment.

## Related topics

- [Routing](routing.md) — registration order, which decides which pattern wins.
- [Routers and modularity](routers-and-modularity.md) — `mergeParams` and how params flow into a mounted router.
- [Request and response](request-and-response.md) — `req.query`, `req.body` and the rest of the request object.
- [Static files](static-files.md) — safe handling of wildcard paths that reach the filesystem.
- [Validation](../express-libraries/validation.md) — schema-checking params instead of hand-rolling `Number.isInteger`.
- [Error handling](error-handling.md) — turning a failed lookup in `app.param()` into a clean 404.
- [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) — the rest of the upgrade, beyond paths.
- [Troubleshooting](../reference/troubleshooting.md) — error messages by symptom.
