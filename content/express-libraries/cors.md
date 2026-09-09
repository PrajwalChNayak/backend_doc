---
title: CORS
description: What the same-origin policy actually protects, how preflight works, and how to configure the cors package with an allow-list without breaking credentials or caches.
status: current
updated: 2026-09-08
---

CORS is a set of response headers that tell a browser whether JavaScript from one origin may **read** a response from another. It is not access control, it is not a firewall, and it does not stop the request from reaching your handler. Getting this wrong in either direction — too strict and your frontend breaks, too loose and any website can read authenticated data as your users — is one of the most common configuration failures in an Express API.

## What the same-origin policy actually protects

An origin is the triple `(scheme, host, port)`. `https://app.example.com` and `https://api.example.com` are different origins; so are `http://example.com` and `https://example.com`, and `https://example.com` and `https://example.com:8443`.

The same-origin policy stops JavaScript on page A from **reading** the response of a request to origin B. That is the whole guarantee. It exists because browsers attach cookies automatically: without it, any site you visit could `fetch('https://bank.example/accounts')` with your session cookie and read the JSON.

What it does **not** do:

- **It does not stop the request being sent.** For a "simple" request (defined below) the browser dispatches it, your server runs the handler, the database write happens — and only then does the browser refuse to hand the response body to the calling script. This is exactly why CSRF exists as a separate problem with a separate defense.
- **It does not apply to non-browser clients.** `curl`, Postman, a mobile app, another server — none of them implement the same-origin policy. Your CORS config is invisible to them.
- **It does not restrict `<img>`, `<script>`, `<form>`, `<link>`.** Those cross-origin loads are allowed by design; only *reading the bytes back from script* is gated.

:::warning
CORS is not authentication. `origin: 'https://app.example.com'` does not mean "only my app can call this endpoint" — it means "only my app's JavaScript can read the answer in a browser." Every endpoint still needs its own authorization check.
:::

## Simple vs preflighted requests

A request is **simple** — sent immediately, no `OPTIONS` first — only when all of the following hold:

- Method is `GET`, `HEAD`, or `POST`.
- The only author-set headers are from the CORS-safelisted set: `Accept`, `Accept-Language`, `Content-Language`, `Content-Type`, `Range`, plus a few user-agent-controlled ones.
- If `Content-Type` is set, its value is one of `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`.
- No `ReadableStream` body, and no event listeners registered on an `XMLHttpRequest.upload`.

Everything else is **preflighted**: the browser first sends an `OPTIONS` request and only sends the real one if the answer permits it.

The practical consequences:

| Request | Preflight? | Why |
| --- | --- | --- |
| `GET /items` | No | Simple. |
| `POST /items` with `Content-Type: application/json` | **Yes** | JSON is not a safelisted content type. |
| `POST /items` with `Content-Type: text/plain` | No | Safelisted — and a plain HTML form can produce this. |
| `GET /items` with `Authorization: Bearer …` | **Yes** | `Authorization` is not safelisted. |
| `DELETE /items/1` | **Yes** | Method not in the safelist. |
| `PUT /items/1` | **Yes** | Same. |

:::danger
The `text/plain` row is why CSRF is a real problem. A cross-origin page can `fetch('https://api.example.com/transfer', { method: 'POST', credentials: 'include', body: '{"to":"attacker"}', headers: { 'Content-Type': 'text/plain' } })`, your server may still parse it, and the browser sends it without asking you first. It only hides the *response*. See [CSRF](../security/csrf.md).
:::

### The headers that matter

On the preflight **request**:

| Header | Meaning |
| --- | --- |
| `Origin` | The origin of the calling page. Browser-set; a script cannot forge it. |
| `Access-Control-Request-Method` | The method the real request will use. |
| `Access-Control-Request-Headers` | Comma-separated non-safelisted headers the real request will send. |

On the **response** (to the preflight, and to the actual request):

| Header | Meaning |
| --- | --- |
| `Access-Control-Allow-Origin` | A single origin, or `*`. Never a list. |
| `Access-Control-Allow-Methods` | Methods permitted, for preflight only. |
| `Access-Control-Allow-Headers` | Request headers permitted, for preflight only. |
| `Access-Control-Allow-Credentials` | `true` to permit cookies/`Authorization`. Any other value is treated as absent. |
| `Access-Control-Max-Age` | Seconds the browser may cache this preflight result. |
| `Access-Control-Expose-Headers` | Which **response** headers script may read. Without it, only the CORS-safelisted response headers are visible. |
| `Vary: Origin` | Tells caches the response depends on the request's `Origin`. |

`Access-Control-Expose-Headers` is the one people forget. By default `fetch` can read only `Cache-Control`, `Content-Language`, `Content-Length`, `Content-Type`, `Expires`, `Last-Modified` and `Pragma`. Your `X-Request-Id`, `RateLimit`, or pagination headers are invisible to the client until you list them.

## Installation

:::tabs
@tab npm
```bash
npm install cors@2
```
@tab pnpm
```bash
pnpm add cors@2
```
@tab yarn
```bash
yarn add cors@2
```
:::

`cors` 2.8.6 ships CommonJS; the default import works from ESM.

## A production configuration

The default `cors()` sets `Access-Control-Allow-Origin: *`. That is correct for a genuinely public, credential-free API and wrong for everything else.

```js title="src/security/cors.js"
import cors from 'cors'

const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
)

export const corsMiddleware = cors({
  origin(origin, callback) {
    // No Origin header: curl, server-to-server, same-origin navigations.
    // Allow it — there is no browser to protect here.
    if (!origin) return callback(null, true)

    if (ALLOWED_ORIGINS.has(origin)) return callback(null, origin)

    // Reject by NOT setting the header. Do not pass an Error unless you
    // want a 500 for every disallowed preflight.
    return callback(null, false)
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 600,
})
```

```js title="src/app.js"
import express from 'express'
import { corsMiddleware } from './security/cors.js'

const app = express()

app.use(corsMiddleware)
app.use(express.json())
```

```env title=".env"
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

Points worth spelling out:

- **`origin` is a function, and the allow-list is exact-match.** A `Set` of full origin strings. Not `startsWith`, not a regex, not `includes`.
- **`callback(null, origin)` echoes that one origin.** `callback(null, true)` also reflects the request origin — same result here because you already checked membership.
- **`callback(null, false)` omits the header.** The browser then blocks the read. That is the correct rejection: the endpoint still returns its normal status, and non-browser clients are unaffected.
- **`allowedHeaders` is explicit.** Omit it and `cors` reflects whatever `Access-Control-Request-Headers` asks for, which makes the preflight rubber-stamp anything.
- **`maxAge` is bounded.** Firefox caps preflight caching at 24 hours and Chromium at 2 hours, so anything larger is wishful. Ten minutes is a reasonable default; a long cache means a config change takes that long to take effect for active users.
- **`methods` lists what you actually implement.** The default includes `PUT`, `PATCH`, `POST`, `DELETE`, `GET`, `HEAD` whether or not you support them.

### Why `origin: '*'` with `credentials: true` fails

The Fetch spec forbids the combination. When a request is made with credentials, `Access-Control-Allow-Origin: *` is not treated as a match — the browser requires a literal origin string.

```js vulnerable title="DO NOT COPY — silently broken"
app.use(cors({ origin: '*', credentials: true }))
```

The failure is confusing because the server looks fine. The response arrives with a 200, the headers are present, and the browser still refuses the read with a message about the wildcard. Nothing appears in your server logs. The fix is to echo a specific allowed origin instead of `*`.

The same rule applies to `Access-Control-Allow-Headers: *` and `Access-Control-Allow-Methods: *` on a credentialed request.

## Why reflecting the Origin unconditionally is a vulnerability

This is the anti-pattern:

```js vulnerable title="DO NOT COPY"
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  next()
})
```

Every origin is now allowed, with credentials. Any page anywhere can run `fetch('https://api.example.com/me', { credentials: 'include' })` and read the logged-in user's data. It is `origin: '*'` with the one restriction that made `*` survivable — no credentials — removed.

`cors({ origin: true })` does the same thing, and so does a sloppy predicate:

```js vulnerable title="DO NOT COPY — all of these are bypassable"
origin: (o, cb) => cb(null, o.endsWith('example.com'))      // notexample.com
origin: (o, cb) => cb(null, o.includes('app.example.com'))  // https://app.example.com.evil.test
origin: /example\.com/                                       // https://evil.test/?x=example.com in some engines
```

Exact string membership in an allow-list is the only form that does not have a bypass. The full exploit narrative, including how an attacker chains this with a session cookie, is in [CORS misconfiguration](../security/cors-misconfiguration.md).

### Why `Vary: Origin` matters

When the response body or headers differ by request `Origin`, any cache in between — a CDN, a reverse proxy, the browser's own HTTP cache — must be told, or it will serve the response computed for one origin to a request from another.

Concretely: `https://app.example.com` makes a request, the CDN caches the response including `Access-Control-Allow-Origin: https://app.example.com`. Then `https://admin.example.com` requests the same URL, gets the cached copy, and its browser blocks it. Same mechanism in the other direction can *leak* an allow header to an origin that should not have received it.

`cors` adds `Vary: Origin` for you whenever `origin` is anything other than a static `*`. If you hand-roll the headers, you must add it yourself — and `res.vary('Origin')` throws in Express 5 if you call it with no argument.

## Per-route CORS

Most APIs need one policy, but a public endpoint alongside a credentialed one is common.

```js title="src/routes/index.js"
import { Router } from 'express'
import cors from 'cors'
import { corsMiddleware } from '../security/cors.js'

const router = Router()

// Public, no credentials: a wildcard is genuinely fine here.
const publicCors = cors({ origin: '*', credentials: false, methods: ['GET'] })

router.get('/status', publicCors, (req, res) => {
  res.json({ ok: true })
})

// Everything else uses the allow-list.
router.use(corsMiddleware)

router.get('/me', requireAuth, async (req, res) => {
  res.json(await loadUser(req.user.id))
})

export default router
```

When `cors` is used as route-level middleware rather than `app.use()`, it does **not** answer preflights for that route — an `OPTIONS` request will fall through to your 404 handler. Register the preflight explicitly:

```js title="Express 5 path syntax"
// One route.
router.options('/items/:id', corsMiddleware)

// A subtree. '/{*splat}' matches the base path too; '/*splat' does not.
router.options('/{*splat}', corsMiddleware)
```

:::deprecated
The Express 4 idiom `app.options('*', cors())` throws in Express 5, because `path-to-regexp` v8 requires a named wildcard. Write `app.options('/{*splat}', cors())` instead. Likewise `'/api/*'` becomes `'/api/*splat'`, and a regex-in-a-string like `'/[items|things]/:id'` becomes the array `['/items/:id', '/things/:id']`.
:::

Using `cors` as application-level middleware (`app.use(corsMiddleware)`) handles preflights for every route automatically and is the simpler choice when one policy covers the API.

## How to verify

Preflight from an origin that should be rejected:

```bash
curl -H "Origin: https://evil.example" \
     -H "Access-Control-Request-Method: POST" \
     -X OPTIONS -i https://api.example.com/items
```

A correct configuration returns **no** `Access-Control-Allow-Origin` header at all. If you see `Access-Control-Allow-Origin: https://evil.example`, you are reflecting the origin and the API is readable by any site on the internet.

Preflight from an allowed origin:

```bash
curl -H "Origin: https://app.example.com" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: content-type,authorization" \
     -X OPTIONS -i https://api.example.com/items
```

Expect:

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET,HEAD,POST,PUT,PATCH,DELETE
Access-Control-Allow-Headers: Content-Type,Authorization,X-Request-Id
Access-Control-Max-Age: 600
Vary: Origin
```

Also test the `null` origin, which sandboxed iframes and some `file://` contexts send:

```bash
curl -H "Origin: null" -H "Access-Control-Request-Method: POST" \
     -X OPTIONS -i https://api.example.com/items
```

`null` must not be in your allow-list. Any attacker page can produce it with `<iframe sandbox="allow-scripts" srcdoc="…">`.

## Security considerations

**The allow-list must be exact strings.** Substring, suffix, and regex checks all have bypasses. Compare full origins with `Set.has()`.

**Never allow `null`.** It is trivially forgeable from a sandboxed iframe and is not a meaningful identity.

**`credentials: true` raises the stakes on every other option.** With credentials off, a permissive `Access-Control-Allow-Origin` leaks only what an unauthenticated client could already fetch. With credentials on, it leaks the logged-in user's data.

**A missing `Origin` header is not an attacker signal.** Browsers omit it on same-origin `GET`s and non-browser clients omit it entirely. Allowing requests with no `Origin` (as the config above does) is correct — those requests are not protected by the same-origin policy in the first place, so refusing them buys nothing and breaks health checks and server-to-server calls.

**CORS does not replace CSRF protection.** A simple cross-origin `POST` still executes. If you authenticate with cookies, you need `SameSite` and/or a CSRF token regardless of your CORS config.

**Rejecting by throwing an error gives you 500s.** `callback(new Error('not allowed'))` sends the error to your error handler, so every scan and every stale bookmark produces a 500 and pollutes your alerting. Reject with `callback(null, false)`.

**Do not put the allow-list in the code.** Origins differ per environment; a hard-coded staging origin in production is a permanent hole.

## Production considerations

**Configure origins through the environment.** One comma-separated variable, parsed at boot, validated at boot. Fail startup if it is empty in production rather than falling back to `*`.

**Order matters.** Register CORS before body parsing and before authentication, so a preflight — which carries no body and no credentials — is answered without running either. A preflight that hits your auth middleware and gets a 401 breaks the real request that follows.

**Preflights cost a round trip.** Every `POST` with `Content-Type: application/json` from a browser is two requests. `maxAge` amortizes it, capped by browser limits (~2h Chromium, ~24h Firefox). If preflight latency matters, keep the API on the same origin as the app behind one reverse proxy and skip CORS entirely.

**A CDN in front of the API must forward and vary on `Origin`.** If it strips the header, the origin function sees `undefined` and allows everything; if it caches without varying, it cross-pollinates responses between origins.

**Same-site subdomains are still cross-origin.** `app.example.com` calling `api.example.com` needs CORS. Cookies are a different axis: `SameSite=Lax` cookies *are* sent between subdomains of the same site, so you can have working cookies and blocked reads at the same time.

**Watch what you expose.** `exposedHeaders` should list only headers the client needs. Exposing internal diagnostics headers hands attackers information for free.

## Common mistakes

- **`app.use(cors())` and calling it done.** That is `Access-Control-Allow-Origin: *` — every site can read every unauthenticated response.
- **`origin: '*'` with `credentials: true`.** Invalid per spec, fails only in the browser, produces no server-side signal.
- **Reflecting `req.headers.origin` with credentials.** The single most damaging CORS bug there is.
- **Suffix or substring origin checks.** `evil-example.com` and `app.example.com.evil.test` both pass.
- **Allowing `null`.** Forgeable from any sandboxed iframe.
- **Forgetting `Vary: Origin` when hand-rolling headers.** Caches then serve one origin's ACAO to another.
- **Expecting CORS to block the request.** It blocks the *read*. The side effect already happened.
- **Registering a preflight route with a bare `*` path.** Express 5 rejects it; use `'/{*splat}'`.
- **Registering `cors` after `express.json()` or after auth.** Preflights carry no body and no credentials, and get rejected before they reach CORS.
- **Not exposing custom headers.** Your client reads `undefined` for `X-Request-Id` and the bug looks like a server problem.
- **Treating a passing CORS config as an authorization control.** `curl` does not care.

## Related topics

- [CORS misconfiguration](../security/cors-misconfiguration.md) — the exploit chain, end to end, with a working attacker page.
- [CSRF](../security/csrf.md) — why a permissive CORS config is not the only cross-origin risk, and why simple requests still execute.
- [Security headers with Helmet](security-headers-helmet.md) — `Cross-Origin-Resource-Policy` and the rest of the browser policy headers.
- [Cookies](cookies.md) — `SameSite`, and why credentialed cross-origin requests need `SameSite=None; Secure`.
- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — the Express 5 wildcard rules used by the preflight routes above.
- [Rate limiting](rate-limiting.md) — because CORS stops nobody from calling your API in a loop.
