# Unverified / omitted — `content/express/`

Items I could not verify against CONTRIBUTING.md §1, the Express 5 migration guide, or
official package docs, and therefore either omitted from the pages or stated in a
deliberately loose form. Recorded for the "Remaining issues" report.

Author: Express Fundamentals section. Date: 2026-09-08.

## path-to-regexp v8 error text

- `content/express/route-parameters-and-path-syntax.md` quotes two error messages:
  - `TypeError: Missing parameter name at 1: https://git.new/pathToRegexpError`
  - `TypeError: Unexpected [ at 1, expected END: https://git.new/pathToRegexpError`

  The **shape** of both (message, character index, trailing `git.new/pathToRegexpError`
  documentation link) is what readers see in the wild. The exact casing of the expected
  token name in the second message (`END` vs `end`) was **not** re-verified against the
  installed `path-to-regexp@8` source, and it has differed between v8 patch releases.
  If someone can run `node -e "require('path-to-regexp').pathToRegexp('/[a]')"` against
  the version `express@5.2.1` resolves, please correct the casing in place.

- Two further startup errors are described in prose only — an unterminated `:"quoted"`
  parameter name and an unclosed `{` group. Their exact message text is not quoted
  because I could not verify it.

## RegExp route paths

- Documented: unnamed capture groups appear on `req.params` under numeric keys, and
  `req.params` has an ordinary prototype (not the null prototype used for string paths).
- **Omitted:** whether *named* capture groups in a real `RegExp` path
  (`/(?<version>\d+)/`) are surfaced on `req.params` by name in Express 5. Not verified,
  so the pages never mention it.

## Path-parameter decoding failures

- Stated: a path segment with malformed percent-encoding produces a 400 before the
  handler runs.
- **Omitted:** the exact error message and `err.code`/`err.type` of that failure.

## `res.status()` out-of-range

- CONTRIBUTING §1.2 says values outside 100–999 throw. The **error type** (`RangeError`
  vs `TypeError`) is not stated there and is not claimed on the page — the text just
  says "throws".

## Express 5 default error handler logging

- `content/express/error-handling.md` states that Express 5's default error handler logs
  the whole error object, so `cause` and driver-specific fields surface. Taken from the
  assignment brief and consistent with the migration guide's "changed behaviour" list;
  not verified line-by-line against `express@5.2.1` source.

## Template engine versions

- CONTRIBUTING §1.3 does not list `ejs` or `pug`. `content/express/templating.md`
  therefore says `npm install ejs` / `npm install pug` with **no version pinned**, unlike
  every other package reference on the site. If the coordinator wants versions here,
  they need a registry lookup and a row in §1.3.
- The `<%= %>` / `<%- %>` (EJS) and `=` / `!=` (Pug) escaping semantics are documented
  behavior of those engines and are stated as such.

## Cross-references to files that do not exist yet

- `content/express/layered-architecture.md` links to
  `../../examples/layered-api/README.md` as instructed. That example directory did not
  exist when this section was written — `scripts/check.mjs` will report a dangling link
  until whoever owns `examples/` creates it.
- Every other outbound link points at a slug that exists in `scripts/nav.mjs`, but most
  of those pages were still unwritten at the time of writing.
