# Unverified / omitted — `content/nestjs-production/`

Author pass: 2026-09-11. All eleven pages in `content/nestjs-production/` were written
against **CONTRIBUTING.md Part 2 (§11–§13)**, which is the repository's authoritative
verified fact base for NestJS 12 (produced by unpacking `@nestjs/core@12.0.1` and
`@nestjs/common@12.0.1` and reading the shipped `.d.ts` files), plus the already-written
pages `content/nestjs/esm-vs-commonjs.md`, `content/nestjs/configuration.md`,
`content/nestjs/installation-and-cli.md`, `content/nestjs-libraries/terminus.md`,
`content/nestjs-databases/health-checks.md` and
`docs-notes/unverified-nestjs-libraries.md`.

**Late addition — a second verification pass was possible.** Partway through this pass
`@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` became available on disk under
`examples/nest-crud-module/node_modules/`, installed by a concurrent section pass. The
shipped `.d.ts` files were then read directly, which promoted three items out of this
file and surfaced one option the pages had been missing entirely. The
"Verified by reading the shipped declarations" section below records what was confirmed;
"Deliberately omitted" now holds only what remains genuinely unverifiable.

---

## Verified by reading the shipped declarations (second pass)

Source: `examples/nest-crud-module/node_modules/@nestjs/common/interfaces/` in
`@nestjs/common@12.0.1`, and `@nestjs/core@12.0.1` alongside it.

### `instrument` — fully verified, and it is not an `@nestjs/observe` type

`NestApplicationContextOptions.instrument` is declared as:

```ts
instrument?: {
  instanceDecorator: (instance: unknown) => unknown
}
```

It is a **general-purpose hook**: Nest passes every instance the container creates to
`instanceDecorator` and uses the returned value. It is not typed against `@nestjs/observe`
at all, so any SDK — or your own code — can supply it.

`content/nestjs-production/observability.md` was corrected to show this exact shape
(it previously showed a placeholder value passed straight to `instrument`, which would
have been wrong). It also now notes that the decorator runs per instance, so it is
per-request for `Scope.REQUEST` providers. `@nestjs/observe`'s `createInstanceDecorator`
is the factory that produces such a function, which is consistent with
`docs-notes/unverified-nestjs-libraries.md` describing it as "a factory the module calls
internally, not a decorator you apply".

### `forceCloseConnections` — verified

`NestApplicationOptions.forceCloseConnections?: boolean`, documented in the declarations
as: *"Force close open HTTP connections. Useful if restarting your application hangs due
to keep-alive connections in the HTTP adapter."* The pages' description matches. The
declarations do not name the underlying Node call, so the pages still describe only the
observable behaviour and do not claim `closeIdleConnections()` versus
`closeAllConnections()`.

### `return503OnClosing` — newly found, and it was missing from the pages

`NestApplicationOptions.return503OnClosing?: boolean`, `@default false`: *"Whether to
return 503 Service Unavailable for new requests during the shutdown process, while
allowing existing in-flight requests to complete."*

This is a first-party answer to part of the deploy-time-502 problem and the pages did not
mention it. Added to `graceful-shutdown.md` (with a table distinguishing it from the drain
delay — a 503 is a *legible* failure, not a successful request, so it complements rather
than replaces the delay), to `health-and-readiness-probes.md`, and to
`deployment-checklist.md`.

### Lifecycle hook signatures — verified

`onModuleInit()`, `onApplicationBootstrap()` and `onModuleDestroy()` take **no**
arguments; `beforeApplicationShutdown(signal?: string)` and
`onApplicationShutdown(signal?: string)` both receive the signal. The table in
`graceful-shutdown.md` is correct as written.

### `ConsoleLogger` options — verified

`json?`, `structuredParams?` (`@default true`) and `flattenParams?` (`@default false`,
and it requires `structuredParams`) all exist as documented in CONTRIBUTING §11.4. The
`observability.md` snippet is correct.

### Other `NestApplicationOptions` fields seen but not used

`routeConflictPolicy`, `routeResolutionStrategy`, `preview`, `snapshot`,
`moduleIdGeneratorAlgorithm`, `autoFlushLogs` (`@default true`), `forceConsole`,
`rawBody`, `bodyParser`, `cors`, `httpsOptions`. None are production-operations topics,
so none were introduced on these pages; `routeConflictPolicy` and
`routeResolutionStrategy` belong to the routing pages, which already cover them.

---

## Deliberately omitted as unverifiable

### `@nestjs/observe` — the hosted product

`@nestjs/observe` itself is **not** installed under `examples/`, so only the facts already
recorded in CONTRIBUTING §11.1/§11.4 and `docs-notes/unverified-nestjs-libraries.md` are
used: version **0.1.8** (pre-1.0), exports `createObserveModule`, `TracerService`,
`TraceSpanDelegate`, `custom-metrics`, `createInstanceDecorator` and `observe.constants`,
exports **no decorators**, requires `appKey`/`appSecret`/`serviceId`, and has a collector
endpoint overridable through an option and `OBSERVE_ENDPOINT`.

**Omitted:** pricing, plan availability, retention, the dashboard feature set, the exact
`createObserveModule` call signature, and any claim that the collector is OTLP-compatible.
The page states only that the endpoint is configurable and that the wire contract is not a
published specification.

### `nest deploy` — targets, flags and providers

CONTRIBUTING §11.4 confirms the command exists in the v12 CLI.
`content/nestjs/installation-and-cli.md` already documents it at that level.
`build-and-deployment.md` repeats only that, plus the operational caveat that it is not a
replacement for a pipeline you control.

**Omitted:** every flag, every hosting target, authentication, pricing, and whether it
produces a container image. None of that was verifiable.

### OpenTelemetry package versions

`@opentelemetry/sdk-node` and `@opentelemetry/auto-instrumentations-node` were **not**
verified in this site's fact-checking passes (Part 1 records the same omission in
`content/production/observability.md`). `observability.md` names the packages, shows the
`--import` load-order requirement, and carries a `:::note` telling the reader to check
the registry before pinning. **No version numbers are given.**

### `@prometheus-io/client` version

Part 1 records `prom-client` as npm-deprecated in favour of `@prometheus-io/client`.
The successor package's current version was not verified, so `observability.md` names the
package inside a `:::deprecated` callout and tells the reader to check the registry
before pinning. No version is stated.

### Per-worker memory baseline for a Nest process

`content/production/clustering.md` gives 40–80 MB RSS for a small Express API.
No equivalent figure for a Nest process was measurable in this pass, and inventing one
would be worse than omitting it. `clustering.md` instead shows how to measure it
(`process.memoryUsage()` logged immediately after `app.listen()`) and asks the reader to
budget from their own number.

### `@nestjs/schedule` distributed locking

There is no first-party lock API in `@nestjs/schedule` 12.0.1 (already recorded in
`docs-notes/unverified-nestjs-libraries.md`). `clustering.md` describes the three real
options — a separate single-replica scheduler deployment, enqueueing to BullMQ with a
stable job id, or a Redis lock — in terms of the underlying mechanisms only. No
`@nestjs/schedule` API is claimed for it.

---

## Third-party versions used, and where they came from

| Item | Value used | Source |
| --- | --- | --- |
| `@nestjs/core` / `common` / `platform-express` / `platform-fastify` | 12.0.1 | CONTRIBUTING §11.1 |
| `@nestjs/cli`, `@nestjs/schematics` | 12.0.0 | CONTRIBUTING §11.1 |
| `@nestjs/config`, `@nestjs/terminus`, `@nestjs/cache-manager`, `@nestjs/bullmq` | 12.0.0 | CONTRIBUTING §11.1 |
| `@nestjs/schedule` | 12.0.1 | CONTRIBUTING §11.1 |
| `@nestjs/throttler` | 6.5.0 | CONTRIBUTING §11.1 (correction to the brief) |
| `@nestjs/graphql` | 14.0.0 | CONTRIBUTING §11.1 (correction to the brief) |
| `@nestjs/observe` | 0.1.8, pre-1.0 | CONTRIBUTING §11.1 |
| `pino` 10.3.1, `nestjs-pino` 5.1.0 | as stated | CONTRIBUTING §11.1 |
| `pino-pretty` 13.1.3 | as stated | CONTRIBUTING §1.3 |
| `zod` 4.5.4, `argon2` 0.45.1, `bcrypt` 6.0.0, `helmet` 8.3.0 | as stated | CONTRIBUTING §1.3 / §11.1 |
| `better-sqlite3` 13.0.3 | as stated | CONTRIBUTING §1.3 |
| `vitest` 5.0.0, `oxlint` 1.82.0, `typescript` 7.0.2 | as stated | CONTRIBUTING §11.1 |
| Node 24.20.0 / Node 24 LTS target | as stated | CONTRIBUTING §1.1 |
| Nest Node floors (app v20.19+/v22.12+/v26+; CLI v22.22.3+/v24.15+/v26+) | as stated | CONTRIBUTING §11.2 |

## Third-party tags carried over from Part 1, with a re-check caveat on the page

| Item | Value used | Note |
| --- | --- | --- |
| `actions/checkout@v7`, `actions/setup-node@v7` | as in `content/production/ci.md` | `ci.md` repeats the "current majors on 2026-09-09, check each action's own repository" `:::note`. No new action versions were invented; the Pages actions are not used on this page. |
| `postgres:18-alpine` | as in `content/production/ci.md` | same `:::note` tells the reader to confirm before copying |
| `redis:8-alpine` | new on this page | covered by the same `:::note`; only used as a service container |
| `node:24.20.0-bookworm-slim` | 24.20.0 from CONTRIBUTING §1.1 | `docker.md` also shows the pinning table and recommends a digest pin in CI |
| `tini` (Debian package, `/usr/bin/tini`) | used as the init in `docker.md` | Part 1's `content/production/dockerfile.md` uses `dumb-init` from the same archive; `docker.md` names `dumb-init` and `docker run --init` as the alternatives |

## Claims taken from the existing NestJS pages rather than re-derived

These were written and fact-checked in earlier passes of this project and are treated as
authoritative here rather than re-verified:

- `TerminusModule.forRoot()` options (`errorLogStyle`, `logger`,
  `gracefulShutdownTimeoutMs`), the attempt builder (`withTimeout`, `cacheFor`), the
  `'ok' | 'error' | 'degraded' | 'shutting_down'` status set, and the absence of a Redis
  indicator — from `content/nestjs-libraries/terminus.md` and
  `content/nestjs-databases/health-checks.md`.
- `@nestjs/config` `forRoot` options (`isGlobal`, `cache`, `envFilePath`, `load`,
  `ignoreEnvFile`, `validationSchema`, `validationOptions`, `validate`,
  `validatePredefined`, `skipProcessEnv`), first-definition-wins `envFilePath` ordering,
  `registerAs` + `ConfigType` + `.KEY`, and `ConfigService<Env, true>` with
  `{ infer: true }` — from `content/nestjs/configuration.md`.
- The v12 CLI flags (`--rspackPath`, `--emit-declarations`, `--no-type-check`,
  `--silent`, `--parallel [concurrency]`), `nest-cli.json`'s `includeLibraryAssets`, and
  the ESM/oxlint/Vitest generation defaults — from
  `content/nestjs/installation-and-cli.md` and CONTRIBUTING §11.4.
- The five required ESM changes and the `require(esm)` / `nest upgrade` behaviour — from
  `content/nestjs/esm-vs-commonjs.md` and CONTRIBUTING §11.4.

## Cross-links to pages that do not exist yet

`scripts/check.mjs` resolves `.md` links against `nav.mjs`, not against the filesystem, so
links to registered-but-unwritten pages resolve. These eleven pages link to several such
pages, all registered in `nav.mjs`: `nestjs-libraries/logging.md`,
`nestjs-libraries/observe.md`, `nestjs-advanced/fastify-adapter.md`,
`nestjs-advanced/monorepo-and-libraries.md`, the `nestjs-testing/*` pages, several
`nestjs-security/*` pages, `express-vs-nestjs/how-nest-uses-express.md` and the
`nestjs-reference/*` pages.

**No `#anchor` links to other pages were used anywhere in this section**, because
`check.mjs` resolves anchors against the target page's rendered headings and an unwritten
page has none.
