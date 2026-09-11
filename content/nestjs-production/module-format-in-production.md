---
title: ESM vs CommonJS in production
description: The operational side of the Nest 12 module-format decision — what changes in the build and the image, what breaks in bootstrap scripts and bundler configs, and an honest recommendation.
status: current
updated: 2026-09-11
---

`@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` ship as ES modules. That is a fact about the packages on disk, not a migration you have to perform: CommonJS applications consume them through `require(esm)` unchanged, and `nest upgrade` deliberately preserves whatever format your project already uses. The decision, the five required changes and the compile-time consequences are covered in [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md). This page is what the choice costs *after* the build, in the artifact you ship.

## The short version

| | CommonJS | ESM |
| --- | --- | --- |
| Work to adopt on an existing app | none | every relative import, plus every script |
| `nest build` output | `dist/*.js`, `require()` at runtime | `dist/*.js`, `import` at runtime |
| Runtime Node floor | v20.19+ / v22.12+ / v26+ | the same |
| Image size, start time, memory | no measurable difference | no measurable difference |
| Failure mode when you get it wrong | a compile error | **`ERR_MODULE_NOT_FOUND` in the container only** |
| Bundled builds | well-trodden | the sharp edge |
| Path aliases at runtime | resolved by the bundler, or fragile | need subpath imports |

The row that matters operationally is the fifth. An ESM mistake is disproportionately likely to survive the build, survive `npm test`, survive the dev server, and appear for the first time when the container starts. Everything below is about closing that gap.

## The build is almost the same

`nest build` is `tsc` either way. It reads `tsconfig.build.json`, writes JavaScript into `dist/`, and does not bundle. The module format changes what `tsc` emits, not what the CLI does.

```json title="tsconfig.json — the ESM half"
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "target": "es2023",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "sourceMap": true,
    "outDir": "./dist",
    "strict": true
  }
}
```

```json title="package.json"
{
  "type": "module"
}
```

Three of those settings are load-bearing and one is easy to get wrong:

- **`module: "nodenext"` and `moduleResolution: "nodenext"` together.** `nodenext` is what makes TypeScript apply Node's resolution rules instead of a bundler's, which is the only way the compiler can tell you that a relative import is missing its `.js` extension. `moduleResolution: "bundler"` turns that error off, which means the mistake reaches the image.
- **`resolvePackageJsonExports: true`** makes the compiler honor each dependency's `exports` map. `@nestjs/core@12` publishes its entry points through `exports`; without this you can resolve module paths at compile time that Node will refuse at runtime.
- **`experimentalDecorators` and `emitDecoratorMetadata` do not change.** Nest's DI reads the emitted metadata regardless of module format.

Everything else about the artifact is identical. `dist/main.js` is still the entry point, `node dist/main.js` is still the command, and there is no measurable difference in image size or cold-start time between the two formats. Anyone claiming ESM is "faster in production" for a Nest service is comparing something else.

## What actually changes in the artifact

### Relative imports carry `.js`

```ts title="src/users/users.controller.ts"
import { Controller, Get } from '@nestjs/common'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get()
  findAll() {
    return this.users.findAll()
  }
}
```

The extension is `.js` even though the file on disk is `.ts` — you are naming the emitted file, which is what Node resolves at runtime. Bare package specifiers are unchanged.

Omit one and `nest build` still succeeds under `moduleResolution: "bundler"`, tests still pass under a runner that resolves the way a bundler does, and `node dist/main.js` fails with `ERR_MODULE_NOT_FOUND` naming a path you never wrote. `nodenext` turns that into a compile error, which is the entire reason to set it.

### `__dirname` is gone

```ts title="src/main.ts"
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  app.useStaticAssets(join(import.meta.dirname, '..', 'public'))
  await app.listen(process.env.PORT ?? 3000)
}

bootstrap()
```

`import.meta.dirname` and `import.meta.filename` replace `__dirname` and `__filename` (Node 20.11+), and `import.meta.resolve()` replaces `require.resolve()`.

This bites hardest in the places that are *not* Nest modules: a template path in a mailer provider, a migrations glob in a TypeORM data source, a `.proto` path in a microservice transport, a seed script. Each one is a separate small failure, each one surfaces only when that code path runs, and some of those code paths first run in production.

:::warning
A path built from `import.meta.dirname` points **into `dist/`** at runtime and into `src/` during development. That asymmetry is not new to ESM, but the migration is when people notice it. Anything resolved that way must be listed under `compilerOptions.assets` in `nest-cli.json` or it will not be in `dist/` at all — see [Build and deployment](build-and-deployment.md).
:::

### Path aliases need a runtime story

`tsconfig` `paths` (`@app/*`, `@common/*`) are a compile-time fiction. Under a CommonJS webpack build the bundler rewrote them; under plain `tsc` and ESM nothing does, so `dist/main.js` contains an import of `@common/logger` that Node cannot resolve.

Node's own subpath imports are the version the runtime understands with no loader:

```json title="package.json"
{
  "type": "module",
  "imports": {
    "#common/*": "./dist/common/*"
  }
}
```

No resolver process, no `--loader` flag, no extra moving part in the image. The alternative — a runtime path-mapping package loaded before your app — works and is one more thing that can be missing from the production image.

## What breaks

Two categories, and both live outside the `src/` tree the CLI manages for you.

### Custom bootstrap and operational scripts

The moment `"type": "module"` lands, every `.js` file in the repository is an ES module, including the ones nobody thinks of as application code.

| Breaks | Replacement |
| --- | --- |
| `__dirname` / `__filename` in a seed or migration script | `import.meta.dirname` / `import.meta.filename` |
| `require()` of a CJS-only dependency | `createRequire(import.meta.url)` |
| `require.resolve()` | `import.meta.resolve()` |
| `module.exports` in `jest.config.js`, `webpack.config.js`, `eslint.config.js` | rename the file to `.cjs`, or convert it |
| a TypeORM `ormconfig.js` / data-source file using `module.exports` | `export default` |
| dynamic `require(path)` in a plugin or module loader | `await import(path)` — now **asynchronous** |
| a Docker entrypoint that runs `node -e "require('./dist/x')"` | `node --input-type=module -e "await import('./dist/x.js')"` |

The dynamic-import row is the one with a blast radius. `require(path)` is synchronous and `await import(path)` is not, so a synchronous registry becomes asynchronous and that propagates to every caller. In a Nest application the usual landing spot is a provider's `onModuleInit`, which is already async — but the refactor is real work, not a find-and-replace.

### Bundler configurations that assume CJS-only packages

If your build goes through webpack, rspack or esbuild, the configuration was almost certainly written when every dependency was CommonJS. The assumptions that stop holding:

- **`externals` lists** that assumed a package would be `require`d.
- **`output.libraryTarget: 'commonjs2'`** on a build that now emits ESM.
- **`mainFields` / conditions ordering** that prefers `main` over `exports`, so the bundler resolves a CommonJS entry point that `@nestjs/core@12` no longer has.
- **A CommonJS config file** in a `"type": "module"` package — rename it to `.cjs`.
- **Optional peer dependencies Nest loads lazily.** `@nestjs/core` requires transport and platform packages on demand; a bundler that cannot see a dynamic require either drops them or emits a warning you will ignore until the container fails.

:::warning
A bundled ESM build concentrates every sharp edge on this page in one place. If you are adopting ESM, do it with plain `tsc` first, confirm `node dist/main.js` works **inside the container**, and only then reintroduce bundling. Debugging "works in dev, `ERR_MODULE_NOT_FOUND` in the image" is far easier when the bundler is not also a suspect.

The v12 CLI adds `--rspackPath` to `nest build` and `nest start` if rspack is where you are heading.
:::

## Verifying the artifact, not the dev server

Three checks, in this order, catch nearly everything. All three belong in CI, because two of them are exactly the ones a developer never runs.

```bash
# 1. Every missing .js extension becomes a compile error here, not a runtime one.
npx tsc --noEmit

# 2. Run the BUILT output. `nest start` resolves differently enough that a
#    passing dev server proves nothing about dist/.
npx nest build && node dist/main.js

# 3. Run it in the image. A case-sensitive filesystem and a missing asset
#    both surface here and nowhere earlier.
docker build -t api:test . && docker run --rm -e NODE_ENV=production api:test
```

Step 3 is not optional if you develop on macOS or Windows. `import { UsersService } from './Users.service.js'` resolves happily on a case-insensitive filesystem and fails on the Linux container, and it is always found in production.

:::best-practice
Add a smoke step to CI that boots the built image, hits `/livez`, and stops it. It costs about twenty seconds and it catches the three failures that only exist in the artifact: a missing `.js` extension, a missing asset, and a runtime dependency filed under `devDependencies`. See [Continuous integration](ci.md).
:::

## Testing differs, and that is the real cost

Jest's ESM support still requires `--experimental-vm-modules` plus a transform configuration, which is why **new ESM projects generated by the v12 CLI default to Vitest** (5.0.0). An existing CommonJS project keeps Jest and `nest upgrade` does not change it.

If you migrate an application with a large Jest suite to ESM, the runner configuration is usually the single largest chunk of the work — larger than the imports, larger than the scripts. Budget for it explicitly rather than discovering it in the middle of the change. See [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md).

## The honest recommendation

**Stay on CommonJS for an application that already exists and works.** `require(esm)` is precisely the feature that makes Nest 12's ESM packages a non-event for you, `nest upgrade` preserves your format on purpose, and an ESM migration buys a production service nothing it can measure. The change touches every relative import in the repository and every script around it, and its characteristic failure lands in the container rather than in CI.

**Start a new project on ESM.** You get Vitest without the flag dance, native `await import()`, direct use of ESM-only packages, and none of the migration cost — because there is nothing to migrate.

**Migrate an existing application only when something concrete forces it:** an ESM-only dependency you need at module scope, a runner decision, or a tooling requirement. Two or three `await import()` workarounds inside `onModuleInit` is the honest signal that the migration has started paying for itself.

:::best-practice
Whatever you choose, choose it for the whole repository and write it down. The genuinely bad state is half-migrated — `"type": "module"` set, a few scripts renamed to `.cjs`, `moduleResolution: "bundler"` still in `tsconfig.json` hiding the extension errors. That configuration builds, tests green, and fails in the image.
:::

## Common mistakes

- **Believing Nest 12 forces an ESM migration.** It does not. CommonJS apps consume the ESM core packages through `require(esm)` with no rewrite.
- **`moduleResolution: "bundler"` in an ESM project.** It suppresses exactly the errors that would have caught the missing extensions, so they surface in the container instead.
- **Leaving `resolvePackageJsonExports` off.** You resolve entry points at compile time that Node refuses at runtime.
- **Writing `.ts` in the import extension.** You are naming the emitted file: `.js`.
- **`__dirname` in a provider that only runs in production.** The template path, the migrations glob, the `.proto` file — each fails the first time that path executes.
- **Keeping `tsconfig` path aliases with no runtime resolver.** They compile and then fail in the image. Use subpath imports.
- **A CommonJS config file left in a `"type": "module"` package.** Rename it to `.cjs`.
- **Migrating to ESM and switching to a bundler in the same change.** Two independent failure surfaces, one debugging session.
- **Testing only the dev server.** `nest start` resolves differently from `node dist/main.js`; only one of them is what you ship.
- **Not building in a Linux container while developing on a case-insensitive filesystem.** A wrong-case import is found in production, every time.
- **Expecting `nest upgrade` to convert the project.** It preserves the existing module format by design.
- **Migrating "because ESM is newer".** There is no runtime win here to pay for the work.

## Related topics

- [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) — the decision, the five required changes, and how to choose.
- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — Node's resolution rules, `require(esm)` and subpath imports.
- [The ESM migration](../nestjs-reference/esm-migration.md) — the step-by-step conversion.
- [Build and deployment](build-and-deployment.md) — `nest build`, the `dist/` layout and assets.
- [Docker](docker.md) — verifying the artifact on a case-sensitive filesystem.
- [Continuous integration](ci.md) — the three checks that catch container-only failures.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — `--rspackPath` and the Node floors.
- [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md) — the runner cost of the migration.
- [Project structure](../nestjs/project-structure.md) — why relative imports beat path aliases here.
- [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md) — everything else in the upgrade.
- [Deployment checklist](deployment-checklist.md) — the build items to verify before shipping.
