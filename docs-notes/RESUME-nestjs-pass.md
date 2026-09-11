# RESUME — NestJS documentation pass

**Paused 2026-09-09 at the user's request.** This file is the complete handover:
what is done, what is left, and everything needed to continue without redoing
research. Say "resume" and work continues from **Step 1** below.

---

## Current state in one line

**74 of 113** NestJS pages written. Five sections complete, three partial, four
not started. The existing Node/Express site (93 pages) is untouched and still
builds. Everything written is structurally complete — **no half-finished files**.

Paused 2026-09-11 at the user's request ("stop it, I will let you know when to
finish"). Say **resume** / **finish** to continue from Step 1.

### Section status

| Section | Pages | State |
| --- | --- | --- |
| `nestjs` (Fundamentals) | 12/12 | complete |
| `nestjs-request-handling` | 9/9 | complete |
| `nestjs-validation` | 7/7 | complete |
| `nestjs-databases` | 13/13 | complete |
| `nestjs-orms` | 9/9 | complete |
| `nestjs-libraries` | 9/11 | **missing: logging, observe** |
| `nestjs-advanced` | 7/9 | **missing: 2 — diff nav.mjs against the directory** |
| `nestjs-security` | 8/15 | **missing: 7 — diff nav.mjs against the directory** |
| `nestjs-testing` | 0/7 | not started |
| `nestjs-production` | 0/11 | not started |
| `express-vs-nestjs` | 0/4 | not started |
| `nestjs-reference` | 0/6 | not started |

To list exactly what is missing:

```bash
node -e "const fs=require('fs');import('./scripts/nav.mjs').then(({sections})=>{for(const s of sections.filter(x=>x.group==='nestjs'))for(const p of s.pages){const f='content/'+s.id+'/'+p.slug+'.md';if(!fs.existsSync(f))console.log(f)}})"
```

### Validators — all green on the content that exists

Run `lint-snippets.mjs` with **Node 24**; it exits non-zero on an older Node
rather than silently skipping TypeScript.

```
lint-snippets   832 ts + 881 js blocks, 0 syntax failures
lint-sql        0 violations, 27 marked-exempt demonstrations
check           2848 links resolved, 0 warnings
                15 errors -- all "listed in nav.mjs but the file does not exist"
                for the 39 unwritten pages. That error list IS the TODO list.
```

### Corrections found by reading the shipped packages

| Claim | Reality |
| --- | --- |
| `errorCode` shows up in the error response | **No.** `createBody()` takes it as a 4th argument but no built-in subclass passes it, and `BaseExceptionFilter` never reads it. Setting it is a silent no-op. Recorded in CONTRIBUTING §11.4. |
| `@nestjs/throttler` is 12.x | **6.5.0** |
| `@nestjs/graphql` / `@nestjs/apollo` are 12.x | **14.0.0** |
| `@nestjs/observe` is a first-class SDK | **0.1.8**, pre-1.0 |
| Terminus ships a Redis health indicator | It does not, in 12.0.0 |
| `ValidationPipeOptions` had no `errorFormat` | It does — `'grouped'` changes `message` from `string[]` to `Record<string, string[]>` and breaks filters that assume an array |

### Four bugs fixed in this repo's own tooling

All found by running the validators against real TypeScript content:

1. `lint-snippets.mjs` **silently skipped every `ts` block** on a Node without
   `stripTypeScriptTypes`, printing "0 failures" while checking nothing. Now
   exits non-zero and says so.
2. Constructor parameter properties — Nest's idiomatic DI form — are rejected by
   strip-only mode. Now falls back to `transform` mode.
3. A bare decorated method or object literal is legitimate documentation but not
   a standalone program. Both are now classified as fragments.
4. The fragment wrappers put `import` statements **inside** the generated class
   body, itself a syntax error — so every "imports + bare method" block was
   reported broken. The import block is now split off and re-prepended, with
   multi-line specifier lists tracked. This alone took failures 14 → 3.

A recurring content shape needs a class wrapper: a module-scope `const`
(an allow-list `Set`/`Map`) followed by a bare method is not pasteable anywhere,
so those blocks were rewritten with their surrounding `@Injectable()` class.

---

## DONE — do not redo

### 1. Fact verification (complete, authoritative)

Every version was verified against the live npm registry, and the v12 API surface
was verified by unpacking `@nestjs/common@12.0.1` / `@nestjs/core@12.0.1` and
reading the published `.d.ts` files. **All of it is written up in
`CONTRIBUTING.md` Part 2 (§11–§13), lines 533–761.** That is the single source of
truth for the rest of this pass — no further research is needed.

Confirmed from the brief: core packages are **12.0.1**; `@nestjs/platform-express`
bundles exactly `express@5.2.1`, `multer@2.2.0`, `cors@2.8.6`,
`path-to-regexp@8.4.2`; core packages are `"type": "module"`; `errorCode`,
`routeConflictPolicy`, `routeResolutionStrategy`, `structuredParams`,
`StandardSchemaValidationPipe` and `StandardSchemaSerializerInterceptor` all
exist with the signatures recorded in §11.4.

**Four corrections to the brief** (these would have been wrong):

| Package | Brief implied | Actual |
| --- | --- | --- |
| `@nestjs/throttler` | 12.x | **6.5.0** |
| `@nestjs/graphql` | 12.x | **14.0.0** |
| `@nestjs/apollo` | 12.x | **14.0.0** |
| `@nestjs/observe` | first-class | **0.1.8** — pre-1.0 |

Also found: `@nestjs/cli` is 12.0.0 and `@nestjs/schematics` is 12.0.0 with
`engines.node: ">=22.12.0"`, which is exactly why the CLI needs a newer Node than
the app. And `nats` 2.29.3 / `subscriptions-transport-ws` 0.11.0 / unscoped `casl`
each carry a real npm deprecation notice, so the brief's claims are demonstrable.

### 2. `CONTRIBUTING.md` — extended

Part 2 appended (§11 verified facts, §12 NestJS authoring rules, §13 groups).
529 → 761 lines.

### 3. `scripts/nav.mjs` — extended

- Added `group: 'core'` to all 9 existing sections. **Nothing reordered or renamed.**
- Added a `groups` export (`core` = "Node & Express", `nestjs` = "NestJS").
- Added **12 NestJS sections / 113 pages**. Total site: **21 sections, 206 pages**.
- Added `sectionsInGroup()` and `groupOfSection()` helpers.
- Added the 3 NestJS migration pages to `legacyExemptPages`.

### 4. Navigation reworked for 21 sections

21 sections cannot fit one bar. `scripts/lib/template.mjs` and `scripts/build.mjs`
now render a **platform switcher**: the bar shows the sections of the group you
are reading, preceded by a dropdown to the other. Built from the same markup as a
section menu, so the existing keyboard/click handling covers it with no JS change.
The mobile panel lists every group in full. The home page is grouped by platform.
CSS added for `.topnav__item--group`, `.home-group*`, `.mobilenav__platform*`.

Verified rendering: switcher present, 9 core triggers on a core page, 2 mobile
platform groups.

### 5. `scripts/check.mjs` — NestJS rules added (as the brief requires)

- `NESTJS_LEGACY_PATTERNS` — `from 'nats'` / `require('nats')`,
  `subscriptions-transport-ws`
- `BAD_NEST_ROUTE_PATTERNS` — `@Get('*')`, `@Get(':a.:b?')`, regex-in-string
- Joi check — a `validationOptions` block holding Joi keys (`allowUnknown`,
  `abortEarly`, `stripUnknown`, `convert`) without `libraryOptions` nesting
- All follow the existing prose-vs-code rule: banned in a fence, allowed in prose
  that carries deprecation language.

:::note A bug was found and fixed here
Shell escaping wrote a literal `0x01` control byte into the wildcard regex instead
of a `\1` backreference, which would have made it match the **valid** `'*splat'`
form. Fixed and verified: 0 control bytes remain, `node --check` passes.
:::

### 6. Content written — 8 of 113 pages

All 8 are structurally complete (front matter + `## Common mistakes` +
`## Related topics` last). They were produced by agents that were stopped
mid-section, so **spot-check them against CONTRIBUTING Part 2 before trusting
them**, but they do not need rewriting from scratch.

| File | Lines |
| --- | --- |
| `content/nestjs/introduction.md` | 144 |
| `content/nestjs/installation-and-cli.md` | 227 |
| `content/nestjs/project-structure.md` | 209 |
| `content/nestjs-request-handling/middleware.md` | 304 |
| `content/nestjs-validation/validation-pipe.md` | 363 |
| `content/nestjs-validation/class-validator.md` | 458 |
| `content/nestjs-databases/connections-and-di.md` | 453 |
| `content/nestjs-orms/typeorm.md` | 640 |

---

## TO DO — resume here

### Step 1 — finish the content, ONE agent at a time

The user asked for **one agent at a time**. Run these sequentially, waiting for
each to finish before launching the next. Each agent must read `CONTRIBUTING.md`
in full (Part 2 especially) and `scripts/nav.mjs` first, and must not run the build.

| # | Section | Dir | Pages left | Note |
| --- | --- | --- | --- | --- |
| 1 | Fundamentals | `content/nestjs/` | 9 of 12 | 3 written |
| 2 | Request Handling | `content/nestjs-request-handling/` | 8 of 9 | 1 written |
| 3 | Validation | `content/nestjs-validation/` | 5 of 7 | 2 written |
| 4 | Databases | `content/nestjs-databases/` | 12 of 13 | 1 written |
| 5 | ORMs | `content/nestjs-orms/` | 8 of 9 | 1 written |
| 6 | Libraries | `content/nestjs-libraries/` | 11 | none |
| 7 | Advanced | `content/nestjs-advanced/` | 9 | none |
| 8 | Security | `content/nestjs-security/` | 15 | none |
| 9 | Testing | `content/nestjs-testing/` | 7 | none |
| 10 | Production | `content/nestjs-production/` | 11 | none |
| 11 | vs Express | `content/express-vs-nestjs/` | 4 | none |
| 12 | Reference | `content/nestjs-reference/` | 6 | none |

Exact filenames and titles are in `scripts/nav.mjs`. The detailed per-section
briefs used for agents 1–7 are in the conversation; the key content requirements
are also captured in the task brief and in CONTRIBUTING Part 2.

### Step 2 — `SECTION_REQUIREMENTS` in `scripts/check.mjs`

**Not yet done.** Add the NestJS sections that need
`## Security considerations` + `## Production considerations`:
`nestjs-databases`, `nestjs-orms`, `nestjs-libraries`. And `nestjs-security`
needs only the universal two (matching how `security` is configured).

### Step 3 — examples

None created yet. Under `examples/`, following the existing convention
(own `package.json`, `README.md`, `smoke.json`, `tsconfig.json` — Nest needs a
real build step because Node type-stripping cannot execute decorators):

minimal Nest 12 API · full CRUD module (DTOs, ValidationPipe, guards,
interceptors, filters) · the same validation via Zod + `StandardSchemaValidationPipe` ·
TypeORM · Prisma · Mongoose · JWT auth with role guards · file upload with
`ParseFilePipe` · a vulnerable/fixed pair (injection + IDOR) · one CommonJS and
one ESM project.

### Step 4 — validation and the deliverable

Run and report real numbers: `build.mjs`, `check.mjs`, `lint-sql.mjs`,
`lint-snippets.mjs`, `test-site-js.mjs`, `check-deps.mjs`, `run-examples.mjs`,
plus the a11y audit at
`<scratchpad>/a11y.mjs`. Confirm the Node/Express sections still pass.

---

## Known state of the validators right now

`node scripts/check.mjs` **fails**, by design: it reports the NestJS pages that
`nav.mjs` declares but that have not been written yet.

```
pages checked    101 / 206
links resolved   1614
errors           49
warnings         0
```

That error list is the TODO list and goes green as content lands. Everything else
(build, lint-sql, lint-snippets, the 20 client-runtime tests) was passing at the
pause. **The 93 Node/Express pages are untouched.**

To get a clean validation run *before* the content is finished, comment out the
12 NestJS section objects in `scripts/nav.mjs` — nothing else depends on them.
