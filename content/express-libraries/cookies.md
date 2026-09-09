---
title: Cookies
description: Reading and setting cookies in Express 5 with cookie-parser, every attribute that matters, the __Host- and __Secure- prefixes, and clearing cookies correctly.
status: current
updated: 2026-09-08
---

A cookie is a small piece of state the browser stores and then attaches to every matching request automatically. That automatic attachment is what makes cookies convenient for sessions and what makes them the reason CSRF exists. The attributes you set decide which of those two dominates.

## Why it exists

Express can set a cookie out of the box with `res.cookie()`, but it does not parse the inbound `Cookie` header. `cookie-parser` populates `req.cookies`, and — with a secret — `req.signedCookies`.

## Installation

:::tabs
@tab npm
```bash
npm install cookie-parser@1
```
@tab pnpm
```bash
pnpm add cookie-parser@1
```
@tab yarn
```bash
yarn add cookie-parser@1
```
:::

## Basic example

```js title="src/app.js"
import express from 'express'
import cookieParser from 'cookie-parser'

const app = express()

app.use(cookieParser(process.env.COOKIE_SECRET))

app.get('/set', (req, res) => {
  res.cookie('theme', 'dark', {
    httpOnly: false, // the client script needs to read this one
    secure: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  })
  res.status(204).end()
})

app.get('/read', (req, res) => {
  res.json({
    plain: req.cookies, // { theme: 'dark' }
    signed: req.signedCookies, // {} until you set a signed cookie
  })
})

export default app
```

Without a secret, `cookieParser()` still populates `req.cookies`; `req.signedCookies` stays empty and `res.cookie(..., { signed: true })` throws.

## Attributes

`res.cookie(name, value, options)` accepts:

| Option | What it does |
| --- | --- |
| `httpOnly` | The cookie is invisible to `document.cookie`. Set it on anything the client script does not need. |
| `secure` | The browser sends the cookie only over HTTPS. |
| `sameSite` | `'lax'`, `'strict'`, `'none'`, or a boolean. Controls whether the cookie is attached to cross-site requests. |
| `domain` | Which host(s) receive it. Omitted means "this exact host only" — which is the safer default. |
| `path` | URL prefix that must match. Defaults to `/`. |
| `maxAge` | Lifetime in **milliseconds**, relative to now. Express converts it to `Expires`. |
| `expires` | An absolute `Date`. Prefer `maxAge`. |
| `partitioned` | Stores the cookie under the top-level site as well as its own — the CHIPS proposal, for third-party contexts. |
| `priority` | `'low'`, `'medium'` or `'high'`. A hint for which cookies a browser evicts first. |
| `signed` | Appends an HMAC so tampering is detectable. Requires a `cookie-parser` secret. |
| `encode` | The value encoder. Defaults to `encodeURIComponent`. |

Omitting both `maxAge` and `expires` produces a **session cookie**: the browser deletes it when it closes. That is often the right choice for authentication, and it is not a security boundary — many browsers restore session cookies after a crash or when "continue where you left off" is enabled.

### `sameSite`

This is the attribute that matters most for security.

| Value | Sent on cross-site requests? | Use for |
| --- | --- | --- |
| `'strict'` | Never — not even a top-level link from another site | Cookies where following a link should not act as you (an admin panel) |
| `'lax'` | Only on top-level `GET` navigations | **The default choice for session cookies.** Blocks cross-site `POST`, which removes most CSRF |
| `'none'` | Always | Genuine third-party contexts only. **Requires `secure: true`** or the browser drops the cookie |

`'lax'` is the right answer for a first-party session cookie. It keeps the login working when a user clicks a link from an email, and it stops a cross-site form post from carrying the session.

:::warning
`sameSite: 'lax'` is *not* complete CSRF protection. It does not cover a cross-site `GET` that has a side effect (which is why `GET` should never mutate), it does not apply between subdomains of the same site, and browser defaults vary. Pair it with a CSRF token for state-changing routes — `csrf-csrf` 4.0.3 implements the double-submit pattern (`csurf` is archived and must not be used). See [CSRF](../security/csrf.md).
:::

Setting `sameSite: 'none'` for a cross-origin SPA re-enables everything `'lax'` was blocking. If your frontend and API are on genuinely different sites, you need `none; Secure` *and* a CSRF token *and* a correct CORS `credentials` configuration — see [CORS](cors.md).

### `domain` widens, never narrows

Omitting `domain` produces a **host-only** cookie: only the exact host that set it receives it. Setting `domain: '.example.com'` sends it to `example.com` and every subdomain.

That is a real expansion of the trust boundary. Any subdomain — including one that is really a CNAME to a third-party SaaS, or one an attacker took over after you deleted the service but not the DNS record — now receives the cookie on every request. Subdomain takeover turns directly into session theft.

Omit `domain` unless you actively need cross-subdomain sharing.

## `__Host-` and `__Secure-` prefixes

Cookie attributes are not visible to the server on the way back — the `Cookie` header contains only names and values. A cookie planted by a subdomain or over plain HTTP looks identical to one you set. The prefixes fix that by making the browser enforce rules at set time based on the **name**.

| Prefix | The browser rejects the `Set-Cookie` unless… |
| --- | --- |
| `__Secure-` | `Secure` is set and the origin is secure |
| `__Host-` | `Secure` is set, the origin is secure, **`Domain` is absent**, and `Path` is exactly `/` |

`__Host-` is the strong one. Because `Domain` must be absent, a `__Host-` cookie is host-locked: no subdomain can set or overwrite it, so subdomain takeover and cookie-tossing attacks cannot forge it.

```js title="src/auth/session.js"
res.cookie('__Host-sid', sessionId, {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/', // required, exactly '/'
  // NO domain option — required
  maxAge: 24 * 60 * 60 * 1000,
})
```

The prefix is part of the name everywhere: reading it is `req.cookies['__Host-sid']`, and clearing it is `res.clearCookie('__Host-sid', { path: '/' })`.

The one cost is local development over `http://localhost`, where `Secure` cookies are generally accepted by browsers but the rest of the constraint set can still bite. Gate the prefix on the environment if it gets in the way, and make sure production uses it.

## Signed cookies

A signed cookie carries an HMAC of its value. `cookie-parser` verifies it and, on success, puts the value in `req.signedCookies`; a tampered cookie is rejected and appears as `false`.

```js
app.use(cookieParser(process.env.COOKIE_SECRET))

app.post('/prefs', (req, res) => {
  res.cookie('prefs', JSON.stringify({ theme: 'dark' }), {
    signed: true,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  })
  res.status(204).end()
})

app.get('/prefs', (req, res) => {
  const raw = req.signedCookies.prefs // undefined if absent, false if tampered
  if (!raw) return res.status(400).json({ error: 'bad_cookie' })
  res.json(JSON.parse(raw))
})
```

:::danger
Signing provides **integrity, not confidentiality**. The value is stored as `s:<value>.<signature>` and the value part is plainly readable in the browser's developer tools. Never put anything secret in a cookie, signed or not — the signature stops modification, not reading.
:::

`cookie-parser` accepts an array of secrets. The first is used to sign; all of them are tried when verifying, which is how you rotate without logging everyone out:

```js
app.use(cookieParser([process.env.COOKIE_SECRET_NEW, process.env.COOKIE_SECRET_OLD]))
```

Note that `express-session` manages its own cookie and its own signing. You do not need `cookie-parser` for sessions, though having it is harmless — just do not configure two different secrets and expect one to verify the other's cookies.

## The 4 KB limit

Browsers cap a single cookie at roughly **4096 bytes** for name plus value plus attributes, and also cap the number of cookies per domain (around 180 in Chromium) and the total size sent per domain.

The failure mode is silent. Set a 5 KB cookie and the browser simply does not store it; the next request arrives with no cookie at all and your code sees an anonymous user with no error anywhere.

Every cookie is also sent on **every** matching request, including requests for images and scripts. A 3 KB cookie on a page with 40 assets is 120 KB of upstream traffic per page load, on connections where upstream bandwidth is the scarce resource.

The rule: cookies hold an **identifier**, and the data lives server-side. A 32-byte session ID pointing at a Redis record is the pattern; a JSON blob of user state in a cookie is not.

If you genuinely need more, `cookie-session` 2.1.1 stores the session in the cookie itself — accepting the size limit, the lack of server-side revocation, and the fact that the payload is readable by the user.

## Clearing cookies

```js
res.clearCookie('__Host-sid', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' })
```

Two Express 5 behaviors to internalize:

:::warning
**`res.clearCookie()` ignores `maxAge` and `expires` entirely.** It always sets an expiry in the past; passing your own is silently discarded.

**The browser only removes a cookie when `path` and `domain` match those used to set it.** `res.cookie('sid', v, { path: '/admin' })` followed by `res.clearCookie('sid')` clears nothing — the second call targets `path=/`, a different cookie as far as the browser is concerned, and the original keeps being sent.
:::

The practical discipline is to define the cookie options **once** and reuse them for both calls:

```js title="src/auth/cookie-options.js"
export const SESSION_COOKIE = '__Host-sid'

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
}
```

```js title="src/routes/auth.js"
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '../auth/cookie-options.js'

res.cookie(SESSION_COOKIE, id, { ...SESSION_COOKIE_OPTIONS, maxAge: 86_400_000 })
// …later…
res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS)
```

Logging out must also destroy the server-side session. Clearing the cookie only asks the browser to forget it — anyone who already copied the value still holds a valid session until the record is gone. See [Authentication](authentication.md).

## Security considerations

**`httpOnly` on everything the client script does not read.** It is the difference between an XSS that defaces a page and an XSS that steals every session.

**`secure` always in production.** Without it the cookie is sent over plain HTTP and is readable by anyone on the path; HSTS reduces but does not eliminate the window.

**`sameSite: 'lax'` as the floor, plus a CSRF token for state-changing routes.**

**Prefer `__Host-`.** It is the only mechanism that lets the server know a cookie was not planted by a subdomain or over HTTP.

**Omit `domain`.** Sharing a session cookie across subdomains means every subdomain is part of your session's trust boundary.

**Never store secrets, tokens, or personal data in a cookie value.** It is readable by the user, by any script if not `httpOnly`, and it appears in browser storage, in some proxy logs, and in crash dumps.

**Signed does not mean encrypted.** Integrity only.

**Rotate `COOKIE_SECRET` with an array,** and treat it like any other secret — see [Secrets management](../security/secrets-management.md).

**Validate cookie values as untrusted input.** A cookie is client-supplied. If you parse JSON out of one, wrap it, bound its size, and validate the result with a schema — see [Validation](validation.md).

**Do not put a session identifier in a URL** as a cookie fallback. It leaks through `Referer`, logs, and shared links.

## Production considerations

**`secure: true` behind a TLS-terminating proxy needs `app.set('trust proxy', 1)`.** Otherwise Express sees an HTTP connection from the load balancer and refuses to set the cookie. The symptom is "login works locally and does nothing in production", with no error.

**Keep cookies small and few.** They are upstream bytes on every request to the matching path, including static assets. Serving assets from a cookie-less domain is a classic and still-valid optimization.

**Cookies and caching interact.** A response that varies by cookie must say so, or a shared cache will serve one user's page to another. `Vary: Cookie` is expensive for CDN hit rates — prefer keeping personalized responses uncacheable and cacheable responses cookie-independent.

**Third-party cookie deprecation.** Browsers are removing cross-site cookies. If a cookie of yours is set in a third-party context — an embedded widget, an iframe — it needs `SameSite=None; Secure` and, increasingly, `partitioned: true` (CHIPS), which scopes it per top-level site. Note that `Partitioned` is not yet fully standardized and older clients ignore it.

**Plan for cookies simply not arriving.** Users clear them, privacy modes drop them, extensions block them, and a size-limit violation silently discards them. Handle "no cookie" as a normal anonymous path, not an error.

**Verify what you actually send:**

```bash
curl -i https://api.example.com/login -X POST -d '…' | grep -i set-cookie
```

Check for `HttpOnly`, `Secure`, `SameSite`, the absence of `Domain`, and the `__Host-` prefix.

## Common mistakes

- **Forgetting `httpOnly`.** Any XSS becomes session theft.
- **`sameSite: 'none'` without `secure: true`.** The browser rejects the cookie outright.
- **Setting `domain: '.example.com'` by habit.** Every subdomain now receives your session cookie.
- **Believing a signed cookie is encrypted.** The value is right there in the developer tools.
- **`res.clearCookie(name)` with different options than `res.cookie` used.** The cookie survives.
- **Passing `maxAge` to `clearCookie`.** Express 5 ignores it.
- **Storing user data in a cookie until it crosses 4 KB.** The browser silently drops it and you debug a phantom logout.
- **Using `__Host-` with a `domain` option or a non-root `path`.** The browser rejects the whole `Set-Cookie`.
- **`secure: true` behind a proxy without `trust proxy`.** No cookie is ever set in production.
- **Clearing the cookie on logout but not destroying the session.** A copied session ID still works.
- **Reaching for `csurf`.** It is archived and unmaintained; use `csrf-csrf` or a session-bound token.
- **Treating a cookie value as trusted input.** It is as attacker-controlled as a query string.

## Related topics

- [CSRF](../security/csrf.md) — the attack that cookie auto-attachment enables, and the token patterns that stop it.
- [Authentication](authentication.md) — session cookies, `express-session`, and logout done properly.
- [CORS](cors.md) — credentialed cross-origin requests and why they force `SameSite=None`.
- [Security headers with Helmet](security-headers-helmet.md) — HSTS, which underpins `Secure`.
- [Validation](validation.md) — cookies are input and deserve a schema.
- [Secrets management](../security/secrets-management.md) — where `COOKIE_SECRET` lives and how to rotate it.
