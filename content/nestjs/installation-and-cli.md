---
title: Installation and the CLI
description: Installing the NestJS 12 CLI, the Node version it needs, and every command you will actually use — new, generate, build, start, upgrade and deploy.
status: current
updated: 2026-09-09
---

`@nestjs/cli` is **12.0.0** and it is the only supported way to scaffold, build and run a Nest project. It wraps TypeScript compilation, watch mode, the schematics that generate files, and — new in v12 — a deploy command. The one thing that surprises people is that the CLI needs a **newer Node than the app it builds**.

## The Node version floor

Two different floors apply, and they are not the same number.

| To do this | Needs Node | Why |
| --- | --- | --- |
| **Run** a Nest 12 app | v20.19+, v22.12+, or v26+ | `@nestjs/core@12.0.1` declares `engines.node: ">= 20"`, and the ESM packages need a runtime with `require(esm)` |
| **Use the CLI** — `nest new`, `nest generate`, `nest build`, `nest upgrade` | **v22.22.3+, v24.15+, or v26+** | `@nestjs/schematics@12.0.0` declares `engines.node: ">=22.12.0"` because of the Angular devkit underneath |

This handbook targets **Node 24 LTS** (24.20.0 at the time of writing), which satisfies both with room to spare. Node 20 is end of life as of 2026-04-30 — do not start there even though `@nestjs/core` still accepts it.

:::warning
A CI image pinned to Node 20 or 22.12 will install `@nestjs/cli` and then fail inside a schematic with an engine error that names `@angular-devkit/schematics`, not Nest. If `nest new` or `nest generate` dies with a message about an unsupported engine, check `node -v` before anything else.
:::

## Installing

Install the CLI globally, or do not install it at all and let `npx` fetch it per invocation.

:::tabs
@tab npm
```bash
npm install -g @nestjs/cli@12
nest --version
```
@tab pnpm
```bash
pnpm add -g @nestjs/cli@12
nest --version
```
@tab yarn
```bash
yarn global add @nestjs/cli@12
nest --version
```
:::

```bash
# No global install: pin the version in the command instead.
npx @nestjs/cli@12 new my-api
```

The `npx` form is what belongs in a CI script and in a README, because it makes the CLI version part of the repository rather than part of whoever's laptop ran the command.

## `nest new`

```bash
nest new my-api --package-manager npm
cd my-api
npm run start:dev
```

`nest new` asks for a package manager if you do not pass `--package-manager`, creates the directory, writes the project files, and installs dependencies. Useful flags:

| Flag | Effect |
| --- | --- |
| `--package-manager <npm\|pnpm\|yarn>` | skips the interactive prompt |
| `--skip-install` | writes files, installs nothing — what you want in a template repository |
| `--skip-git` | no `git init` |
| `--directory <path>` | generate into a directory whose name differs from the project name |
| `--dry-run` | print what would be written and exit |
| `--strict` | turn on TypeScript's strict family in the generated `tsconfig.json` |

Use `--strict`. The generated project without it has `strictNullChecks` off, and turning strict mode on later in a codebase that grew without it is a week of work.

### What v12 generates

Two defaults changed in the 12 line, and both are scoped to **new** projects:

- **New ESM projects default to Vitest** (5.0.0) as the test runner rather than Jest.
- **Generated projects default to oxlint** (1.82.0) as the linter.

Existing CommonJS applications are unaffected by either. `nest upgrade` does not swap your test runner or your linter out from under you, and it preserves the project's existing module format — see [ESM vs CommonJS](esm-vs-commonjs.md).

## `nest generate`

The workhorse. `nest g <schematic> <name>` writes the file, writes its spec file, and — for controllers and providers — registers the class in the nearest module.

```bash
nest g module users
nest g controller users
nest g service users
```

```bash
# Everything for one feature at once: module, controller, service, DTOs and specs.
nest g resource orders
```

| Schematic | Alias | Creates |
| --- | --- | --- |
| `module` | `mo` | a `@Module()` class |
| `controller` | `co` | a `@Controller()` class, registered in the nearest module |
| `service` | `s` | an `@Injectable()` class, registered as a provider |
| `provider` | `pr` | a bare `@Injectable()` class |
| `guard` | `gu` | a `CanActivate` implementation |
| `interceptor` | `itc` | a `NestInterceptor` implementation |
| `pipe` | `pi` | a `PipeTransform` implementation |
| `filter` | `f` | an `ExceptionFilter` implementation |
| `middleware` | `mi` | a `NestMiddleware` implementation |
| `resource` | `res` | module + controller + service + DTOs + entity + specs |
| `library` | `lib` | a monorepo library — see [Monorepo and library mode](../nestjs-advanced/monorepo-and-libraries.md) |

Flags worth knowing: `--dry-run` (`-d`) prints the file list without writing, `--flat` skips the per-schematic subdirectory, `--no-spec` suppresses the test file, and `--project <name>` targets one project in a monorepo.

:::tip
Run `nest g resource orders --dry-run` before the real thing. It prints eleven paths, and seeing them is the fastest way to decide whether you actually want that layout in your `src/`.
:::

## `nest build` and `nest start`

```bash
nest build              # tsc -> dist/
nest start              # build, then run dist/main
nest start --watch      # rebuild and restart on change
nest start --debug      # attach the inspector
```

`nest build` compiles with `tsc` by default. `--webpack` switches to a bundled build, and **v12 adds `--rspackPath`** for pointing the build at an rspack configuration.

New in the v12 CLI, available on both `build` and `start`:

| Flag | What it does | Use it when |
| --- | --- | --- |
| `--emit-declarations` | emit `.d.ts` files alongside the JavaScript | you publish a library, or a monorepo package is consumed by another |
| `--no-type-check` | transpile without running the type checker | inner-loop watch builds; type errors are caught by a separate `tsc --noEmit` in CI |
| `--silent` | suppress the CLI's own output | CI logs, or a script that parses stdout |
| `--parallel [concurrency]` | build monorepo projects in parallel, optionally capped | a monorepo where projects do not depend on each other |
| `--rspackPath <path>` | path to an rspack configuration | you have standardized on rspack |

:::warning
`--no-type-check` makes builds fast by not checking anything. It belongs in `start:dev`, never in the command that produces your production artifact. Pair it with a `tsc --noEmit` step in CI so the types are still enforced somewhere.
:::

## `nest-cli.json`

The CLI reads its configuration from `nest-cli.json` at the project root.

```json title="nest-cli.json"
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "mail/templates/**/*.hbs", "watchAssets": true }],
    "includeLibraryAssets": true
  }
}
```

`assets` copies non-TypeScript files into `dist/` — templates, `.sql` migration files, `.graphql` documents — because `tsc` only emits what it compiles. Forgetting it is the classic "works in dev, 500s in production" bug: `nest start` runs from source-adjacent paths, the built artifact does not.

**`includeLibraryAssets` is new in v12.** In a monorepo, it extends asset copying to the assets declared by libraries the application depends on, instead of only the application's own. Without it, a shared library that ships templates silently contributes nothing to `dist/`.

## `nest upgrade`

```bash
npm install -g @nestjs/cli@latest @nestjs/schematics@latest
nest upgrade --dry-run
nest upgrade
```

Upgrade the CLI and the schematics **first** — `nest upgrade` is implemented by the schematics package, so running it with the old one does the old thing. Then run it with `--dry-run` to see the version bumps it proposes before letting it write.

What it does: bumps the `@nestjs/*` dependency ranges in `package.json` and applies the migration schematics for the target version. What it does **not** do: change your module format. A CommonJS project stays CommonJS, because the v12 core packages are consumable from CommonJS through `require(esm)` with no rewrite at all.

The full v11 → v12 checklist, including the things `nest upgrade` cannot automate, lives in [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md).

## `nest deploy`

New in the v12 CLI. `nest deploy` publishes the built application to a hosting target instead of leaving deployment entirely to your own pipeline.

```bash
nest build
nest deploy
```

:::note
Treat `nest deploy` as a convenience for getting something running, not as a replacement for a deployment pipeline you control. A production service still wants a reproducible container image, a health probe and a rollback path — see [Build and deployment](../nestjs-production/build-and-deployment.md) and [Docker](../nestjs-production/docker.md).
:::

Two other commands round out the set: `nest info` prints the Node, npm and `@nestjs/*` versions actually resolved in the current project — paste its output into any bug report — and `nest add <package>` installs a package and runs its install schematic, when the package ships one.

## What a new project depends on

`nest new` installs `@nestjs/core`, `@nestjs/common` and `@nestjs/platform-express` at **12.0.1**, plus `reflect-metadata` 0.2.2 and `rxjs` 7.8.2.

`@nestjs/platform-express@12.0.1` pins its own HTTP stack, so these versions are decided for you:

```json
{ "cors": "2.8.6", "express": "5.2.1", "multer": "2.2.0",
  "path-to-regexp": "8.4.2", "tslib": "2.8.1" }
```

Two consequences worth internalizing now. Your routes are matched by **path-to-regexp 8**, so every Express 5 path rule applies — see [Routing and path syntax](routing-and-path-syntax.md). And file uploads go through **multer 2.2.0**; multer 1.x is end of life and npm-deprecated, and you never install it yourself here because the platform package owns the dependency.

## Common mistakes

- **Installing the CLI on Node 20 or 22.12.** The app runs there; the schematics do not. The error names the Angular devkit and reads like an unrelated failure.
- **Running `nest upgrade` before upgrading `@nestjs/schematics`.** The migration logic lives in the schematics package, so you get the previous version's migrations.
- **Committing a global CLI version instead of pinning it.** `npx @nestjs/cli@12` in the README makes the version reproducible; "run `nest new`" does not.
- **Shipping `--no-type-check` builds to production.** Fast and unchecked. Keep a `tsc --noEmit` gate in CI if you use it.
- **Forgetting `compilerOptions.assets`.** Templates, `.graphql` files and SQL files are not compiled, so they are not copied. The app works from source and 500s from `dist/`.
- **Assuming a monorepo library's assets are included.** They are not, unless `includeLibraryAssets` is set.
- **Skipping `--strict` on a new project.** Retrofitting `strictNullChecks` later is far more expensive than living with it from commit one.
- **Installing `multer` yourself.** `@nestjs/platform-express` already pins 2.2.0; a second copy at a different major is how you end up on a deprecated 1.x.

## Related topics

- [Project structure](project-structure.md) — what the generated tree contains and how to grow it.
- [ESM vs CommonJS](esm-vs-commonjs.md) — the module-format decision the CLI preserves rather than makes.
- [Routing and path syntax](routing-and-path-syntax.md) — the path-to-regexp 8 rules the bundled Express brings.
- [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md) — the full upgrade checklist.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — producing the artifact you actually ship.
- [Vitest for ESM projects](../nestjs-testing/vitest-for-esm.md) — the test runner new ESM projects get.
- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — the underlying script conventions.
- [Native TypeScript support](../node/native-typescript-support.md) — why a Nest project cannot skip the build step.
