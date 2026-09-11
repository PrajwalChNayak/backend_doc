---
title: Dependency auditing
description: Auditing a NestJS 12 dependency tree — npm audit and its noise, --omit=dev, lockfile integrity, overrides for transitive patches, --ignore-scripts against install-script attacks, and the deprecated packages this stack must avoid.
status: current
updated: 2026-09-11
---

A Nest application you wrote yourself is a few thousand lines. The thing you actually deploy is several hundred packages, most of which you have never heard of, every one of which runs with your database credentials. This page is the commands that tell you what is in there, what they mean, and the specific packages a Nest 12 stack must not be carrying.

The general reasoning — provenance, reducing dependency count, why most advisories do not apply to you — is in [Dependency auditing](../security/dependency-auditing.md). This page is the Nest-specific tree and the commands to run against it.

## The threat

Three different attacks live in your `node_modules`, and they need different controls:

| Attack | What happens | Control |
| --- | --- | --- |
| A known vulnerability in a package you use | an advisory exists and you have not applied it | `npm audit`, then `overrides` when the fix is transitive |
| An install-script supply-chain compromise | a maintainer account is taken over and `postinstall` runs on every developer machine and CI runner | `--ignore-scripts` |
| Typosquatting or dependency confusion | you install a package that is not the one you meant | scoped names, a pinned registry, lockfile review |

The second is the one that has caused the largest real incidents, and it is the one `npm audit` does not look at.

## `npm audit`, and its signal-to-noise problem

```bash
npm audit
```

```text
# npm audit report

tar  <6.2.1
Severity: moderate
Denial of service while parsing a crafted tar file - https://github.com/advisories/GHSA-f5x3-32g6-xq36
fix available via `npm audit fix`
node_modules/@nestjs/cli/node_modules/tar

1 moderate severity vulnerability
```

Read that carefully before doing anything. The path is `@nestjs/cli/node_modules/tar` — the CLI is a **development** dependency, it is not in your production image, and the vulnerability requires you to parse a hostile tar file, which the CLI does not do with attacker input. Fixing it is housekeeping, not security.

This is the whole problem with `npm audit` on a Nest project. `@nestjs/cli` 12.0.0 and `@nestjs/schematics` 12.0.1 pull in the Angular devkit, which is an enormous tree, and it is the source of most of what you will see. An audit that reports forty issues that nobody triages is worse than no audit, because it trains the team to ignore the output.

### Cut the development noise first

```bash
npm audit --omit=dev
```

```text
found 0 vulnerabilities
```

That is the number that describes what you ship. Run the full audit too, but treat the two as different questions: `--omit=dev` is "is the deployed artifact vulnerable", the full run is "is a developer's laptop or a CI runner at risk".

### Make CI fail on a threshold

`--audit-level` sets the severity at which the command exits non-zero. Anything below it is reported and ignored.

```bash
# The deployed tree: nothing high or critical may merge.
npm audit --omit=dev --audit-level=high
```

```text
found 0 vulnerabilities
```

```bash
# The full tree, including tooling: report but do not block.
npm audit --audit-level=critical || true
```

Start at `high` for production dependencies and tighten once the count is genuinely zero. A threshold you keep overriding is not a gate.

For anything programmatic, use the JSON form — the text output is not stable:

```bash
npm audit --omit=dev --json \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).metadata.vulnerabilities'
```

```text
{ info: 0, low: 2, moderate: 1, high: 0, critical: 0, total: 3 }
```

### `npm audit fix` versus `--force`

`npm audit fix` applies upgrades that stay inside your declared semver ranges. It is safe and usually resolves very little, because the fix is often a major version away.

`npm audit fix --force` installs **breaking major versions** to make the report green. On a Nest project that is specifically dangerous: it will happily move `@nestjs/*` packages across a major line, and it has no idea that `@nestjs/throttler` is on **6.5.0** while the core packages are on **12.0.1**. Run it, read the diff, run the test suite — or do not run it.

## Lockfile integrity and `npm ci`

`npm install` resolves ranges and can quietly change the tree. `npm ci` installs exactly what the lockfile says, and refuses to run at all if the lockfile and `package.json` disagree.

```bash
npm ci --omit=dev --ignore-scripts
```

```text
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: @nestjs/throttler@6.5.0 from lock file
```

That error is the feature. Someone edited `package.json` without regenerating the lockfile, and the build stops rather than resolving something nobody reviewed.

Three rules that follow:

- **Commit the lockfile.** It is the only record of what you actually tested.
- **Use `npm ci` in CI and in the Docker build, never `npm install`.** A build that resolves fresh is a build whose dependency tree nobody approved.
- **Review lockfile diffs.** A pull request that changes one line of `package.json` and four hundred lines of `package-lock.json` deserves a look at the new names, not just the new versions.

The lockfile also carries an `integrity` hash per package, so `npm ci` fails on a tarball that does not match what was published when you locked it.

## Finding what is actually installed

The declared range is not the installed version. Ask the tree.

```bash
npm ls multer
```

```text
api@1.0.0
└─┬ @nestjs/platform-express@12.0.1
  └── multer@2.2.0
```

```bash
# Every copy of a package, at any depth, as JSON.
npm query '#multer' | node -pe 'JSON.parse(require("fs").readFileSync(0)).map(p => p.name + "@" + p.version)'
```

```text
[ 'multer@2.2.0' ]
```

Two results instead of one means you have two copies at different versions, and the one you audited may not be the one that runs. For a Nest application the packages worth checking by name are the ones that touch request data:

```bash
for pkg in express multer path-to-regexp jsonwebtoken cookie body-parser; do
  npm ls "$pkg" --omit=dev 2>/dev/null | sed -n "s/.*\($pkg@[0-9.]*\).*/\1/p" | sort -u
done
```

```text
express@5.2.1
multer@2.2.0
path-to-regexp@8.4.2
jsonwebtoken@9.0.3
cookie@1.0.2
```

## `overrides`: forcing a patched transitive version

The advisory is in a package four levels down, and the direct dependency that owns it has not released a fix. `overrides` tells npm to install a different version regardless of what the intermediate package asked for.

```json title="package.json"
{
  "overrides": {
    "tar": "^6.2.1"
  }
}
```

Narrower is better, because a blanket override applies everywhere and can break a package that genuinely needed the old version:

```json title="package.json"
{
  "overrides": {
    "@nestjs/cli": {
      "tar": "^6.2.1"
    }
  }
}
```

```bash
rm -rf node_modules package-lock.json && npm install && npm ls tar
```

```text
api@1.0.0
└─┬ @nestjs/cli@12.0.0
  └── tar@6.2.1  overridden
```

The `overridden` marker is the confirmation. Three caveats:

- **An override is a lie to the resolver.** The intermediate package declared a range for a reason; you have decided it was wrong. Run the tests.
- **It is a temporary state.** Add the upstream issue link as a comment in the pull request, and remove the override when the real fix lands. Overrides that survive for years become invisible pins.
- **`npm ls` after every change.** The syntax is easy to get subtly wrong, and a mistyped override silently does nothing.

## Install scripts and `--ignore-scripts`

### The threat

`preinstall`, `install` and `postinstall` scripts run automatically, with your user's privileges, on every developer machine and every CI runner, for **every package in the tree** — not just the ones you chose. A compromised maintainer account on a package you have never heard of is arbitrary code execution on your laptop before you have run a single test.

This is how the largest npm supply-chain incidents have worked, and no audit catches it: there is no advisory until somebody notices.

### The fix

```bash
npm ci --ignore-scripts
```

Some packages genuinely need their scripts — native modules like `argon2` 0.45.1, `bcrypt` 6.0.0 and `better-sqlite3` 13.0.3 build a binary at install time. Allow those specifically rather than allowing everything:

```json title=".npmrc equivalent, in package.json"
{
  "scripts": {
    "postinstall": "npm rebuild argon2 better-sqlite3"
  }
}
```

Or, better for a container build, use prebuilt binaries and skip the compile entirely. In the Dockerfile the pattern is:

```dockerfile title="Dockerfile"
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Nothing in the tree gets to run code during install.
RUN npm ci --omit=dev --ignore-scripts
# Then rebuild only the native modules you actually depend on.
RUN npm rebuild argon2
```

:::best-practice
Set `ignore-scripts=true` in your project's `.npmrc` so it is the default for everybody, and make the exceptions explicit. The cost is one extra `npm rebuild` line; the benefit is that a compromised package in the tree cannot run anything.
:::

## Typosquatting and dependency confusion

**Typosquatting** is a package named to be mistyped or misread: a missing hyphen, a transposed letter, a scope dropped. The Nest ecosystem has a specific version of this, because so many packages are scoped:

| You meant | A squatter's name | How to avoid it |
| --- | --- | --- |
| `@nestjs/config` | `nestjs-config` | prefer the `@nestjs/` scope; check the npm page's publisher |
| `@casl/ability` | unscoped `casl`, which is deprecated and split into packages | install the scoped package |
| `@nats-io/transport-node` | the old unscoped package, deprecated and moved | install the scoped package |
| `nestjs-pino` | a near-identical name | this one is genuinely unscoped — check the download count and the repository link |

Not every unscoped package is wrong — `nestjs-pino` 5.1.0 is the real logging integration and has no scope. The check is not "is it scoped" but "does this name resolve to the repository I expect", and the lockfile diff is where you see it.

**Dependency confusion** is the internal-package version: you have `@acme/shared-dtos` on a private registry, an attacker publishes `@acme/shared-dtos` on the public registry with a higher version, and a misconfigured resolver takes the public one.

```text title=".npmrc"
# Every @acme package resolves from the private registry, never the public one.
@acme:registry=https://npm.acme.internal/
//npm.acme.internal/:_authToken=${NPM_TOKEN}

# And the default for everything else.
registry=https://registry.npmjs.org/
ignore-scripts=true
```

Claim your organization's scope on the public registry even if you never publish to it. An unclaimed scope is the attack.

## Packages this stack must not carry

Each of these is confirmed by its own npm deprecation notice, or by a version fact in this handbook.

| Package | Status | Use instead |
| --- | --- | --- |
| `multer` 1.x | deprecated: *"Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x"* | multer 2.x — Nest 12 already bundles 2.2.0 |
| `csurf` | deprecated: *"This package is archived and no longer maintained"* | `csrf-csrf` 4.0.3, or SameSite plus an origin check |
| the unscoped NATS client | deprecated: *"Package moved. Use @nats-io/transport-node"* | `@nats-io/transport-node` 3.4.0 |
| the Apollo WebSocket subscriptions transport | deprecated: *"no longer maintained. We recommend you use `graphql-ws` instead"* | `graphql-ws` 6.2.1 |
| unscoped `casl` | deprecated: *"CASL is split into few packages"* | `@casl/ability` 7.0.1 |
| `request` | deprecated years ago | the global `fetch`, or `undici` 8.10.2 |
| `prom-client` | deprecated: *"replaced by @prometheus-io/client"* | `@prometheus-io/client` |
| `oslo` | deprecated: *"no longer supported"* | the successor project at oslojs.dev |
| `express-async-handler` | not deprecated on npm, but unnecessary — Express 5 forwards rejected promises to the error handler on its own | delete it |

Find them in one pass:

```bash
# Deprecation notices are printed during install; this replays them.
npm ls --all 2>&1 | grep -i deprecated

# Or ask the registry about each direct dependency.
node -e '
const { dependencies = {} } = require("./package.json")
for (const name of Object.keys(dependencies)) {
  const { execSync } = require("child_process")
  const note = execSync(`npm view ${name} deprecated`, { encoding: "utf8" }).trim()
  if (note) console.log(`${name}: ${note}`)
}'
```

This site's own checker fails the build if a code fence imports the moved NATS package or the abandoned subscriptions transport — see CONTRIBUTING §12. Adopt the same idea: a grep in CI for the names you have decided against is faster and more reliable than remembering.

## Keeping `@nestjs/*` aligned

A Nest-specific hazard that no audit tool knows about: **the `@nestjs/*` packages are not on one version line.**

| Package | Current |
| --- | --- |
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/testing` | 12.0.1 |
| `@nestjs/config`, `@nestjs/passport`, `@nestjs/mongoose` | 12.0.0 |
| `@nestjs/jwt`, `@nestjs/swagger`, `@nestjs/typeorm` | 12.0.1 |
| `@nestjs/throttler` | **6.5.0** |
| `@nestjs/graphql`, `@nestjs/apollo` | **14.0.0** |
| `@nestjs/observe` | **0.1.8** — pre-1.0 |

A Renovate group rule that bumps every `@nestjs/` package to the same major, or an `npm audit fix --force` run, will try to move `@nestjs/throttler` somewhere that does not exist. Group the core packages together and leave the rest to their own updates:

```json title="renovate.json"
{
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "description": "The framework core moves as one unit.",
      "matchPackageNames": [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-express",
        "@nestjs/testing"
      ],
      "groupName": "nestjs core"
    },
    {
      "description": "Security patches land on their own, immediately.",
      "matchUpdateTypes": ["patch"],
      "automerge": true,
      "vulnerabilityAlerts": { "labels": ["security"], "automerge": true }
    }
  ]
}
```

Dependabot's equivalent is `.github/dependabot.yml` with a `groups` block. Either is fine; what matters is that security patches are not queued behind a major-version upgrade that nobody has time for.

`nest upgrade` from `@nestjs/cli` 12.0.0 updates the `@nestjs/*` packages for you and preserves the existing module format — but note that the CLI needs a newer Node than the application does: `@nestjs/schematics` 12 declares `>=22.12.0`, so Node **22.22.3+, 24.15+ or 26+**. See [Installation and the CLI](../nestjs/installation-and-cli.md).

## The CI job

```yaml title=".github/workflows/audit.yml"
name: audit
on:
  pull_request:
  schedule:
    - cron: '0 6 * * 1'   # a fresh advisory can appear with no code change

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      # Fails if package.json and the lockfile disagree, and runs no scripts.
      - run: npm ci --ignore-scripts

      # The deployed tree. This one blocks the merge.
      - run: npm audit --omit=dev --audit-level=high

      # The full tree, including tooling. Reported, not blocking.
      - run: npm audit --audit-level=critical || true

      # Registry signatures for everything in the lockfile.
      - run: npm audit signatures

      # Names we have decided against.
      - run: |
          if npm ls --all 2>&1 | grep -iE 'multer@1\.|csurf@'; then
            echo 'A package on the deny list is installed'; exit 1
          fi
```

The weekly schedule matters as much as the pull-request trigger: advisories are published against versions you already shipped, and nothing in your repository changes when that happens.

`npm audit signatures` checks the registry's cryptographic signatures for every package in the lockfile, which is a different question from "is there an advisory" — it tells you the tarball is the one the registry published.

## Production considerations

- **Audit what you deploy, not what you develop.** `--omit=dev` is the number that matters; the Nest CLI's tree is not in your image.
- **Scan the image too.** `npm audit` sees JavaScript. A container scanner sees the base image's OpenSSL, which is where the critical CVEs usually are. See [Docker](../nestjs-production/docker.md).
- **Generate an SBOM at build time.** When an advisory lands, "which of our forty services ships this version" should be a query, not an afternoon.
- **Budget for the upgrade, not just the audit.** Finding the vulnerability is the cheap half; the expensive half is a major-version upgrade you have deferred for two years.
- **Pin the Node version in CI to the one you deploy.** An audit run on a different runtime can resolve a different tree for native modules.
- **Fewer dependencies is the only control that compounds.** Node 24 has `fetch`, `crypto.randomUUID()`, a test runner, a watch mode, `node:sqlite` and `--env-file` built in. Every one of those replaces a package and everything under it.
- **Review the transitive tree when adding a dependency, not when auditing it.** `npm view <pkg> dependencies` before the install is thirty seconds; a compromised transitive dependency is a week.

## Common mistakes

- **Running `npm audit` without `--omit=dev` and panicking.** Most of a Nest tree's findings are in the CLI, which you do not ship.
- **Treating every advisory as equally urgent.** Read the path and the attack vector; a DoS in a build tool is not a production incident.
- **Ignoring the audit entirely because it is noisy.** Set a threshold, gate on it, and keep the count at zero so the next finding is visible.
- **`npm audit fix --force` to get a green report.** It installs breaking majors and does not understand that `@nestjs/throttler` is 6.5.0.
- **`npm install` in CI or in a Dockerfile.** It resolves fresh and can ship a tree nobody reviewed.
- **Not committing the lockfile.** There is then no record of what you tested.
- **Rubber-stamping a four-hundred-line lockfile diff.** New package names are the thing to look at.
- **Leaving install scripts enabled everywhere.** A compromised package in the tree runs code on every machine that installs.
- **A blanket `overrides` entry.** Scope it to the dependency that needs it, and remove it when upstream fixes the problem.
- **Overrides with no expiry.** They become invisible version pins that outlive the advisory.
- **Assuming a scoped-looking name is the official package.** Check the publisher and the repository; `nestjs-config` is not `@nestjs/config`.
- **Not claiming your organization's npm scope.** An unclaimed scope is a dependency-confusion attack waiting to happen.
- **Grouping every `@nestjs/` package in one Renovate rule.** They are not on one version line.
- **Only auditing on pull requests.** Advisories appear against code you shipped months ago; run it on a schedule.
- **Auditing JavaScript and never scanning the base image.** The critical CVEs are usually below your code.

## Related topics

- [Dependency auditing](../security/dependency-auditing.md) — provenance, signature verification and the argument for fewer dependencies.
- [Secrets and config validation](secrets-and-config.md) — the `.npmrc` token the private registry needs, and keeping it out of an image layer.
- [File upload security](file-upload-security.md) — why the multer version in your tree is a security fact.
- [CSRF](csrf.md) — the archived package this page tells you not to install.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — the CLI's Node floor and `nest upgrade`.
- [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md) — the package moves that come with the major.
- [Continuous integration](../nestjs-production/ci.md) — where this workflow sits among the other gates.
- [Docker](../nestjs-production/docker.md) — `npm ci --ignore-scripts` in a multi-stage build, and image scanning.
- [Microservices and transports](../nestjs-advanced/microservices.md) — the NATS client that moved packages.
- [GraphQL](../nestjs-advanced/graphql.md) — the subscriptions transport that was replaced.
- [Authorization](../nestjs-libraries/authorization.md) — the CASL package split, and which one to install.
