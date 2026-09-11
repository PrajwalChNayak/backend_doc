---
title: ESM vs CommonJS
description: NestJS 12 core packages ship as ES modules — what that changes for CommonJS apps (almost nothing), how to opt into ESM properly, what breaks, and how to choose.
status: current
updated: 2026-09-11
---

The headline change in the NestJS 12 line is that `@nestjs/core` and `@nestjs/common` both declare `"type": "module"` and their internal imports carry `.js` extensions. That sounds like a migration and mostly is not one: CommonJS applications consume the ESM packages through `require(esm)` with **no rewrite at all**, and `nest upgrade` deliberately preserves whatever module format your project already uses. This page is about the decision you now get to make, not one you are forced into.

## What actually changed

| | Nest 11 | Nest 12 |
| --- | --- | --- |
| `@nestjs/core`, `@nestjs/common` on disk | CommonJS | **ESM** (`"type": "module"`) |
| A CommonJS app consuming them | `require()` | `require(esm)` — same source, no change |
| An ESM app consuming them | interop through the CJS build | native ESM, real named exports |
| `nest upgrade` | — | keeps the project's existing format |
| `nest new` defaults | CommonJS + Jest + ESLint | ESM projects default to **Vitest**; generated projects default to **oxlint** |

`require(esm)` is the Node feature that makes this a non-event. A CommonJS file can `require()` an ES module synchronously, provided the module graph has no top-level `await`. Nest's packages are built with that constraint in mind, which is why a Nest 11 CommonJS application upgrades to 12 without touching a single import statement.

The Node-level mechanics — the resolution algorithm, `exports` maps, dual-package hazards, why `require(esm)` works and when it does not — are covered once in [ESM vs CommonJS](../node/esm-vs-commonjs.md). Read that page for the platform behavior; this one covers what Nest adds.

:::note
Running a Nest 12 app needs Node **v20.19+, v22.12+, or v26+**, which are the versions where `require(esm)` is available. The CLI needs more: **v22.22.3+, v24.15+, or v26+**, because `@nestjs/schematics@12.0.1` declares `>=22.12.0`. This handbook targets Node 24 LTS, which satisfies both.
:::

## Staying on CommonJS

Nothing to do. Keep `"type"` out of `package.json` (or set it to `"commonjs"`), keep `module: "commonjs"` in `tsconfig.json`, keep your imports without extensions, keep `__dirname`.

This is the right choice for most existing applications, and it is not a deprecated path — it is the format the CLI preserves on upgrade and the one the majority of the ecosystem still ships. The reasons to stay:

- **Zero migration cost.** The alternative touches every relative import in the repository.
- **Bundlers and tooling that assume CJS-only packages** keep working.
- **Jest** works without the experimental-VM-modules dance.
- **`__dirname` and `require.resolve()`** keep working in whatever custom scripts you have accumulated.

## Opting into ESM

Five changes, and all five are required — a partial migration produces `ERR_MODULE_NOT_FOUND` at runtime with a build that succeeded.

### 1. `package.json`

```json title="package.json"
{
  "type": "module"
}
```

### 2. `tsconfig.json`

```json title="tsconfig.json"
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "target": "es2023",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "./dist",
    "strict": true
  }
}
```

`nodenext` is the setting that makes TypeScript apply **Node's** resolution rules rather than a bundler's, which is the only way the compiler can tell you that a relative import is missing its extension. `resolvePackageJsonExports: true` makes it honor the `exports` map in each dependency's `package.json` — which is how `@nestjs/core@12` publishes its entry points, so without it you can resolve paths the runtime will refuse.

`experimentalDecorators` and `emitDecoratorMetadata` stay exactly as they were. Nest's dependency injection reads that metadata regardless of module format; see [Dependency injection](dependency-injection.md).

### 3. `.js` extensions on every relative import

```ts
import { UsersService } from './users.service.js'
import { CreateUserDto } from './dto/create-user.dto.js'
```

The extension is `.js` even though the file on disk is `.ts`. You are naming the **emitted** file, which is what Node will resolve at runtime. This trips everyone once, and `moduleResolution: "nodenext"` is what turns it from a runtime crash into a compile error.

Bare package specifiers do not change: `import { Module } from '@nestjs/common'` is unchanged.

### 4. `import.meta.dirname` instead of `__dirname`

```ts title="src/main.ts"
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  app.useStaticAssets(join(import.meta.dirname, '..', 'public'))
  await app.listen(3000)
}

bootstrap()
```

`__dirname`, `__filename`, `require()` and `module.exports` do not exist in an ES module. `import.meta.dirname` and `import.meta.filename` are the direct replacements (Node 20.11+), and `import.meta.resolve()` replaces `require.resolve()`.

### 5. Check what the rest of the project assumed

This is the step that actually takes the time, and the next section is about it.

## What breaks

Two categories, and they are the reason an ESM migration is a project rather than a flag.

### Custom bootstrap and tooling scripts

Anything in the repository that is not a Nest module, and that reaches for CommonJS globals, stops working the moment `"type": "module"` lands:

| Breaks | Replacement |
| --- | --- |
| `__dirname` / `__filename` | `import.meta.dirname` / `import.meta.filename` |
| `require()` | `import`, or `createRequire(import.meta.url)` for a CJS-only dependency |
| `require.resolve()` | `import.meta.resolve()` |
| `module.exports` | `export` / `export default` |
| dynamic `require(path)` in a plugin loader | `await import(path)` — now asynchronous, which may change the caller |
| a `jest.config.js` using `module.exports` | rename to `.cjs`, or move to Vitest |
| a `seed.js` / `migrate.js` script in `scripts/` | same treatment as any other file |

The dynamic-import row is the one that bites hardest. `require(path)` is synchronous and `await import(path)` is not, so a synchronous plugin registry has to become asynchronous, and that propagates to its callers.

### Bundler configurations that assume CJS-only packages

A webpack, rspack or esbuild configuration written when every dependency was CommonJS usually contains at least one assumption that no longer holds:

- **`externals` lists** that assumed a package would be `require`d.
- **`output.libraryTarget: 'commonjs2'`** on a build that now emits ESM.
- **Conditions/`mainFields` ordering** that prefers `main` over `exports`, so it resolves a CommonJS entry point that no longer exists in `@nestjs/core@12`.
- **A CommonJS config file** (`webpack.config.js` with `module.exports`) in a `"type": "module"` package — rename it to `.cjs`.

The v12 CLI adds `--rspackPath` to `nest build` and `nest start` if you are standardizing on rspack; see [Installation and the CLI](installation-and-cli.md).

:::warning
A bundled ESM build is where the sharp edges concentrate. If you are adopting ESM, the lowest-risk path is `nest build` with plain `tsc` first, confirmed working in a container, and only then reintroduce bundling. Debugging "works in dev, `ERR_MODULE_NOT_FOUND` in the image" is much easier when the bundler is not also in the picture.
:::

### Path aliases

`tsconfig` `paths` (`@app/*`, `@common/*`) are a compile-time fiction. Under CommonJS the CLI's webpack build could rewrite them; under ESM they need a runtime resolver, which is one more moving part in production and a common source of container-only failures.

Node's own **subpath imports** are the version the runtime understands natively:

```json title="package.json"
{
  "type": "module",
  "imports": {
    "#config/*": "./dist/config/*"
  }
}
```

No loader, no resolver, no surprises in the image. See [ESM vs CommonJS](../node/esm-vs-commonjs.md).

### Testing

Jest's ESM support still requires `--experimental-vm-modules` and a transform configuration, which is why **new ESM projects generated by the v12 CLI default to Vitest** (5.0.0) instead. Vitest runs ESM natively and needs no flag.

An existing CommonJS project keeps Jest; `nest upgrade` does not change your test runner. If you migrate to ESM and keep Jest, budget real time for the runner configuration — it is often the single largest chunk of the migration. See [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md).

## How to choose

| Choose **CommonJS** when | Choose **ESM** when |
| --- | --- |
| You have an existing application that works | You are starting a new project |
| Your test suite is a large Jest investment | You want Vitest, or you have no suite yet |
| A bundler config you did not write is in the build | Your build is plain `tsc` |
| A dependency you need is CJS-only and does poorly under interop | Your dependency tree is modern |
| The team has no appetite for a cross-cutting change | You need an ESM-only package — `file-type`, `nanoid` and friends |

The deciding question is usually the last row on the right. An ESM-only dependency in a CommonJS project can be loaded with `await import()`, which works but has to happen inside an async function — fine in a provider's `onModuleInit`, awkward at module scope. Two or three of those and the migration pays for itself.

:::best-practice
Do not migrate an application to ESM because it is newer. Migrate when a concrete dependency, a runner, or a tooling decision requires it. `@nestjs/core@12` being ESM internally is explicitly **not** such a requirement — that is the whole point of `require(esm)` and of `nest upgrade` preserving your format.
:::

## Verifying the migration

Three checks catch almost every mistake, in this order:

1. **`npx tsc --noEmit`** with `moduleResolution: "nodenext"`. Every missing `.js` extension is a compile error here rather than a runtime one.
2. **Run the built output, not the sources.** `node dist/main.js`. `nest start` resolves differently enough that a passing dev server proves nothing about the artifact.
3. **Run it in the container.** Case-sensitive filesystems and a missing `assets` entry in `nest-cli.json` both surface here and nowhere earlier.

A step-by-step migration, including the parts that cannot be automated, is in [The ESM migration](../nestjs-reference/esm-migration.md). The production-side considerations — image size, start-up cost, source maps — are in [ESM vs CommonJS in production](../nestjs-production/module-format-in-production.md).

## Common mistakes

- **Assuming Nest 12 forces an ESM migration.** It does not. CommonJS apps consume the ESM packages through `require(esm)` unchanged.
- **Omitting the `.js` extension on relative imports.** The build succeeds and the container fails with `ERR_MODULE_NOT_FOUND`.
- **Writing `.ts` in the extension.** You are naming the emitted file, not the source.
- **`module: "esnext"` with `moduleResolution: "bundler"`.** The compiler stops applying Node's rules, so it cannot warn you about the two mistakes above. Use `nodenext` for both.
- **Leaving `resolvePackageJsonExports` off.** You can resolve entry points at compile time that Node will refuse at runtime.
- **Using `__dirname` in an ES module.** It does not exist. `import.meta.dirname`.
- **Leaving a CommonJS `jest.config.js` in a `"type": "module"` package.** Rename it to `.cjs`, or move to Vitest.
- **Keeping `tsconfig` path aliases with no runtime story.** They compile and then fail in the image. Use subpath imports.
- **Migrating and bundling in the same change.** Two independent failure surfaces, one debugging session.
- **Expecting `nest upgrade` to convert the project.** It preserves the existing module format by design.

## Related topics

- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — the Node-level resolution rules, `require(esm)` and subpath imports.
- [The ESM migration](../nestjs-reference/esm-migration.md) — the step-by-step conversion.
- [ESM vs CommonJS in production](../nestjs-production/module-format-in-production.md) — what the format costs at runtime.
- [Installation and the CLI](installation-and-cli.md) — `nest upgrade`, `--rspackPath`, and the Node floors.
- [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md) — the runner new ESM projects get.
- [Project structure](project-structure.md) — why relative imports beat path aliases here.
- [Dependency injection](dependency-injection.md) — the decorator metadata that is unaffected by the format.
- [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md) — everything else in the upgrade.
- [Native TypeScript support](../node/native-typescript-support.md) — why a build step is required either way.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — producing and verifying the artifact.
