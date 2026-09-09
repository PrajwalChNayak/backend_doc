# Unverified / deliberately omitted — `content/node/`

Author pass: Node.js Fundamentals section, 2026-09-08.

Everything below was **left out of the published pages** because it could not be
confirmed against `CONTRIBUTING.md` §1 or official Node documentation available during
this pass. Per the "never invent" rule, an omission was preferred to a confident guess.
Each item is a candidate for a follow-up fact-check.

---

## Omitted entirely

| Topic | Why it was omitted |
| --- | --- |
| **`--env-file` precedence over already-set environment variables** | Could not confirm whether values in the file override variables already present in `process.env`, or whether the existing environment wins (the way `dotenv` behaves by default). The page says nothing about precedence. This is a frequently asked question and should be verified and added to `environment-variables-and-config.md`. |
| **Whether `--env-file` is permitted inside `NODE_OPTIONS`** | `debugging.md` says only that "not every flag is permitted" in `NODE_OPTIONS`, without naming `--env-file`. Needs the disallowed-flag list from the Node CLI docs. |
| **`z.stringbool()` (Zod 4)** | Believed to exist in Zod 4 for coercing `"true"`/`"1"` strings to booleans, but not confirmed against the Zod 4 docs. `environment-variables-and-config.md` uses `z.enum(['true','false']).default('false').transform(...)` instead, which is valid in both Zod 3 and 4. |
| **Zod 4 error formatting helpers (`z.treeifyError`, `z.prettifyError`)** | Not confirmed. The config example formats `parsed.error.issues` manually, which is stable API. |
| **`fs.glob()`** | Added in Node 22 as experimental; its stability status on Node 24 was not confirmed, so `fs-and-path.md` does not mention it. |
| **`--test-skip-pattern`** | Believed to exist alongside `--test-name-pattern`, but not confirmed for Node 24. Omitted from `built-in-test-runner.md`. |
| **Corepack / the `packageManager` field** | Corepack's bundling and deprecation status in Node 24 could not be confirmed, so `package-json-and-npm-scripts.md` does not mention Corepack or `packageManager` at all. |
| **The npm major version bundled with Node 24** | Not stated anywhere; no version number was claimed. |
| **`UV_THREADPOOL_SIZE` maximum value** | Commonly cited as 1024. The default (4) is stated per CONTRIBUTING §1.1; the maximum is not. |
| **Argument forwarding for `node --run` (e.g. `node --run test -- --flag`)** | Not confirmed; `package-json-and-npm-scripts.md` documents `npm run test -- …` only. |
| **`--experimental-network-inspection`** | Not confirmed for Node 24; omitted from `debugging.md`. |
| **`stream.compose()`** | Experimental; omitted from `streams-and-buffers.md` in favor of `pipeline` with async generators. |
| **Node's `.env` parser handling of an `export FOO=bar` prefix** | Not confirmed; not mentioned. |
| **Inline (trailing) comments in a `.env` line** | Not confirmed; the page only documents whole-line `#` comments. |
| **Relationship rule between `headersTimeout` and `keepAliveTimeout` beyond "set headers slightly higher"** | The concrete defaults in `the-http-module.md` (5 s / 60 s / 300 s / 0) are stated; any stricter internal constraint Node enforces between them was not confirmed and is not claimed. |

---

## Stated with moderate confidence — worth a second check

These **are** in the published pages. They are believed correct but were not verifiable
against the sources listed in `CONTRIBUTING.md` during this pass.

| Claim | Page |
| --- | --- |
| Default byte-stream `highWaterMark` is **64 KiB** on Node 24, raised from 16 KiB in Node 22 (objectMode: 16 objects). | `streams-and-buffers.md` |
| `--test-concurrency` defaults to **available CPU cores minus one**. | `built-in-test-runner.md` |
| `node --run` **does** add `node_modules/.bin` to `PATH`, and sets `NODE_RUN_SCRIPT_NAME` / `NODE_RUN_PACKAGE_JSON_PATH`. | `package-json-and-npm-scripts.md` |
| ES-module mocking in `node:test` is gated behind **`--experimental-test-module-mocks`**. | `built-in-test-runner.md` |
| `node --inspect-wait` exists (added around Node 22.2). | `debugging.md` |
| `--trace-sync-io` warns on synchronous I/O after the first turn of the event loop. | `debugging.md` |
| Default `--stack-trace-limit` is **10**. | `debugging.md` |
| `{ recursive: true }` for `fs.watch` is supported on Windows and macOS, and on Linux from Node 20. | `fs-and-path.md` |
| TypeScript's `rewriteRelativeImportExtensions` option rewrites `.ts` specifiers to `.js` on emit. | `native-typescript-support.md` |
| Import attributes (`with { type: 'json' }`) are required and supported for JSON imports on Node 24. | `esm-vs-commonjs.md` |
| Coverage on Node 24 is still reached via `--experimental-test-coverage` (threshold flags `--test-coverage-lines` / `-branches` / `-functions` / `-include` / `-exclude` taken from CONTRIBUTING §1.1). | `built-in-test-runner.md` |

---

## Notes for the coordinator

- No page in `content/node/` links to `examples/`, because that directory is currently
  empty. If example apps land later, `runtime-and-event-loop.md`,
  `built-in-test-runner.md` and `the-http-module.md` are the natural places to add
  "full runnable version" references.
- `content/node/` links out to 26 pages owned by other authors. All of them resolve to
  slugs that exist in `scripts/nav.mjs`; none were invented.
