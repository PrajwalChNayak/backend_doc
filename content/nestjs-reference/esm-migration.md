---
title: The ESM migration
description: Converting a CommonJS NestJS 12 project to ES modules step by step — package.json, the nodenext tsconfig, .js extensions, import.meta.dirname, what breaks in tooling and tests, and how to decide whether it is worth doing.
status: legacy
updated: 2026-09-11
---

`@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` ship as ES modules, but your application does not have to follow. CommonJS projects consume them through Node's `require(esm)` with no source change at all, and `nest upgrade` preserves whatever format you already have. This page is for the case where you have decided to convert anyway — because you need an ESM-only dependency, because you want Vitest, or because you are standardizing a fleet. It is a project, not a flag, and the last section is about deciding whether to start.

:::note
The decision, and the reasons to stay on CommonJS, are argued in [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md). Read that first if you have not committed yet. This page assumes you have.
:::

## What you are changing

Five things, and all five are required. A partial migration compiles cleanly and then fails at runtime with `ERR_MODULE_NOT_FOUND`, which is the worst place to find out.

| # | Change | Failure if you skip it |
| --- | --- | --- |
| 1 | `"type": "module"` in `package.json` | Node keeps treating `.js` as CommonJS; `import.meta` throws |
| 2 | `module: "nodenext"`, `moduleResolution: "nodenext"`, `resolvePackageJsonExports: true` | the compiler stops catching the mistakes below |
| 3 | `.js` extension on every relative import | `ERR_MODULE_NOT_FOUND` at runtime, build green |
| 4 | `import.meta.dirname` for `__dirname` | `ReferenceError: __dirname is not defined` |
| 5 | fix everything else in the repo that assumed CommonJS | a script, a config file, or the test runner stops working |

The Node-level mechanics — resolution, `exports` maps, dual-package hazards, when `require(esm)` works — are covered once in [ESM vs CommonJS](../node/esm-vs-commonjs.md). This page is the Nest-specific procedure.

## Before you start

- **Be on Nest 12 and Node 24 first.** Doing the version bump and the format change together means every failure has two candidate causes. See [NestJS 11 → 12 migration](v11-to-v12-migration.md).
- **Do it on its own branch, in its own release.** This touches every file with a relative import.
- **Do not migrate and introduce bundling in the same change.** Two independent failure surfaces, one debugging session.
- **Know your test runner's fate.** If you are on Jest, decide now whether you are moving to Vitest, because that is usually the largest single chunk of the work.

## Step 1 — `package.json`

```json title="package.json"
{
  "name": "orders-api",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "test": "vitest run"
  }
}
```

From this commit on, every `.js` file in the project is an ES module. That includes files you did not think of: `jest.config.js`, `webpack.config.js`, `scripts/seed.js`, anything a git hook runs.

## Step 2 — `tsconfig.json`

```json title="tsconfig.json"
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "target": "ES2023",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "./dist",
    "strict": true,
    "strictPropertyInitialization": false,
    "skipLibCheck": true
  }
}
```

Three of those settings are the migration, and the rest are unchanged from a normal Nest project.

**`module: "nodenext"` and `moduleResolution: "nodenext"`** make TypeScript apply *Node's* resolution rules rather than a bundler's. That is the only configuration in which the compiler can tell you that a relative import is missing its extension. Getting this wrong is the single most common way an ESM migration ends up debugged in a container instead of in an editor.

**`resolvePackageJsonExports: true`** makes the compiler honor each dependency's `exports` map. `@nestjs/core@12` publishes its entry points that way, so without this you can resolve module paths at compile time that Node will refuse at runtime.

**`experimentalDecorators` and `emitDecoratorMetadata` do not change.** Nest's dependency injection reads decorator metadata regardless of module format. If DI breaks during this migration, the cause is an import, not a decorator — see [Dependency injection](../nestjs/dependency-injection.md).

:::warning
`module: "esnext"` with `moduleResolution: "bundler"` is the configuration people reach for, and it is the wrong one here. It compiles everything — including the two mistakes this migration is most likely to produce — and defers both to runtime. Use `nodenext` for both keys.
:::

## Step 3 — `.js` extensions on every relative import

This is the mechanical bulk of the work.

:::legacy CommonJS — extensionless relative imports
```ts
import { CreateUserDto } from './dto/create-user.dto'
import { UsersRepository } from './users.repository'
import { UsersService } from './users.service'
```
:::

```ts title="src/users/users.controller.ts"
import { Controller, Get, Param } from '@nestjs/common'
import { UsersService } from './users.service.js'

@Controller('users')
export class UsersController {
  private readonly users: UsersService

  constructor(users: UsersService) {
    this.users = users
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findById(id)
  }
}
```

The extension is **`.js` even though the file on disk is `.ts`.** You are naming the file that will exist after compilation, which is what Node resolves at runtime. Everyone trips on this once; `moduleResolution: "nodenext"` is what turns it from a runtime crash into a compile error.

Three details that matter:

- **Bare package specifiers do not change.** `import { Module } from '@nestjs/common'` is identical.
- **Directory imports do not exist.** `from './users'` resolving to `./users/index.ts` is a CommonJS behavior. Write `from './users/index.js'`.
- **`import type` still needs the extension** under `nodenext`, even though the statement is erased.

Let the compiler find them rather than grepping:

```bash
npx tsc --noEmit
```

Every missing extension is a `TS2835` telling you exactly what to write. Fix until it is silent; that is most of step 3 done.

:::tip
A codemod is tempting and usually not worth it, because the edits are trivially mechanical and `tsc --noEmit` enumerates them exhaustively. What a codemod *will* get wrong is the directory-import case, where the correct answer is `./x/index.js` and a naive rewrite produces `./x.js`.
:::

## Step 4 — `import.meta.dirname` instead of `__dirname`

`__dirname`, `__filename`, `require()` and `module.exports` do not exist in an ES module.

:::legacy CommonJS
```ts
import { join } from 'node:path'

const templates = join(__dirname, '..', 'templates')
```
:::

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

| CommonJS | ES module | Available from |
| --- | --- | --- |
| `__dirname` | `import.meta.dirname` | Node 20.11 |
| `__filename` | `import.meta.filename` | Node 20.11 |
| `require.resolve(spec)` | `import.meta.resolve(spec)` | Node 20.6 |
| `require(spec)` | `import spec`, or `createRequire(import.meta.url)` | — |
| `require(dynamicPath)` | `await import(dynamicPath)` | — |
| `module.exports = x` | `export default x` | — |

The last two rows are the ones that change more than a line. `require(path)` is synchronous and `await import(path)` is not, so a synchronous plugin registry, a dynamic strategy loader or a lazily-required migration file becomes asynchronous — and that propagates to its callers.

For a dependency that genuinely has no ESM build, `createRequire` is the escape hatch and it is not a failure:

```ts title="src/legacy/load-cjs-only.ts"
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const legacy = require('some-cjs-only-package')

export default legacy
```

## Step 5 — everything else in the repository

This is the step that actually takes the time.

### Config and script files

Every `.js` file in the package is now an ES module.

| File | Fix |
| --- | --- |
| `jest.config.js` using `module.exports` | rename to `jest.config.cjs`, or move to Vitest |
| `webpack.config.js` / `rspack.config.js` | rename to `.cjs`, or rewrite with `export default` |
| `eslint.config.js` | usually already ESM; check |
| `scripts/seed.js`, `scripts/migrate.js` | same treatment as application code |
| `.prettierrc.js`, `commitlint.config.js` | `.cjs`, or the JSON form |
| a git hook running `node script.js` | the script is an ES module now |

### `tsconfig` path aliases

`paths` (`@app/*`, `@common/*`) are a compile-time fiction. Under CommonJS the CLI's webpack build could rewrite them; under ESM they need a runtime resolver, which is one more moving part in production and a classic container-only failure.

Node's **subpath imports** are the version the runtime understands natively, with no loader:

```json title="package.json"
{
  "type": "module",
  "imports": {
    "#config/*": "./dist/config/*",
    "#common/*": "./dist/common/*"
  }
}
```

```ts
import { AppConfig } from '#config/app.config.js'
```

Prefer relative imports inside a single application, and subpath imports where the depth genuinely hurts. See [Project structure](../nestjs/project-structure.md).

### The test runner

Jest's ESM support still requires `--experimental-vm-modules` plus a transform configuration, which is why **new ESM projects generated by the v12 CLI use Vitest 5.0.0** instead. Vitest runs ESM natively and needs no flag.

If you keep Jest, budget real time — this is often the largest chunk of the migration, and it is the part with the least payoff. If you move to Vitest, the `Test.createTestingModule()` code in your specs does not change; only the runner, its config and the assertion imports do. See [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md).

### `nest-cli.json` assets

Unchanged by ESM, but this is the moment people notice it, because they finally run `node dist/main.js` instead of `nest start`. Templates, `.graphql` documents and `.sql` files are not compiled, so they are not copied unless `compilerOptions.assets` says so:

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "mail/templates/**/*.hbs", "watchAssets": true }]
  }
}
```

### Bundler configuration

A webpack, rspack or esbuild config written when every dependency was CommonJS usually holds at least one assumption that no longer applies:

- **`externals` lists** that assumed a package would be `require`d.
- **`output.libraryTarget: 'commonjs2'`** on a build that now emits ESM.
- **`mainFields` / conditions ordering** that prefers `main` over `exports`, resolving a CommonJS entry point that `@nestjs/core@12` no longer has.
- **A CommonJS config file** in a `"type": "module"` package.

:::warning
If you are adopting ESM, get it working with plain `nest build` (`tsc`) first, confirmed inside the container, and only then reintroduce bundling. Debugging "works in dev, `ERR_MODULE_NOT_FOUND` in the image" is far easier when the bundler is not also in the picture. The v12 CLI adds `--rspackPath` if you are standardizing on rspack.
:::

## What breaks, ranked by how often

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND` for a file that exists | a relative import with no `.js` | add the extension; set `moduleResolution: "nodenext"` so the compiler catches the rest |
| `ERR_MODULE_NOT_FOUND` for `./x` that is a directory | directory imports do not exist in ESM | `./x/index.js` |
| `ReferenceError: __dirname is not defined` | a CommonJS global in an ES module | `import.meta.dirname` |
| `ERR_REQUIRE_ESM` | a CommonJS file in the project `require()`ing an ES module | convert it, or `createRequire` |
| `Cannot use import statement outside a module` | a `.js` file being treated as CommonJS | `"type": "module"`, or rename to `.mjs` |
| Jest fails on the first `import` | no `--experimental-vm-modules` / transform | configure it, or move to Vitest |
| `SyntaxError: Unexpected token 'export'` in a config file | `.js` config in a `"type": "module"` package | rename to `.cjs` |
| Nest cannot resolve a provider that is clearly imported | `import type` used for an injected class | use a value import |
| Works locally, fails in the image | path aliases with no runtime resolver, or a missing `assets` entry | subpath imports; `nest-cli.json` assets |

The `import type` row deserves emphasis because it is not really an ESM problem, but it surfaces during this migration when editors offer to "optimize" imports. An injected class must be a **value** import — `emitDecoratorMetadata` writes the constructor's parameter types into the emitted file, and a type-only import is erased, so the container receives `undefined`. Nest 12's resolution error calls this out by name; see [Troubleshooting](troubleshooting.md).

## Verifying

Three checks, in this order, catch nearly everything:

1. **`npx tsc --noEmit`** with `moduleResolution: "nodenext"`. Every missing extension is a compile error here rather than a production one.

   ```bash
   npx tsc --noEmit
   ```

2. **Run the built output, not the sources.**

   ```bash
   nest build && node dist/main.js
   ```

   `nest start` resolves differently enough that a working dev server proves nothing about the artifact.

3. **Run it in the container.**

   ```bash
   docker build -t orders-api . && docker run --rm -p 3000:3000 orders-api
   ```

   Case-sensitive filesystems, a missing `assets` entry and a path alias with no runtime story all surface here and nowhere earlier.

Then the ordinary gates: the test suite, and one end-to-end request per HTTP method against the built artifact.

## Is it worth doing?

Be honest about the answer, because "it is newer" is not one.

| Migrate when | Stay on CommonJS when |
| --- | --- |
| You need an ESM-only dependency — `file-type` 22, `nanoid` 6 and friends | The application works and nothing is asking for it |
| You are starting a new project (the CLI now defaults to it) | Your test suite is a large Jest investment |
| Your build is plain `tsc` and you control it | A bundler config you did not write is in the build |
| You want Vitest, or have no test suite yet | A dependency you need is CJS-only and does poorly under interop |
| You are standardizing a fleet and can absorb the work once | The team has no appetite for a cross-cutting change right now |

The deciding row is usually the first one on the left. An ESM-only dependency can be loaded from CommonJS with `await import()`, which works but has to happen inside an async function — fine in a provider's `onModuleInit`, awkward at module scope. Two or three of those and the migration pays for itself.

:::best-practice
`@nestjs/core@12` being ESM internally is explicitly **not** a reason to migrate. That is the entire point of `require(esm)` and of `nest upgrade` preserving your format. Migrate when a dependency, a runner or a tooling decision requires it — and then do it in one deliberate change rather than a file at a time.
:::

## Common mistakes

- **Migrating the format and the framework version together.** Two migrations, one set of symptoms.
- **Omitting the `.js` extension.** The build succeeds and the container fails. This is the defining mistake of this migration.
- **Writing `.ts` in the extension.** You are naming the emitted file, not the source.
- **`module: "esnext"` with `moduleResolution: "bundler"`.** The compiler stops applying Node's rules, so it cannot warn you about anything above.
- **Leaving `resolvePackageJsonExports` off.** You resolve entry points at compile time that Node refuses at runtime.
- **Keeping directory imports.** `./users` does not resolve to `./users/index.js` in ESM.
- **Using `__dirname` anywhere, including in a seed script.** It does not exist.
- **Leaving a CommonJS `jest.config.js` in place.** Rename to `.cjs`, or move to Vitest.
- **Keeping `tsconfig` path aliases with no runtime story.** They compile and then fail in the image.
- **Switching an injected class to `import type`.** DI resolves it to `undefined`, and the error names a class that is visibly imported.
- **Migrating and bundling at once.** Do `tsc` first, prove the container, then bundle.
- **Testing only with `nest start`.** Run `node dist/main.js`; it is the thing production runs.

## Related topics

- [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) — the decision, and the case for staying put.
- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — Node's resolution rules, `require(esm)` and subpath imports.
- [NestJS 11 → 12 migration](v11-to-v12-migration.md) — the version bump this migration should follow, not accompany.
- [ESM vs CommonJS in production](../nestjs-production/module-format-in-production.md) — what the format costs at runtime.
- [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md) — the runner new ESM projects get.
- [Project structure](../nestjs/project-structure.md) — relative imports versus aliases.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — `nest build`, `--rspackPath` and `nest-cli.json`.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — producing and verifying the artifact.
- [Troubleshooting](troubleshooting.md) — the error strings above, indexed by symptom.
- [Native TypeScript support](../node/native-typescript-support.md) — why a build step is required either way.
