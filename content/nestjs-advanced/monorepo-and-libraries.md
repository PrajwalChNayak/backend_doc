---
title: Monorepo and library mode
description: Nest 12's monorepo mode — nest generate app and nest generate library, the nest-cli.json project graph, the tsconfig path aliases and project references the schematics write, and the v12 includeLibraryAssets option.
status: current
updated: 2026-09-11
---

The Nest CLI can manage one project or several in a single repository, and the switch between the two is one command. What that command actually does — to your directory layout, to `nest-cli.json`, and to the root `tsconfig.json` — is worth understanding before you run it, because it rewrites all three and there is no "undo" schematic.

## Standard mode and monorepo mode

`nest new` gives you **standard mode**: one application, `src/` at the root, a `nest-cli.json` with a `sourceRoot` and nothing else. It is the right shape for the overwhelming majority of services.

**Monorepo mode** is a workspace with a `projects` map. Each project is either an `application` (has a `main` entry file, is deployed) or a `library` (has an `index` entry file, is imported). They share one `node_modules`, one `package.json`, one lockfile and one root `tsconfig.json`.

| | Standard | Monorepo |
| --- | --- | --- |
| `nest-cli.json` | `sourceRoot`, no `projects` | `monorepo: true`, `root`, `sourceRoot`, `projects` |
| Layout | `src/`, `test/` | `apps/<name>/src/`, `libs/<name>/src/` |
| Build output | `dist/` | `dist/apps/<name>/`, `dist/libs/<name>/` |
| Sharing code | a relative import, or a published package | a path alias to a library |
| Default builder in v12 | `tsc` | **`rspack`** — set by the schematic that converts you |

There is no third mode. A Nest monorepo is not npm workspaces, not a package manager feature, and not independently versioned packages — it is one build with several outputs.

## Converting: `nest generate app`

Run this in a standard-mode project and the CLI restructures the workspace:

```bash
nest generate app gateway
```

What changes, in order:

1. The existing `src/` and `test/` move under `apps/<original-app-name>/`.
2. `nest-cli.json` gains `monorepo: true`, a `root`, a rewritten `sourceRoot`, `compilerOptions.builder: "rspack"`, a `compilerOptions.tsConfigPath` pointing at the moved app's `tsconfig.app.json`, and a `projects` entry for **both** applications.
3. Each application gets a `tsconfig.app.json` — `composite: true`, `declaration: true`, `rootDir: "./src"`, `outDir: "../../dist/apps/<name>"`.
4. The root `tsconfig.json` has `baseUrl` **deleted**, `include` and `exclude` **deleted**, and gains `files: []` and a `references` array with one entry per application.
5. `package.json` scripts that referenced `test/` or `src/` are rewritten to the new paths.

```json title="nest-cli.json (after conversion)"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "monorepo": true,
  "root": "apps/orders-api",
  "sourceRoot": "apps/orders-api/src",
  "compilerOptions": {
    "builder": "rspack",
    "tsConfigPath": "apps/orders-api/tsconfig.app.json"
  },
  "projects": {
    "orders-api": {
      "type": "application",
      "root": "apps/orders-api",
      "entryFile": "main",
      "sourceRoot": "apps/orders-api/src",
      "compilerOptions": { "tsConfigPath": "apps/orders-api/tsconfig.app.json" }
    },
    "gateway": {
      "type": "application",
      "root": "apps/gateway",
      "entryFile": "main",
      "sourceRoot": "apps/gateway/src",
      "compilerOptions": { "tsConfigPath": "apps/gateway/tsconfig.app.json" }
    }
  }
}
```

The top-level `root`, `sourceRoot` and `compilerOptions` describe the **default project** — the one `nest build` and `nest start` use when you do not name one.

:::warning The conversion moves files and rewrites three config files
Commit first. Nothing here is reversible by a second command, and a half-converted workspace is confusing to read back.
:::

`references` plus `composite: true` is TypeScript project references: each project is compiled as its own unit and consumed through its declaration output rather than its source. That is what makes an incremental build in a multi-project workspace fast, and it is also why a project that is not listed in `references` will not be rebuilt when a dependency changes.

## `nest generate library`

```bash
nest generate library shared
# or
nest g lib shared
```

The schematic asks for a **prefix** and defaults to `@app`. You can change the default by putting a `defaultLibraryPrefix` key in `nest-cli.json`; the library schematic reads it directly.

What it writes:

```text
libs/shared/
  tsconfig.lib.json
  src/
    index.ts
    shared.module.ts
    shared.service.ts
    shared.service.spec.ts
```

```ts title="libs/shared/src/shared.module.ts"
import { Module } from '@nestjs/common'
import { SharedService } from './shared.service.js'

@Module({
  providers: [SharedService],
  exports: [SharedService],
})
export class SharedModule {}
```

```ts title="libs/shared/src/index.ts"
export * from './shared.module.js'
export * from './shared.service.js'
```

The `.js` extensions are added only in an ESM project — the schematic checks the workspace's module format and generates accordingly. See [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) for why they are required there and harmless nowhere else.

`index.ts` is the library's public surface. Everything a consumer is allowed to import goes through it; everything else stays internal. This is the single most valuable thing a library gives you over a shared folder, and it only holds if you enforce it — an import that reaches past `index.ts` into `libs/shared/src/internals/` compiles fine and quietly destroys the boundary.

It also registers the project and, if you have not set one, flips the workspace onto the rspack builder:

```json title="nest-cli.json"
{
  "compilerOptions": { "builder": "rspack" },
  "projects": {
    "shared": {
      "type": "library",
      "root": "libs/shared",
      "entryFile": "index",
      "sourceRoot": "libs/shared/src",
      "compilerOptions": { "tsConfigPath": "libs/shared/tsconfig.lib.json" }
    }
  }
}
```

```json title="libs/shared/tsconfig.lib.json"
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "rootDir": "./src",
    "outDir": "../../dist/libs/shared"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test", "**/*spec.ts"]
}
```

:::note A library is not a package
`nest g lib` does not create a `package.json`, a version, or anything publishable. It creates a compilation unit with a path alias. If you need to publish, that is an npm workspace and a different tool — `nest build --emit-declarations` will emit the `.d.ts` files, but the packaging is yours.
:::

## Path aliases

The library schematic edits the root `tsconfig.json` for you:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "paths": {
      "@app/shared": ["./libs/shared/src"],
      "@app/shared/*": ["./libs/shared/src/*"]
    }
  }
}
```

It also **deletes `baseUrl`** if one was there. Modern TypeScript resolves `paths` relative to the config file, so `baseUrl` is unnecessary and, when present, changes how bare specifiers resolve in ways nobody wants.

Consuming the library is then an ordinary import:

```ts title="apps/gateway/src/app.module.ts"
import { Module } from '@nestjs/common'
import { SharedModule } from '@app/shared'
import { GatewayController } from './gateway.controller.js'

@Module({
  imports: [SharedModule],
  controllers: [GatewayController],
})
export class GatewayModule {}
```

:::danger A path alias is a compile-time fiction
`tsc` does not rewrite `@app/shared` in its output. It emits the specifier exactly as you wrote it, and Node has no idea what `@app/shared` is — `ERR_MODULE_NOT_FOUND` at startup, after a build that reported no errors.

This is why the v12 schematics set `builder: "rspack"` when they convert a workspace: a **bundler** resolves the alias at build time and inlines the library, so the deployed artifact has no unresolvable specifier in it. If you switch the builder back to `tsc`, you own that resolution yourself — through Node's own `imports` field in `package.json`, a runtime path resolver, or by not using aliases at all.

The failure mode is nasty because it never appears in development: `nest start` resolves the alias through the TypeScript toolchain, and only the built artifact breaks.
:::

## Building and running

```bash
nest build                      # the default project
nest build gateway              # one named project
nest build gateway orders-api   # several
nest build --all                # every project in the workspace
nest build --all --parallel 4   # …with a concurrency cap

nest start gateway --watch
```

`--parallel [concurrency]` goes with `--all`. It is safe when projects do not depend on each other and a false economy when they do — TypeScript project references already give you incremental rebuilds along the dependency graph.

The other v12 build flags apply per project: `--builder <tsc|swc|webpack|rspack>`, `--emit-declarations`, `--no-type-check`, `--silent`, `--rspackPath`. The full set is in [Installation and the CLI](../nestjs/installation-and-cli.md).

Generating into a specific project needs `--project`, or the schematic lands in the default one:

```bash
nest generate controller orders --project gateway
nest g s billing -p orders-api
```

:::tip `-p` is not the same flag everywhere
On `nest generate`, `-p` is `--project`. On `nest build` and `nest start`, `-p` is `--path` — the path to a tsconfig file. Type the long form in scripts.
:::

## `includeLibraryAssets` (new in v12)

`compilerOptions.assets` copies non-TypeScript files — templates, `.graphql` documents, `.sql` files — into the build output, because `tsc` only emits what it compiles. In a monorepo that has always been per-project, which meant a library's assets were never copied during an application build. The library compiled, its templates did not ship, and the application 500'd in production on the first render.

v12 adds `includeLibraryAssets`: an application opts into the assets declared by the libraries it depends on.

```json title="nest-cli.json"
{
  "monorepo": true,
  "projects": {
    "mailer": {
      "type": "library",
      "root": "libs/mailer",
      "entryFile": "index",
      "sourceRoot": "libs/mailer/src",
      "compilerOptions": {
        "tsConfigPath": "libs/mailer/tsconfig.lib.json",
        "assets": [{ "include": "templates/**/*.hbs", "watchAssets": true }]
      }
    },
    "gateway": {
      "type": "application",
      "root": "apps/gateway",
      "entryFile": "main",
      "sourceRoot": "apps/gateway/src",
      "compilerOptions": {
        "tsConfigPath": "apps/gateway/tsconfig.app.json",
        "includeLibraryAssets": ["mailer"]
      }
    }
  }
}
```

:::warning It is a list of library names, not a boolean
`includeLibraryAssets` is typed `string[]` and is read per application, so each app names the libraries whose assets it wants. `true` is not a valid value, and the option is opt-in per application — there is no "copy everything" switch.
:::

The CLI helps you find the gap. When you build an application, any library in the workspace that declares `assets` and is not named by any application being built produces this on the console:

```text
Assets configured for library "mailer" will not be copied during application build.
Add it to "compilerOptions.includeLibraryAssets" or build the library separately.
```

That warning is the whole feature working as intended. Read the build output.

## What belongs in a library

The question is not "is this code shared" — it is "does this code have a stable interface".

| Good library | Bad library |
| --- | --- |
| Domain types and DTOs used by two applications | "utils" |
| A configured client for an internal service | A module that imports from an application |
| Cross-cutting Nest pieces: a logging module, a guard, an exception filter | Anything that changes every time either consumer changes |
| Database entities and migrations shared by an API and a worker | A library created because two files looked similar |

Two rules that keep a library graph from rotting:

- **Libraries never import applications.** The dependency arrow points one way. A library that reaches into `apps/` is an application with the wrong folder.
- **A library that only one application uses is a folder.** Move it when the second consumer appears, not in anticipation of one.

## When a monorepo is the wrong answer

Monorepo mode makes sharing code cheap. That is also its failure mode: it makes coupling cheap, and coupling that is cheap to create is expensive to remove later.

Reach for it when you have **two deployables that genuinely share a domain** — an HTTP API and the worker that drains its queue, a gateway and the service behind it. Do not reach for it to avoid publishing a package that two unrelated teams consume, and do not reach for it to split one application into "layers"; a module boundary inside one project costs nothing and is easier to move.

The lockstep is the real cost. One `package.json` means one version of every dependency for every project in the workspace. Upgrading a library that one application needs and another is not ready for is no longer a per-service decision. The same argument, one level up, is in [Microservices and transports](microservices.md) — and the argument against splitting at all is in [When plain Express is better](../express-vs-nestjs/when-plain-express-is-better.md).

## Common mistakes

- **Running `nest g app` without committing first.** It moves directories and rewrites three config files, and there is no reverse schematic.
- **Assuming `includeLibraryAssets` is a boolean.** It is an array of library project names, read per application.
- **Ignoring the "assets will not be copied" warning.** It is telling you the templates are missing from `dist/` before production does.
- **Switching the builder to `tsc` and keeping the path aliases.** `tsc` emits `@app/shared` verbatim and Node cannot resolve it. The build passes; the container crashes on start.
- **Importing past a library's `index.ts`.** It compiles, and the public surface you designed stops existing.
- **A library that imports from `apps/`.** The dependency graph now has a cycle in it and the build order is undefined.
- **Adding a project to `nest-cli.json` by hand and forgetting the `tsconfig.json` `references` entry.** It will not be rebuilt when its dependencies change, and you will chase a stale `dist/`.
- **Expecting `nest g lib` to produce a publishable package.** No `package.json`, no version. It is a compilation unit.
- **`-p` meaning `--project` on `nest build`.** It means `--path` there. Use the long form.
- **`nest build --all --parallel` with dependent projects.** Parallelism across a dependency edge is not a speedup.
- **Creating a library for code one application uses.** That is a folder with extra configuration.
- **Reaching for monorepo mode to organize a single application.** Modules already do that, for free, and they are easier to move later.

## Related topics

- [Installation and the CLI](../nestjs/installation-and-cli.md) — `nest-cli.json`, the v12 build flags, and the CLI's Node floor.
- [Project structure](../nestjs/project-structure.md) — how to lay out a single application, and when a folder is enough.
- [Modules](../nestjs/modules.md) — the boundary a library formalizes, and the one you should try first.
- [Dynamic modules](dynamic-modules.md) — giving a shared library configurable behaviour via `forRoot()`.
- [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) — why the generated library files carry `.js` extensions in an ESM workspace.
- [Microservices and transports](microservices.md) — the network boundary, and why a module boundary is cheaper.
- [When plain Express is better](../express-vs-nestjs/when-plain-express-is-better.md) — the case against structure you do not yet need.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — turning `dist/apps/<name>` into a deployable artifact.
- [Continuous integration](../nestjs-production/ci.md) — building and testing several projects in one pipeline.
- [Unit tests](../nestjs-testing/unit-tests.md) — where a library's tests live and how the CLI maps its aliases for them.
