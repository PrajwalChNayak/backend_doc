---
title: Request and response
description: The req and res objects in Express 5 — what changed, which properties lie to you behind a proxy, and how to send every kind of response correctly.
status: current
updated: 2026-09-08
---

`req` and `res` are Node's `IncomingMessage` and `ServerResponse` with Express properties added on top. Several of those properties changed meaning in Express 5, and two of them — `req.body` and `req.ip` — cause outages when misunderstood. This page covers the parts you touch daily and the traps in each.

## Reading the request

### `req.body` is `undefined` until a parser runs

```js
app.post('/books', (req, res) => {
  console.log(req.body)   // undefined — no body parser registered
})
```

Express 4 gave you `{}`, so `req.body.title` was merely `undefined`. Express 5 gives you `undefined`, so `req.body.title` throws `TypeError: Cannot read properties of undefined`, which the router forwards to your error handler as a 500. The upgrade turns a silent wrong answer into a loud one — that is the point, but it does mean any route reached without a parser now fails hard.

```js
app.use(express.json({ limit: '100kb' }))          // application/json
app.use(express.urlencoded({ extended: false }))   // form posts
```

A parser only runs when the request's `Content-Type` matches, so a `POST` with no content type still leaves `req.body` undefined. Validate rather than assume:

```js
app.post('/books', (req, res) => {
  if (!req.body) return res.status(415).json({ error: 'expected application/json' })
  // …
})
```

Four parsers ship with Express — no `body-parser` install needed:

| Parser | Handles | Default limit |
| --- | --- | --- |
| `express.json()` | `application/json` | 100kb |
| `express.urlencoded()` | `application/x-www-form-urlencoded` | 100kb |
| `express.text()` | `text/plain` | 100kb |
| `express.raw()` | any type, into a `Buffer` | 100kb |

`express.urlencoded()` defaults to `extended: false` in Express 5, which parses with Node's `querystring` and gives you a flat object of strings. Pass `{ extended: true }` only when you actually post nested form fields such as `address[city]`.

All four accept **Brotli**-compressed request bodies (`Content-Encoding: br`) in addition to gzip and deflate. Mobile clients that compress uploads no longer need a shim.

### `req.query` is a getter, and the default parser is `'simple'`

```js
app.use((req, res, next) => {
  req.query = sanitize(req.query)   // fails: req.query has no setter
  next()
})
```

`req.query` is a lazily-evaluated getter in Express 5. Sanitizing middleware that reassigns it silently stops working (or throws in strict mode). Put the cleaned values somewhere else — `req.validated = schema.parse(req.query)` — and read from there.

The default query parser is `'simple'`, not `'extended'`:

| Query string | `'simple'` (default) | `'extended'` |
| --- | --- | --- |
| `?tag=a&tag=b` | `{ tag: ['a', 'b'] }` | `{ tag: ['a', 'b'] }` |
| `?filter[status]=open` | `{ 'filter[status]': 'open' }` | `{ filter: { status: 'open' } }` |
| `?ids[]=1&ids[]=2` | `{ 'ids[]': ['1', '2'] }` | `{ ids: ['1', '2'] }` |

`'simple'` uses Node's built-in `querystring`; `'extended'` uses `qs`. Opt in when your clients send bracket syntax:

```js
app.set('query parser', 'extended')
```

The tradeoff is real: `qs` builds arbitrarily nested objects from user input, which is a larger attack surface (deep nesting, array-index blowups) and more CPU per request. Prefer `'simple'` plus flat, explicit query parameters; reach for `'extended'` when an existing client contract requires it.

Either way every value is a `string`, a `string[]`, or (under `'extended'`) a nested object — never a number or a boolean. `?limit=10` gives `'10'`, and `?admin=false` is a truthy string. Coerce with a schema.

### Host, hostname and port

```js
// Host: api.example.com:8443
req.host       // 'api.example.com:8443'  — includes the port in Express 5
req.hostname   // 'api.example.com'       — never includes the port
```

Express 4 stripped the port from `req.host`; Express 5 does not. Code that compares `req.host` against an allow-list of hostnames — CORS checks, tenant routing, redirect validation — breaks the moment a port appears. Use `req.hostname` for identity comparisons.

### `req.ip` and `trust proxy`

Behind a load balancer, every connection arrives from the proxy, so `req.ip` is the proxy's address unless you tell Express to believe the forwarding headers.

```js
// One proxy in front of the app (a single ALB, nginx, or Cloudflare edge).
app.set('trust proxy', 1)
```

| Value | Meaning |
| --- | --- |
| `false` (default) | `req.ip` is the socket address; `X-Forwarded-*` ignored |
| a number, e.g. `1` | trust that many hops from the right of `X-Forwarded-For` |
| `'loopback'` | trust `127.0.0.1`, `::1` and `::ffff:127.0.0.1` |
| an IP or CIDR, or an array of them | trust exactly those proxies |
| `true` | trust the leftmost entry — trust everything |

:::danger
`app.set('trust proxy', true)` lets any client set its own IP address. `X-Forwarded-For: 1.2.3.4` becomes `req.ip`, so a rate limiter keyed on `req.ip` can be defeated by rotating a header:

```bash
for i in $(seq 1 1000); do
  curl -s -H "X-Forwarded-For: 10.0.0.$((RANDOM % 255))" https://api.example.com/login -d '…'
done
```

Set the exact number of proxies in front of you instead. Getting it wrong the other way — leaving the default `false` behind a load balancer — is just as bad: every request appears to come from the proxy, so one user hitting the limit locks out everyone.
:::

When `trust proxy` is enabled, `req.protocol`, `req.secure`, `req.hostname` and `req.ips` all switch to reading the `X-Forwarded-*` headers too. Verify with a request through the real proxy, not against localhost:

```bash
curl -s https://api.example.com/debug/ip   # should print your public address
```

### Other request properties worth knowing

```js
req.params            // path parameters — null prototype, see the path syntax page
req.method            // 'GET'
req.path              // '/books/42' (no query string, mount prefix stripped)
req.originalUrl       // '/api/v1/books/42?full=1' (never rewritten)
req.get('content-type')  // header lookup, case-insensitive
req.accepts('json')      // content negotiation; also acceptsCharsets/Encodings/Languages
req.is('application/json')
req.cookies           // requires cookie-parser
req.xhr               // X-Requested-With === 'XMLHttpRequest'
```

The singular `req.param` accessor and the singular `acceptsCharset` / `acceptsEncoding` / `acceptsLanguage` spellings were removed in Express 5. Read `req.params`, `req.query` or `req.body` explicitly, and use the plural negotiation methods — `req.acceptsCharsets()`, `req.acceptsEncodings()`, `req.acceptsLanguages()`.

## Sending the response

### Status codes

```js
res.status(201).json(created)
res.sendStatus(204)                 // sets status and sends the status text as the body
```

`res.status()` accepts integers from **100 to 999** only. Anything else — a string, a float, `0`, `99`, `1000` — throws. That check catches the classic bug of passing a database or driver error code straight through:

```js
// Throws if err.code is something like 23505 (a Postgres error code).
res.status(err.code).json({ error: err.message })
```

Map error codes to HTTP statuses deliberately; never forward them.

Passing a bare number to `res.send()` was removed. Use `res.sendStatus(n)` for a status-only response, or `res.status(n).json(...)` / `res.status(n).end()`.

### `res.json()` and `res.send()`

```js
res.json({ id: 1 })          // Content-Type: application/json; charset=utf-8
res.send('<p>hi</p>')        // Content-Type: text/html; charset=utf-8
res.send(Buffer.from(bytes)) // Content-Type: application/octet-stream
res.send({ id: 1 })          // an object routes through res.json()
```

`res.send()` picks a content type from the argument's type unless you already set one. That inference is why `res.send()` on a string of JSON produces `text/html` — a mismatch some clients reject. Say what you mean: `res.json()` for JSON, `res.type('text/plain').send(str)` for text.

:::deprecated
The two-argument forms `res.json(obj, status)` and `res.send(body, status)` were removed in Express 5, along with `res.jsonp(obj, status)`. The status always comes first now, via `res.status(status).json(obj)`.
:::

`res.json()` respects the `json replacer`, `json spaces` and `json escape` app settings, so you can pretty-print in development without touching call sites:

```js
if (app.get('env') === 'development') app.set('json spaces', 2)
```

### Redirects — the argument order flipped

```js
res.redirect('/books')             // 302 by default
res.redirect(301, '/books')        // status FIRST in Express 5
```

:::deprecated
Express 4 accepted the arguments the other way round, as `(url, status)`. Express 5 accepts only `(status, url)`. A ported call that still passes the URL first does not throw — it ignores the second argument and sends a 302, which is a caching bug you will not notice locally.
:::

The magic `'back'` target was removed as well. Compute it yourself, and never redirect to a raw header value:

```js
const referrer = req.get('Referrer')
const safe = referrer?.startsWith('https://app.example.com/') ? referrer : '/'
res.redirect(safe)
```

An unchecked redirect target is an open-redirect vulnerability — see [Security headers](../security/security-headers.md) and the [OWASP API Top 10](../security/owasp-api-top-10.md).

### Headers, `Vary` and cookies

```js
res.set('X-Request-Id', req.id)
res.type('text/csv')
res.vary('Accept-Encoding')        // throws in Express 5 if the field is omitted
res.append('Link', '<…>; rel="next"')
```

`res.vary()` now throws when called with no field. That is a guard against a real bug: a cached response that varies on a header nobody declared gets served to the wrong client.

```js
res.cookie('sid', id, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
res.clearCookie('sid', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
```

`res.clearCookie()` ignores `maxAge` and `expires` in Express 5 — it sets its own expiry in the past — but every *other* option must match how the cookie was set. A cookie written with `path: '/api'` is not cleared by a `clearCookie` with the default path, and the user stays logged in.

### Files, streams and long responses

```js
res.sendFile('report.pdf', { root: 'storage/reports' })   // root confines the path
res.download('storage/reports/report.pdf', 'Q3.pdf')      // adds Content-Disposition
```

For generated output, stream instead of buffering — it keeps memory flat regardless of result size and lets the client start reading immediately:

```js
import { pipeline } from 'node:stream/promises'

app.get('/exports/books.csv', async (req, res) => {
  res.type('text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="books.csv"')

  // A stream error rejects here and Express 5 routes it to the error handler.
  await pipeline(books.streamAsCsv(), res)
})
```

`res.write()` sends a chunk and returns `false` when the internal buffer is full; ignoring that return value is how a slow client turns into unbounded server memory. `pipeline` handles backpressure, cleanup and error propagation for you — prefer it to a manual `write`/`end` loop.

:::warning
Once the first byte is written you cannot change the status code or headers. If generation can fail, do the work that might fail *before* the first `res.write()`, or accept that the client sees a truncated 200. Check `res.headersSent` in your error handler.
:::

### `res.locals`

`res.locals` is a per-request object visible to every later middleware and to templates.

```js
app.use((req, res, next) => {
  res.locals.requestId = req.id
  res.locals.user = req.user ?? null
  next()
})
```

Use it for values a *response* needs (template variables, a request id for the error handler). Use `req` properties for values the *request pipeline* needs. `app.locals` is the application-wide equivalent and is shared across all requests — never write per-request data there.

## Common mistakes

- **Reading `req.body.x` without a parser.** In Express 5 that throws instead of yielding `undefined`. Register the parser and check `req.body` exists.
- **Assigning to `req.query`.** It is a getter; the write is lost. Store sanitized values elsewhere.
- **Expecting `?filter[status]=open` to nest** under the default `'simple'` parser. Either flatten the query or opt into `'extended'`.
- **Comparing `req.host` to a hostname.** It includes the port in Express 5. Use `req.hostname`.
- **Leaving `trust proxy` at its default behind a load balancer**, so every request shares one IP — or setting it to `true`, so clients can forge theirs. Set the hop count.
- **Passing a driver error code to `res.status()`.** Values outside 100–999 throw.
- **Writing `res.redirect(url, status)`.** Express 5 takes the status first; the old order silently sends a 302.
- **Calling `res.vary()` with no argument.** It throws now.
- **Clearing a cookie with different options than it was set with.** Path, domain and `sameSite` must match, or nothing is cleared.
- **Buffering a large export into a string.** Stream it with `pipeline` and keep memory constant.
- **Putting per-request data on `app.locals`.** It leaks across requests. Use `res.locals`.

## Related topics

- [Middleware](middleware.md) — where the parsers sit in the stack and why order matters.
- [Route parameters and path syntax](route-parameters-and-path-syntax.md) — `req.params` and its null prototype.
- [Error handling](error-handling.md) — what happens to the `TypeError` from an undefined `req.body`.
- [Static files](static-files.md) — `res.sendFile` options and path-traversal safety.
- [Templating](templating.md) — `res.render` and `res.locals` together.
- [Cookies](../express-libraries/cookies.md) — flags, signing and session cookies in detail.
- [Rate limiting](../express-libraries/rate-limiting.md) — why `trust proxy` decides whether it works.
- [Streams and buffers](../node/streams-and-buffers.md) — backpressure, the reason `pipeline` exists.
- [Validation](../express-libraries/validation.md) — turning strings from `req.query` into typed values.
