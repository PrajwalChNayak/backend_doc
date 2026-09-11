---
title: Coverage
description: Configuring coverage for a NestJS 12 project under both Vitest 5 and Jest 30 — what the number measures and what it cannot, excluding generated and bootstrap files, setting thresholds you can actually hold, and why 100% is usually the wrong target.
status: current
updated: 2026-09-11
---

Coverage tells you which lines ran during the test suite. It does not tell you whether anything was asserted, whether the assertions were right, or whether the code that ran was the code that matters. It is a useful instrument for finding untested regions and a terrible target to optimize, and a Nest project makes both properties unusually visible because so much of the codebase is decorators, modules and bootstrap glue that will report as covered without a single meaningful test.

## What the number measures

Four metrics, in increasing order of usefulness.

| Metric | Counts | Blind to |
| --- | --- | --- |
| **Statements** | statements executed | branches not taken |
| **Lines** | source lines touched | everything statements misses, plus multi-statement lines |
| **Functions** | functions entered | what happened inside them |
| **Branches** | each side of each conditional | the combination of two conditions, and every assertion |

Branch coverage is the only one worth watching closely. A service with 95% statement coverage and 60% branch coverage has one tested path per method and no tested error path — which is exactly the profile of a suite that catches nothing.

None of the four sees an assertion. This test scores 100% on every metric:

```ts
it('does something', async () => {
  await service.placeOrder('o1')
})
```

It executes the whole method, every branch it happens to take, and asserts nothing. Coverage is a statement about execution, not about verification, and that gap is why the number cannot be a goal on its own.

Nest adds a second gap. A controller method's decorators run at class-definition time, so `@Get(':id')`, `@UseGuards(...)` and `@ApiOkResponse(...)` are marked covered the moment the module is imported — even if no request ever reaches that route. Import `AppModule` in one e2e test and a large share of your "coverage" is metadata evaluation.

## Vitest

`@vitest/coverage-v8` 5.0.0 is the provider that matches Vitest 5.0.0, and the versions must agree.

:::tabs
@tab npm
```bash
npm install --save-dev @vitest/coverage-v8@5
```
@tab pnpm
```bash
pnpm add -D @vitest/coverage-v8@5
```
@tab yarn
```bash
yarn add -D @vitest/coverage-v8@5
```
:::

```ts title="vitest.config.ts"
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Without `include`, only files a test touched are reported — which
      // flatters the number by hiding whole modules nobody imported.
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/**/*.entity.ts',
        'src/**/*.interface.ts',
        'src/**/*.spec.ts',
        'src/**/index.ts',
        'src/migrations/**',
        'src/generated/**',
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
      // Emit the report even when tests fail, so CI can still annotate.
      reportOnFailure: true,
    },
  },
})
```

Run it with `vitest run --coverage`, which is what the generated `test:cov` script does. `--coverage` on the command line overrides `coverage.enabled`, so leaving it off in the config is correct — you do not want the instrumentation cost on every watch-mode rerun.

Notes on the options, all verified against Vitest 5.0.0's own declarations:

- `provider` is `'v8'` (default), `'istanbul'` or `'custom'`. V8 is faster and needs no instrumentation pass; Istanbul goes through a source transform. If you switch between them, expect the branch number to move — they count branches differently.
- `include` and `exclude` are glob arrays, and `exclude` is applied after `include`. There is no `all` option in Vitest 5; `include` is what replaced it.
- `thresholds` accepts `statements`, `branches`, `functions` and `lines`, plus `perFile` to require the minimum of every file rather than the aggregate, and `100: true` as shorthand for all four at 100.
- `thresholds` also takes per-glob entries alongside the global numbers, which is how you hold a high bar where it matters without imposing it everywhere:

```ts
thresholds: {
  statements: 70,
  branches: 60,
  // The money code carries a higher bar than the codebase average.
  'src/billing/**/*.ts': { statements: 95, branches: 90 },
}
```

- `reportOnFailure: true` makes the report appear even on a red run, which you want in CI.
- `excludeAfterRemap` re-applies the exclusion list after coverage is mapped back to source. If files you excluded keep appearing in the report, that is the option to reach for.

For a project with the generated two-config split, coverage across both suites means either running each and merging the `lcov` files, or adding a third config whose `include` covers both globs. Merging is the usual answer; say so in the CI job rather than quietly reporting only the unit-test number.

## Jest

The CLI's CommonJS scaffold generates a `jest.config.ts` with `collectCoverageFrom` already pointed at `src`, `libs` and `apps`. The additions worth making are the exclusions and the threshold.

```ts title="jest.config.ts"
import type { Config } from 'jest'

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',

  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    'src/main.ts',
    '\\.module\\.ts$',
    '\\.dto\\.ts$',
    '\\.entity\\.ts$',
    '\\.interface\\.ts$',
    'src/migrations/',
    'src/generated/',
  ],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: { statements: 70, branches: 60, functions: 70, lines: 70 },
    './src/billing/': { statements: 95, branches: 90 },
  },
}

export default config
```

`coverageThreshold` requires a `global` key; per-path entries are added alongside it and are matched as path prefixes or globs. `coverageProvider` is `'babel'` by default and `'v8'` is the faster option — with the same caveat that the two count branches differently, so change it once and re-baseline rather than switching back and forth.

The e2e config (`test/jest-e2e.json`) is separate, so the same merge question applies as under Vitest.

## What to exclude, and why

Excluding files is not cheating. It is refusing to let noise move the number.

| Excluded | Reason |
| --- | --- |
| `src/main.ts` | bootstrap. Runs in production, never in tests — by design, since e2e tests build the app themselves. |
| `*.module.ts` | a decorator call and an empty class body. Covered by importing it; verifies nothing. |
| `*.dto.ts` | property declarations and validation decorators. The *rules* deserve tests ([Testing guards, pipes and interceptors](testing-the-pipeline.md)); the file's line count does not. |
| `*.entity.ts` / `*.schema.ts` | the same, for the persistence mapping. |
| `*.interface.ts`, `*.d.ts`, type-only files | erased at build; nothing to execute. |
| `src/migrations/**` | run once each, verified by the migration test, and their line count would swamp everything. |
| `src/generated/**` | the Prisma client, GraphQL types, OpenAPI clients. Not your code. |
| `index.ts` barrels | re-exports. |
| Spec files and test helpers | measuring the tests measures nothing. |

What must **not** be excluded: services, repositories, guards, pipes, interceptors, filters, and anything that computes. If a file is genuinely untestable, that is a design report, not an exclusion candidate.

:::warning An exclusion list is a thing people hide behind
Adding a path to `exclude` to make a threshold pass is the coverage equivalent of deleting a failing test. Each entry should be defensible in one sentence, and the list should be reviewed like any other code. A pattern like `src/**/*.service.ts` appearing in an exclusion list is a code-review stop.
:::

## Thresholds you can actually hold

A threshold is only useful if it fails the build, and it only stays useful if nobody lowers it.

**Start at whatever you have today, minus a point.** Measure, round down, commit. A threshold set aspirationally is lowered within a week, and a threshold that gets lowered teaches the team that the gate is decorative.

**Ratchet up, never down.** Raise the number when a change pushes it up. Vitest has `thresholds.autoUpdate` to write the new values back automatically; it is convenient and it removes the human moment where someone notices the number moved, so prefer the manual bump on a team that is trying to build the habit.

**Use per-path thresholds for the code that matters.** A flat 80% across a codebase means the billing module and the health-check controller are held to the same bar, which is absurd. 95% on `src/billing/**` and 60% elsewhere describes your actual risk.

**Watch `perFile` carefully.** `thresholds.perFile: true` requires every file to meet the minimum, which catches the one file at 12% that the aggregate hides. It also fails on a three-line utility with one untested branch. It is right for a small, uniform codebase and painful for a large one.

Rough numbers that hold up for a Nest API, once the exclusions above are in place:

| Metric | A reasonable gate | A good place to be |
| --- | --- | --- |
| Statements | 70 | 80–85 |
| Lines | 70 | 80–85 |
| Functions | 70 | 80 |
| Branches | **60** | 75 |

Branches lags the others and should. If branch coverage is within a few points of statement coverage, either the code has very few conditionals or someone has been writing tests to move the number.

## Why 100% is usually the wrong target

Not because the last few percent are hard, but because of what people do to reach them.

**It rewards the wrong tests.** The fastest way from 92% to 100% is a test per uncovered line, asserting nothing meaningful. That is measurable, reviewable-looking work that adds maintenance cost and zero defect detection.

**It makes refactoring expensive.** Every extracted method needs its own test to keep the number, so the number starts arguing against the change.

**It is satisfiable while missing everything that matters.** A suite can be at 100% and still not know whether the SQL is valid, whether the unique constraint fires, whether the guard is attached to the route, whether the `ValidationPipe` is registered, whether the serializer leaks a password hash, or whether an N+1 crept in. Every one of those needs a real database or a real request — [Database fixtures](database-fixtures.md) and [End-to-end tests](e2e-tests.md) — and none of them shows up as a coverage gap.

**It is the wrong question.** "Which of our error paths has no test?" is answerable and useful. "What is our coverage percentage?" is answerable and mostly not.

Where 100% genuinely is the right target: a small, pure, high-consequence module — a pricing calculator, a permission evaluator, a token verifier. Set it per-path, on the files that earn it, and leave the aggregate alone.

## Reading the report instead of the number

The useful workflow is not the summary line.

1. Open the HTML or `lcov` report and **sort by branch coverage ascending**. The worst files are the list of things to test next.
2. In a file you care about, look at which branches are red. They are almost always `catch` blocks, `if (!found) throw`, permission denials and retry paths — the behavior most worth testing and least likely to be exercised by a happy-path suite.
3. Ignore files whose uncovered lines are decorators and property declarations. That is the Nest shape, not a gap.
4. In CI, report the **delta** rather than the absolute. "This PR drops branch coverage in `src/orders` by 4 points" is actionable; "coverage is 78.3%" is wallpaper.

`json-summary` is the reporter to emit for that, since it is small and trivial for a CI step to diff against the base branch. See [Continuous integration](../nestjs-production/ci.md) for wiring it into the pipeline alongside the migration and e2e jobs.

## Common mistakes

- **Treating coverage as a measure of test quality.** It measures execution, not verification. A test with no assertions scores full marks.
- **Chasing statements while branch coverage stays flat.** The error paths are the bugs.
- **Not excluding modules, DTOs, entities and `main.ts`.** Importing `AppModule` once inflates the number with metadata evaluation.
- **Excluding a service to make a threshold pass.** The gate is now decorative and everyone knows it.
- **No `coverage.include` under Vitest.** Only files a test touched are reported, so a module nobody imported cannot lower your number.
- **Mismatched Vitest and `@vitest/coverage-v8` versions.** They move together; 5.0.0 needs 5.0.0.
- **Switching providers and comparing numbers.** V8 and Istanbul count branches differently; re-baseline instead.
- **A `coverageThreshold` with no `global` key under Jest.** It is required.
- **Reporting only the unit suite's coverage** while e2e runs under a separate config. Merge the reports or say what the number covers.
- **Lowering a threshold to get a build green.** Fix the test or accept the failure; a threshold that moves down is not a gate.
- **`autoUpdate` on a team that is still building the habit.** The number rises silently and nobody learns to watch it.
- **A 100% target across the whole codebase.** It buys assertion-free tests and refactoring friction.
- **Assuming coverage would have caught it.** A missing global pipe, an unattached guard and an N+1 are all invisible to every metric on this page.

## Related topics

- [Vitest for ESM projects](vitest-for-esm.md) — the runner and config the Vitest coverage block sits in.
- [Unit tests](unit-tests.md) — the branch-level tests that move branch coverage honestly.
- [Testing guards, pipes and interceptors](testing-the-pipeline.md) — cheap branch coverage on the classes with the most conditionals.
- [End-to-end tests](e2e-tests.md) — the failures coverage cannot see.
- [Database fixtures](database-fixtures.md) — the other class of failure coverage cannot see.
- [Continuous integration](../nestjs-production/ci.md) — enforcing the threshold and reporting the delta on every push.
- [Mocking providers](mocking-providers.md) — why a fully mocked suite can be high-coverage and low-value.
- [Testing](../express-libraries/testing.md) — the same argument with the built-in Node runner's coverage flags.
- [The built-in test runner](../node/built-in-test-runner.md) — `--experimental-test-coverage` and the `--test-coverage-*` thresholds.
