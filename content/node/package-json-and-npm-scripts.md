---
title: package.json and npm scripts
description: The fields that change how Node behaves, a script set that works on Node 24, and the install commands that belong in CI.
status: current
updated: 2026-09-08
---

`package.json` is not just a dependency list — several of its fields change how the runtime resolves and executes your code. This page covers the fields that matter for a backend service, the scripts you actually need now that Node has a watcher and a test runner built in, and the install behavior that keeps CI reproducible.

## A working baseline

```json title="package.json"
{
  "name": "my-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "imports": {
    "#config": "./src/config.js",
    "#db/*": "./src/db/*.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch --env-file-if-exists=.env src/server.js",
    "test": "node --test",
    "test:watch": "node --test --watch",
    "test:coverage": "node --test --experimental-test-coverage",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^5.2.1"
  },
  "devDependencies": {
    "eslint": "^10.10.0",
    "typescript": "^7.0.2"
  }
}
```

Nothing in that script block needs `nodemon`, `dotenv-cli`, `jest`, `mocha`, `cross-env`, or `ts-node`. Node 24 covers all of it.

## Fields that change runtime behavior

| Field | Effect |
| --- | --- |
| `type` | `"module"` makes every `.js` file in the subtree an ES module |
| `exports` | defines the package's public entry points; anything else is unreachable from outside |
| `imports` | internal `#alias` mappings, resolved by Node itself |
| `main` | legacy entry point, used only when `exports` is absent |
| `engines` | the Node range you support — npm errors on mismatch when `engine-strict` is set |
| `bin` | executables linked into `node_modules/.bin` |
| `files` | the allow-list of what gets published to the registry |
| `private` | `true` prevents accidental `npm publish` — set it on every application |

`exports`, `imports` and `type` are covered in depth in [ESM vs CommonJS](./esm-vs-commonjs.md).

:::best-practice
Put `"private": true` on every application. It costs nothing and it is the only thing standing between a mistyped `npm publish` and your source code on the public registry.
:::

### `engines` is documentation until you enforce it

npm only warns on an `engines` mismatch by default. Make it fail:

```text title=".npmrc"
engine-strict=true
```

Then a developer on the wrong major version gets an error at install time rather than a confusing runtime failure two hours later.

## Scripts

### `npm run` vs `node --run`

Node 22 added a built-in script runner. It is dramatically faster because it skips npm's startup entirely:

```bash
node --run test
```

It deliberately implements less than `npm run`:

| | `npm run` | `node --run` |
| --- | --- | --- |
| Runs `pre` / `post` scripts | yes | **no** |
| Adds `node_modules/.bin` to `PATH` | yes | yes |
| Workspace flags (`-w`) | yes | no |
| `npm_package_*` env vars | yes | no (sets `NODE_RUN_SCRIPT_NAME` and `NODE_RUN_PACKAGE_JSON_PATH`) |
| Searches parent directories for `package.json` | yes | no |

Use `node --run` for the hot loop — tests, lint, dev — where the ~200 ms npm overhead is noticeable. Keep `npm run` in CI and anywhere you rely on lifecycle scripts.

:::warning
If you migrate a script set to `node --run`, check for `pretest` / `posttest` / `prestart` hooks first. They are silently skipped, so a build step that used to run before your tests simply stops running and the failure looks like a stale-artifact bug.
:::

### Keep scripts thin

A script that grows past a line or two belongs in a file. `"build": "rm -rf dist && tsc && cp -r public dist/"` does not run on Windows and cannot be tested. Move it to `scripts/build.mjs` and call `node scripts/build.mjs`.

Avoid inline environment assignment (`NODE_ENV=production node …`) for the same reason — it is shell syntax and fails on Windows `cmd`. Use `node --env-file` instead, described in [Environment variables and config](./environment-variables-and-config.md).

### `npm run` argument passing

```bash
npm run test -- --test-name-pattern="users"
```

Everything after `--` is appended to the script's command line.

## Installing

| Command | Use it when |
| --- | --- |
| `npm install` | adding or updating a dependency locally; rewrites `package-lock.json` |
| `npm ci` | CI and Docker builds — installs exactly the lockfile, deletes `node_modules` first, fails if the lockfile and `package.json` disagree |
| `npm install --omit=dev` | producing a runtime-only tree for a container image |

:::tabs
@tab npm
```bash
npm ci --omit=dev
```
@tab pnpm
```bash
pnpm install --frozen-lockfile --prod
```
@tab yarn
```bash
yarn install --immutable
```
:::

**Commit `package-lock.json`.** It is what makes a build reproducible and what `npm audit` and your SCA tooling read. A repository without a lockfile installs different transitive dependencies on different days.

### Versions and ranges

Use caret ranges (`^5.2.1`) in `package.json` and let the lockfile pin the exact tree. The caret allows compatible minor and patch updates; the lockfile makes sure everyone gets the same one until you deliberately update.

:::danger
`npm install` runs `postinstall` scripts from every package in the tree, with your user's permissions. That is the mechanism behind most npm supply-chain attacks. In CI, prefer `npm ci --ignore-scripts` and explicitly rebuild the few packages that genuinely need a native build step. See [Dependency auditing](../security/dependency-auditing.md).
:::

### Forcing a transitive fix with `overrides`

When a vulnerability is in a dependency of a dependency and the direct parent has not released:

```json title="package.json"
{
  "overrides": {
    "some-vulnerable-lib": "^2.1.4"
  }
}
```

Treat this as temporary. You are overriding a version the parent never tested against, so pair it with a test run and remove it once the parent updates.

## Dependencies Node 24 already replaces

The cheapest dependency is the one you delete. Every one of these is built in:

| You used to install | Node 24 built-in |
| --- | --- |
| `dotenv`, `dotenv-cli`, `cross-env` | `node --env-file=.env` / `--env-file-if-exists` |
| `nodemon` | `node --watch`, `--watch-path` |
| `jest`, `mocha`, `chai`, `sinon` | `node:test` + `node:assert/strict` + `mock` |
| `nyc` / `c8` | `node --test --experimental-test-coverage` |
| `ts-node` | native type stripping — `node src/server.ts` |
| `node-fetch`, `request` | global `fetch`, `Headers`, `Request`, `Response` |
| `uuid` | `crypto.randomUUID()` |
| `lodash.clonedeep`, `rfdc` | `structuredClone(value)` |
| `rimraf` | `fs.rm(path, { recursive: true, force: true })` |
| `mkdirp` | `fs.mkdir(path, { recursive: true })` |
| `abort-controller` | global `AbortController`, `AbortSignal.timeout()` |
| `better-sqlite3` (for simple cases) | `node:sqlite` — `DatabaseSync`, no native build |
| `npm-run-all` (for the simple case) | `node --run` |

```js title="src/ids.js"
import { randomUUID } from 'node:crypto'

const id = randomUUID()            // also available as globalThis.crypto.randomUUID()
const copy = structuredClone(order) // deep clone, handles Map, Set, Date, TypedArray, cycles
```

`structuredClone` is not a drop-in for every deep clone: it throws a `DataCloneError` on functions, and a class instance comes back as a plain object because prototypes are not preserved. For plain data — the shape most request payloads have — it is faster and more correct than a hand-rolled recursive copy, and unlike `JSON.parse(JSON.stringify(x))` it keeps `Date`, `Map`, `Set` and cyclic references intact.

:::note
`node:sqlite` replaces `better-sqlite3` for straightforward embedded storage and test fixtures, with no compile step in your Docker build. Keep `better-sqlite3` 13.0.3 when you depend on its extension loading, custom collations, or a specific API surface. See [SQLite](../databases/sqlite.md).
:::

## Common patterns

### Check what is out of date

```bash
npm outdated          # direct dependencies with newer versions
npm audit             # known advisories
npm audit --omit=dev  # only what actually ships
```

`npm audit` on the full tree reports build-time-only advisories that do not affect your running service; `--omit=dev` is the number that matters for production risk.

### Reading fields without a parser

```bash
npm pkg get version
npm pkg set scripts.dev="node --watch src/server.js"
```

Useful in CI scripts, and it preserves formatting better than `sed`.

### Workspaces

A monorepo declares its members in the root `package.json`:

```json title="package.json"
{
  "private": true,
  "workspaces": ["packages/*", "services/*"]
}
```

npm hoists shared dependencies to the root `node_modules` and symlinks the workspace packages, so `import { x } from '@acme/toolkit'` resolves to your local source without a publish step. Run a script in one member with `npm run test -w @acme/toolkit`.

## Common mistakes

- **Not committing the lockfile.** Every install becomes a different build.
- **Using `npm install` in CI or a Dockerfile.** It can silently update the tree. `npm ci` installs the lockfile or fails.
- **Putting `typescript`, `eslint` or test tooling in `dependencies`.** They ship to production and bloat the image. They are `devDependencies`.
- **Inline `NODE_ENV=… node …` in scripts.** Breaks on Windows shells. Use `--env-file`, or set it in the process manager.
- **Assuming `node --run` is a drop-in for `npm run`.** It skips `pre`/`post` scripts and workspace flags.
- **Leaving `"private": true` off an application.** One `npm publish` typo publishes your service.
- **Pinning exact versions everywhere instead of using the lockfile.** You get the reproducibility you already had, plus a manual upgrade chore for every patch release.
- **Leaving `overrides` in place forever.** They pin a version the parent package never tested; revisit them at every upgrade.

## Related topics

- [ESM vs CommonJS](./esm-vs-commonjs.md) — what `type`, `exports` and `imports` actually do.
- [Environment variables and config](./environment-variables-and-config.md) — replacing `cross-env` and `dotenv-cli` with `--env-file`.
- [The built-in test runner](./built-in-test-runner.md) — what `npm test` should call.
- [Dependency auditing](../security/dependency-auditing.md) — lockfiles, advisories, and install-script risk.
- [Dockerfile](../production/dockerfile.md) — `npm ci --omit=dev` in a multi-stage build.
- [Continuous integration](../production/ci.md) — caching and reproducible installs in CI.
