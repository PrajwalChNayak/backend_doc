# Unverified items — Getting Started + Production sections

Author pass: `content/getting-started/` and `content/production/`, 2026-09-08.

Everything below could not be checked against the npm registry, a container
registry or an official release page from this environment, so it was either
**omitted**, **written without a version**, or **left as an explicit placeholder**.
Nothing here was invented. Please verify before the final build.

---

## 1. OpenTelemetry package versions — OMITTED

**Where:** `content/production/observability.md`, "Tracing with OpenTelemetry".

`@opentelemetry/sdk-node` and `@opentelemetry/auto-instrumentations-node` are
referenced **by name only**. No version number is quoted anywhere on the page,
and an inline `:::note` tells the reader that these packages were not part of the
2026-09-08 verification pass and that they must check the registry before pinning.

The API surface used (`new NodeSDK({ instrumentations })`, `sdk.start()`,
`getNodeAutoInstrumentations()`, loading via `node --import`) is the documented
setup shape, but it should be re-checked against the current major, because the
exporter configuration in particular has changed between majors.

**Action:** either add both packages to the verified table in `CONTRIBUTING.md`
§1.3 and quote the versions, or leave the page as-is (it reads correctly without
them).

## 2. `prom-client` version number — QUOTED FROM THE BRIEF, NOT FROM §1.3

**Where:** `content/production/observability.md`, "Exporting them".

`CONTRIBUTING.md` §1.3 lists `prom-client` in the "must be named as deprecated"
table but gives **no version**. The authoring brief supplied `15.1.3`, which is
what the page quotes inside a `:::deprecated` callout, alongside the successor
package `@prometheus-io/client`.

No version is quoted for `@prometheus-io/client`; the page tells the reader to
check the registry.

**Action:** confirm `prom-client@15.1.3` is the deprecated release, or drop the
number and keep the deprecation statement (which *is* in §1.3).

## 3. GitHub Actions versions — PARTIALLY PINNED, PARTIALLY PLACEHOLDERED

**Where:** `content/production/ci.md`.

| Action | What the page does |
| --- | --- |
| `actions/checkout` | Pinned `@v4`. Known-good major, **not verified as latest**. |
| `actions/setup-node` | Pinned `@v4`. Known-good major, **not verified as latest**. |
| `actions/configure-pages` | Written as `@vN` — an explicit placeholder. |
| `actions/upload-pages-artifact` | Written as `@vN` — an explicit placeholder. |
| `actions/deploy-pages` | Written as `@vN` — an explicit placeholder. |

An inline `:::note` after the main workflow tells the reader that `@v4` is
known-good rather than necessarily current, and a comment in the Pages workflow
says to take the current major for each Pages action from GitHub's own starter
workflow. The three Pages actions are released independently of each other and of
`checkout`, so guessing a shared major would have been a fabrication.

**Action:** replace the three `@vN` placeholders with the current majors, and
bump `checkout`/`setup-node` if newer majors exist.

Everything else in the workflows is first-party GitHub Actions *syntax*
(`services`, `options: --health-cmd`, `concurrency`, `permissions`,
`environment`, `node-version-file`, `cache: npm`, `::error::`) and is stable and
documented — no invention there.

## 4. Container image tags — NOT REGISTRY-VERIFIED

**Where:** `content/getting-started/running-the-examples.md` (the `docker run`
one-liners), `content/production/ci.md` (the Postgres service container), and
`content/production/dockerfile.md` (the base images).

| Tag used | Note |
| --- | --- |
| `node:24-bookworm-slim` | The recommended base throughout. Variant naming follows the official image convention; not pulled to confirm. |
| `node:24-alpine` | Used in the Alpine tradeoff section. Same caveat. |
| `postgres:18-alpine` | Used in the example one-liner and the CI service container. |
| `mysql:9` | Example one-liner. |
| `redis:8-alpine` | Example one-liner. |
| `mongo:8` | Example one-liner. |

These are all plausible current majors for 2026-09 and follow each image's
published tagging scheme, but none was pulled or checked against a registry from
this environment.

**Action:** `docker pull` each one, or downgrade the major where a tag does not
exist. None of the surrounding prose depends on the exact major.

## 5. Base-image digest pinning — PLACEHOLDER ONLY

**Where:** `content/production/dockerfile.md`, "Pin the base image".

The table shows `node:24-bookworm-slim@sha256:…` with an ellipsis and the prose
explicitly says to substitute the real digest from `docker pull` output. **No
fabricated digest appears anywhere.**

## 6. Distroless Node image — REFERRED TO GENERICALLY, NO TAG QUOTED

**Where:** `content/production/dockerfile.md`, "Distroless".

The section describes distroless as an option and states its tradeoffs (no shell,
no package manager, no init, debugging via an ephemeral or `-debug` container).
It says Google publishes Node variants per major version and explicitly tells the
reader to **confirm a tag exists for their Node major before depending on it**.
No `gcr.io/...` image path or tag is written out, because a Node 24 distroless
tag could not be confirmed.

**Action:** if a Node 24 distroless tag is confirmed, the section could name it.

## 7. Tool versions deliberately omitted

Named without a version, because none was verified and none is needed for the
prose to be correct:

- `autocannon`, `k6`, `clinic` (`clinic doctor`, `clinic flame`, `clinic bubbleprof`)
  — `content/production/performance.md`
- `piscina` (mentioned once as the well-known worker-thread pool) —
  `content/production/clustering.md`
- `dumb-init`, `tini` — `content/production/dockerfile.md`
- `docker scout`, Trivy, Grype — `content/production/dockerfile.md`
- Dependabot, Renovate — `content/production/dockerfile.md`, `ci.md`
- `psql` / `libpq`, `httpie` — `content/getting-started/prerequisites.md`
- `nvm`, `fnm`, `volta` — `content/getting-started/prerequisites.md`

The `nvm` install command is **not** written out; the page links to the project
instead, because that command changes with every release.

## 8. Example directories linked but not authored by this pass

`content/getting-started/running-the-examples.md` links, per the brief, to
README files another author is creating:

- `../../examples/minimal-express-api/README.md`
- `../../examples/layered-api/README.md`
- `../../examples/file-upload/README.md`
- `../../examples/db-sqlite/README.md`
- `../../examples/vulnerable-sql-injection/README.md`
- `../../examples/fixed-sql-injection/README.md`

`examples/` was **empty** at the time of writing. `scripts/check.mjs` resolves
relative links, so these will be reported as dangling until those directories
exist.

## 9. Version-dated statements that will expire

Correct on 2026-09-08, wrong later. Flagged here so a future pass can find them:

- "Node 24 is the only Active LTS line" — false from **2026-10-28**, when Node 26
  enters Active LTS. Appears in `introduction.md`, `prerequisites.md` (with the
  date stated inline), and by implication throughout.
- Node 20 EOL 2026-04-30, Node 24 EOL 2028-04-30, Node 26 EOL 2029-04-30 — from
  `CONTRIBUTING.md` §1.1.
- `terminationGracePeriodSeconds` default of **30** and Node's `keepAliveTimeout`
  default of **5 s** / `requestTimeout` default of **300 s** — documented
  platform and runtime defaults, stable, but worth re-checking on a major bump.
- AWS ALB's 60-second default idle timeout — quoted in
  `content/production/graceful-shutdown.md` as a table row with the instruction
  to set Node's value above the proxy's, whatever it is.

## 10. Performance numbers are orders of magnitude, not measurements

**Where:** `content/production/performance.md`, "Realistic numbers".

The table gives orders of magnitude on "a modern cloud vCPU" and the surrounding
prose says explicitly to measure your own. Nothing in it is presented as a
benchmark result, and no benchmark is cited. Treat it as calibration, not data.

## 11. Editorial note — an edit arrived mid-pass

`content/getting-started/introduction.md` was modified on disk during this pass:
the async-wrapper `:::note` became a `:::deprecated` callout titled "Async
wrappers are obsolete". That is an improvement and was kept — `CONTRIBUTING.md`
§6 requires the string `express-async-handler` to sit inside a `:::legacy` or
`:::deprecated` callout, and it now does.

For a moment the file contained a `:::note` **wrapping** the `:::deprecated`
block. Callouts may not nest (§5), so that would have failed the build; the file
on disk is now un-nested and correct. Flagging it only in case the same edit is
replayed elsewhere.

---

## Coordinator resolution — 2026-09-09

Section 3 (GitHub Actions versions) is **resolved**. Queried the GitHub Releases API
for each action and updated both `content/production/ci.md` and the real workflow at
`.github/workflows/docs.yml`:

| Action | Was | Current major (verified 2026-09-09) |
| --- | --- | --- |
| `actions/checkout` | `@v4` | **`@v7`** (v7.0.1) |
| `actions/setup-node` | `@v4` | **`@v7`** (v7.0.0) |
| `actions/configure-pages` | `@vN` placeholder | **`@v6`** (v6.0.0) |
| `actions/upload-pages-artifact` | `@vN` placeholder | **`@v5`** (v5.0.0) |
| `actions/deploy-pages` | `@vN` placeholder | **`@v5`** (v5.0.1) |

No `@vN` placeholders remain in the docs. A `.nvmrc` containing `24` was added, so
the workflow's `node-version-file: .nvmrc` now matches what `ci.md` recommends.

Section 2 (`prom-client` 15.1.3) is **resolved**: confirmed against the registry —
15.1.3 is the current version and it carries the npm deprecation notice
"prom-client has been replaced by @prometheus-io/client". `scripts/check-deps.mjs`
re-verifies this claim on every run.

Section 4 (container image tags) remains unverified — no registry pulls were made.
