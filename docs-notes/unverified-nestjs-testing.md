# Unverified / omitted — `content/nestjs-testing/`

Written during the NestJS Testing pass, 2026-09-11. Everything below was either
unverifiable against a published `.d.ts`, an unpacked package, or a live run, so
it was **left out of the pages**.

Verification method for this section: `npm pack` + unpack of `@nestjs/testing@12.0.1`,
`@nestjs/common@12.0.1`, `@nestjs/core@12.0.1`, `@nestjs/typeorm@12.0.1`,
`@nestjs/mongoose@12.0.0`, `@nestjs/bullmq@12.0.0`, `@nestjs/schematics@12.0.0`,
`vitest@5.0.0` and `unplugin-swc@1.6.0`, plus a throwaway Vitest 5 project used to
settle the decorator-metadata question empirically.

---

## Omitted

### `@nestjs/testing` — no middleware override

`TestingModuleBuilder` exposes exactly `setLogger`, `useMocker`, `overridePipe`,
`overrideFilter`, `overrideGuard`, `overrideInterceptor`, `overrideProvider`,
`overrideModule` and `compile`. There is **no `overrideMiddleware`**. Pages say
so rather than implying a symmetry that does not exist.

### `ExecutionContextHost`

`@nestjs/core` ships `ExecutionContextHost`, a concrete `ExecutionContext`
implementation that would be convenient in guard tests. It is exported only from
the `@nestjs/core/internal` subpath, and the package's own naming marks it as
non-public API. Mentioned in one sentence on `testing-the-pipeline.md` as
existing-but-internal; **not used in any example**, and no claim is made about
its stability across minors.

### `@nestjs/testing` mock helper packages

`@golevelup/ts-jest` (`createMock`) and similar community mock factories are
widely used with Nest. They are third-party, outside the verified version table
in CONTRIBUTING §11.1, and their Nest 12 / Vitest 5 compatibility was not
checked. Left out entirely; the pages show hand-written partial mocks and
`useMocker` instead.

### Jest 30 ESM support details

`jest@30.5.1` is current, and the generated CommonJS scaffold uses it with
`ts-jest@^29.2.5`. Jest's native ESM story (`--experimental-vm-modules`,
`extensionsToTreatAsEsm`, `jest.unstable_mockModule`) was **not** exercised
against a Nest 12 ESM project. `vitest-for-esm.md` therefore says "Jest can be
made to work under ESM, at a cost" without prescribing a configuration.

### Nest CLI test-related flags

`nest build` / `nest start` gained `--rspackPath`, `--emit-declarations`,
`--no-type-check`, `--silent` and `--parallel [concurrency]` (CONTRIBUTING §11.4).
None of these is a test command, and there is no `nest test`. No claim is made
about running the suite through the CLI.

### Vitest `browser` / `projects` for splitting unit and e2e runs

Vitest 5 has a `projects` option, and it is plausibly the tidier replacement for
the generated `vitest.config.e2e.ts` + `--config` split. Not tested against a
Nest project, so the pages document the two-config layout the schematic
actually generates.

### Coverage remapping accuracy under the Oxc transform

`coverage.excludeAfterRemap` exists in Vitest 5 and is documented as the fix for
transpiled files appearing in a report despite matching `exclude`. Whether the
Nest + Oxc pipeline actually needs it was not measured, so `coverage.md`
mentions the option's existence and the symptom, without asserting that Nest
projects hit it.

### Istanbul vs v8 provider fidelity numbers

No branch-coverage comparison was run between `provider: 'v8'` and
`provider: 'istanbul'` on a Nest codebase. `coverage.md` states only the
verified configuration surface, not which provider reports "better" branches.

---

## Verified the hard way (kept, recorded here for the next author)

These went **into** the pages, and each is a live-run or source result rather
than a documentation claim — worth re-checking on the next version bump.

1. **`.compile()` does not run lifecycle hooks.** `TestingModuleBuilder.compile()`
   scans, applies overrides, instantiates providers and returns a
   `TestingModule`. It never calls `init()`. Confirmed in
   `testing-module.builder.js` and by a passing assertion that a provider's
   `onModuleInit` had not fired after `compile()` and had after
   `moduleRef.init()`.

2. **Hook ordering in v12 is by hierarchy level.**
   `core/hooks/on-module-init.hook.js` groups a module's controllers,
   injectables, middlewares and providers with
   `getInstancesGroupedByHierarchyLevel()`, sorts the levels, and `await`s a
   `Promise.all` per level. Modules themselves are ordered by `distance`
   descending. This is the v12 ordering change.

3. **`useMocker` only fires for tokens that fail to resolve**, and a falsy
   return rethrows the original resolution error. From `testing-injector.js`:
   the mocker is called inside the `catch` of `resolveComponentWrapper` /
   `resolveComponentHost`.

4. **`reflect-metadata` is imported by the framework.** Both
   `@nestjs/core/index.js` and `@nestjs/common/index.js` start with
   `import 'reflect-metadata'`, so a test file does not need its own polyfill
   import.

5. **The decorator-metadata question, settled by running it.** Throwaway project:
   `@nestjs/*@12.0.1` + `vitest@5.0.0`, `tsconfig` with `emitDecoratorMetadata`.

   | Transform | Result |
   | --- | --- |
   | Vitest 5.0.0 on Vite **8.3.0** (Oxc) | DI resolves — **passes** |
   | Vitest 5.0.0 on Vite **7.3.6** (esbuild) | injected dependency is `undefined` — **fails** |
   | Vite 7.3.6 + `unplugin-swc@1.6.0` + `@swc/core@1.16.2` | **passes** |
   | Vite 8.3.0 with `emitDecoratorMetadata: false` | injected dependency is `undefined` — **fails** |

   The failure mode is never "Nest can't resolve dependencies"; it is
   `TypeError: Cannot read properties of undefined` at first use of the injected
   field.

6. **The generated scaffolds**, read from
   `@nestjs/schematics@12.0.0/dist/lib/application/files/`:
   - `ts-esm/` — `"type": "module"`, `vitest.config.ts` + `vitest.config.e2e.ts`
     (both only `vite-tsconfig-paths`, `globals: true`, `root: './'`,
     `include`), `test: "vitest run"`, `lint: "oxlint src/ test/"`,
     tsconfig `types: ["vitest/globals", "node"]`.
   - `ts/` — CommonJS, `jest.config.ts` (`ts-jest` transform, `testRegex`,
     `pathsToModuleNameMapper`, `collectCoverageFrom` over `src`/`libs`/`apps`,
     `coverageDirectory: './coverage'`) plus `test/jest-e2e.json`.
   - The ESM scaffold pins `vitest: ^4.1.2` and `@vitest/coverage-v8: ^4.1.2`
     in its template `devDependencies` even though **5.0.0** is the current
     release. The pages document 5.0.0 and flag the scaffold's caret range.
