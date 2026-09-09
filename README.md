# Node.js & Express Backend Handbook

A production-grade reference for building backends with **Node.js 24 LTS** and **Express 5** — runtime fundamentals, the libraries a real API needs, databases, ORMs, security and operations. Every page is authored as Markdown under `content/` and generated into a static site under `docs/` by a plain Node ESM generator with **zero npm dependencies**.

---

## Quick start

```bash
node scripts/build.mjs     # content/ -> docs/
node scripts/serve.mjs     # http://localhost:8080
```

That is the whole toolchain. **No `npm install` is required for the site itself** — `scripts/build.mjs`, `scripts/serve.mjs` and every validator are plain Node ESM with no dependencies, so a fresh clone builds and serves on Node 24 immediately. `npm install` is only needed inside an individual `examples/*` directory when you want to run that example.

Serve on a different port with `node scripts/serve.mjs 3000`.

---

## Repository layout

```text
content/            Markdown source — the only place you author pages
docs/               GENERATED static site. Committed, served by GitHub Pages. Never hand-edit.
scripts/            The zero-dependency toolchain: build, serve, and the validators
scripts/lib/        Generator internals — markdown.mjs, highlight.mjs, template.mjs
scripts/assets/     site.css and site.js, copied verbatim into docs/
examples/           Runnable apps, one folder each, own package.json + README + smoke.json
docs-notes/         Per-section "unverified" notes — anything an author could not confirm
CONTRIBUTING.md     The authoring contract: verified versions, Markdown dialect, page shape
```

`scripts/nav.mjs` is the single source of truth for the information architecture — sidebar order, prev/next links, breadcrumbs, the search index and the orphan check all derive from it.

> **Note — the pre-existing React/Vite app.** This repository also still contains an unrelated React + Vite single-page app that renders Kubernetes documentation from `src/data/*.json`. That is what `index.html`, `src/`, `public/`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js` and `eslint.config.js` belong to, and it still builds with `npm run dev` / `npm run build`. The two projects do not conflict: Vite outputs to `dist/` (git-ignored), the handbook outputs to `docs/` (committed). Nothing in `src/` is part of the handbook.

---

## Content sections

Nine sections, 93 pages, defined in `scripts/nav.mjs`.

| # | Section | What it covers | Pages |
| --- | --- | --- | --- |
| 1 | **Getting Started** | What this handbook is, who it is for, and how to run everything in it. | 4 |
| 2 | **Node.js Fundamentals** | The runtime itself: scheduling, module resolution, and the built-ins that replace packages you used to install. | 12 |
| 3 | **Express Fundamentals** | Express 5 from the ground up — routing, middleware, the request/response cycle, and laying out a real application. | 10 |
| 4 | **Express Libraries** | The packages a real API actually needs, each with the current major, a working configuration, and its failure modes. | 13 |
| 5 | **Databases** | Drivers, pools, transactions, migrations, and the operational details that decide whether it survives production. | 14 |
| 6 | **ORMs and Query Builders** | Prisma, Drizzle, TypeORM, Sequelize, Mongoose and Knex — what each is good at, and how to keep raw-query escape hatches safe. | 10 |
| 7 | **Security** | Every page states the threat, shows a working exploit, gives the fix in code, and tells you how to verify the fix. | 17 |
| 8 | **Production** | Getting it deployed, observable, and survivable. | 9 |
| 9 | **Reference** | Lookup material: the Express 4 → 5 migration, a cheat sheet, the library index, and troubleshooting. | 4 |

---

## Validation

Every validator is zero-dependency Node ESM and runs straight from a clean checkout.

| Script | What it checks | Command |
| --- | --- | --- |
| `scripts/lint-sql.mjs` | **SQL injection.** String-concatenated or interpolated SQL in docs and example code. | `node scripts/lint-sql.mjs` |
| `scripts/check.mjs` | Front matter, `nav.mjs` title match, required headings per section, `## Related topics` last, dangling `.md` links and `#anchors`, orphan/missing pages, fences with no language, Express 4 APIs outside a `:::legacy` callout. | `node scripts/check.mjs` |
| `scripts/lint-snippets.mjs` | Every fenced JS/TS block parses as an ES module (TypeScript is type-stripped first); bare import specifiers resolve against the packages installed under `examples/`. | `node scripts/lint-snippets.mjs` |
| `scripts/check-deps.mjs` | Every npm package named in the docs or an example `package.json` exists on the registry, is not unexpectedly deprecated, and has not drifted from the documented version. Needs network. | `node scripts/check-deps.mjs` |
| `scripts/run-examples.mjs` | Boots each `examples/*` app, polls `/health`, replays `smoke.json`, runs `npm test`. | `node scripts/run-examples.mjs` |
| `scripts/build.mjs` | Regenerates `docs/`. Reports build-time warnings. | `node scripts/build.mjs` |

Run the four static validators in one go:

```bash
npm run docs:validate
```

### `scripts/lint-sql.mjs` is the one that matters most

It scans **every fenced block in `content/`** and **every `.js` / `.mjs` / `.ts` file in `examples/`** for SQL assembled by string concatenation or template interpolation, and fails the build unless the code is explicitly marked as a deliberate vulnerable demonstration. That guarantee is the point: these docs can never ship an injectable example by accident, because a query is either parameterised or it is loudly labelled.

The only exemptions are the three documented in [CONTRIBUTING.md §7](CONTRIBUTING.md) — a fence whose info string contains `vulnerable`, an example directory named `vulnerable-*`, and an explicit `// lint-sql:allow <justification>` on a proven-safe identifier allow-list. Do not add an exemption to make a build pass; fix the query.

---

## npm scripts

These wrap the same commands, for people who prefer `npm run`.

| Script | Runs |
| --- | --- |
| `npm run docs:build` | `node scripts/build.mjs` |
| `npm run docs:check` | `node scripts/check.mjs` |
| `npm run docs:lint-sql` | `node scripts/lint-sql.mjs` |
| `npm run docs:lint-snippets` | `node scripts/lint-snippets.mjs` |
| `npm run docs:check-deps` | `node scripts/check-deps.mjs` |
| `npm run docs:examples` | `node scripts/run-examples.mjs` |
| `npm run docs:validate` | `docs:check` → `docs:lint-sql` → `docs:lint-snippets` → `docs:check-deps` |
| `npm run docs:serve` | `node scripts/serve.mjs` |

The unprefixed `dev`, `build`, `lint` and `preview` scripts belong to the React/Vite app, not to the handbook.

---

## Publishing to GitHub Pages

`docs/` is generated **and committed**, so Pages can serve it with no build step of its own.

```bash
node scripts/build.mjs
git add docs
git commit -m "Rebuild docs"
git push
```

Then, once per repository:

1. **Settings → Pages**
2. **Source:** `Deploy from a branch`
3. **Branch:** `main`, **Folder:** `/docs`
4. **Save**

Two details make this work:

- `docs/.nojekyll` is written by `scripts/build.mjs` on every build, so Jekyll does not strip files and directories it would otherwise ignore.
- Every link the generator emits is **relative**, so the site works unchanged from a project subpath such as `https://<user>.github.io/<repo>/` as well as from a domain root.

The workflow in `.github/workflows/docs.yml` fails a pull request whose `docs/` output is stale, so the published site cannot silently lag `content/`.

---

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) completely before writing a line of content. It is the contract for the whole site: the verified version tables, the Markdown dialect the generator implements, the required page shape, and the rules each validator enforces.

Two rules worth repeating here: never hand-edit anything under `docs/`, and if you cannot verify an API or a package from official docs or the registry, leave it out and record it in `docs-notes/`.

**All version facts in this repository were verified on 2026-09-08** against the live npm registry, `nodejs.org/dist/index.json`, the nodejs/Release schedule, and the official Express 5 migration guide.

---

## Extending the site

A later pass adds a **Next.js** section. Doing so means appending one object to the `sections` array in `scripts/nav.mjs` and creating the matching `content/<id>/` directory with one Markdown file per `slug`. Nothing else changes — the generator, the checker, the sidebar, prev/next, breadcrumbs and the search index all derive from that array.
