# Unverified / deliberately omitted — `content/nestjs/`

Author pass: NestJS Fundamentals, pages 4–12, 2026-09-11.

Facts used on these pages were taken from `CONTRIBUTING.md` §11–§13 and, where a
signature mattered, re-read directly from the published type declarations in
`@nestjs/common@12.0.1`, `@nestjs/core@12.0.1`, `@nestjs/config@12.0.0` and
`@nestjs/platform-express@12.0.1` (each unpacked with `npm pack` during this pass).

Per the "never invent" rule, everything below was **left out of the published
pages**. Each is a candidate for a follow-up fact-check.

---

## Re-verified during this pass (now safe to rely on)

These were read from the shipped `.d.ts` files rather than from memory, so they
are *not* open questions — recorded here so the next author does not repeat the work.

| Claim | Source |
| --- | --- |
| `routeConflictPolicy` / `routeResolutionStrategy` live on `NestApplicationOptions`, i.e. the second argument to `NestFactory.create()` | `common/interfaces/nest-application-options.interface.d.ts` |
| `RouteConflictPolicyLevel = 'off' \| 'warn' \| 'error'`; `RouteResolutionStrategy = 'declaration' \| 'specificity'` | `common/interfaces/router-options.interface.d.ts` |
| With `'specificity'` active, Nest drops shadow conflicts the sort already resolved | `core/router/route-conflict-detector.d.ts`, `filterSortResolvedShadows` |
| Route decorators accept `string \| string[]` and have **no** `RegExp` overload | `common/decorators/http/request-mapping.decorator.d.ts` |
| `@nestjs/config` `validationSchema?: StandardSchemaV1`; `validationOptions?: StandardSchemaV1.Options` | `config/dist/interfaces/config-module-options.interface.d.ts` |
| Joi settings nest under `validationOptions.libraryOptions`; the package also defaults Joi schemas to `abortEarly: false`, `allowUnknown: true` | `config/dist/utils/validate-with-schema.util.js` |
| `HostComponentInfo.isTreeDurable` is the flag a `ContextIdStrategy` resolver branches on | `core/injector/instance-wrapper.d.ts` |
| `durable` is declared on `ScopeOptions`, `ClassProvider` and `FactoryProvider`, and is documented as usable **only** with `scope: Scope.REQUEST` | `common/interfaces/scope-options.interface.d.ts`, `.../provider.interface.d.ts` |
| `REQUEST` and `INQUIRER` are string constants exported from `@nestjs/core` | `core/router/request/request-constants.d.ts`, `core/injector/inquirer/inquirer-constants.d.ts` |
| `errorCode` is a field on both `HttpExceptionOptions` and `HttpException` | `common/exceptions/http.exception.d.ts` |
| `RouteTree` supports nested `children` | `core/router/interfaces/routes.interface.d.ts` |
| `setGlobalPrefix(prefix, { exclude })` takes `string \| RouteInfo` entries | `common/interfaces/global-prefix-options.interface.d.ts` |

---

## Omitted entirely

| Topic | Why it was omitted |
| --- | --- |
| **Any number for the cost of `Scope.REQUEST`** | `injection-scopes.md` describes the *mechanism* (per-request construction of the whole chain above the scoped provider) and says the framework documents it as having a performance impact, but states no percentage, no requests-per-second figure and no allocation count. No benchmark was run during this pass, and a made-up number would be worse than none. A measured figure belongs in `nestjs-production/performance.md`. |
| **The exact log line format of the route-conflict diagnostics** | `RouteConflictDetector.handle()` is documented as logging once per conflict at `'warn'` and aggregating `'error'`-level conflicts into a single `RouteConflictException`, which is what the page says. The literal text of the message, and whether the exception lists every conflict in one string, were not confirmed, so no sample output is shown. |
| **Whether route-conflict detection applies to non-HTTP handlers** | `RouteConflictDetector.detect()` takes `ResolvedRoute[]` with `method`/`host`/`version`, which is HTTP-shaped. Whether microservice message patterns participate was not confirmed; `routing-and-path-syntax.md` describes the feature as HTTP-only by saying nothing about transports. |
| **`ConfigService.changes$`** | A real `Observable<ConfigChangeEvent>` getter on `ConfigService` in 12.0.0, but what emits into it — and whether anything in the shipped package ever does outside an explicit `set()` — was not confirmed. `configuration.md` does not mention it. |
| **The `parser` option on `ConfigModuleOptions`** | Present in the type (`parser?: Parser`), but the `Parser` signature and the intended use (custom `.env` formats?) were not confirmed well enough to give an example. Omitted. |
| **`ignoreEnvVars`** | Present but marked `@deprecated` in favor of `validatePredefined`. Deliberately not documented, to avoid teaching a deprecated option; `validatePredefined` is documented instead. |
| **`skipProcessEnv` interaction with `cache`** | Both options are documented individually in `configuration.md`. Whether caching is skipped, partial or unaffected when `skipProcessEnv: true` was not confirmed, so no claim is made. |
| **Durable providers under microservice transports** | `injection-scopes.md` shows the HTTP `ContextIdStrategy` only. Whether `attach(contextId, request)` receives a comparable object for every transport was not confirmed, and the page notes the `REQUEST` token differs there rather than claiming how durability behaves. |
| **Precise ordering rules for the Nest 12 lifecycle-hook change** | `CONTRIBUTING.md` §11.4 states hooks now run by component hierarchy level. The *algorithm* — how levels are computed, and what happens between siblings at the same level — was not confirmed, so `modules.md` warns that the order changed and points at the migration page rather than describing a new guarantee. |
| **Whether `nest start`'s boot route log includes the host and version** | `controllers.md` says the CLI logs mapped routes at boot (standard `RoutesResolver` behavior) but shows no sample output and claims nothing about its columns. |
| **`ModuleRef.introspect()` return shape** | `IntrospectionResult` is exported, but its fields were not read. `dependency-injection.md` names `get`, `resolve` and `create` only. |
| **`@nestjs/devtools-integration` setup** | `injection-scopes.md` names the package and its version (12.0.0, from §11.1) as a way to view the resolved graph, but shows no configuration, because the module's options were not verified. It belongs in a Libraries or Production page with a real configuration. |

---

## Stated with moderate confidence — worth a second check

These **are** in the published pages.

| Claim | Page |
| --- | --- |
| A guard returning `false` produces **403** specifically (rather than a configurable default) | `request-lifecycle.md` |
| An exception thrown *inside* an exception filter is not caught by another filter and falls through to the platform default | `request-lifecycle.md` |
| Global enhancers do not run for a request that matched no route, so a global interceptor never sees a 404 while middleware does | `request-lifecycle.md` |
| Filter selection is narrowest-first (method → controller → global) | `request-lifecycle.md` |
| `envFilePath` resolves "first file that defines a key wins" | `configuration.md` |
| `@nestjs/config` reads `.env` through `dotenv` 17.4.2, so `dotenv`'s own precedence rules apply to `override` | `configuration.md` (stated only as the `override` option's documented default of `false`) |
