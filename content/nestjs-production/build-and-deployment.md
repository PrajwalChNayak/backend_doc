---
title: Build and deployment
description: What nest build actually produces, the dist layout, the new v12 CLI flags, nest deploy, and why the artifact you ship runs node directly with no TypeScript toolchain.
status: current
updated: 2026-09-11
---

A Nest application cannot run from source. Decorators and `emitDecoratorMetadata` are emitting syntax, so Node's type-stripping cannot execute them — every deployment starts with a real compile step. What that step produces, and what you are allowed to throw away afterwards, is the whole of this page.

## What `nest build` actually produces

`nest build` runs `tsc` against `tsconfig.build.json` and writes JavaScript into `outDir`. That is all it does by default. There is no bundling, no tree shaking, no minification, and no dependency inlining — `dist/` is your source tree, transpiled, still importing from `node_modules`.

```bash
npx nest build
node dist/main.js
```

Three files decide the result:

| File | Role |
| --- | --- |
| `tsconfig.json` | the compiler options your editor and `tsc --noEmit` use |
| `tsconfig.build.json` | extends the above and **excludes** `test`, `**/*spec.ts`, `node_modules` and `dist` |
| `nest-cli.json` | `sourceRoot`, `compilerOptions.deleteOutDir`, `compilerOptions.assets` |

The split matters. If you build with `tsconfig.json` instead of `tsconfig.build.json`, your spec files are compiled into the artifact, `rootDir` widens to cover `test/` as well as `src/`, and the entry point moves from `dist/main.js` to `dist/src/main.js`. That single change breaks every `CMD` and every `start:prod` script in the repository, and the error — `Cannot find module '/app/dist/main.js'` — does not tell you why.

```json title="tsconfig.build.json"
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

### The `dist/` layout

For a conventional `src/`-rooted project:

```text
dist/
  main.js              # the entry point
  main.js.map          # only if sourceMap is on
  app.module.js
  users/
    users.module.js
    users.controller.js
    users.service.js
    dto/
      create-user.dto.js
  mail/
    templates/         # ONLY if nest-cli.json lists it under assets
      welcome.hbs
```

`tsc` emits only what it compiles. Anything that is not TypeScript — Handlebars templates, `.graphql` documents, `.sql` files, JSON fixtures, `.proto` definitions — is invisible to it and will simply not be in `dist/`. The application works in development, because `nest start` runs with the repository on disk next to it, and 500s in the container.

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [
      { "include": "mail/templates/**/*.hbs", "watchAssets": true },
      { "include": "**/*.graphql" }
    ],
    "includeLibraryAssets": true
  }
}
```

`deleteOutDir: true` is worth setting deliberately. Without it, a file you deleted from `src/` last week is still sitting in `dist/`, still being imported by something, and still passing its tests.

`includeLibraryAssets` is new in v12 and only matters in a monorepo: it extends asset copying to the assets declared by the libraries an application depends on. Without it a shared library that ships templates contributes nothing to the application's `dist/`. See [Monorepo and library mode](../nestjs-advanced/monorepo-and-libraries.md).

:::warning
Verify the artifact, not the dev server. `npm run start:dev` proves nothing about `dist/` — different resolution, different working directory, different files on disk. The only build check worth having is `nest build && node dist/main.js`, run in CI and again in the image. See [Continuous integration](ci.md).
:::

## The v12 CLI flags

`nest build` and `nest start` both gained five flags in the 12 line. They are covered in full in [Installation and the CLI](../nestjs/installation-and-cli.md); what follows is which ones belong in a production pipeline.

| Flag | Production build | Watch / inner loop |
| --- | --- | --- |
| `--emit-declarations` | yes, if this project is consumed as a library | no |
| `--no-type-check` | **never** | yes |
| `--silent` | optional — quieter CI logs | no |
| `--parallel [concurrency]` | yes, in a monorepo with independent projects | yes |
| `--rspackPath <path>` | only if you have standardized on rspack | same |
| `--webpack` | only if you need a bundle | same |

`--no-type-check` is the one to be careful with. It transpiles without running the checker, which makes a watch rebuild dramatically faster and makes a production build a lie — the artifact compiles regardless of how wrong the types are. If you use it in `start:dev`, pair it with an explicit `tsc --noEmit` gate in CI so the types are still enforced somewhere.

```json title="package.json — scripts"
{
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch --no-type-check",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main.js",
    "typecheck": "tsc --noEmit"
  }
}
```

Note that `start:prod` is plain `node`. That is not a stylistic choice, and the next two sections are why.

## Running the compiled output

```bash
NODE_ENV=production node dist/main.js
```

`node` and nothing else. Not `nest start`, not `npm run start:prod` as the container command, not a process manager wrapper.

- **`nest start` is a development command.** It compiles first, then spawns your app as a child process, which means the CLI is PID 1 and your application is not — so `SIGTERM` goes to the CLI and your shutdown hooks may never run. It also requires `@nestjs/cli`, a devDependency, to be present in the runtime image.
- **`npm run …` puts npm between the signal and your process.** npm is a package manager, not a supervisor; signal forwarding to the child is not something to depend on. See [Docker](docker.md).

Either mistake produces the same symptom: deploys drop requests, `docker stop` takes the full ten seconds, and nothing in your logs mentions a shutdown. The mechanics are in [Graceful shutdown](../production/graceful-shutdown.md); the Nest-specific hook ordering is in [Graceful shutdown](graceful-shutdown.md).

### `NODE_ENV`

Set `NODE_ENV=production` in the image, as an `ENV`, not in a start script. Nest itself does not branch on it much, but the Express 5 instance underneath does — view caching, terse error output — and a long tail of libraries disables development-only checks when they see it.

Read it in exactly one place: your configuration schema. Every other `process.env.NODE_ENV` in the codebase is a code path your tests never execute. That argument is made once, properly, in [Configuration](../production/configuration.md), and the Nest version is in [Environment configuration](configuration.md).

:::warning
Do not invent `NODE_ENV=staging`. It disables Express's production optimizations and misleads every library that compares against `'production'`. Staging runs with `NODE_ENV=production` and a different `DATABASE_URL`; use a separate `APP_ENV` variable if you want to *label* the environment for logs and metrics.
:::

## Do not ship the TypeScript toolchain

`typescript`, `ts-node`, `@nestjs/cli`, `@nestjs/schematics` and your test runner are all devDependencies. They belong in the build stage and nowhere else.

| Reason | Detail |
| --- | --- |
| **Size** | The compiler and the CLI's dependency tree are hundreds of megabytes you pull on every scale-up. |
| **Attack surface** | Every CVE in a build tool becomes an alert you triage for code that never executes. A compiler in a running container is also a useful primitive for anyone who gets a shell. |
| **Startup cost** | Compiling at boot adds seconds to every cold start, and every replica pays it independently. |
| **Determinism** | Compiling in the container means the artifact is produced N times, in N environments, from whatever is on disk. You can no longer say what is running. |

So the runtime image installs with `npm ci --omit=dev` and runs `node dist/main.js`. The complete multi-stage Dockerfile is in [Docker](docker.md).

:::danger
`--omit=dev` fails loudly at runtime, not at build time, when a *runtime* dependency is in the wrong section of `package.json`. The symptom is `Cannot find module '@nestjs/config'` when the container starts, in production, after the image passed every test.

Three packages are commonly misfiled in a Nest project: `reflect-metadata` and `rxjs` (both genuine runtime dependencies — Nest's DI reads decorator metadata at construction time), and `class-transformer`/`class-validator` when a `ValidationPipe` is registered globally. Boot the built image in CI before you push it and this class of bug never reaches you.
:::

### Source maps

Compile with `"sourceMap": true` and ship the `.map` files. The cost is disk; the benefit is that a production stack trace names `users.service.ts:42` instead of `users.service.js:118`.

Node does not apply them by default — run with `--enable-source-maps`:

```json title="package.json"
{
  "scripts": {
    "start:prod": "node --enable-source-maps dist/main.js"
  }
}
```

It costs a little CPU when an error is *thrown*, not on the happy path. If you feed stack traces to an error tracker, upload the maps there instead and keep them out of the image.

## `nest deploy`

New in the v12 CLI. `nest deploy` publishes the built application to a hosting target rather than leaving deployment entirely to a pipeline you assemble yourself.

```bash
npx nest build
npx nest deploy
```

It is a genuine convenience for getting something running — a prototype, an internal tool, a demo — and it is not a replacement for a deployment pipeline you control.

:::note
A production service still wants the things `nest deploy` does not give you: a reproducible image tagged with a git SHA, a rollback that does not involve rebuilding, health gating on the rollout, resource limits, and an audit trail of who deployed what. If you cannot answer "what exactly is running and how do I get back to the previous one", the deploy mechanism is not finished regardless of which command invoked it.
:::

## Build once, promote the same artifact

The one deployment rule worth arguing about: **build a single image, tag it with the git SHA, and promote that exact image from staging to production unchanged.**

If you rebuild per environment, production runs an artifact that staging never saw. Dependency resolution can differ, a base image can have moved, a transient registry failure can pull a different patch. Everything you proved in staging was proved about a different build.

That rule is what forces configuration out of the image and into the environment, which is the other half of [Environment configuration](configuration.md).

```text
CI on main ──► nest build ──► docker build ──► registry: api:9f3a1c2
                                                   │
                          staging deploy ──────────┤
                          production deploy ───────┘   (same digest)
```

Rollback is then "point at the previous SHA", which takes seconds and requires no build.

## Migrations are a deploy step

Running migrations from `main.ts` or from an `onModuleInit` hook races: N replicas start at once and N migrations run concurrently against the same schema. Some migration tools take an advisory lock and most do not.

Run them as a discrete step in the pipeline, before the new version rolls out, and keep every migration backward-compatible with the version currently serving traffic — during a rolling deploy both versions are live at once. The detail is in [Migrations](../nestjs-databases/migrations.md).

## Common mistakes

- **Building with `tsconfig.json` instead of `tsconfig.build.json`.** Spec files land in the artifact and the entry point silently moves to `dist/src/main.js`.
- **Forgetting `compilerOptions.assets`.** Templates, `.graphql` and `.sql` files are not compiled, so they are not copied. Works in dev, 500s in the container.
- **Assuming a monorepo library's assets are included.** They are not, unless `includeLibraryAssets` is set.
- **`nest start` as the container command.** The CLI ends up as PID 1, `SIGTERM` goes to it, and your shutdown hooks never run — plus you have shipped the CLI.
- **`npm run start:prod` as the container command.** npm sits between the signal and your process for no benefit.
- **`--no-type-check` in the production build.** Fast, and unchecked. Keep a `tsc --noEmit` gate in CI if you use it in watch mode.
- **Shipping `typescript` and `@nestjs/cli` in the runtime image.** Hundreds of megabytes and a much larger vulnerability report for code that never runs.
- **`reflect-metadata` or `rxjs` in `devDependencies`.** `npm ci --omit=dev` then produces a container that cannot boot, and only at runtime.
- **No `deleteOutDir`.** A deleted source file keeps running from a stale `dist/`.
- **Source maps enabled but `--enable-source-maps` not passed.** You pay the size and get none of the benefit.
- **Rebuilding the image per environment.** Production runs an artifact nothing tested.
- **Tagging only `latest`.** "What is running" and "roll back to what" both become unanswerable.
- **Running migrations at application boot.** N replicas start, N migrations race.

## Related topics

- [ESM vs CommonJS in production](module-format-in-production.md) — what the module format changes about this build.
- [Docker](docker.md) — the multi-stage image that turns `dist/` into an artifact.
- [Continuous integration](ci.md) — building, testing and smoke-booting the artifact.
- [Environment configuration](configuration.md) — why config must not be baked into the image.
- [Graceful shutdown](graceful-shutdown.md) — what has to receive `SIGTERM` for the hooks to run.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — every `nest build` and `nest start` flag in full.
- [Project structure](../nestjs/project-structure.md) — the `src/` layout `dist/` mirrors.
- [Monorepo and library mode](../nestjs-advanced/monorepo-and-libraries.md) — `--parallel` and `includeLibraryAssets`.
- [Migrations](../nestjs-databases/migrations.md) — running them as a deploy step instead of at boot.
- [Native TypeScript support](../node/native-typescript-support.md) — why Nest cannot skip the compile step.
- [Deployment checklist](deployment-checklist.md) — the build and deploy items to verify before shipping.
