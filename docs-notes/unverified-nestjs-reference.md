# Unverified / deliberately omitted — `content/express-vs-nestjs/` and `content/nestjs-reference/`

Author pass: **Express vs NestJS (4 pages)** and **NestJS Migration and Reference (6 pages)**,
2026-09-11.

Facts used on these pages came from `CONTRIBUTING.md` §11–§13 and, wherever a signature or a
literal string mattered, were re-read directly from the published packages. Each of the
following was unpacked from the npm registry with `npm pack` during this pass and read on disk:

`@nestjs/common@12.0.1`, `@nestjs/core@12.0.1`, `@nestjs/platform-express@12.0.1`,
`@nestjs/testing@12.0.1`, `@nestjs/microservices@12.0.1`, `@nestjs/websockets@12.0.1`,
`@nestjs/swagger@12.0.1`, `@nestjs/config@12.0.0`, `@nestjs/cli@12.0.0`,
`@nestjs/schematics@12.0.0`, `@nestjs/graphql@14.0.0`, `@nestjs/apollo@14.0.0`,
`@nestjs/observe@0.1.8`.

Per the "never invent" rule, everything in the **Omitted** section below was left out of the
published pages.

---

## Re-verified during this pass (safe to rely on; do not redo)

| Claim | Source read |
| --- | --- |
| `@nestjs/platform-express@12.0.1` dependencies are exactly `cors 2.8.6`, `express 5.2.1`, `multer 2.2.0`, `path-to-regexp 8.4.2`, `tslib 2.8.1` | its own `package.json` |
| `ExpressAdapter`'s constructor is `constructor(instance?: any)` — so `new ExpressAdapter(existingExpressApp)` is a supported mount point | `platform-express/adapters/express-adapter.d.ts` |
| `AbstractHttpAdapter.getInstance<T = any>(): T`; the `HttpServer` interface declares the non-generic `getInstance(): ServerInstance`, and `NestExpressApplication.getHttpAdapter()` is typed `HttpServer<…, Express>` so no type argument is needed | `core/adapters/http-adapter.d.ts`, `common/interfaces/http/http-server.interface.d.ts`, `platform-express/interfaces/nest-express-application.interface.d.ts` |
| `NestApplication.init()` calls `registerParserMiddleware()`, `registerRouter()`, then `registerRouterHooks()` — which registers **both** the not-found handler and the exception handler | `core/nest-application.js` |
| `ExpressAdapter.setNotFoundHandler(handler, prefix)` mounts a prefix-scoped `express.Router()` using `router.all('*path', handler)` when a prefix exists, and otherwise mounts a stack-tail handler that **skips** paths belonging to another app's registered prefix. This is what makes `setGlobalPrefix()` the difference between "Nest swallows every unmatched request" and "unmatched requests fall through to the rest of the Express stack" | `platform-express/adapters/express-adapter.js` |
| Nest registers `express.json()` and **`express.urlencoded({ extended: true })`** by default, unless the app is created with `{ bodyParser: false }`. Nest therefore differs from bare Express 5, whose `urlencoded` default is `extended: false`. The **query** parser is untouched and stays on Express 5's `'simple'` | `platform-express/adapters/express-adapter.js`, `registerParserMiddleware()` |
| `NestExpressApplication` methods: `set`, `engine`, `enable`, `disable`, `useStaticAssets`, `useBodyParser`, `setBaseViewsDir`, `setViewEngine`, `setLocal`, `enableCors`, `getHttpAdapter`, `listen` | `platform-express/interfaces/nest-express-application.interface.d.ts` |
| `ResponseDecoratorOptions` is `{ passthrough: boolean }`, so `@Res({ passthrough: true })` is the documented way to keep Nest's response pipeline | `common/decorators/http/route-params.decorator.d.ts` |
| `ParameterDecoratorOptions` is `{ schema?: StandardSchemaV1; pipes?: … }`, accepted by `@Body`, `@Query`, `@Param`, `@RawBody`, `@Payload` and `@MessageBody` | same file, plus `microservices/decorators/payload.decorator.d.ts`, `websockets/decorators/message-body.decorator.d.ts` |
| Route decorators exported by `@nestjs/common`: `Get Post Put Patch Delete Head Options All Search QueryMethod Propfind Proppatch Mkcol Copy Move Lock Unlock` plus the `RequestMapping` factory. All take `path?: string \| string[]`; **no `RegExp` overload exists** | `common/decorators/http/request-mapping.decorator.d.ts` |
| `@SseSignal()` and the `SSE_ABORT_CONTROLLER` symbol are real exports; the signal aborts when the client disconnects, the `Observable` completes, or it errors | `common/decorators/http/sse-signal.decorator.d.ts` |
| `HttpException.createBody` has a 4-argument overload `(message, error, statusCode, errorCode?)`, and the implementation copies `errorCode` into the body **only when truthy** | `common/exceptions/http.exception.d.ts` + `.js` |
| `BadRequestException` calls `createBody(objectOrError, description, HttpStatus.BAD_REQUEST)` — three arguments, so `errorCode` is never in the body | `common/exceptions/bad-request.exception.js` |
| The string `errorCode` does not occur **anywhere** in `@nestjs/core@12.0.1` — confirmed by a full-package grep. `BaseExceptionFilter.catch()` writes `exception.getResponse()` verbatim | `core/exceptions/base-exception-filter.js` |
| `ConsoleLoggerOptions.structuredParams` defaults to `true`; `flattenParams` defaults to `false` and requires `structuredParams` | `common/services/console-logger.service.d.ts` |
| `StandardSchemaValidationPipeOptions` = `{ transform?, validateCustomDecorators?, validateOptions?, errorHttpStatusCode?, exceptionFactory? }` with defaults `true` / `false` / — / `BAD_REQUEST` / — | `common/pipes/standard-schema-validation.pipe.d.ts` |
| `StandardSchemaSerializerInterceptor(reflector, defaultOptions?)`; both its options and `@SerializeOptions()` take `{ schema?, validateOptions? }` | `common/serializer/standard-schema-serializer.interceptor.d.ts`, `.../standard-schema-serializer.interfaces.d.ts` |
| `ValidationPipeOptions.errorFormat: 'list' \| 'grouped'` exists; `'grouped'` changes `message` from `string[]` to `Record<string, string[]>` | `common/pipes/validation.pipe.d.ts` |
| `@nestjs/config@12.0.0` `validationSchema?: StandardSchemaV1`; Joi settings nest under `validationOptions.libraryOptions`, and the package pre-seeds `{ abortEarly: false, allowUnknown: true }` for Joi vendors only | `config/dist/interfaces/config-module-options.interface.d.ts`, `config/dist/utils/validate-with-schema.util.js` |
| `NatsRequestJSONDeserializer.deserialize(value)` calls `value.json()` — confirming that v12 deserializers receive the NATS **message object** | `microservices/deserializers/nats-request-json.deserializer.js` |
| `ApolloDriverConfig.graphiql?: boolean \| GraphiQLOptions`; `playground` is retained as a **deprecated alias**; the driver resolves `options.graphiql ?? options.playground ?? process.env.NODE_ENV !== 'production'` | `apollo/dist/interfaces/apollo-driver-config.interface.d.ts`, `apollo/dist/drivers/apollo-base.driver.js` |
| `SubscriptionConfig` declares a `'graphql-ws'` key and imports `ServerOptions` from `graphql-ws` | `graphql/dist/services/gql-subscription.service.d.ts` |
| `nest build` / `nest start` flags: `--rspackPath [path]`, `--emit-declarations`, `--type-check` / `--no-type-check`, `--silent`, `--tsc`, `--webpack`, `--webpackPath [path]`, `--watchAssets`, `--preserveWatchOutput`; `--parallel [concurrency]` and `--all` on `build` only | `cli/commands/build.command.js`, `cli/commands/start.command.js` |
| `nest upgrade` options: `-d/--dry-run`, `-s/--skip-install`, `--observe` / `--no-observe`, `-t/--tag [tag]`, `-c/--collection [name]`; alias `update` | `cli/commands/upgrade.command.js` |
| `nest deploy` exists, uses `allowUnknownOption()` / `allowExcessArguments()`, and passes every argument through | `cli/commands/deploy.command.js` |
| `compilerOptions.includeLibraryAssets?: string[]` — an array of library project names, **not** a boolean | `cli/lib/configuration/configuration.d.ts`, `cli/lib/compiler/assets-manager.js` |
| `nest new` prompts for the module system and the schema's **default is `"esm"`**; the ESM template ships `"type": "module"`, a `nodenext` tsconfig with `resolvePackageJsonExports: true`, Vitest scripts and `oxlint` | `schematics/dist/lib/application/schema.json`, `.../files/ts-esm/package.json`, `.../files/ts-esm/tsconfig.json` |
| Exact bootstrap error strings — `UNKNOWN_DEPENDENCIES_MESSAGE`, `UNDEFINED_FORWARDREF_MESSAGE`, `UNDEFINED_MODULE_MESSAGE`, `UNKNOWN_EXPORT_MESSAGE`, `INVALID_CLASS_SCOPE_MESSAGE`, `UNKNOWN_REQUEST_MAPPING`, `INVALID_MIDDLEWARE_MESSAGE`, `ROUTE_CONFLICT_MESSAGE`, `DUPLICATE_ROUTE_MESSAGE`, `SHADOWED_ROUTE_MESSAGE` — quoted verbatim on the troubleshooting page | `core/errors/messages.js` |
| v12's `UNKNOWN_DEPENDENCIES_MESSAGE` has a **second branch** for the `import type` case: when the dependency at the failing index is `undefined` / `Object`, it prints "The dependency at index [N] appears to be undefined at runtime" and names `import type` explicitly | `core/errors/messages.js` |
| `@nestjs/observe@0.1.8` declares `engines.node: ">= 20.19.0"` and one runtime dependency (`@jridgewell/trace-mapping`) | its `package.json` |

This resolves two items previously marked open in `docs-notes/unverified-nestjs-fundamentals.md`:
the literal text of the route-conflict diagnostics **is** now confirmed (see `ROUTE_CONFLICT_MESSAGE`,
`DUPLICATE_ROUTE_MESSAGE`, `SHADOWED_ROUTE_MESSAGE` above).

---

## Omitted entirely

| Topic | Why it was omitted |
| --- | --- |
| **`Cannot determine a type for … (Object)`** as an error string | The brief named it as the missing-`emitDecoratorMetadata` symptom. A full-package grep of `@nestjs/core@12.0.1` and `@nestjs/common@12.0.1` finds **no such string**. What those packages actually print is `UNKNOWN_DEPENDENCIES_MESSAGE` with `Object` (or nothing) in the dependency list, plus the v12 `import type` hint. A message beginning `Cannot determine a GraphQL output type for the "…"` exists but lives in `@nestjs/graphql` and means a missing `@ObjectType()`. `troubleshooting.md` documents the real strings and states this discrepancy in a `:::note` rather than repeating the unverified one. |
| **Any number for Nest's bootstrap or per-request overhead** | `comparison.md` and `when-plain-express-is-better.md` both argue that Nest costs bootstrap time and per-request pipeline work, and both say "milliseconds, not seconds" without a figure. No benchmark was run during this pass. A measured number belongs in `nestjs-production/performance.md`. |
| **The endpoint-count crossover ("about ten endpoints")** | Stated as a heuristic in prose, explicitly hedged as "for most teams". It is judgement, not a measured threshold, and is labelled that way on the page. |
| **`nest deploy`'s hosting semantics** | The command delegates entirely (`allowUnknownOption()`, usage `[mau-options]`), and the ESM project template carries `@nestjs/mau@^0.2.6` as a devDependency. The authentication flow, the target platform's behaviour and the full option list were **not** verified, so no options, no provider name and no worked example are documented — only that the command exists and passes arguments through. |
| **`@nestjs/observe` configuration** | `v11-to-v12-migration.md` names the package, its version (0.1.8), its pre-1.0 status, the `instrument` application option it hooks into, and the CLI's `--observe` / `--no-observe` flags. Its module options, exported services and metric surface were not read closely enough to show a configuration, so none is shown. |
| **Whether route-conflict detection covers microservice message patterns** | `RouteConflictDetector` operates on HTTP-shaped `ResolvedRoute[]` (`method` / `host` / `version`). Whether `@MessagePattern()` participates was not confirmed; both pages describe the feature as HTTP-only by saying nothing about transports. |
| **The list of migration schematics `nest upgrade` applies for 11 → 12** | The command's options were read; the schematics collection's per-version migration list was not. The page says what `nest upgrade` does in general terms (bumps `@nestjs/*` ranges, applies the version's migrations, preserves module format) and then enumerates the manual work separately. |
| **The default concurrency of `nest build --parallel`** | The flag takes an optional `[concurrency]`. What it defaults to when omitted was not verified, so no default is stated. |
| **Whether `structuredParams` affects a custom `LoggerService`** | It is an option on `ConsoleLoggerOptions`, so the pages attribute the behaviour to `ConsoleLogger` specifically. Whether `nestjs-pino` or another custom logger is affected is not claimed either way. |
| **The exact Node patch versions in the CLI floor (`v22.22.3+`, `v24.15+`)** | Taken from `CONTRIBUTING.md` §11.2 as given. The `engines` fields were re-read and confirm the *shape* of the constraint (`@nestjs/core` `>= 20`, `@nestjs/cli` `>= 20.11`, `@nestjs/schematics` `>=22.12.0`) but not those specific patch numbers, which come from the devkit's own transitive constraints. |
| **`@nestjs/schedule` coordination primitives** | `troubleshooting.md` states that the scheduler is in-process and fires once per replica, and recommends a single-replica deployment, a Redis lock, or BullMQ repeatable jobs. No `@nestjs/schedule` API for distributed locking is named, because none was found. The Redis recipe is given only as the generic `SET key value NX PX ttl`. |
| **A concrete `ContextIdStrategy` for durable providers** | Named as option 3 for the request-scope entry, with a pointer to `nestjs/injection-scopes.md`, which owns the worked example. No new code is shown here. |
| **`@nestjs/mau` itself** | Seen in the generated ESM template's devDependencies at `^0.2.6`. Not documented, not named on any page, because nothing about it was verified beyond its presence. |
| **Fastify-adapter parity details** | `how-nest-uses-express.md` says controllers survive a platform swap and bootstrap code does not, and lists the categories that break. It does not enumerate Fastify-specific replacements; `nestjs-advanced/fastify-adapter.md` owns that. |

---

## Stated with moderate confidence — worth a second check

These **are** in the published pages.

| Claim | Page |
| --- | --- |
| Mounting Nest on an existing Express app without a global prefix makes Nest's not-found handler swallow every route registered on the server *after* `app.init()`. Derived from reading `setNotFoundHandler()` plus Express's registration-order matching, not from running it. | `express-vs-nestjs/migrating-incrementally.md` |
| `app.init()` (rather than `app.listen()`) is the right call when the host application owns the HTTP server. Consistent with `init()` performing every registration step and `listen()` being the thing that binds, but not exercised end to end here. | `express-vs-nestjs/migrating-incrementally.md` |
| Reading `req.session` through `@Session()` works for Nest controllers when `express-session` is mounted on the shared Express instance. Follows from `@Session()` being `req.session` and both halves sharing one app object. | `express-vs-nestjs/migrating-incrementally.md` |
| A shell-form Docker `CMD` prevents `SIGTERM` from reaching Node, so shutdown hooks never fire. General container behaviour, cross-linked to `nestjs-production/docker.md` rather than demonstrated. | `nestjs-reference/troubleshooting.md` |
| `ValidationPipe` skips parameters whose metatype is not a validatable class, which is why a primitive- or `any`-typed parameter is silently unvalidated. Consistent with `toValidate()`'s documented role; the exact metatype list was not re-read. | `nestjs-reference/troubleshooting.md` |
| Every `@ApiXxxResponse` shorthand in the OpenAPI table exists. The full export list was read and is ~50 entries; the page names the common ones and says "one exists for essentially every HTTP status" rather than reproducing all of them. | `nestjs-reference/decorator-reference.md` |
