# NestJS documentation pass — complete

**Finished 2026-09-12.** This file replaces the RESUME handover that tracked the
pass while it was paused. Nothing here is a TODO; it is the record of what was
built and, more usefully, what was found to be *wrong* along the way.

---

## Final state

| | Sections | Pages |
| --- | --- | --- |
| `core` — Node & Express | 9 | 93 |
| `nestjs` — NestJS | 12 | 113 |
| **Total** | **21** | **206** |

27 runnable projects under `examples/`. The 93 Node/Express pages were never
edited by this pass beyond adding `group: 'core'` to their sections in
`scripts/nav.mjs`.

## Validation — last full sweep, Node 24.20.0

Run `lint-snippets.mjs` with **Node 24**. It exits non-zero on an older Node
rather than silently skipping TypeScript — that failure mode is how it once
reported "0 failures" while checking nothing.

```
build           206 pages, 21 section indexes, 3015 code blocks
check           206/206 pages, 3716 links, 0 errors, 0 warnings
lint-snippets   every fenced js + ts block parses
lint-sql        0 unmarked findings; 27 marked-exempt demonstrations
test-site-js    20/20
check-deps      every documented package resolves on npm
run-examples    21 passed, 2 degraded-no-service, 4 skipped-no-service,
                198/198 HTTP responses as expected, 93 unit tests
```

`degraded-no-service` and `skipped-no-service` are examples needing a database
or broker that is not running locally. They are not failures.

## Corrections to the brief, found by reading the shipped packages

Every one of these would have shipped as a false statement.

| Claim | Reality |
| --- | --- |
| `@nestjs/throttler` is 12.x | **6.5.0** |
| `@nestjs/graphql` / `@nestjs/apollo` are 12.x | **14.0.0** |
| `@nestjs/observe` is a first-class SDK | **0.1.8**, pre-1.0 |
| `errorCode` appears in the error response | **No.** `createBody()` accepts it as a 4th argument, but no built-in subclass passes it and `BaseExceptionFilter` never reads it. Setting it is a silent no-op. |
| `instrument` takes an `@nestjs/observe` value | It takes `{ instanceDecorator: (instance: unknown) => unknown }` — a general-purpose hook, not typed against the SDK, and **present in v11 too**, so not a v12 addition. |
| Terminus ships a Redis health indicator | It does not, in 12.0.0. |
| Nest inherits Express 5's defaults | It does not. `urlencoded` is registered `{ extended: true }` — the opposite of bare Express 5. The query parser is left on `'simple'`. |
| `ValidationPipeOptions` has no `errorFormat` | It does. `'grouped'` changes `message` from `string[]` to `Record<string, string[]>` and breaks filters assuming an array. |

Missing entirely until the final pass: **`return503OnClosing`** (`@default
false`), genuinely new in v12 and absent from 11.1.6.

All of the above are recorded in `CONTRIBUTING.md` §11.4, which is the
authoritative fact base — not in this file.

## Bugs found in this repo's own tooling

Found by running the validators against real TypeScript content, not by
inspection:

1. `lint-snippets.mjs` **silently skipped every `ts` block** on a Node without
   `stripTypeScriptTypes`, printing "0 failures" while checking nothing.
2. Constructor parameter properties — Nest's idiomatic DI form — are rejected by
   strip-only mode. Falls back to `transform` mode.
3. The fragment wrappers put `import` statements **inside** the generated class
   body, itself a syntax error, so every "imports + bare method" block was
   reported broken. Splitting the import head off took failures 14 → 3.
4. `check.mjs`'s wildcard-route regex contained a literal `0x01` control byte
   where a `\1` backreference was intended, which would have made it match the
   **valid** `'*splat'` form.
5. `check.mjs`'s Joi rule was dead code — the constant was defined but the check
   was never inserted. Found by planting deliberate probe violations.
6. `check.mjs`'s route rules fired regardless of adapter, but `@Get('*')` is
   valid on Fastify. Added a `// check:allow-path` opt-out.
7. `run-examples.mjs` spawned the PATH `node` (v20, EOL) rather than the runtime
   running the script. Now uses `process.execPath`.
8. `.gitignore`'s `examples/**/uploads/` silently ignored a *source* directory,
   `src/uploads/`. Narrowed to `examples/*/uploads/`.

## Things a later pass should know

- **A dependency version is a fact about a release, not a recommendation.** A
  blind global version bump during this pass corrupted three of them
  (`file-type`, `swagger-ui-dist` twice). They are now pinned with written
  reasons in `DELIBERATE_PINS` in `scripts/check-deps.mjs`. Never bump a version
  that is quoted because a package *bundles* it.
- **The browser preview pane reports `innerHeight: 0`**, so scroll behaviour and
  CSS transforms cannot be verified there. `scripts/test-site-js.mjs` exercises
  the shipped `site.js` headlessly instead; extend it rather than trusting a
  visual check.
- Each section has a `docs-notes/unverified-*.md` recording what was
  deliberately *not* claimed and why. Read the relevant one before extending a
  section — it is the list of places where invention would be easy.
