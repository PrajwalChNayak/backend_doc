---
title: CSRF
description: When CSRF applies and when it does not, an auto-submitting attack form, and the fixes in order — SameSite cookies, origin checks, and csrf-csrf tokens.
status: current
updated: 2026-09-08
---

Cross-site request forgery tricks a victim's browser into making a state-changing request to your site using credentials the browser attaches automatically. The defining condition is **ambient authority**: if the browser sends the credential without your JavaScript doing anything, a cross-site page can trigger an authenticated action. That is exactly how cookie and session auth work — and exactly why token-in-header auth is immune.

## When CSRF applies and when it does not

CSRF applies when your endpoint is authenticated by something the browser sends automatically:

- **Session cookies** and any cookie-based auth.
- HTTP Basic auth and client certificates (also ambient).

CSRF does **not** apply when the credential must be added by your own code on each request:

- An `Authorization: Bearer <token>` header where the token lives in memory (or `localStorage`) and your fetch layer attaches it. A cross-site page cannot read that token and cannot make the browser add the header, so it cannot forge the request.

If your API is pure bearer-token and sets no auth cookie, you do not need CSRF tokens. The moment you put the session in a cookie, you do.

## The threat

A cross-site page cannot read your responses (the same-origin policy and CORS see to that), but it can *send* requests, and the browser attaches the victim's cookies. So the attacker does not need to read anything — they only need the **side effect**: change the victim's email, transfer funds, delete an account, or log the victim into an attacker-controlled account. One visit to a malicious page fires the request with the victim's full session behind it.

## A concrete exploit

Here is a cookie-authenticated endpoint that changes the account email, protected only by the session cookie.

:::danger CSRF on a cookie-authenticated endpoint
The only thing authorizing this state change is the session cookie, which the browser attaches to *any* request to this origin — including one triggered by another site.
:::

```js vulnerable title="DO NOT COPY"
import express from 'express'
import cookieParser from 'cookie-parser'

const app = express()
app.use(cookieParser())
app.use(express.urlencoded({ extended: false }))

app.post('/account/email', (req, res) => {
  if (!req.cookies.session) return res.sendStatus(401)
  // No CSRF defense: a valid session cookie is treated as intent.
  updateEmail(req.cookies.session, req.body.email)
  res.json({ ok: true })
})

app.listen(3000)
```

The attacker hosts a page that auto-submits a form to that endpoint. A form POST with `Content-Type: application/x-www-form-urlencoded` is a **simple request** — it is sent with no CORS preflight and no permission from your server:

```html title="hosted on https://evil.example"
<body onload="document.forms[0].submit()">
  <form action="https://api.example.com/account/email" method="POST">
    <input type="hidden" name="email" value="attacker@evil.example" />
  </form>
</body>
```

When a logged-in victim opens that page, their browser POSTs the form to `api.example.com` with the session cookie attached. The server sees a valid session and changes the email to the attacker's address — who can now trigger a password reset and take the account. The victim saw a blank page.

## CORS does not prevent CSRF

A common misconception is that CORS stops this. It does not. CORS governs whether the attacker can **read** the response; the forged request is still **sent**, and the side effect still happens. The form POST above is a simple request that never triggers a preflight, so there is no CORS check to fail before the write occurs. Tightening CORS changes nothing about CSRF.

There is a narrow, related effect: a request with `Content-Type: application/json` is **not** a simple request, so the browser preflights it, and an attacker's cross-site page cannot set that content type on a form-driven request. So a server that accepts writes only as `application/json` gets a *weak, partial* defense — attackers cannot forge a JSON body through a simple form. Treat it as a small bonus, not a control: it breaks down if any endpoint also accepts form or text bodies, and it is trivially undone by a lenient parser. Use a real token or SameSite.

## The fixes, in order of preference

### 1. SameSite cookies

`SameSite` tells the browser not to attach the cookie to cross-site requests. It is the highest-leverage fix because it defends every endpoint at once, at the cookie layer.

- **`SameSite=Lax`** is the modern browser default when a cookie sets no `SameSite`. It blocks the cookie on cross-site *subrequests* — including the auto-submitting POST above — which stops the classic attack. It still sends the cookie on **top-level GET navigations** the user's click initiates, so any state change reachable by a cross-site top-level `GET` (a bad idea anyway) is not covered, and it does not isolate **cross-subdomain** requests, which are same-site.
- **`SameSite=Strict`** withholds the cookie on all cross-site requests, including top-level navigations. It is the strongest, but it means a link from an email or another site lands the user logged-out until they navigate within your site — often too strict for the main session cookie.

```js good title="src/session-cookie.js"
res.cookie('session', sessionId, {
  httpOnly: true,        // not readable by JS
  secure: true,          // HTTPS only
  sameSite: 'lax',       // blocks cross-site subrequests (the CSRF vector)
  path: '/',
  maxAge: 1000 * 60 * 60 * 8,
})
```

:::best-practice
Set `SameSite=Lax` on the session cookie as a baseline, and never expose a state-changing action over `GET`. That combination alone stops the standard form-POST CSRF. Add a token (below) for defense in depth and for the gaps Lax leaves.
:::

### 2. Origin / Referer checking

For state-changing requests, compare the `Origin` header (fall back to `Referer`) against your own origin and reject mismatches. Browsers send `Origin` on cross-origin writes, and the attacker cannot forge it from script.

```js good title="src/check-origin.js"
const ALLOWED = new Set(['https://app.example.com'])

export function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const origin = req.get('Origin') ?? new URL(req.get('Referer') ?? 'http://x/').origin
  if (!ALLOWED.has(origin)) return res.status(403).json({ error: 'bad origin' })
  next()
}
```

This is a solid second layer, but a missing `Origin`/`Referer` (some privacy tools strip them) needs a deliberate policy — usually reject — so it is best combined with SameSite rather than used alone.

### 3. Synchronizer / double-submit token

The classic control: issue an unpredictable token the attacker cannot know, require it on every state-changing request, and reject requests without a valid one. Because a cross-site page cannot read your token, it cannot include it. Use `csrf-csrf` (4.0.3) for the signed double-submit-cookie pattern.

```js good title="src/csrf.js"
import { doubleCsrf } from 'csrf-csrf'

const {
  generateCsrfToken,
  doubleCsrfProtection,
  invalidCsrfTokenError,
} = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET,
  getSessionIdentifier: (req) => req.cookies.session ?? '',
  cookieName: '__Host-psifi.x-csrf-token',
  cookieOptions: { sameSite: 'lax', secure: true, path: '/' },
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
})

export { generateCsrfToken, doubleCsrfProtection, invalidCsrfTokenError }
```

```js good title="src/app.js"
import express from 'express'
import cookieParser from 'cookie-parser'
import { generateCsrfToken, doubleCsrfProtection } from './csrf.js'

const app = express()
app.use(cookieParser())
app.use(express.json())

// Hand the SPA a token to echo back in the X-CSRF-Token header.
app.get('/csrf-token', (req, res) => {
  res.json({ token: generateCsrfToken(req, res) })
})

// Enforce it on every state-changing route.
app.use(doubleCsrfProtection)

app.post('/account/email', (req, res) => {
  updateEmail(req.cookies.session, req.body.email)
  res.json({ ok: true })
})
```

:::deprecated
`csurf` is **archived and unmaintained** — do not add it to any project. Use `csrf-csrf` (above) or a session-bound synchronizer token you issue and check yourself.
:::

## Login and logout CSRF

Two variants are easy to forget because they act *before or after* a session:

- **Login CSRF.** The attacker forges a login request with *their own* credentials, so the victim is silently logged into the attacker's account, then enters personal data (payment details, documents) that the attacker later retrieves. Protect the login form with a CSRF token too, even though the user is not yet authenticated.
- **Logout CSRF.** Forging a logout is low-severity but annoying and can be chained (log the victim out, then present a fake login page). Protect the logout endpoint with the same token or require a POST plus SameSite.

## How to verify the fix

Replay the forged request without a token. With protection in place it is rejected:

```bash
# Simulated cross-site POST: session cookie present, no CSRF token.
curl -i -X POST http://localhost:3000/account/email \
  -H 'content-type: application/x-www-form-urlencoded' \
  -b 'session=valid-session-id' \
  -d 'email=attacker@evil.example'
```

```text
HTTP/1.1 403 Forbidden
{"error":"invalid csrf token"}
```

The legitimate SPA flow fetches a token first and sends it back, which succeeds:

```bash
TOKEN=$(curl -s -c jar http://localhost:3000/csrf-token | node -e 'process.stdin.once("data",d=>process.stdout.write(JSON.parse(d).token))')
curl -i -X POST http://localhost:3000/account/email \
  -b jar -H "x-csrf-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"me@app.example.com"}'
# => 200 {"ok":true}
```

```js title="test/csrf.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

test('a state change without a token is rejected', async () => {
  const res = await request(createApp())
    .post('/account/email')
    .set('Cookie', 'session=valid-session-id')
    .type('form')
    .send({ email: 'attacker@evil.example' })
  assert.equal(res.status, 403)
})

test('a request carrying the issued token succeeds', async () => {
  const agent = request.agent(createApp())
  const { body } = await agent.get('/csrf-token')
  const res = await agent
    .post('/account/email')
    .set('x-csrf-token', body.token)
    .send({ email: 'me@app.example.com' })
  assert.equal(res.status, 200)
})
```

## Common mistakes

- **Believing CORS stops CSRF.** CORS gates reads; the forged write is still sent. Use SameSite or a token.
- **Exposing state changes over `GET`.** `SameSite=Lax` still sends the cookie on top-level GET navigations, and GETs are trivially forged with an `<img>`. All writes are POST/PUT/PATCH/DELETE.
- **Relying on JSON content type as the whole defense.** It only forces a preflight, and it collapses if any route also accepts form/text bodies. It is a bonus, not a control.
- **Using `csurf`.** It is archived and unmaintained. Use `csrf-csrf` or a session-bound synchronizer token.
- **Forgetting login CSRF.** An unauthenticated login form still needs a token, or the victim ends up in the attacker's account.
- **Assuming bearer-token APIs need CSRF tokens.** If auth is an `Authorization` header your code attaches and there is no auth cookie, CSRF does not apply — adding tokens there is noise.
- **`SameSite` without `Secure`.** Modern browsers require `Secure` for `SameSite=None` and increasingly distrust non-secure cookies. Set both.

## Production considerations

- Prefer stateless bearer tokens for pure APIs consumed by SPAs and mobile clients; the CSRF question disappears with the auth cookie. Reserve cookie sessions for server-rendered apps and protect them with SameSite plus a token.
- Scope the CSRF cookie tightly (`__Host-` prefix, `path=/`, `secure`) so it cannot be set or read from a subdomain an attacker might control.
- Rotate the CSRF secret like any other secret, and issue tokens bound to the session so a token cannot be reused across users.

## Related topics

- [CORS misconfiguration](cors-misconfiguration.md) — why CORS and CSRF are different problems that people conflate.
- [Cross-site scripting (XSS)](xss.md) — XSS reads your CSRF token, so an XSS hole defeats CSRF defenses.
- [Authentication and session security](authentication-and-session-security.md) — session cookie lifecycle and flags.
- [Cookies](../express-libraries/cookies.md) — `sameSite`, `secure`, `httpOnly` and cookie prefixes.
