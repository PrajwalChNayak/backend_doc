---
title: Vitest for ESM projects
description: Why NestJS 12 gives new ESM projects Vitest 5 instead of Jest, what the generated vitest.config.ts contains, the emitDecoratorMetadata requirement and the silent failure when a transform does not honor it, vi.mock versus jest.mock, and migrating an existing Jest suite.
status: current
updated: 2026-09-11
---

NestJS 12's core packages ship as ES modules, and the CLI's ESM project template comes with Vitest rather than Jest. That is a sensible default and it is not free: Nest's dependency injection depends on decorator metadata, and whether your test runner emits that metadata depends on which transformer sits underneath it. When it does not, the failure is silent and looks nothing like a build problem.

## Why ESM projects default to Vitest

`@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` both declare `"type": "module"` and carry `.js` extensions on their internal imports. A CommonJS application still consumes them through `require(esm)` and needs no rewrite — see [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md).

What changes is the test runner's job. Under ESM, a runner has to resolve real module specifiers, honor `exports` maps, and intercept modules without CommonJS's mutable `module.exports` object. Vitest was designed around a module graph that works that way; Jest's ESM support exists but is still opt-in and comparatively awkward.

So the Nest 12 CLI splits the default:

| Project | Generated runner | Generated linter |
| --- | --- | --- |
| **New ESM project** (`"type": "module"`) | **Vitest** | oxlint 1.82.0 |
| **New CommonJS project** | Jest + `ts-jest` | oxlint 1.82.0 |
| **Existing project upgraded with `nest upgrade`** | unchanged | unchanged |

An existing CommonJS application keeps Jest. `nest upgrade` preserves the module format and does not rewrite your test setup. There is no requirement to migrate; this page covers it because plenty of teams will opt into ESM anyway, and then find the suite is the hard part.

:::note Versions
The current Vitest release is **5.0.0**, with `@vitest/coverage-v8` at 5.0.0. The CLI's ESM template pins a caret range on an earlier major in its `devDependencies`, so a freshly generated project may not be on 5 — check and bump. The rest of this page is written against 5.0.0.
:::

## The generated configuration

The ESM template ships two configs, one per suite, and a script for each.

```ts title="vitest.config.ts"
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // `nest g library` adds for a monorepo.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
})
```

```ts title="vitest.config.e2e.ts"
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
})
```

```json title="package.json"
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:cov": "vitest run --coverage",
    "test:debug": "vitest --inspect-brk --no-file-parallelism",
    "test:e2e": "vitest run --config ./vitest.config.e2e.ts"
  }
}
```

Two suites in two configs is deliberate: unit tests run on every save, e2e tests need a database and run less often. `--no-file-parallelism` in the debug script is there because a debugger attached to eight workers is not a debugging session.

`vitest` with no arguments is watch mode; `vitest run` is the single pass CI wants. Getting that backwards is how a CI job hangs until it times out.

## The decorator metadata requirement

This is the part that bites, and it is worth being precise about the mechanism.

Nest resolves `constructor(repository: OrdersRepository)` by reading the `design:paramtypes` metadata TypeScript emits when `emitDecoratorMetadata` is on. Erase the types without emitting that metadata and the constructor's parameter list becomes information nobody has. Nest then injects nothing.

The generated `tsconfig.json` has what is needed:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2023",
    "types": ["vitest/globals", "node"]
  }
}
```

But `tsc` is not what transforms your code under Vitest. Vite is, and **not every Vite transformer implements `emitDecoratorMetadata`**. Vitest 5 accepts Vite 6, 7 or 8, and the behavior differs between them. Measured on a throwaway Nest 12 project whose only test resolves one injected dependency:

| Transform | Decorator metadata | Result |
| --- | --- | --- |
| Vitest 5.0.0 on **Vite 8** (Oxc) | emitted | test passes |
| Vitest 5.0.0 on **Vite 7** (esbuild) | **not emitted** | injected dependency is `undefined` |
| Vite 7 + `unplugin-swc` | emitted | test passes |
| Vite 8 with `emitDecoratorMetadata: false` | not emitted | injected dependency is `undefined` |

esbuild does not implement `emitDecoratorMetadata` and never has; it is a documented non-goal. So a project on Vite 7 and a project on Vite 8 behave differently with byte-identical source.

:::danger The failure is silent
It is **not** `Nest can't resolve dependencies of the OrdersService`. The container resolves the class fine — it just injects nothing, because as far as it can tell the constructor takes no typed parameters. The first symptom is:

```text
TypeError: Cannot read properties of undefined (reading 'findById')
```

at the first line of the first method that touches an injected field. A whole afternoon goes into the service before anyone looks at the transform.

The three-line diagnosis: if `moduleRef.get(SomeService)` returns an instance whose injected fields are all `undefined`, and the same code runs correctly under `nest start`, you have a metadata problem and nothing else.
:::

### Making it deterministic with SWC

Rather than depending on which Vite major resolves, pin the behavior with an explicit transform. `unplugin-swc` 1.6.0 with `@swc/core` 1.16.2 is the usual choice, and it reads your `tsconfig.json` — including `experimentalDecorators` and `emitDecoratorMetadata` — so there is no second copy of the settings to drift.

:::tabs
@tab npm
```bash
npm install --save-dev unplugin-swc@1 @swc/core@1
```
@tab pnpm
```bash
pnpm add -D unplugin-swc@1 @swc/core@1
```
@tab yarn
```bash
yarn add -D unplugin-swc@1 @swc/core@1
```
:::

```ts title="vitest.config.ts"
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import swc from 'unplugin-swc'

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    // Reads tsconfig.json, so experimentalDecorators and emitDecoratorMetadata
    // are honored without being restated here.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
})
```

`module: { type: 'es6' }` keeps SWC emitting ES modules, which is what an ESM project needs; without it SWC may follow the tsconfig `module` setting into a shape Vite does not want.

If you prefer to state the transform explicitly rather than inherit it, the equivalent SWC options are:

```ts
export const swcOptions = {
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2023',
  },
  module: { type: 'es6' },
}
```

`legacyDecorator: true` is not optional. Nest uses TypeScript's legacy (stage-2) decorators, not the standard decorators in the current language proposal, and the two are not interchangeable — a transform configured for standard decorators produces classes Nest cannot read.

### Verify it once, deliberately

Put a test in the repository that fails loudly when the metadata stops being emitted. It costs four lines and it converts a mystifying `undefined` into a named failure.

```ts title="test/metadata.spec.ts"
import { Injectable } from '@nestjs/common'
import { Test } from '@nestjs/testing'

@Injectable()
class Leaf {
  value() {
    return 42
  }
}

@Injectable()
class Root {
  private readonly leaf: Leaf

  constructor(leaf: Leaf) {
    this.leaf = leaf
  }

  run() {
    return this.leaf.value()
  }
}

it('the test transform emits decorator metadata', async () => {
  const moduleRef = await Test.createTestingModule({ providers: [Root, Leaf] }).compile()

  expect(moduleRef.get(Root).run()).toBe(42)
})
```

If that fails, no other failure in the suite is worth reading yet.

:::tip You do not need to import `reflect-metadata`
`@nestjs/common` and `@nestjs/core` both `import 'reflect-metadata'` at their entry points, so it is loaded as soon as anything Nest is imported. A `setupFiles` entry or a per-spec import for it is cargo cult — harmless, but it is not what is fixing your problem.
:::

## `vi.mock` versus `jest.mock`

The APIs look alike and differ in the places that matter under ESM.

| | Jest | Vitest |
| --- | --- | --- |
| Module mock | `jest.mock(path, factory)` | `vi.mock(path, factory)` |
| Hoisted above imports | yes | yes |
| Escape hoisting for a shared variable | `jest.requireActual` dance | `vi.hoisted(() => …)` |
| The real module inside a factory | `jest.requireActual(path)` | `await vi.importActual(path)` |
| Spy on a method | `jest.spyOn(obj, 'm')` | `vi.spyOn(obj, 'm')` |
| Standalone fake | `jest.fn()` | `vi.fn()` |
| Typed mock helper | `jest.mocked(x)` | `vi.mocked(x)` |
| Fake timers | `jest.useFakeTimers()` | `vi.useFakeTimers()` |
| Reset between tests | `clearMocks` / `resetMocks` / `restoreMocks` in config | same option names |

Two differences cause most of the trouble.

**The specifier must match what you wrote.** Vitest resolves the path in `vi.mock` the same way the importer does, so under `moduleResolution: "nodenext"` the `.js` extension is part of the identity:

```ts
// Matches `import { sendMail } from '../src/mailer.js'`
vi.mock('../src/mailer.js', () => ({ sendMail: vi.fn(async () => undefined) }))

// Silently mocks nothing — no such specifier was imported.
vi.mock('../src/mailer', () => ({ sendMail: vi.fn() }))
```

The second form does not error. It resolves to a module nobody imported, the real one loads, and the test fails somewhere else entirely.

**The factory is hoisted, so it cannot close over a `const`.** Both runners hoist the call above the imports; Vitest gives you an explicit way out:

```ts
import { describe, expect, it, vi } from 'vitest'

// Hoisted alongside the vi.mock call, so the factory may reference it.
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn(async () => undefined) }))

vi.mock('../src/mailer.js', () => ({ sendMail }))

it('queues a welcome mail', async () => {
  // …
  expect(sendMail).toHaveBeenCalledOnce()
})
```

To keep the rest of a module real, pull it in and spread:

```ts
vi.mock('../src/clock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/clock.js')>()
  return { ...actual, now: () => new Date('2026-01-01T00:00:00Z') }
})
```

:::best-practice In a Nest codebase you should rarely need any of this
Module mocking is the tool for code that reaches for an import at module scope. Nest code reaches for a token, and `overrideProvider` substitutes it with no loader involvement, no hoisting rules and no specifier-matching — see [Mocking providers](mocking-providers.md).

Reserve `vi.mock` for third-party modules with no injectable seam: an SDK that exports a bare function, a module with import-time side effects. If you find yourself mocking your own services by path, the wiring is fighting the framework.
:::

## Globals

`globals: true` puts `describe`, `it`, `expect`, `beforeEach` and the rest on `globalThis`, and `"types": ["vitest/globals"]` in tsconfig is what makes TypeScript agree. That pairing is what the CLI generates, and it is why Jest-shaped specs mostly compile unchanged.

The alternative is explicit imports, which cost one line per file and buy clarity plus the ability to drop `vitest/globals` from `types`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
```

Either is defensible; the thing that is not defensible is `globals: true` without the `types` entry, which produces `Cannot find name 'describe'` across the whole suite and sends people hunting in the wrong file.

## Migrating an existing Jest suite

Most of a Nest suite is `Test.createTestingModule(...)` and supertest, and none of that changes. The migration is the runner, the config and the mock API.

**1. Swap the dependencies.** Remove `jest`, `ts-jest`, `@types/jest` and `jest.config.ts`. Add `vitest`, `@vitest/coverage-v8`, `vite-tsconfig-paths`, and `unplugin-swc` + `@swc/core` if you want the transform pinned.

**2. Translate the config.**

| `jest.config.ts` | `vitest.config.ts` |
| --- | --- |
| `testRegex` / `testMatch` | `test.include` (glob array) |
| `rootDir` | `test.root` |
| `moduleNameMapper` from tsconfig paths | the `vite-tsconfig-paths` plugin |
| `transform: { '^.+\\.ts$': 'ts-jest' }` | the Vite transform, or `unplugin-swc` |
| `setupFilesAfterEach` | `test.setupFiles` |
| `globalSetup` | `test.globalSetup` |
| `testEnvironment: 'node'` | `test.environment: 'node'` (the default) |
| `collectCoverageFrom` | `test.coverage.include` |
| `coveragePathIgnorePatterns` | `test.coverage.exclude` |
| `coverageThreshold` | `test.coverage.thresholds` |
| `testTimeout` | `test.testTimeout` |
| `maxWorkers: 1` | `test.fileParallelism: false` |

**3. Rename the mock API.** A mechanical pass: `jest.` becomes `vi.` for `fn`, `spyOn`, `mock`, `mocked`, `useFakeTimers`, `advanceTimersByTime`, `clearAllMocks`, `resetAllMocks`, `restoreAllMocks`. Two that are not one-for-one:

- `jest.requireActual(path)` becomes `await vi.importActual(path)` — asynchronous, so the mock factory becomes `async`.
- `jest.setTimeout(ms)` becomes `test.testTimeout` in the config, or `vi.setConfig({ testTimeout: ms })` inside a file.

**4. Add `.js` extensions to every relative specifier in `vi.mock`** if you moved to `nodenext` resolution. This is the step that gets skipped, and it fails silently.

**5. Run the metadata test first.** If dependency injection is broken, everything else in the run is noise.

**6. Expect the assertion library to be almost identical.** Vitest's `expect` is Chai-backed with a Jest-compatible surface. Custom matchers registered with `expect.extend` port directly. Snapshot files are compatible in format, though the inline-snapshot writer formats slightly differently — regenerate rather than hand-merge.

## What is still fiddly

An honest list, because none of these is in the marketing.

- **The transform question above.** It is the single biggest source of lost time, and its symptom points nowhere near its cause.
- **Two configs, two scripts.** Running the whole suite means two commands, and CI has to remember both. Coverage across both requires merging reports or a third config.
- **Watch mode and a database do not mix well.** A file save re-runs a suite mid-transaction against a shared database. Keep e2e tests out of the watch config, which is what the generated split already does.
- **`vi.mock` path identity.** Extension-sensitive, silently wrong when mismatched.
- **Debugging needs `--no-file-parallelism`.** Otherwise breakpoints land in whichever worker got there first.
- **Coverage of decorated classes.** Both v8 and Istanbul report through a source map produced by whichever transform you chose, so switching from esbuild to SWC can move your coverage number by a percent or two with no code change. Do not chase that.
- **Some Jest ecosystem packages have no Vitest equivalent.** Anything that reaches into Jest's internals rather than its public API needs replacing, not porting.
- **Vite plugin ordering occasionally matters.** `tsconfigPaths()` before `swc.vite()` is the arrangement that works; the reverse has been known to drop alias resolution.

Jest can be made to work under ESM — `--experimental-vm-modules` and the unstable module-mocking API exist — but you are then maintaining a configuration that the framework's own scaffold does not generate and that most of the answers you find online do not match. If you are staying on CommonJS, stay on Jest; if you are moving to ESM, move to Vitest.

## Common mistakes

- **Assuming `emitDecoratorMetadata` in tsconfig is enough.** It tells `tsc`. It does not tell whichever transformer Vitest is actually using.
- **Reading `Cannot read properties of undefined` as a logic bug.** Check dependency injection first; the metadata test tells you in a second.
- **Configuring SWC for standard decorators.** Nest uses legacy decorators; `legacyDecorator: true` and `decoratorMetadata: true` are both required.
- **`vitest` in CI.** That is watch mode. CI wants `vitest run`.
- **`globals: true` without `"types": ["vitest/globals"]`.** `Cannot find name 'describe'` everywhere, and the fix is in a different file than the error.
- **`vi.mock('../src/mailer')` when the import says `'../src/mailer.js'`.** No error, no mock, a confusing downstream failure.
- **A `vi.mock` factory closing over a module-scope `const`.** The call is hoisted; use `vi.hoisted()`.
- **Reaching for `vi.mock` to fake your own services.** `overrideProvider` is the seam the framework already gives you.
- **Running e2e tests in watch mode against a shared database.** Interleaved transactions and failures that move around.
- **Porting `jest.requireActual` as if it were synchronous.** `vi.importActual` returns a promise.
- **Deleting `jest.config.ts` before the Vitest config is proven.** Keep both until the suite is green, then remove one.
- **Chasing a coverage delta caused by changing the transform.** The code did not change; the source maps did.

## Related topics

- [ESM vs CommonJS](../nestjs/esm-vs-commonjs.md) — the module-format decision this page assumes you have made.
- [Unit tests](unit-tests.md) — the testing module the runner executes.
- [Mocking providers](mocking-providers.md) — the substitution seam that makes `vi.mock` mostly unnecessary.
- [End-to-end tests](e2e-tests.md) — the suite the second config exists for.
- [Coverage](coverage.md) — configuring `coverage.thresholds` and the exclusion list for both runners.
- [Installation and the CLI](../nestjs/installation-and-cli.md) — what `nest new` generates and the Node floor the CLI needs.
- [Dependency injection](../nestjs/dependency-injection.md) — what `design:paramtypes` is actually feeding.
- [Native TypeScript support](../node/native-typescript-support.md) — why Nest's decorators need a real transform and not type stripping.
- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — the runtime-level rules underneath all of this.
- [Continuous integration](../nestjs-production/ci.md) — running both configs on every push.
