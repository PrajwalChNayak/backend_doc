---
title: Static files
description: Serving files with express.static in Express 5, the new dotfiles default that breaks /.well-known, caching headers, and safe use of res.sendFile.
status: current
updated: 2026-09-08
---

`express.static()` maps a URL prefix onto a directory on disk. It is middleware like any other: if the file exists it responds, and if it does not it calls `next()` and your routes get a chance. Express 5 changed one default here — hidden files and directories are now ignored — and that single change breaks ACME certificate renewal for anyone who does not know about it.

## Basic example

```js title="src/app.js"
import express from 'express'
import path from 'node:path'

const app = express()

// Serve ./public at the site root: ./public/logo.svg -> GET /logo.svg
app.use(express.static(path.join(import.meta.dirname, '..', 'public')))

// Or under a prefix: ./public/app.js -> GET /static/app.js
app.use('/static', express.static(path.join(import.meta.dirname, '..', 'public')))
```

`import.meta.dirname` is the ESM equivalent of `__dirname`, available from Node 20.11. Always build an absolute path: a relative string is resolved against `process.cwd()`, so the app serves different files depending on which directory you started it from.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `dotfiles` | `'ignore'` | `'allow'`, `'deny'` (403) or `'ignore'` (404) for paths containing a dot-prefixed segment |
| `index` | `'index.html'` | file served for a directory request; `false` disables it |
| `fallthrough` | `true` | on a miss, call `next()` instead of responding 404 |
| `maxAge` | `0` | `Cache-Control: max-age` in ms or an ms-style string |
| `immutable` | `false` | adds `immutable` to `Cache-Control` (only meaningful with `maxAge`) |
| `etag` | `true` | send an `ETag` for conditional requests |
| `lastModified` | `true` | send `Last-Modified` |
| `extensions` | `false` | array of extensions to try when the path has none |
| `redirect` | `true` | redirect a directory URL without a trailing slash |
| `setHeaders` | — | `(res, path, stat)` hook to set headers per file |

## The `.well-known` breakage

Express 5's `express.static()` defaults to `dotfiles: 'ignore'`, and — this is the part that surprises people — the check now applies to **hidden directories anywhere in the path**, not just the final filename. `/.well-known/acme-challenge/token` contains the segment `.well-known`, so it returns 404.

The consequences are real: Let's Encrypt HTTP-01 validation fails, `security.txt` disappears, Apple and Android app-association files stop resolving, and OpenID discovery documents 404.

```bash
curl -i https://example.com/.well-known/acme-challenge/test
```

```text
HTTP/1.1 404 Not Found      (Express 5, default express.static options)
```

The fix is one line, mounted **before** the general static middleware:

```js title="src/app.js"
// Serve the well-known directory explicitly, with dotfiles allowed.
app.use('/.well-known', express.static('public/.well-known', { dotfiles: 'allow' }))

// Everything else keeps the safe default.
app.use(express.static('public'))
```

:::warning
Do not "fix" this by setting `dotfiles: 'allow'` on the main static mount. That exposes every dot-prefixed file under the served directory — `.env`, `.git/config`, `.npmrc`, `.aws/credentials` — to anyone who guesses the name. Scope the exception to `/.well-known` and nothing else.
:::

## Caching

Static assets are the cheapest caching win in any app, and the correct settings depend entirely on whether the URL is content-addressed.

```js
// Fingerprinted build output: app.4f3a91.js never changes meaning.
app.use('/assets', express.static('dist/assets', {
  maxAge: '1y',
  immutable: true,
  index: false,
}))

// Hand-written files whose URL is stable: revalidate every time.
app.use(express.static('public', { maxAge: 0, etag: true }))
```

`immutable` tells the browser not to revalidate at all for the lifetime of `max-age` — no conditional request, not even on reload. It is correct only when the filename contains a content hash, because you can never change the file's contents afterwards. Applying it to `/logo.svg` means users see the old logo for a year.

`etag` and `lastModified` make a miss cheap rather than free: the browser sends `If-None-Match` and gets a 304 with no body. Leave them on.

:::note
`.js` files are now served as `text/javascript` rather than `application/javascript`. Both are valid and browsers treat them identically; the change comes from an updated `mime-db`. If a test asserts on the exact content type, that assertion needs updating.

The `mime` property that used to hang off the static middleware was removed in Express 5. Use the `mime-types` package directly if you need to look a type up.
:::

## `fallthrough` and 404 behavior

With the default `fallthrough: true`, a missing file falls through to your routes — which is what makes a single-page-app fallback work:

```js
app.use(express.static('public'))          // real files win
app.use('/api', apiRouter)

// Everything else renders the SPA shell. Note the Express 5 catch-all syntax.
app.get('/{*splat}', (req, res) => {
  res.sendFile('index.html', { root: 'public' })
})
```

Set `fallthrough: false` on a mount that should be authoritative — an `/assets` prefix, say — so a missing asset 404s immediately instead of walking the rest of your stack and possibly returning HTML for a `.js` request.

## `res.sendFile` and path traversal

`res.sendFile()` sends one file. It requires either an absolute path or the `root` option, and `root` is also the security boundary:

```js
app.get('/downloads/*path', (req, res) => {
  // req.params.path is an ARRAY of decoded segments in Express 5.
  const relative = req.params.path.join('/')
  res.sendFile(relative, { root: path.join(import.meta.dirname, '..', 'storage') })
})
```

With `root` set, a path that escapes the root — `../../etc/passwd`, or an absolute path — is rejected rather than served. Verify it:

```bash
curl -i 'http://localhost:3000/downloads/../../package.json'
curl -i 'http://localhost:3000/downloads/%2e%2e%2f%2e%2e%2fpackage.json'
```

Both must return 403, not 200.

If you build the path yourself instead, resolve it and check containment explicitly:

```js
import path from 'node:path'

const ROOT = path.resolve('storage')

app.get('/downloads/*path', (req, res, next) => {
  const target = path.resolve(ROOT, req.params.path.join('/'))
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return res.sendStatus(403)
  }
  res.sendFile(target, next)   // pass next: a send error becomes an Express error
})
```

`path.join` alone is not a defense — it happily resolves `..` and walks out of the directory. Only comparing the *resolved* path against the *resolved* root is.

`res.sendFile()` accepts `root`, `maxAge`, `lastModified`, `headers`, `dotfiles`, `acceptRanges`, `cacheControl` and `immutable`. The Express 4 `hidden` and `from` options were removed — use `dotfiles` and `root`.

## Security considerations

- **Never point `express.static()` at the project root.** `app.use(express.static('.'))` serves `package.json`, `node_modules`, and every source file, including anything with a credential in it. Serve a dedicated `public/` directory that contains only public files.
- **Keep `dotfiles: 'ignore'`** everywhere except an explicit `/.well-known` mount.
- **Uploads are not static assets.** A directory users can write to must never be served with `express.static()` — an uploaded `.html` file becomes stored XSS on your origin, and an uploaded `.js` file becomes a script your CSP trusts. Serve user content from a separate origin or through a handler that forces `Content-Disposition: attachment` and a safe content type. See [File upload security](../security/file-upload-security.md).
- **Directory listings are not a feature Express provides**, and you should not add one. It turns a guessing game into a catalog.
- **Set security headers before the static mount** so they apply to assets too — [Helmet](../express-libraries/security-headers-helmet.md) registered first covers everything below it.

## Production considerations

Node is not the fastest way to send a file, and every static request occupies the same event loop as your API. In production put something in front:

| Serving strategy | When it fits |
| --- | --- |
| CDN in front of object storage | public assets with a hashed filename — the usual answer |
| nginx / a reverse proxy | you already run one; it sends files with `sendfile()` and never touches Node |
| `express.static()` | development, internal tools, small deployments, and the `/.well-known` exception |

Keep the `express.static()` mount in the app anyway so local development needs no extra infrastructure — it simply stops being on the hot path once a CDN is in front.

Enable [compression](../express-libraries/compression.md) at the proxy or CDN rather than in Node when you can; compressing every asset in-process burns CPU that your handlers need. And make sure the cache key is right: a CDN caching a response that varies on `Accept-Encoding` without a matching `Vary` header serves Brotli bytes to a client that cannot read them.

## Common mistakes

- **Serving `/.well-known` with the default options.** Express 5 ignores dot-prefixed directories; certificate renewal fails silently. Mount it separately with `dotfiles: 'allow'`.
- **Setting `dotfiles: 'allow'` globally** to fix the above, exposing `.env` and `.git`.
- **Passing a relative directory** to `express.static()`. It resolves against `process.cwd()`, so behavior depends on where the process was launched.
- **`immutable: true` on non-fingerprinted files.** Clients will not revalidate; the stale file sticks for the whole `max-age`.
- **Treating `req.params.path` as a string.** Wildcard params are arrays in Express 5.
- **Trusting `path.join` to contain a user path.** Resolve and compare against the root.
- **Serving the upload directory.** Uploaded HTML and JS execute on your origin.
- **Registering `express.static()` above a rate limiter or Helmet.** Assets then bypass the controls you thought were global.

## Related topics

- [Middleware](middleware.md) — `express.static()` is middleware, and its position in the stack matters.
- [Route parameters and path syntax](route-parameters-and-path-syntax.md) — wildcard params and the `'/{*splat}'` catch-all.
- [Request and response](request-and-response.md) — `res.sendFile`, `res.download` and header helpers.
- [Templating](templating.md) — when you need generated HTML rather than files on disk.
- [File upload security](../security/file-upload-security.md) — why user content never goes in `public/`.
- [Cross-site scripting (XSS)](../security/xss.md) — the payoff of an uploaded `.html` file.
- [Security headers with Helmet](../express-libraries/security-headers-helmet.md) — headers that must cover assets too.
- [Compression](../express-libraries/compression.md) — where compressing assets belongs.
- [Performance](../production/performance.md) — why a CDN beats a Node process at this job.
