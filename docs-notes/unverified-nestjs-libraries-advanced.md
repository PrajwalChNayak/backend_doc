# Unverified / omitted — `nestjs-libraries/logging`, `nestjs-libraries/observe`, `nestjs-advanced/fastify-adapter`, `nestjs-advanced/monorepo-and-libraries`

Author pass: 2026-09-11. Every fact on these four pages was verified by unpacking the
published tarball (`npm pack <pkg>@<version>`) and reading the shipped `.d.ts` and `.js`
files, or by `npm view <pkg> version` against the live registry. This file records what
was checked, what was deliberately left out, and one correction that affects a page
outside this pass.

## Packages unpacked and read for this pass

| Package | Version | Read for |
| --- | --- | --- |
| `@nestjs/common` | 12.0.1 | `ConsoleLoggerOptions`, `ConsoleLogger`, `Logger`, `LoggerService`, `LOG_LEVELS`, `isLogLevelEnabled`, `NestApplicationContextOptions` |
| `@nestjs/core` | 12.0.1 | `LegacyRouteConverter` |
| `@nestjs/observe` | 0.1.8 | whole public surface |
| `nestjs-pino` | 5.1.0 | `Params`, `LoggerModule`, `PinoLogger`, `Logger`, `NativeLogger`, `nativeLoggerOptions`, `InjectPinoLogger` |
| `@nestjs/platform-fastify` | 12.0.1 | `FastifyAdapter`, `NestFastifyApplication`, the three route decorators, the vendored middie |
| `@nestjs/cli` | 12.0.0 | `Configuration`, `CompilerOptions`, `ProjectConfiguration`, `AssetsManager`, `build`/`start`/`generate` command flags |
| `@nestjs/schematics` | 12.0.0 | `library` and `sub-app` factories and their file templates |
| `find-my-way` | 9.9.0 | supported path formats and match order |

Registry version checks on 2026-09-11: `@fastify/multipart` 10.1.1, `@fastify/static`
10.1.3, `@fastify/helmet` 13.1.1, `@fastify/cookie` 11.1.2, `@fastify/rate-limit`
11.2.0, `@fastify/compress` 9.2.0.

---

## Correction that affects a page outside this pass

**`compilerOptions.includeLibraryAssets` is `string[]`, not `boolean`.**

`content/nestjs/installation-and-cli.md` currently shows:

```json
{ "compilerOptions": { "includeLibraryAssets": true } }
```

Verified against `@nestjs/cli@12.0.0`:

- `lib/configuration/configuration.d.ts` declares
  `includeLibraryAssets?: string[]` with the comment *"List of library project names
  whose assets should also be copied when building this application."*
- `lib/compiler/assets-manager.js` reads it with
  `getValueOrDefault(configuration, 'compilerOptions.includeLibraryAssets', appName) || []`
  and iterates it, so it is resolved **per application**.
- `actions/build.action.js` iterates the same value as a list of library names when
  deciding whether to print the "assets will not be copied" warning.

`true` would be iterated as a non-array and contribute nothing. The new
`monorepo-and-libraries.md` page documents the array form.
`installation-and-cli.md` was not touched by this pass and still needs the fix.

---

## `@nestjs/observe` 0.1.8 — verified, and the gaps left out

Verified and documented:

- `createObserveModule(options?: CreateObserveModuleOptions)` returns
  `{ ObserveModule, ObserveInstrument }`; `ObserveInstrument` is typed exactly
  `NestApplicationOptions['instrument']`.
- `instrument` on `NestApplicationContextOptions` (from `@nestjs/common@12.0.1`) is
  `{ instanceDecorator: (instance: unknown) => unknown }` and nothing else.
- `ObserveModule.forRoot()` registers with `global: true`; `forRootAsync()` uses
  `options.global ?? true` and supports `imports`, `useFactory`/`useClass`/`useExisting`,
  `inject`, `extraProviders`.
- The module's `exports` are `AsyncLocalStorage` and `TracerService`.
- `TracerService` members: `createSpan`, `activeSpan`, `captureError`, `counter`,
  `gauge`, `summary`, `currentTraceId`, `setAttribute`, `getAttribute`.
- `TraceSpanDelegate`: `id`, `name`, `setTag`, `addTags`.
- `Counter` / `Gauge` / `Summary` method sets; `MAX_SERIES_PER_METRIC = 1000`.
- Every `ObserveOptions` and `CreateObserveModuleOptions` field and default quoted on
  the page comes from the interface's own JSDoc `@default` tags.

Deliberately omitted:

- **No decorators exist.** `dist/index.d.ts` re-exports `custom-metrics`,
  `createInstanceDecorator` (a factory the module calls internally, not an applicable
  decorator), the interfaces, `observe.constants`, `observe.module`, `services` (which
  is only `TracerService`), `trace-span.delegate` and two type helpers. No `@Trace()`,
  `@Span()` or `@Metric()`. The page says so explicitly rather than staying silent.
- **`profiling` is not an option.** The JSDoc block describing continuous profiling is
  present in `observe-options.interface.d.ts` and says *"SHELVED - setting this
  currently does nothing"*, but **no `profiling` field is declared on the interface** —
  the comment sits orphaned above `tracesSampleRate`. The page states that profiling is
  shelved and that there is no option to set; no example uses one.
- **Pricing, plans, retention and dashboard features.** The README names a free
  allowance; that is service marketing, not package behaviour, and it can change
  without a release. Not documented, consistent with `unverified-nestjs-libraries.md`.
- **Self-hosting the collector.** `endpoint` is a free-form string with a documented
  default and an `OBSERVE_ENDPOINT` environment override. The ingest wire contract
  (`dist/agent/telemetry-wire-contract.js`) is internal and unversioned, so the page
  says the option exists and explicitly refuses to imply that an OTLP collector works.
- **`TracerService`'s `Store` / `TraceKey` generics.** `setAttribute` and `getAttribute`
  are typed through `Path<Store>` / `PathValue<Store, P>` helpers over a store type
  parameter that the DI container cannot infer. The page names the methods and their
  purpose but shows no generic instantiation, because the supported way to supply that
  type argument is not documented anywhere in the package.
- **Agent internals.** `ObserveAgentSharedBuffer`, the detached worker entry point, the
  encoders and `profiling/*` are not exported from the package root. Only the fact that
  submission happens on a detached worker thread is stated, which the README says.
- **A typo in a public signature.** `tracesSampleRate`'s function form is declared
  `(protocal: 'http' | 'rpc' | 'grpc' | 'graphql', attributes: any) => boolean` — the
  parameter name is misspelled in the shipped types. Parameter names are not part of
  the call contract, so the page writes `protocol`; recorded here in case it is renamed.

---

## `nestjs-pino` 5.1.0 — checked, partially documented

- Peers verified: `@nestjs/common` and `@nestjs/core` `^11.0.8 || ^12.0.0`,
  `pino ^10.0.0`, `pino-http ^11.0.0`, `rxjs ^7.1.0`; `engines.node >=22.12.0`.
- `Params` fields all read from `dist/params.d.ts`: `pinoHttp`, `exclude`, `forRoutes`,
  `useExisting`, `renameContext`, `assignResponse`, `nativeLogger`.
- `NativeLogger` and `nativeLoggerOptions` are named on the page as the migration path
  for anything parsing `ConsoleLogger`'s JSON shape, but their field-by-field output is
  **not** documented — the preset's contents are a `pino-http` `Options` object built in
  `dist/presets.js` and are not part of a documented contract.
- `useExisting: true` (reuse a logger already configured on the Fastify adapter) is not
  documented: it is Fastify-adapter-specific and the package's own README points at its
  FAQ for the trade-offs rather than stating them.
- `PinoLogger.runInContext(fn, { bindings, inherit })` is mentioned for non-HTTP work.
  The `inherit` flag is not explained in detail; its JSDoc is clear but there is no
  worked example in the package to base one on.

## `ConsoleLogger` — what was left out

- `printMessages`, `printAsJson`, `getJsonLogObject`, `formatMessage`,
  `stringifyParams` and `getTimestamp` are `protected`, i.e. subclass extension points
  rather than API. The page shows overriding `error()` only, which is public.
- The `util.inspect` pass-through options (`depth`, `maxArrayLength`, `maxStringLength`,
  `sorted`, `compact`, `breakLength`, `showHidden`) are listed in the options table but
  not demonstrated; their behaviour is `util.inspect`'s, not Nest's, and several are
  documented in the types as ignored once the output is parseable JSON.

## `@nestjs/platform-fastify` 12.0.1 — one thing described in prose rather than code

**The Fastify catch-all route form is not written in a code fence on the page.**

Verified from the source: `FastifyAdapter`'s verb methods pass `args[0]` straight to
`fastify.route({ url })`, and `LegacyRouteConverter.tryConvert` is called **only** in
`createMiddlewareFactory` — so route paths use `find-my-way` 9.9.0's grammar, while
middleware paths use `path-to-regexp` 8. `find-my-way`'s documented formats include a
bare star wildcard, a trailing optional parameter, `:file.:ext` pairs and parenthesised
regular expressions — all of which are invalid under path-to-regexp 8.

`scripts/check.mjs` fails the build on those literal forms inside any `@Get(...)`-style
decorator, on every line, with no prose exemption and no exemption inside a `:::warning`
callout. Writing the correct Fastify catch-all would therefore fail the build, and
wrapping it in `:::legacy` would be a lie about a currently valid API. The page
documents the difference in a comparison table and in prose, names `find-my-way` 9.9.0
as the authority, and shows no wildcard route example. **If this page should carry a
literal example, `BAD_NEST_ROUTE_PATTERNS` in `scripts/check.mjs` needs a
per-page or per-adapter exemption first.**

Other Fastify items checked and deliberately not documented:

- **`FastifyAdapter`'s full method surface.** `setOnRequestHook`, `setOnResponseHook`,
  `useBodyParser`, `useStaticAssets`, `setViewEngine`, `enableCors`, `register`,
  `inject`, `isParserRegistered` are documented. `applyVersionFilter`,
  `registerParserMiddleware`, `createMiddlewareFactory`, `mapException`,
  `registerWithPrefix`, `isNativeResponse` and `injectRouteOptions` are adapter
  internals called by `@nestjs/core` and are not presented as API.
- **`@fastify/view` engine wiring.** `setViewEngine()` takes `FastifyViewOptions`, whose
  `engine` key is the template library itself. No specific template engine is named or
  version-pinned, because none is verified in this pass.
- **HTTP/2 and HTTPS option shapes.** `FastifyHttp2Options`,
  `FastifyHttp2SecureOptions` and `FastifyHttpsOptions` are named as existing on the
  constructor; their fields are Node's `http2`/`https` server options and are not
  reproduced.

## `@nestjs/cli` 12.0.0 / `@nestjs/schematics` 12.0.0 — checked

Verified from the schematic factories, not from docs:

- `nest g library` defaults the prefix to `@app`, overridable with a
  `defaultLibraryPrefix` key read directly out of `nest-cli.json` by
  `library.factory.js`. **That key is not declared on the CLI's own `Configuration`
  interface** — it is read with a raw `JSON.parse` lookup. The page describes it as a
  key the library schematic reads, which is exactly what is true.
- `nest g library` sets `compilerOptions.builder` to `'rspack'` when it is undefined;
  `nest g app` sets it unconditionally while converting a standard-mode workspace.
- Both factories `delete tsconfig.compilerOptions.baseUrl`. `nest g app` additionally
  deletes `include`/`exclude` and adds `files: []` plus a `references` array.
- Generated `tsconfig.lib.json` / `tsconfig.app.json` carry `composite: true`,
  `declaration: true`, `rootDir: './src'` and `outDir: '../../dist/{libs,apps}/<name>'`.
- `nest build [apps...]` accepts several project names; `--all` and
  `--parallel [concurrency]` are separate flags and `--parallel`'s own help text says
  "(with --all)".
- `--emit-declarations`, `--type-check` / `--no-type-check` help text says "when SWC is
  used"; the page does not claim they apply to every builder.

Deliberately omitted:

- **A named runtime path resolver.** The page states the mechanism — `tsc` emits the
  alias verbatim and Node cannot resolve it, which is why the v12 schematics default to
  a bundler — and points at Node's own `imports` field as the built-in alternative. No
  third-party path-resolution package is recommended, because none was version-verified
  in this pass.
- **`Builder` object forms.** `builder` accepts `'tsc' | 'swc' | 'webpack' | 'rspack'`
  or an object with `type` and builder-specific `options` (`swcrcPath`, `configPath`,
  and so on). Only the string form is shown; the object form's per-builder options are
  build tooling internals.
- **`exec`, `allowOutsidePaths`, `manualRestart`, `generateOptions`.** Real
  `nest-cli.json` keys, read from the `Configuration` interface, with no verified
  behaviour worth a paragraph here.
