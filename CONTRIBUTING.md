# Contributing / Authoring Guide

**Every author (human or agent) must read this file completely before writing a single
line of content.** It is the contract for the whole site: verified version facts,
Markdown dialect, page shape, and the rules the validators enforce.

Last fact-verification pass: **2026-09-08**, against the live npm registry
(`registry.npmjs.org`), `nodejs.org/dist/index.json`, the
[nodejs/Release schedule](https://github.com/nodejs/Release/blob/main/schedule.json),
and the official [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html).

---

## 1. Verified facts — use these, do not invent others

### 1.1 Node.js release state (verified 2026-09-08)

| Line | Latest release | Status **today** | Becomes / became LTS | End of life |
| --- | --- | --- | --- | --- |
| Node 26 | 26.8.1 | **Current** (not yet LTS) | 2026-10-28 | 2029-04-30 |
| Node 24 "Krypton" | 24.20.0 | **Active LTS** | 2025-10-28 | 2028-04-30 |
| Node 22 "Jod" | 22.23.2 | **Maintenance LTS** | 2024-10-29 | 2027-04-30 |
| Node 20 "Iron" | 20.20.2 | **End of life** | — | 2026-04-30 (passed) |

> **Correction to the original brief.** The brief listed Node 26 as Active LTS. As of
> 2026-09-08 Node 26 is still **Current**; it enters Active LTS on **2026-10-28**.
> Node 24 is the only Active LTS line right now. Write it that way.

**Target Node 24 LTS.** Never recommend Node 18 or 20 for new work — both are EOL.
Where a feature needs a newer runtime than 24, say so explicitly with the version gate.

Modern built-ins to prefer and to cover:

| Feature | Stable / available from | Notes |
| --- | --- | --- |
| `node --env-file=.env` | 20.6 (flag), stabilised in 24 | `--env-file-if-exists` also available |
| `node:test` runner | 20 (stable) | Use with `node --test`, `--test-reporter`, `--experimental-test-coverage` / `--test-coverage-*` on 24 |
| `node:sqlite` | 22.5 (experimental), 24 (stable enough to teach) | Synchronous, bundled, no native build |
| TypeScript type-stripping | 22.6 behind a flag, **unflagged from 23.6 / 24** | Strips types only; `enum`, `namespace`, decorators and other emitting syntax need `--experimental-transform-types` |
| `fetch`, `Headers`, `Request`, `Response` | 18 (global), stable in 21+ | Backed by undici |
| `AbortController` / `AbortSignal.timeout()` | 16 / 17.3 | Use for request timeouts |
| Web Streams (`ReadableStream`) | 18+ | Interop via `stream.Readable.fromWeb()` / `.toWeb()` |
| `structuredClone`, `globalThis.crypto` | 17 / 19 | |
| `node --watch`, `--watch-path` | 22 stable | Replaces `nodemon` for most cases |

Do **not** claim a feature is stable unless you can point to the Node version above.
If unsure, write "available from Node X" rather than "stable".

### 1.2 Express (verified 2026-09-08)

- **express `5.2.1`** is the current release (published 2025-12-01). `express@4` is
  still published (4.22.2) but is **Legacy** here — it appears only in
  `content/reference/express-4-to-5-migration.md`.
- `express@5.2.1` declares `engines.node: ">= 18"`. We still target Node 24.
- `body-parser` is bundled: use `express.json()`, `express.urlencoded()`,
  `express.text()`, `express.raw()`. Do not tell readers to install `body-parser`.
- Express 5 uses `path-to-regexp@8` via the separate `router` package.

#### Express 5 breaking changes — reflect these in EVERY example

**Removed (using them throws or 404s):**

| Removed | Replacement |
| --- | --- |
| `app.del()` | `app.delete()` |
| `app.param(fn)` (one-arg form) | `app.param(name, fn)` |
| `req.param(name)` | read `req.params` / `req.body` / `req.query` explicitly |
| `req.acceptsCharset/Encoding/Language()` | pluralised `...Charsets/Encodings/Languages()` |
| `res.json(obj, status)` | `res.status(status).json(obj)` |
| `res.jsonp(obj, status)` | `res.status(status).jsonp(obj)` |
| `res.send(body, status)` | `res.status(status).send(body)` |
| `res.send(status)` (number) | `res.sendStatus(status)` |
| `res.redirect(url, status)` | `res.redirect(status, url)` — **argument order flipped** |
| `res.redirect('back')`, `res.location('back')` | `res.redirect(req.get('Referrer') ?? '/')` |
| `res.sendfile()` | `res.sendFile()` |
| `hidden` / `from` options on `res.sendFile()` and `express.static()` | `dotfiles` / `root` |
| `express.static.mime` | the `mime-types` package |
| `router.param(fn)` | `router.param(name, fn)` |
| `router.param([names], fn)` (array) | one `router.param(name, fn)` call per name (`app.param()` still takes an array) |

**Changed behaviour:**

- **Rejected promises are forwarded to the error handler automatically.** An `async`
  handler that throws or awaits a rejected promise reaches the error middleware as if
  you had called `next(err)`. **Never** teach `express-async-handler`, `asyncHandler`
  wrappers, or manual `.catch(next)` for this. (Manual `.catch(next)` is still correct
  inside a *non-async* callback such as a stream `'error'` listener — that's different.)
- **Path matching (path-to-regexp v8):**
  - `'/*'` is invalid → `'/*splat'` (does not match `/`) or `'/{*splat}'` (does).
  - `'/:file.:ext?'` is invalid → `'/:file{.:ext}'`.
  - Regex-in-string like `'/[discussion|page]/:slug'` is invalid → pass an array:
    `['/discussion/:slug', '/page/:slug']`.
  - `(`, `)`, `[`, `]`, `?`, `+`, `!` are reserved — escape with `\` if literal.
  - Parameter names must be valid JS identifiers, or quoted: `:"weird-name"`.
- `req.params` has a **null prototype** for string paths; wildcard params are
  **arrays** (`{ splat: ['foo','bar'] }`); unmatched params are **omitted** entirely.
- `req.body` is **`undefined`** when no body parser ran (Express 4 gave `{}`).
- `req.query` is a **getter**, not writable. Default parser is **`'simple'`**, not
  `'extended'` — opt back in with `app.set('query parser', 'extended')`.
- `express.urlencoded()` defaults to **`extended: false`**.
- `express.static()` defaults to **`dotfiles: 'ignore'`**, and the check now applies to
  hidden *directories* in the path. `/.well-known/...` returns 404 by default. Fix:
  `app.use('/.well-known', express.static('public/.well-known', { dotfiles: 'allow' }))`.
- `req.host` **includes the port** (Express 4 stripped it). `req.hostname` does not.
- `res.status()` accepts integers **100–999** only; anything else throws.
- `res.vary()` throws when the field argument is missing.
- `res.clearCookie()` ignores `maxAge` and `expires`.
- `app.listen()` passes a server `'error'` **to the callback** instead of throwing:
  `app.listen(3000, (err) => { if (err) throw err })`.
- `app.router` exists again as a reference to the base router.
- `res.render()` is always asynchronous now.
- `express.json()` / `urlencoded()` / `text()` / `raw()` accept **Brotli** (`br`)
  request bodies in addition to gzip and deflate.
- Debug namespaces moved: `DEBUG=express:*,router,router:*`.
- `.js` is now served as `text/javascript` (updated `mime-db`).

### 1.3 Package versions (npm `dist-tags.latest`, fetched 2026-09-08)

Pin these in prose and in `examples/*/package.json`. Use a caret range (`^`) in
`package.json` and the bare version in prose.

| Package | Latest | Notes |
| --- | --- | --- |
| `express` | 5.2.1 | Current |
| `helmet` | 8.3.0 | |
| `cors` | 2.8.6 | |
| `express-rate-limit` | 8.7.0 | |
| `rate-limit-redis` | 6.0.1 | store for the above |
| `zod` | 4.5.4 | Zod 4 API — `z.email()`, not `z.string().email()` |
| `express-validator` | 7.3.2 | |
| `jsonwebtoken` | 9.0.3 | |
| `jose` | 6.2.12 | preferred for JWKS / modern JWT |
| `argon2` | 0.45.1 | native build required |
| `bcrypt` | 6.0.0 | |
| `passport` | 0.7.0 | |
| `passport-jwt` | 4.0.1 | |
| `passport-local` | 1.0.0 | |
| `express-session` | 1.19.0 | |
| `connect-redis` | 10.0.0 | |
| `connect-mongo` | 6.0.0 | |
| `cookie-parser` | 1.4.7 | |
| `cookie-session` | 2.1.1 | |
| `csrf-csrf` | 4.0.3 | `csurf` is **archived/deprecated** — never recommend it |
| `compression` | 1.8.1 | |
| `pino` | 10.3.1 | |
| `pino-http` | 11.0.0 | |
| `pino-pretty` | 13.1.3 | dev only |
| `morgan` | 1.12.0 | |
| `winston` | 3.19.0 | |
| `supertest` | 7.2.2 | |
| `swagger-ui-express` | 5.0.1 | |
| `@asteasolutions/zod-to-openapi` | 9.1.0 | |
| `zod-openapi` | 6.0.2 | alternative |
| `express-openapi-validator` | 5.6.2 | |
| `multer` | **2.3.0** | **multer 1.x is EOL and deprecated on npm** — see below |
| `file-type` | 22.0.2 | ESM-only; magic-byte sniffing |
| `sharp` | 0.35.4 | image re-encode |
| `@aws-sdk/client-s3` | 3.1127.0 | |
| `dotenv` | 17.4.2 | prefer `node --env-file` |
| `http-errors` | 2.0.1 | |
| `validator` | 13.15.35 | |
| `sanitize-html` | 2.17.7 | |
| `dompurify` | 3.4.15 | |
| `bullmq` | 6.3.4 | |
| `node-cron` | 4.6.0 | |
| `pm2` | 7.0.4 | |
| `typescript` | 7.0.2 | |
| `tsx` | 4.23.13 | |
| `eslint` | 10.10.0 | |
| `vitest` | 5.0.0 | we prefer `node:test` |
| `@types/express` | 5.0.6 | matches Express 5 |
| `undici` | 8.10.2 | |
| `nanoid` | 6.0.1 | ESM-only |
| `uuid` | 14.0.2 | prefer `crypto.randomUUID()` |

**Databases and drivers**

| Package | Latest | Notes |
| --- | --- | --- |
| `pg` | 8.23.0 | |
| `mysql2` | 3.24.4 | use `mysql2/promise` |
| `better-sqlite3` | 13.0.3 | native build; prefer `node:sqlite` when you can |
| `sqlite3` | 6.0.1 | legacy async driver, prefer the two above |
| `mongodb` | 7.6.0 | |
| `redis` (node-redis) | 6.2.1 | |
| `ioredis` | 6.0.0 | |

**ORMs and query builders**

| Package | Latest **stable** | npm `latest` tag | Notes |
| --- | --- | --- | --- |
| `prisma` | **7.10.0** | `8.0.0-rc.13` | ⚠️ the `latest` **dist-tag points at a release candidate**. Document 7.10.0 and say so. |
| `@prisma/client` | 7.10.0 | 7.10.0 | stays on 7 |
| `drizzle-orm` | 0.45.2 | 0.45.2 | `1.0.0-rc.4` exists on the `rc` tag |
| `drizzle-kit` | 0.31.10 | 0.31.10 | |
| `typeorm` | 1.1.1 | 1.1.1 | TypeORM reached 1.0 — do **not** write `0.3.x` |
| `sequelize` | 6.37.8 | 6.37.8 | v7 still alpha |
| `sequelize-cli` | 6.6.5 | 6.6.5 | |
| `mongoose` | 9.9.5 | 9.9.5 | |
| `knex` | 3.3.0 | 3.3.0 | |
| `kysely` | 0.29.5 | 0.29.5 | mention only |
| `objection` | 3.1.5 | 3.1.5 | mention only; low activity |

**Packages that must be named as deprecated / never recommended**

| Package | Why |
| --- | --- |
| `multer@1.x` (`1.4.5-lts.2`) | npm-deprecated: *"Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x."* |
| `csurf` | archived, unmaintained → use `csrf-csrf` or a session-bound double-submit token |
| `express-async-handler` | unnecessary in Express 5 |
| `request` | long dead → `fetch` / `undici` |
| `prom-client` | npm-deprecated in favour of `@prometheus-io/client` |
| `oslo` | npm-deprecated, superseded by oslojs.dev |
| `zod-to-openapi` (unscoped) | deprecated → `@asteasolutions/zod-to-openapi` |

### 1.4 The "never invent" rule

If you cannot verify an API, an option name, or a package from official docs or the
registry, **leave it out** and add a line to `docs-notes/unverified.md` (create it if
needed) so it lands in the final "Remaining issues" report. A confidently wrong option
name is worse than an omission.

---

## 2. Repository layout

```
content/            Markdown source — the only place you author
  <section-dir>/<page>.md
scripts/
  nav.mjs           SINGLE SOURCE OF TRUTH for the sidebar. Add pages here.
  build.mjs         content/ -> docs/   (plain Node ESM, zero npm deps)
  check.mjs         structural + Express-4-API validator
  lint-sql.mjs      SQL-injection linter (docs + examples)
  check-deps.mjs    npm existence / version-drift checker
  run-examples.mjs  boots the example apps and exercises routes
  lib/              generator internals (markdown, highlight, template)
docs/               GENERATED. Never hand-edit. Served by GitHub Pages.
examples/           runnable apps, one folder each, own package.json + README
archive/            preserved prior work
```

**Do not hand-edit anything under `docs/`.** It is regenerated by `node scripts/build.mjs`.

**Do not run `node scripts/build.mjs` while other authors are working.** The build is
run once, at the end, by the coordinator.

---

## 3. Front matter — required on every page

```markdown
---
title: Route Parameters and Path Syntax
description: How Express 5 matches paths with path-to-regexp v8, and what changed from Express 4.
status: current
updated: 2026-09-08
---
```

| Key | Required | Values |
| --- | --- | --- |
| `title` | yes | Sentence case. Must match the `nav.mjs` entry. |
| `description` | yes | One sentence, ends with a period. Used for the meta description and search. |
| `status` | yes | `current` \| `legacy` \| `deprecated` |
| `updated` | yes | `YYYY-MM-DD` |

The front matter block must be the first thing in the file. Values are plain strings —
do not quote them unless they contain a `:` followed by a space.

**Do not write an `# H1`.** The generator renders the `title` as the page `<h1>`.
Your first heading in the body is an `## H2`.

---

## 4. Page shape — enforced by `scripts/check.mjs`

Every page follows this order. Sections in *italics* are optional; the rest are required.

1. **Overview paragraph** — one to three sentences, immediately after the front matter,
   before any heading. No heading of its own.
2. `## Why it exists` *(optional on pure-reference pages)*
3. `## When to use it` / `## When not to use it` *(optional)*
4. `## Basic example` *(optional on pure-reference pages)*
5. *`## How it works`* / explanation
6. *`## Common patterns`*
7. *`## Security considerations`* — **required** on every page in
   `security/`, `express-libraries/`, `databases/`, `orms/`
8. *`## Production considerations`* — **required** on every page in
   `production/`, `databases/`, `orms/`, `express-libraries/`
9. `## Common mistakes` — **required on every page, no exceptions**
10. `## Related topics` — **required on every page, no exceptions**, and must be the
    last heading in the file.

`## Related topics` is a bullet list of relative links to other pages, each with a short
reason:

```markdown
## Related topics

- [Error handling](../express/error-handling.md) — where rejected promises end up.
- [Rate limiting](../express-libraries/rate-limiting.md) — the other half of abuse control.
```

Links between content pages are written **relative, with the `.md` extension**. The
build rewrites them to `.html`. `scripts/check.mjs` resolves every one and fails on
dangling links and dangling `#anchors`.

---

## 5. Markdown dialect

The generator implements a deliberate subset. Anything not listed here is not
supported — do not use raw HTML.

### Supported

- ATX headings `##`, `###`, `####` (no `#` — that's the title)
- Paragraphs, `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`
- Links `[text](target)`, autolinks `<https://…>`
- Unordered (`-`) and ordered (`1.`) lists, nested by two spaces
- GFM tables with a `| --- |` separator row
- Blockquotes `>`
- Thematic breaks `---` (on their own line, after a blank line)
- Fenced code blocks (see below)
- Callouts and tabs (directive blocks, see below)

### Code fences

````markdown
```js title="src/server.js"
import express from 'express'
```
````

- **Always** set a language: `js`, `ts`, `json`, `bash`, `sql`, `text`, `dockerfile`,
  `yaml`, `html`, `css`, `prisma`, `env`. Highlighting exists for js/ts/json/bash/sql;
  the rest render plain.
- `title="…"` renders a filename chip above the block. Use it whenever the snippet
  corresponds to a real file.
- **`vulnerable`** in the info string marks the block as a deliberate insecure
  demonstration. This is the *only* thing that exempts a block from the SQL-injection
  linter, and it renders with a red "Vulnerable — do not copy" banner:

  ````markdown
  ```js vulnerable title="DO NOT COPY"
  const rows = await client.query(`SELECT * FROM users WHERE id = ${req.params.id}`)
  ```
  ````
- `good` renders a green "Correct" banner. Use it for the fixed counterpart directly
  after a `vulnerable` block.

### Callouts

```markdown
:::note
Plain contextual information.
:::

:::tip Title is optional
Short actionable advice.
:::

:::best-practice
The thing you should actually do.
:::

:::warning
Something that will bite you.
:::

:::danger
A security hole. Use this for exploitable behaviour.
:::

:::deprecated
Removed or scheduled for removal. Say what to use instead.
:::

:::legacy
Express 4 / old-Node material, kept for migration context only.
:::
```

Callouts may contain paragraphs, lists and code fences. They may not nest.

### Tabs

```markdown
:::tabs
@tab npm
```bash
npm install express@5
```
@tab pnpm
```bash
pnpm add express@5
```
@tab yarn
```bash
yarn add express@5
```
:::
```

Use tabs for: package managers (`npm`/`pnpm`/`yarn`), language (`JavaScript`/`TypeScript`),
and per-database variants (`PostgreSQL`/`MySQL`/`SQLite`). Keep the tab labels
*identical* across the whole site so the site-wide tab-sync works.

---

## 6. Version labelling

- Anything **current** needs no marker — that is the default.
- Express 4 idioms, callback-style APIs and EOL Node features go inside a `:::legacy`
  callout **and** the page's front matter `status` becomes `legacy`, **or** they live in
  `content/reference/express-4-to-5-migration.md`.
- Removed APIs get `:::deprecated`.
- `scripts/check.mjs` **fails the build** if any of these strings appears in a code
  fence outside a `:::legacy` / `:::deprecated` callout, and outside the migration
  page:

  `app.del(`, `req.param(`, `res.sendfile(`, `express.static.mime`,
  `res.redirect('back')`, `res.redirect("back")`, `res.location('back')`,
  `express-async-handler`, `require('body-parser')`, `from 'body-parser'`,
  `acceptsCharset(`, `acceptsEncoding(`, `acceptsLanguage(`

  It also flags `app.get('/*'`-style invalid Express 5 paths and `':param?'`
  optional-parameter syntax written as a real route call.

  **Prose is treated differently from code.** The rule being enforced is *"no
  Express 4 API is ever presented as working code"*, so naming a dead API in a
  sentence or a table cell in order to tell the reader to stop using it is
  allowed — the library index and the deprecation tables have to do exactly that.
  A prose line is accepted when it also carries deprecation language
  ("deprecated", "removed", "no longer", "unnecessary", "archived", "instead of",
  "replaced", "do not use", "end of life", …). A line inside a code fence is
  never accepted, warning words or not. If you want to show the old call, put it
  in a `:::legacy` or `:::deprecated` callout.

  Orphan pages are content-scanned too, so forgetting to register a page in
  `nav.mjs` is not a way past these checks.

---

## 7. The SQL-injection linter — read this before writing any query

`scripts/lint-sql.mjs` scans **every fenced block in `content/`** and **every `.js`/`.mjs`/`.ts`
file in `examples/`** for SQL assembled by string concatenation or template
interpolation. It fails the build on a hit.

A hit is exempt only if:

- the fenced block's info string contains `vulnerable`, **or**
- the example file lives under a directory whose name starts with `vulnerable-`, **or**
- the line (or the line above it) contains the exact marker `// lint-sql:allow` followed
  by a short justification — use this **only** for allow-listed identifier interpolation
  that you have proven safe:

  ```js
  const SORTABLE = new Set(['created_at', 'name'])
  if (!SORTABLE.has(sort)) throw new BadRequest('bad sort column')
  // lint-sql:allow sort is checked against the SORTABLE allow-list above
  const sql = `SELECT * FROM users ORDER BY ${sort} ASC`
  ```

So: **write parameterised queries everywhere.**

```js
// pg — numbered placeholders
const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])

// mysql2 — ? placeholders, values array
const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [id])

// better-sqlite3 / node:sqlite — named or positional
const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
```

---

## 8. Runnable examples

Docs **reference** example files rather than duplicating them. Link like this:

```markdown
Full runnable version: [`examples/layered-api`](../../examples/layered-api/README.md).
```

Each example directory has:

- `package.json` — `"type": "module"`, exact dependency versions from §1.3,
  `"engines": { "node": ">=24" }`, and a `start` script.
- `README.md` — what it shows, how to run it, what to curl.
- `src/` — the code. ESM. No TypeScript build step unless the example is *about* TS.

Examples must actually run on Node 24 with no external services, **or** clearly state
the service they need and provide a `docker run` one-liner. Database examples default
to SQLite so `node scripts/run-examples.mjs` can execute them unattended.

---

## 9. Writing style

- Short paragraphs — three sentences is usually the maximum.
- Explain **why**, not just what. "Use X" is worthless; "Use X because Y fails when Z"
  is the whole point of the page.
- No filler: no "In today's fast-paced world", no "It's important to note that", no
  restating the heading as the first sentence.
- Second person ("you"), present tense, active voice.
- Every security claim must be demonstrable: state the threat, show a concrete exploit
  (a `curl` or a payload), show the fix in code, show how to verify the fix.
- Prefer a table to a list when comparing three or more things.
- Code must be complete enough to paste and run — include the imports.
- American spelling.

---

## 10. Adding a page

1. Add the entry to `scripts/nav.mjs` (order there is the sidebar order and drives
   prev/next).
2. Create `content/<section>/<page>.md` with front matter and the required sections.
3. Do **not** build. The coordinator builds once at the end.

`scripts/check.mjs` reports an **orphan** for any file in `content/` missing from
`nav.mjs`, and a **missing file** for any `nav.mjs` entry with no Markdown file.

Filenames are **kebab-case**, one topic per file.
