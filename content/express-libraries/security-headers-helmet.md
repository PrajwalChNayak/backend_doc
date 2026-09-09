---
title: Security headers with Helmet
description: What each HTTP security header does, what helmet 8 sets by default, and how to write a Content-Security-Policy that actually blocks something.
status: current
updated: 2026-09-08
---

Helmet is a collection of small middlewares that set response headers. It does not sanitize anything, validate anything, or block any request — it hands the browser a policy and the browser enforces it. That distinction decides which of its headers are worth configuring and which are noise for a JSON API.

## Why it exists

Browsers ship a large set of opt-in defenses: script allow-lists, framing rules, referrer trimming, transport pinning. Every one of them is off until the server says otherwise, and each is expressed as a differently-shaped header with its own syntax quirks.

Helmet centralizes that into one `app.use()` with sensible defaults, so the interesting work is narrowing the defaults rather than remembering the header names.

## Installation

:::tabs
@tab npm
```bash
npm install helmet@8
```
@tab pnpm
```bash
pnpm add helmet@8
```
@tab yarn
```bash
yarn add helmet@8
```
:::

## Basic example

```js title="src/app.js"
import express from 'express'
import helmet from 'helmet'

const app = express()

app.disable('x-powered-by')
app.use(helmet())

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

export default app
```

Register Helmet **before** your routes and before `express.static()`. Middleware that has already sent headers cannot have them added afterwards.

## What helmet 8 sets by default

`helmet()` with no options sets twelve headers and removes `X-Powered-By`.

| Header | Default value | Worth touching? |
| --- | --- | --- |
| `Content-Security-Policy` | see below | Yes — the only header here that stops real attacks, and the default is wrong for most apps |
| `Cross-Origin-Opener-Policy` | `same-origin` | Rarely |
| `Cross-Origin-Resource-Policy` | `same-origin` | Yes if other origins load your images/fonts/scripts |
| `Origin-Agent-Cluster` | `?1` | No |
| `Referrer-Policy` | `no-referrer` | Sometimes — `strict-origin-when-cross-origin` is friendlier |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Yes — understand `includeSubDomains` before shipping |
| `X-Content-Type-Options` | `nosniff` | No, keep it |
| `X-DNS-Prefetch-Control` | `off` | No |
| `X-Download-Options` | `noopen` | No (IE8 only) |
| `X-Frame-Options` | `SAMEORIGIN` | Yes if you need `DENY` |
| `X-Permitted-Cross-Domain-Policies` | `none` | No |
| `X-XSS-Protection` | `0` | No — `0` is correct, see below |

`Cross-Origin-Embedder-Policy` is **not** set by default. You opt in with `crossOriginEmbedderPolicy: true`.

:::note
Every header can be turned off individually by passing `false`, and configured by passing an options object:

```js
app.use(
  helmet({
    contentSecurityPolicy: { directives: { 'script-src': ["'self'", 'cdn.example.com'] } },
    xDownloadOptions: false,
  }),
)
```
:::

### Why `X-XSS-Protection: 0` is the correct value

The legacy IE/Chrome XSS auditor was itself exploitable — it could be tricked into blanking out parts of a page to create a vulnerability that did not exist. It has been removed from every current browser. Helmet sets `0` to explicitly disable it in the stragglers rather than leaving the value unset. Do not "fix" this to `1; mode=block`.

## Content-Security-Policy

CSP is an allow-list telling the browser which origins may supply scripts, styles, images, frames and connections, and it is the only header in the list that meaningfully reduces the impact of an XSS bug.

Helmet's default policy is:

```text
default-src 'self';
base-uri 'self';
font-src 'self' https: data:;
form-action 'self';
frame-ancestors 'self';
img-src 'self' data:;
object-src 'none';
script-src 'self';
script-src-attr 'none';
style-src 'self' https: 'unsafe-inline';
upgrade-insecure-requests
```

Directives you pass are **merged into** these defaults. Set `useDefaults: false` to start from an empty policy, or set a directive to `null` to remove it.

### Why `'unsafe-inline'` defeats the policy

An XSS payload is an inline script. If `script-src` contains `'unsafe-inline'`, the browser executes any `<script>` the attacker injects into your HTML, and the entire policy contributes nothing against the attack it exists to stop.

```js vulnerable title="DO NOT COPY"
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // An injected <script>alert(document.cookie)</script> runs fine.
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }),
)
```

Note that Helmet's *default* `style-src` includes `'unsafe-inline'`. That is a deliberate compromise — inline styles are far less dangerous than inline scripts, and almost every real app has them — but tighten it if you can.

### Nonces

The way to allow *your* inline scripts without allowing the attacker's is a per-response nonce. The browser executes only inline scripts carrying the matching `nonce` attribute; an injected script has no way to guess it.

```js title="src/security/csp.js"
import crypto from 'node:crypto'
import helmet from 'helmet'

export function cspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64')
  next()
}

export const csp = helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
})
```

```js title="src/app.js"
app.use(cspNonce)
app.use(csp)
```

A directive array entry may be a function; Helmet calls it with `(req, res)` for every response. The nonce must be freshly generated per request — a fixed nonce is exactly as useful to the attacker as `'unsafe-inline'`.

In your template, emit `<script nonce="{{ cspNonce }}">`.

:::warning
A nonce on `script-src` does not help if `base-uri` is unrestricted: an injected `<base href="https://evil.example/">` can redirect every relative script URL. Keep `base-uri 'self'`, which Helmet's default does.
:::

### Rolling a policy out safely

Deploy in report-only mode first, collect the violations, then enforce.

```js
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { scriptSrc: ["'self'"] },
      reportOnly: true,
    },
  }),
)
```

`Content-Security-Policy-Report-Only` makes the browser log violations without blocking, so you find the third-party widget you forgot before your users do.

Helmet performs almost no validation of your policy — a typo in a directive name is silently accepted. Run the result through a CSP checker.

## HSTS

`Strict-Transport-Security` tells the browser to refuse plain HTTP for this host for `max-age` seconds. It closes the first-request-over-HTTP window that a redirect alone leaves open.

```js
app.use(
  helmet({
    strictTransportSecurity: {
      maxAge: 63072000, // 2 years
      includeSubDomains: true,
      preload: true,
    },
  }),
)
```

:::danger
`includeSubDomains` applies the rule to **every** subdomain, including ones you forgot. If `legacy-intranet.example.com` is HTTP-only, it breaks, and browsers that have already cached the policy keep it for the full `max-age` — you cannot undo it by removing the header. `preload` is worse: it hard-codes your domain into browser binaries and removal takes months.

Ship `maxAge` at a few minutes first, confirm every subdomain serves HTTPS, then raise it. Only add `preload` when you are certain.
:::

HSTS is ignored on plain HTTP and on `localhost` in most browsers, but Safari will upgrade `http://localhost`, so disable the header in development if that bites you.

## Framing: `X-Frame-Options` vs `frame-ancestors`

Both stop clickjacking. `frame-ancestors` is the modern one, supports multiple origins, and takes precedence in browsers that support both. `X-Frame-Options` is kept for old clients and for the case where you serve no CSP.

```js
app.use(
  helmet({
    xFrameOptions: { action: 'deny' },
    contentSecurityPolicy: {
      directives: { frameAncestors: ["'none'"] },
    },
  }),
)
```

`X-Frame-Options: ALLOW-FROM` was never widely implemented and Helmet does not support it. If you need to allow specific embedders, that is `frame-ancestors https://partner.example` and nothing else.

## Referrer-Policy

Helmet defaults to `no-referrer`, which strips the `Referer` header entirely. That is the safest option and it also breaks referral analytics and some OAuth flows that inspect the referrer.

`strict-origin-when-cross-origin` is the usual compromise: full URL on same-origin navigations, origin only when crossing to another HTTPS origin, nothing when downgrading to HTTP.

```js
app.use(helmet({ referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }))
```

The reason this matters: URLs leak. A password-reset link, a document ID, or a search query sitting in the path is handed to every third party your page loads if the referrer policy is permissive.

## The cross-origin isolation trio

| Header | What it controls |
| --- | --- |
| `Cross-Origin-Resource-Policy` (CORP) | Who may **embed your response** as a subresource (`<img>`, `<script>`, font). `same-origin` blocks everyone else. |
| `Cross-Origin-Opener-Policy` (COOP) | Whether a page you open (or that opens you) shares a browsing-context group with you. `same-origin` severs the `window.opener` link. |
| `Cross-Origin-Embedder-Policy` (COEP) | Whether **you** may embed cross-origin resources that have not opted in. Not set by default. |

CORP is the one that catches people out. If your API serves images or fonts consumed by a different origin, the default `same-origin` breaks them, and the failure looks nothing like a CORS error:

```js
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
```

Only reach for COEP when you actually need cross-origin isolation — it is the prerequisite for `SharedArrayBuffer` and high-resolution timers, and turning it on breaks every cross-origin resource that does not send CORP or CORS headers.

## Which headers matter for a JSON API

A pure JSON API is not rendered as a document, so most of the list is inert. It costs a few bytes per response to keep the defaults, and there is no harm in that — but know what is actually doing work.

| Header | Useful on a JSON-only API? |
| --- | --- |
| `Strict-Transport-Security` | **Yes.** Browsers still honour it for XHR/fetch origins. |
| `X-Content-Type-Options: nosniff` | **Yes.** Cheap, and matters the moment you serve a user-supplied file. |
| `Content-Security-Policy` | Marginal — but keep a restrictive one, because it is your safety net if a route ever returns HTML (an error page, a redirect body, a docs UI). |
| `Referrer-Policy` | Marginal for API responses; matters for any browser-visited URL. |
| `X-Frame-Options` / `frame-ancestors` | Only if a route can render HTML. A JSON response cannot be usefully framed. |
| `Cross-Origin-Resource-Policy` | Yes — it is what stops another origin from `<script src>`-ing your endpoint. |
| `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies` | No. Legacy-client trivia. |

The mistake is the inverse belief: that adding Helmet secures a JSON API. It does not touch authentication, authorization, injection, or rate limiting.

## Security considerations

**Helmet is not a substitute for anything.** It sets headers. An IDOR, a SQL injection, or a missing authorization check is unaffected by every header on this page.

**CSP protects the browser, not the server.** A non-browser client ignores every directive. CSP reduces the *impact* of an XSS bug in your own HTML; it does not prevent the injection.

**A CSP with `'unsafe-inline'` or `'unsafe-eval'` in `script-src` is decorative.** So is one with a wildcard host, or a CDN origin that hosts arbitrary user content (a JSONP endpoint or an open script-hosting CDN can be used to bypass the allow-list entirely).

**Headers on error responses.** Helmet runs as middleware, so a response short-circuited *before* Helmet — for example by a proxy, or by middleware registered above it — has no headers. Register Helmet first.

**A reverse proxy may strip or duplicate headers.** Verify the headers as seen by the client, not as produced by Node.

Verify with:

```bash
curl -sI https://api.example.com/health | grep -i -E 'content-security|strict-transport|x-frame|x-content-type|referrer|cross-origin'
```

## Production considerations

**Development differs deliberately.** `upgrade-insecure-requests` and HSTS both fight with `http://localhost`. Gate them:

```js title="src/app.js"
const isProd = process.env.NODE_ENV === 'production'

app.use(
  helmet({
    strictTransportSecurity: isProd,
    contentSecurityPolicy: {
      directives: {
        'upgrade-insecure-requests': isProd ? [] : null,
      },
    },
  }),
)
```

An empty array renders the directive with no value (`upgrade-insecure-requests`); `null` removes it.

**Serving a docs UI changes the CSP calculus.** Swagger UI needs inline styles and, depending on configuration, inline scripts. Scope a looser policy to that path rather than loosening the global one — see [API documentation](api-documentation.md).

**Headers add bytes to every response.** A full CSP is several hundred bytes. On a high-volume API this is measurable; on an HTML app it is irrelevant next to the payload. Do not delete CSP to save bandwidth — shorten it by removing directives you do not need.

**Set the same headers at the edge if you have one.** A CDN or ingress that adds its own headers can conflict with Node's. Pick one owner per header and check for duplicates in the response.

**Trust proxy affects `req.secure`, not Helmet.** Helmet sets HSTS regardless of scheme; browsers ignore it over HTTP. If you conditionally set headers based on `req.secure`, you need `app.set('trust proxy', 1)` behind a load balancer.

## Common mistakes

- **Registering Helmet after the routes.** The headers never reach responses that were already sent.
- **Adding `'unsafe-inline'` to `script-src` to make the app work.** This is the whole vulnerability, restored. Use a nonce, or move the script to a file.
- **Reusing one nonce for every response.** Generate it per request, from `crypto.randomBytes`, not from a counter or a timestamp.
- **Shipping `includeSubDomains; preload` with a two-year `max-age` on day one.** You cannot roll this back from the server.
- **Assuming CSP blocks the attack.** It blocks the *payload from executing* in a compliant browser. Fix the injection.
- **Turning off `crossOriginResourcePolicy` globally** because one image broke, instead of setting `cross-origin` on that route.
- **Believing `helmet()` gives you CORS.** They are unrelated; see [CORS](cors.md).
- **Setting `X-XSS-Protection: 1; mode=block`** because a scanner flagged the `0`. The `0` is deliberate.
- **Trusting a header scanner's grade as a security assessment.** An A+ on headers says nothing about your authorization logic.

## Related topics

- [Security headers](../security/security-headers.md) — the threat model behind each header, with exploits.
- [CORS](cors.md) — the other header-driven browser policy, and the one people confuse this with.
- [API documentation](api-documentation.md) — why a docs UI forces a CSP exception.
- [Cross-site scripting (XSS)](../security/xss.md) — the attack CSP is mitigating.
- [HTTPS and TLS](../security/https-and-tls.md) — what has to be true before HSTS is safe to enable.
- [Middleware](../express/middleware.md) — why registration order decides whether headers are applied.
