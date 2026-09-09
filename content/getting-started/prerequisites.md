---
title: Prerequisites
description: The Node 24 runtime, version manager, npm version, JavaScript knowledge, optional Docker services and editor setup you need before the first page.
status: current
updated: 2026-09-08
---

Everything on this site targets **Node.js 24.20.0 LTS**. This page gets you to that version, lists the JavaScript you are assumed to know, and covers the optional tooling — Docker, a Postgres client, an HTTP client — that some examples need.

## The runtime: Node 24 LTS

| Line | Latest | Status on 2026-09-08 | End of life |
| --- | --- | --- | --- |
| Node 26 | 26.8.1 | **Current** — not LTS until 2026-10-28 | 2029-04-30 |
| Node 24 "Krypton" | 24.20.0 | **Active LTS** | 2028-04-30 |
| Node 22 "Jod" | 22.23.2 | Maintenance LTS | 2027-04-30 |
| Node 20 "Iron" | 20.20.2 | **End of life** since 2026-04-30 | passed |

Use **Node 24**. It is the only Active LTS line right now, it receives security backports until April 2028, and it is what every example here is tested against.

:::warning
**Node 20 is end of life.** It stopped receiving security patches on 2026-04-30. A service still running it is accumulating unpatched CVEs in the runtime itself, which no amount of `npm audit` will surface. Node 18 has been EOL for longer. Do not start new work on either, and treat an existing deployment on them as an outstanding security issue.
:::

:::note
Node 26 is fine to *try* — it is the Current line and gets the newest features first — but it is not LTS until **2026-10-28**, so it is not where production belongs today. If you develop on 26 and deploy on 24, you will eventually use a feature that does not exist in your runtime. Pin the version and let CI enforce it.
:::

### Why 24 specifically

Several things this site teaches only became reasonable on 24:

| Feature | Availability | Replaces |
| --- | --- | --- |
| `node --env-file=.env` | flag from 20.6, stabilised in 24 | `dotenv` |
| `node:test` | stable from 20 | Jest / Mocha for most cases |
| `node:sqlite` | 22.5 experimental, teachable on 24 | `better-sqlite3` for simple cases |
| TypeScript type stripping | unflagged from 23.6 / 24 | `tsx` / `ts-node` for running |
| `node --watch` | stable from 22 | `nodemon` |
| `node --run` | script runner without npm's process overhead | `npm run` |

That is four fewer dependencies in a new project, which is four fewer things to audit.

## Installing Node

Do not install Node from your operating system's package manager. Distribution packages lag, and you will eventually need two versions on the same machine. Use a version manager.

:::tabs
@tab nvm

```bash
# macOS / Linux — see github.com/nvm-sh/nvm for the current install command
nvm install 24
nvm use 24
nvm alias default 24
node --version   # v24.20.0
```

`nvm` is a shell function, so it is not available to non-interactive shells, editors or launchd/systemd units without extra work. On Windows, `nvm-windows` is a separate project with a different feature set.

@tab fnm

```bash
fnm install 24
fnm use 24
fnm default 24
node --version
```

`fnm` is a single Rust binary, is noticeably faster than `nvm`, works on Windows, macOS and Linux from the same project, and reads `.nvmrc`. Add its shell hook so switching directories switches versions automatically.

@tab volta

```bash
volta install node@24
node --version
```

Volta pins the toolchain *per project* — running `volta pin node@24` writes the version into `package.json`, and any shell entering that directory gets it, including non-interactive ones. That property makes it the best choice on a team.

@tab installer

Download the **24.x LTS** installer from <https://nodejs.org/en/download>. It is the right answer for a single-version machine or a CI image you control, and the wrong one as soon as you need to work on two projects on different majors — there is no switching.

:::

### Pin the version in the repo

Add a `.nvmrc` at the repository root. `nvm`, `fnm` and most CI setups read it, and it stops the "works on my machine" version drift.

```text title=".nvmrc"
24.20.0
```

Then declare the same floor in `package.json`, so `npm install` warns — or fails, with `engine-strict` — on a wrong runtime:

```json title="package.json"
{
  "name": "my-api",
  "type": "module",
  "engines": {
    "node": ">=24"
  }
}
```

:::best-practice
Use all three: `.nvmrc` for humans and version managers, `engines.node` for npm and hosting platforms, and an explicit version in CI (`actions/setup-node` reads `.nvmrc` via `node-version-file`). One of them alone will be forgotten.
:::

## npm

Node 24 ships **npm 11.x**. You do not install it separately, and you should not `npm install -g npm` unless you have a specific reason — a globally installed npm that is newer than the bundled one is a common source of lockfile churn across a team.

```bash
node --version   # v24.20.0
npm --version    # 11.x
```

The whole site uses npm. pnpm and yarn work fine; where a command differs it is shown in a tabbed block. Two npm commands matter and are covered in [Running the examples](running-the-examples.md): `npm ci` for reproducible installs from the lockfile, and `npm install` for changing dependencies.

## JavaScript you should already know

This is not a JavaScript course. You will be comfortable if you can read and write:

- **Modules** — `import` / `export`, default vs named exports, and why `"type": "module"` matters. [ESM vs CommonJS](../node/esm-vs-commonjs.md) covers the interop rules.
- **Promises and `async`/`await`** — including `Promise.all`, `Promise.allSettled`, and the fact that an unawaited promise still runs.
- **Error semantics** — `throw`, `try`/`catch`/`finally`, `Error` subclasses, and `error.cause`.
- **Destructuring, spread, and default parameters** — every example uses them.
- **Arrow functions and `this`** — enough to know why a class method passed as a callback loses its receiver.
- **Optional chaining `?.` and nullish coalescing `??`** — used throughout, and `??` is not `||`.
- **`Map`, `Set`, `JSON`, template literals** — the standard library basics.
- **Closures** — middleware factories are closures.

You do **not** need TypeScript. Examples are JavaScript; [Native TypeScript support](../node/native-typescript-support.md) covers running `.ts` files on Node 24 when you want it.

You do **not** need prior Express experience, and you do not need to know how the event loop is implemented — [Runtime and the event loop](../node/runtime-and-event-loop.md) teaches what you need.

## Optional: Docker

Most examples run with no external services. The Postgres, MySQL, Redis and MongoDB examples need a database, and the fastest way to get a disposable one is Docker.

Install Docker Desktop (macOS, Windows) or Docker Engine (Linux), then confirm:

```bash
docker --version
docker run --rm hello-world
```

The exact `docker run` one-liners for each database are in [Running the examples](running-the-examples.md), so they live in one place.

:::tip
If you cannot install Docker, you are not stuck. Every database example has a SQLite variant that needs nothing at all, because `node:sqlite` is built into Node 24. Read the relational pages with SQLite and the concepts transfer.
:::

## Optional: a database client

For the Postgres pages, having `psql` on your machine makes it far easier to check what your code actually wrote.

```bash
# macOS
brew install libpq        # client only, no server

# Debian / Ubuntu
sudo apt install postgresql-client
```

```bash
psql "postgres://app:app@localhost:5432/app" -c "select version();"
```

A GUI works too — pgAdmin, TablePlus, DBeaver, or your editor's database panel. The requirement is only that you can run a query outside your application, because "the API returns the wrong data" and "the database contains the wrong data" are different bugs and you need to be able to tell them apart.

## An HTTP client

Every example lists `curl` commands to exercise it. `curl` ships with macOS, most Linux distributions and Windows 10+.

```bash
curl -i http://localhost:3000/health
curl -X POST http://localhost:3000/books \
  -H 'content-type: application/json' \
  -d '{"title":"Dune"}'
```

`httpie` is friendlier for exploratory work — it defaults to JSON, colorizes output and pretty-prints:

```bash
http POST :3000/books title=Dune
```

Both are shown where it helps. Postman, Insomnia and Bruno are fine for browsing an API; prefer a copy-pasteable `curl` in bug reports, because it is unambiguous.

## Editor setup

### ESLint

The site targets **eslint 10.10.0** with flat config (`eslint.config.js`). Install your editor's ESLint extension and enable fix-on-save — most of the mistakes this site warns about are lint-visible, and a squiggle at write time is worth more than a paragraph in a handbook.

```bash
npm install --save-dev eslint@^10.10.0
npx eslint .
```

Flat config is the only supported format in ESLint 10; a `.eslintrc.json` from an older project will not be read.

### .editorconfig

Put one at the repository root so line endings and indentation do not become diff noise on a mixed-OS team. Nearly every editor supports it, some natively and some via an extension.

```text title=".editorconfig"
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`end_of_line = lf` matters most: a Windows checkout that writes CRLF into a shell script produces a container that fails with a confusing "not found" error on the shebang line.

### The rest

- **A formatter** — Prettier or your editor's built-in. Which one is irrelevant; having one agreed and enforced is not.
- **Syntax highlighting for `.env` files** — so a stray quote is visible.
- **The Node debugger.** VS Code attaches to `node --inspect` with no configuration. See [Debugging](../node/debugging.md).
- **`.gitignore`** — `node_modules`, `.env`, `*.log`, coverage output. A committed `.env` is the most common way a real credential reaches a public repository; see [Secrets management](../security/secrets-management.md).

## Common mistakes

- **Installing Node from `apt` or `brew` directly.** You get whatever version the maintainer packaged, you cannot switch, and upgrading Node upgrades it for every project at once.
- **Developing on Node 26 and deploying on Node 24.** The Current line gets APIs first. The failure appears in production, not on your laptop. Pin with `.nvmrc` and check it in CI.
- **Staying on Node 20 because "it still works".** It stopped receiving security patches on 2026-04-30. Runtime CVEs do not show up in `npm audit`.
- **Adding `.nvmrc` but never wiring it up.** Without `fnm`'s shell hook, Volta's pinning, or `node-version-file` in CI, the file is a comment.
- **Installing `dotenv` out of habit.** Node 24 has `--env-file` and `--env-file-if-exists`. See [Environment variables and config](../node/environment-variables-and-config.md).
- **Running `npm install` in CI instead of `npm ci`.** `npm install` may update the lockfile, which means CI tested a different dependency tree from the one you committed.
- **Committing `.env`.** Add it to `.gitignore` before the first commit, not after the first leak.

## Related topics

- [Running the examples](running-the-examples.md) — `npm ci`, `node --run`, and the `docker run` one-liners.
- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file` in detail.
- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — why `"type": "module"` is step one.
- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — `engines`, `node --run`, and the fields that matter.
- [Debugging](../node/debugging.md) — attaching an inspector to a running server.
- [Native TypeScript support](../node/native-typescript-support.md) — running `.ts` on Node 24 without a build step.
- [Secrets management](../security/secrets-management.md) — where `.env` stops being acceptable.
- [Library index](../reference/library-index.md) — every version quoted on this page.
