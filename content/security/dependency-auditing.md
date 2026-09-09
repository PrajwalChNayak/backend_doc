---
title: Dependency auditing
description: Reading npm audit output without drowning in noise, forcing patched transitive versions, defending against install scripts and typosquats, and shrinking the tree.
status: current
updated: 2026-09-08
---

Most of the code in your production image is not yours. A typical Express API has a handful of direct dependencies and several hundred transitive ones, each of which runs with your process's permissions and can read `process.env`. This page is about knowing what is in there, deciding which advisories matter, and reducing the count — which is the only fix that keeps working.

## `npm audit` and its signal-to-noise problem

`npm audit` compares your installed tree against the GitHub Advisory Database and prints every match. Run it against a real project and the output looks like this:

```bash
$ npm audit
# npm audit report

form-data  <=2.5.5
Severity: critical
form-data uses unsafe random function in form-data for choosing boundary - https://github.com/advisories/GHSA-fjxv-7rqg-78g4
form-data: CRLF injection in form-data via unescaped multipart field names and filenames - https://github.com/advisories/GHSA-hmw2-7cc7-3qxx
No fix available
node_modules/form-data
  request  *
  Depends on vulnerable versions of form-data
  Depends on vulnerable versions of qs
  Depends on vulnerable versions of tough-cookie
  Depends on vulnerable versions of uuid
  node_modules/request

…

5 vulnerabilities (3 moderate, 2 critical)
```

Reading that correctly is the whole skill. Four things the output does not tell you:

- **Whether the vulnerable code path is reachable from your application.** An advisory in a Markdown parser used only by a documentation generator is not a production risk; the report gives it the same severity badge as one in your HTTP router.
- **Whether it is a development-only dependency.** A ReDoS in a test reporter runs on your CI machine, not on your API.
- **Whether the severity applies to you.** "Critical — prototype pollution" in a package you feed only literal strings is not critical in your deployment.
- **What "No fix available" means.** Usually that the maintainer of the *intermediate* package has not bumped their range. You can often fix it yourself with `overrides` — see below.

The reason this matters is behavioral: an audit that reports 40 findings every day is an audit nobody reads, and the one that mattered is in there.

### Cut development noise first

```bash
$ npm audit --omit=dev
```

This audits only what ships. `--production` is the older spelling and still works, but `--omit=dev` is the current flag and composes with `--omit=optional` and `--omit=peer`.

:::warning
`--omit=dev` narrows the *report*, not your risk. A compromised development dependency runs on developer laptops and CI runners with repository credentials and deploy keys — often a softer target than production. Audit both; treat them as separate queues with different urgency.
:::

### Make CI fail on a threshold, not on everything

`--audit-level` sets the severity at which the command exits non-zero. It does not filter the printed report.

```bash
# In CI: fail the build on high or critical in production dependencies.
$ npm audit --omit=dev --audit-level=high
```

```bash
$ npm audit --audit-level=high > /dev/null; echo $?
1
$ npm audit --omit=dev --audit-level=critical > /dev/null; echo $?
1
```

For anything more than a threshold — suppressing a triaged finding, tracking an accepted risk — parse the JSON rather than grepping the text:

```bash
$ npm audit --json | jq '.vulnerabilities | to_entries[] | select(.value.severity == "critical") | .key'
```

The one thing not to do is set `--audit-level=none` and forget it. Pick a threshold you will actually act on, and write down who triages the rest.

## `npm audit fix` versus `--force`

```bash
$ npm audit fix
```

This runs a real `npm install` restricted to versions **inside** your declared semver ranges. It is safe in the sense that it cannot introduce a breaking major version, and it is often a no-op precisely because the fix is a major bump.

```bash
$ npm audit fix --force
```

`--force` removes that restriction. The npm documentation is explicit that it is required when remediation needs "modules outside your stated dependency range (including SemVer-major changes)".

:::danger
`npm audit fix --force` will happily downgrade or major-bump a direct dependency to make an advisory disappear. It has silently moved projects backwards to a version *older* than the one they were running. Never run it on a branch you intend to merge without reading the resulting `package.json` diff and running the full test suite.
:::

The safe sequence:

```bash
$ git switch -c chore/audit
$ npm audit fix                     # in-range fixes only
$ npm test
$ git diff package.json package-lock.json
```

Then handle the remaining findings one at a time, deliberately, with `overrides` or a version bump you chose.

## Lockfile integrity and `npm ci`

`package-lock.json` pins the exact version *and* the integrity hash of every package in the tree. That hash is what makes a build reproducible and what detects a tampered tarball.

| | `npm install` | `npm ci` |
| --- | --- | --- |
| Reads | `package.json`, updates the lockfile | `package-lock.json` only |
| Modifies the lockfile | yes | never — errors if it disagrees with `package.json` |
| Existing `node_modules` | reconciles | deletes and reinstalls |
| Missing lockfile | creates one | fails |

**Use `npm ci` in CI and in every image build.** `npm install` in a Dockerfile means your image can contain a version nobody reviewed, because a caret range resolved to something new between the pull request and the deploy.

```dockerfile good title="Dockerfile"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
```

Commit the lockfile. Review lockfile diffs in pull requests — a change to an `integrity` hash for a version that did not change is worth stopping on.

## Finding the version that is actually installed

Advisories name a package and a range. `npm ls` tells you which version you have and, crucially, **who pulled it in**:

```bash
$ npm ls tough-cookie
vuln@ /srv/app
`-- request@2.88.2
  `-- tough-cookie@2.5.0
```

That output is the triage. The vulnerable package is `tough-cookie`, but the thing to fix is `request` — and in this case `request` is deprecated, so the real fix is deleting it.

```bash
$ npm ls --all                 # the whole tree
$ npm ls --omit=dev express    # only what ships
$ npm why tough-cookie         # same information, phrased as "why is this here"
```

## `overrides`: forcing a patched transitive version

When `npm audit` says **"No fix available"**, it usually means the intermediate package's declared range does not include the patched version. You can override it.

```json title="package.json"
{
  "name": "app",
  "dependencies": { "request": "2.88.2" },
  "overrides": { "tough-cookie": "^4.1.4" }
}
```

```bash
$ npm install
$ npm ls tough-cookie
ovr@ /srv/app
`-- request@2.88.2
  `-- tough-cookie@4.1.4 overridden
```

The vulnerability count drops accordingly:

```bash
$ npm audit
4 vulnerabilities (2 moderate, 2 critical)      # was 5
```

Scope an override to one dependent when the blanket form is too broad:

```json title="package.json"
{
  "overrides": {
    "request": { "tough-cookie": "^4.1.4" }
  }
}
```

:::warning
An override forces a version the intermediate package never declared support for. Its API may have changed. `npm ls` will say `overridden` and nothing else will warn you — so an override needs a test that exercises the code path, and a comment saying why it exists and when it can be removed.
:::

An override is a bridge, not a destination. Track it, and delete it when the dependent catches up.

## Install scripts and `--ignore-scripts`

**The threat.** `preinstall`, `install` and `postinstall` scripts execute arbitrary code on any machine that installs the package — with the developer's or the CI runner's permissions, before any of your code runs, and before any review of what was downloaded. This is the delivery mechanism in essentially every npm supply-chain compromise: a maintainer account is taken over, a patch version is published with a malicious `postinstall`, and it runs on thousands of machines within hours.

**The fix.** Do not run them where they are not needed:

```bash
$ npm ci --ignore-scripts
```

```bash
# Make it the default for this project (or globally, per developer).
$ npm config set ignore-scripts true --location=project
```

**The cost.** Some legitimate packages need their install script — native modules that compile or download a prebuilt binary. `bcrypt` 6.0.0, `argon2` 0.45.1, `better-sqlite3` 13.0.3 and `sharp` 0.35.4 are the ones you are most likely to hit in this handbook. When `--ignore-scripts` is on globally, those need an explicit rebuild:

```bash
$ npm rebuild sharp argon2
```

That extra step is the point: allowing scripts becomes a named, reviewable decision for four packages instead of an implicit grant to four hundred. And it is another argument for preferring `node:sqlite` over `better-sqlite3`, or a pure-JS alternative where the performance difference does not matter.

## Typosquatting and dependency confusion

**Typosquatting** is a package published under a name that looks like one you meant: a transposed letter, a missing hyphen, a singular where the real one is plural. It is caught by reading, and only at install time — after which the name is in your lockfile and looks legitimate forever.

```bash
# Before adding anything: does the name resolve to what you expect?
$ npm view express-rate-limit repository.url homepage
$ npm view express-rate-limit time.created dist-tags
```

A package with 40 downloads a week and a creation date of last Tuesday, standing in for one with millions, is the signal.

**Dependency confusion** is the more dangerous variant, because it needs no typo. If your organization has an internal package named `@acme/billing-client` and your registry configuration ever falls back to the public registry, an attacker who publishes `@acme/billing-client` publicly — with a higher version number — can get it installed instead of yours.

The defense is two settings, both required:

```ini title=".npmrc"
# 1. Scope every internal package, and pin that scope to the private registry.
@acme:registry=https://npm.internal.acme.com/
//npm.internal.acme.com/:_authToken=${NPM_TOKEN}

# 2. The public registry is the default for everything else — and only that.
registry=https://registry.npmjs.org/
```

```json title="package.json"
{
  "name": "@acme/billing-client",
  "publishConfig": { "registry": "https://npm.internal.acme.com/" }
}
```

- **Always scope internal packages.** An unscoped internal name is claimable by anyone; a scope you own is not.
- **Never configure the public registry as a fallback for your private scope.** A proxy registry that "falls through to npmjs" reintroduces the whole problem.
- **Reserve your scope on the public registry** even if you never publish there.

## Provenance and signature verification

Every package on the public registry is signed by npm. `npm audit signatures` verifies those signatures against the registry's keys, and reports packages whose tarball does not match:

```bash
$ npm audit signatures
audited 67 packages in 3s

67 packages have verified registry signatures
```

A failure here means the tarball you have is not the tarball the registry signed — a compromised mirror, a corrupted cache, or a tampered artifact. Run it in CI after `npm ci`.

**Provenance** is stronger: it links a published package to the source commit and the CI workflow that built it, as a signed attestation.

```bash
$ npm audit signatures --json --include-attestations
```

Packages published from a supported CI provider with `npm publish --provenance` carry one. Provenance is not yet universal, so you cannot require it across a whole tree — but for your *own* packages, publishing with provenance means a consumer can verify that the tarball came from your repository rather than from a stolen token.

## Deprecated packages

`npm audit` does **not** report deprecations. A package can be abandoned, unmaintained and formally deprecated on the registry while showing zero vulnerabilities — which is the more common failure mode, because an unmaintained package simply never gets an advisory filed against it.

Deprecation warnings appear at install time, and they scroll past:

```bash
$ npm install multer@1.4.5-lts.2 request@2.88.2
npm warn deprecated multer@1.4.5-lts.2: Multer 1.x is impacted by a number of vulnerabilities,
  which have been patched in 2.x. You should upgrade to the latest 2.x version.
npm warn deprecated request@2.88.2: request has been deprecated,
  see https://github.com/request/request/issues/3142
```

Check a single package deliberately:

```bash
$ npm view multer@1.4.5-lts.2 deprecated
Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x.
You should upgrade to the latest 2.x version.
```

The ones this handbook calls out by name:

| Package | Status | Replace with |
| --- | --- | --- |
| `multer@1.x` (`1.4.5-lts.2`) | npm-deprecated — vulnerabilities patched in 2.x | `multer` 2.3.0 |
| `csurf` | archived, unmaintained | `csrf-csrf` 4.0.3, or a session-bound double-submit token |
| `request` | deprecated since 2020 | `fetch` (global, built in) or `undici` 8.10.2 |
| `prom-client` | npm-deprecated | `@prometheus-io/client` |
| `express-async-handler` | unnecessary on Express 5 | delete it — the router forwards rejections itself |

A CI check that fails on any deprecated production dependency is a five-line script and keeps the list from growing:

```bash title="scripts/check-deprecations.sh"
#!/usr/bin/env bash
set -euo pipefail

# Reinstall from the lockfile and fail if npm emits a deprecation warning.
if npm ci --omit=dev 2>&1 | tee /tmp/install.log | grep -q 'npm warn deprecated'; then
  echo "Deprecated production dependencies:"
  grep 'npm warn deprecated' /tmp/install.log
  exit 1
fi
```

## Keeping it current: Dependabot and Renovate

Both open pull requests when a dependency has a newer version. The difference is how much control they give you over batching.

| | Dependabot | Renovate |
| --- | --- | --- |
| Hosting | built into GitHub | self-hosted, GitHub App, or CI job |
| Configuration | `.github/dependabot.yml` | `renovate.json`, considerably more expressive |
| Grouping | limited grouping | grouped by package rules, monorepo-aware |
| Auto-merge | via GitHub rules | built in, with a stability delay |
| Security-only mode | yes, separate from version updates | yes, via `vulnerabilityAlerts` |

```yaml title=".github/dependabot.yml"
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      dev-dependencies:
        dependency-type: development
```

Two rules that decide whether this helps or becomes noise:

- **Group development dependencies into one pull request.** Twelve separate bumps for test tooling teach the team to merge without reading, which is exactly the habit an attacker needs.
- **Add a stability delay** — Renovate's `minimumReleaseAge` (for example, three days) means a malicious version published to a hijacked account has usually been unpublished before your bot proposes it.

And in either case: the bot cannot tell you whether the new version is safe. It can only tell you it exists. A green test suite on an automerged patch bump is not review.

## The actual long-term fix: fewer dependencies

Every dependency is code you did not write, running with your permissions, maintained by someone you have not met, with its own dependencies on the same terms. The audit tooling manages that risk; it does not remove it.

Node 24 has absorbed a lot of what used to be a package:

| Used to need | Now built in | Since |
| --- | --- | --- |
| `node-fetch`, `axios`, `request` | `fetch`, `Headers`, `Request`, `Response` | 18 (global), stable in 21+ |
| `dotenv` | `node --env-file=.env` | 20.6, stabilised in 24 |
| `jest`, `mocha` (for most cases) | `node:test` + `node --test` | 20 |
| `nodemon` | `node --watch` | 22 |
| `uuid` | `crypto.randomUUID()` | 19 |
| `better-sqlite3` (for simple cases) | `node:sqlite` | 22.5 experimental, 24 usable |
| `body-parser` | `express.json()` and friends — bundled with Express 5 | — |
| `express-async-handler` | No longer needed — Express 5 forwards rejected promises itself | Express 5 |

Before adding a package, three questions:

1. **How many transitive dependencies does it bring?** `npm view <pkg> dependencies` before you install; check the install output afterwards. A one-function utility that adds forty packages is not a small dependency.
2. **Is it maintained?** Last publish date, open issue count, whether the last release was a security fix nobody reviewed.
3. **Could this be twenty lines in `src/lib/`?** Sometimes yes, and then it is twenty lines you own, test and can read.

That is not an argument for writing your own crypto, your own HTTP parser, or your own password hashing. It is an argument against the fifth date-formatting helper.

## Security considerations

- **Every dependency can read `process.env`.** There is no sandbox between your code and a transitive package in the same process. Secrets in the environment are secrets shared with the whole tree.
- **Development dependencies are a production risk by another path** — CI runners hold deploy credentials and repository write access.
- **`npm audit` covers known advisories only.** A backdoor published yesterday has no advisory. Lockfile pinning, `--ignore-scripts` and a stability delay are what cover the unknown case.
- **Auditing tells you nothing about behavior.** A package with a clean audit can still exfiltrate your environment on import.
- **Pin exact versions for anything that touches secrets or authentication.** A caret range is an automatic upgrade you did not review.

## Production considerations

- **Run `npm ci --omit=dev --ignore-scripts` in the image build**, and `npm audit signatures` right after it. Both fail fast and cost seconds.
- **Generate an SBOM** (`npm sbom --sbom-format=cyclonedx`) as a build artifact so that when an advisory lands you can answer "are we affected, and in which deployed version" without rebuilding.
- **Rebuild and redeploy on a schedule**, not only on code change. A base image with a patched OpenSSL only reaches production when something rebuilds.
- **Separate the two queues.** "Advisory in a production dependency" is an incident with an owner and a clock. "Advisory in a test reporter" is a chore. Conflating them means neither gets done.
- **Record accepted risks with an expiry.** A finding you triaged as not-applicable should be re-examined in 90 days, not suppressed permanently.

## Common mistakes

- **Treating the vulnerability count as the metric.** Zero findings with `--force`-downgraded packages is worse than five triaged ones.
- **`npm audit fix --force` on the main branch.** It can downgrade direct dependencies to satisfy an advisory.
- **`npm install` in a Dockerfile.** The image can contain versions nobody reviewed. `npm ci`.
- **Not committing `package-lock.json`.** No reproducible builds, no integrity hashes, no meaningful review of what changed.
- **Reading "No fix available" as "nothing to do".** It usually means the intermediate range is stale — try `overrides`.
- **Adding an `overrides` entry and never removing it.** It silently pins a version past the point the dependent supports.
- **Ignoring `npm warn deprecated`.** It scrolls past on every install, and it is the only warning you get for `multer@1.x`, `csurf` and `request`.
- **Auditing only production.** The developer laptop and the CI runner hold the credentials.
- **Leaving install scripts enabled everywhere.** That is arbitrary code execution granted to every package in the tree, by default.
- **Unscoped internal package names.** Dependency confusion needs nothing else.
- **Automerging every bot pull request.** The bot verifies that a version exists, not that it is safe.
- **Adding a package for something Node 24 already does.** `fetch`, `node:test`, `--env-file`, `--watch`, `crypto.randomUUID()`, `node:sqlite`.

## Related topics

- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — ranges, lockfiles and the `overrides` field.
- [Continuous integration](../production/ci.md) — where `npm ci`, `npm audit` and signature verification belong in the pipeline.
- [Dockerfile](../production/dockerfile.md) — `npm ci --omit=dev --ignore-scripts` in a multi-stage build.
- [Secrets management](secrets-management.md) — why every dependency reading `process.env` matters.
- [Library index](../reference/library-index.md) — the packages this handbook recommends, with versions.
- [File uploads](../express-libraries/file-uploads.md) — `multer` 2.x, and why 1.x is deprecated.
- [CSRF](csrf.md) — `csrf-csrf` instead of the archived `csurf`.
- [OWASP API Top 10 in Express](owasp-api-top-10.md) — the list this risk is notably absent from.
