# Unverified / deliberately omitted — NestJS Security, pages 9–15

Covers the seven pages written in this pass:
`authentication-and-session-security`, `jwt-pitfalls`, `csrf`,
`file-upload-security`, `secrets-and-config`, `dependency-auditing`,
`safe-logging`.

Everything below was **left out of the pages** because it could not be verified
from a primary source in this session. Nothing here is asserted in the content.

---

## Left out — could not verify

| Claim | Why it is not in the page |
| --- | --- |
| Chrome's "Lax + POST" two-minute grace period, which sends a `SameSite`-unset cookie on a top-level cross-site POST for cookies created within the last two minutes | Real Chromium behaviour as far as I know, but no primary source was reachable to confirm the window or which browsers implement it. `csrf.md` instead says only that browser defaults are a policy you do not control and that `SameSite` must be set explicitly. |
| Specific CVE identifiers for `multer@1.x` | The npm deprecation notice says "a number of vulnerabilities" and names none. The page quotes the notice verbatim and names no CVE. |
| A named shared-storage package for `@nestjs/throttler` 6.5.0 (a Redis storage adapter) | The 6.5.0 type surface exposes `ThrottlerStorage` and `storage` on `ThrottlerModuleOptions`, which is verified, but no community storage package's current name and version was checked. `authentication-and-session-security.md` says "the `@nestjs/throttler` storage abstraction with a shared backend" without naming one, and links to `nestjs-security/rate-limiting.md`, which covers storage. |
| The current version of `@prometheus-io/client` | Named as the replacement for the deprecated `prom-client` (its own npm notice says so), but no version is stated. |
| `gitleaks` / `trufflehog` versions and their full flag sets | Only `gitleaks protect --staged --redact --no-banner` and `gitleaks detect` appear, and no version is claimed. |
| GitHub Actions step versions (`actions/checkout@v4`, `actions/setup-node@v4`) | Used in the CI example. Widely current but not verified against the marketplace this session. |
| `secrets-exec` in the `secrets-and-config.md` Dockerfile `ENTRYPOINT` | Deliberately a placeholder name for a vendor-specific wrapper (Vault Agent, `aws-vault`, `berglas`, …). The page describes the *pattern* (fetch, put in the environment, `exec` node so PID 1 stays node) and names no tool. |
| A leading top-level wildcard redact path such as `*.password` in pino | pino's documented path forms are `a.b.c`, `a["b-c"].d`, `["a-b"].c`, `a.b.*` and `a[*].b`. Only those forms are used in `safe-logging.md`, and the page states explicitly that a bare `password` matches the top level only. |
| Postgres producing `Key (email)=(…) already exists` at a particular `DETAIL`/verbosity setting | `safe-logging.md` warns that an error *message* can itself be the leak and gives the two message shapes, but does not claim which server setting produces which. |

---

## Version drift observed during this pass (for the coordinator)

The registry moved after the CONTRIBUTING §11.1 verification pass of 2026-09-09.
Checked live on 2026-09-11:

| Package | CONTRIBUTING / brief | Registry `latest` now |
| --- | --- | --- |
| `zod` | 4.5.4 | **4.6.2** |
| `file-type` | 22.0.2 | **22.1.0** |
| `joi` | 18.2.8 | **18.2.9** |
| `@nestjs/schematics` | 12.0.0 | **12.0.1** |
| `@aws-sdk/client-s3` | 3.1128.0 | **3.1130.0** |

No version number was changed in these seven pages on that basis — they still say
what CONTRIBUTING says, so the site stays internally consistent. `joi` **18.2.8**
appears in both `nestjs/configuration.md` and `nestjs-security/secrets-and-config.md`;
if the coordinator refreshes CONTRIBUTING, both need the same edit.

One exception, and it is not drift: `file-upload-security.md` says
`@nestjs/common@12.0.1` depends on `file-type` **22.0.2**. That is read from the
shipped `package.json` of `@nestjs/common@12.0.1` and is a fact about that
release, not about the registry's current `latest`. It must not be "corrected"
to 22.1.0.

---

## Verified this session, against shipped source rather than docs

Recorded here because two of them **correct** claims made elsewhere in the
handbook, and because the rest are load-bearing for the pages.

### Confirmed — the two findings from `nestjs-request-handling/file-uploads.md`

Both were re-verified by reading `@nestjs/common@12.0.1` after `npm pack`, and
both are correct as written on that page.

1. **`FileTypeValidator` needs `file.buffer`.** `isValid()` returns `false` when
   `file.buffer` is absent, unless `fallbackToMimetype` or
   `skipMagicNumbersValidation` is set — so it rejects every file under
   `diskStorage()`. `buildErrorMessage()` has a dedicated branch producing
   *"file buffer is not available; file type validation could not be performed"*.
2. **`ParseFilePipe` mishandles `FileFieldsInterceptor`.**
   `validateFilesOrFile()` branches only on `Array.isArray(value)`, so a field-map
   record is passed **whole** to each validator. `MaxFileSizeValidator.isValid()`
   then evaluates `'size' in record`, which is false, and every request fails.

   Extension found while verifying: the abstract signature is
   `isValid(file?: TFile | TFile[] | Record<string, TFile[]>)` — the record shape
   is admitted deliberately, so a *custom* validator can handle a field map even
   though none of the built-ins do. `file-upload-security.md` documents both the
   per-field workaround and a field-aware validator.

### Corrections to what a draft of these pages first claimed

1. **Nest does register an Express error-handling layer.**
   `RoutesResolver.registerExceptionHandler()` builds a proxy with
   `RouterProxy.createExceptionLayerProxy` and mounts it through
   `ExpressAdapter.setErrorHandler`, which calls `this.use(handler)` at the root
   in addition to any global-prefix router. So `next(err)` from *any* middleware —
   including `app.use()` middleware in `main.ts` — reaches Nest's exception layer,
   and global filters apply (`RouterExceptionFilters.getGlobalMetadata` reads
   `config.getGlobalFilters()`).

   `BaseExceptionFilter.isHttpError()` explicitly recognizes the `http-errors`
   signature (`typeof expose === 'boolean' && typeof statusCode === 'number' &&
   status === statusCode && instanceof Error`), so `csrf-csrf`'s
   `invalidCsrfTokenError` produces `{ statusCode: 403, message: 'invalid csrf
   token' }` — **not** an Express HTML error page. `csrf.md` now says this, and
   gives the accurate reason to wrap the middleware anyway: the error is not an
   `HttpException`, so a global `@Catch(HttpException)` filter never matches it,
   and route-scoped `@UseFilters()` is not in the path at all.

2. **Nest already maps multer's limit errors.** All five file interceptors call
   `transformException()` from `@nestjs/platform-express`, which returns
   `PayloadTooLargeException` for `LIMIT_FILE_SIZE` and `BadRequestException` for
   the other multer and busboy failures — so a custom `MulterError` filter is
   unnecessary. The match is on **`error.message`** against a fixed table, not on
   `error.code`, so an error raised in a `fileFilter` or a custom storage engine
   falls through as a 500 unless it is already an `HttpException`.
   `file-upload-security.md` documents the mapping table and the `fileFilter`
   consequence.

### `jsonwebtoken@9.0.3` (what `@nestjs/jwt@12.0.1` depends on)

Read from `verify.js`. This changes how `jwt-pitfalls.md` presents the two
classic forgeries — they are shown as attempts that the library now rejects,
with the exact error text, rather than as live holes:

- **`alg: none`** → `jwt signature is required` when a key is configured, and
  `please specify "none" in "algorithms" to verify unsigned tokens` when one is
  not. Accepting an unsigned token requires literally passing `algorithms: ['none']`.
- **Algorithm confusion** → when no `algorithms` is given, the permitted set is
  derived from the key type (`secret` → `HS*`, rsa → `RS*`/`PS*`, ec → `ES*`), and
  there is a second, independent check:
  `secretOrPublicKey must be a symmetric key when using HS256`.
- Therefore the still-exploitable Nest-specific vector is
  **`secretOrKeyProvider`**, which receives the raw token on verify
  (`JwtService.getSecretKey` passes `token` as `tokenOrPayload`) and lets the
  application pick a key from the untrusted header — bypassing the derivation
  entirely. That is what the page's exploit uses.
- `JwtService.mergeJwtOptions` spreads module `verifyOptions` first and per-call
  options over them, so a module-level `algorithms` pin survives a per-call
  `{ issuer }` override.
- `exp`/`nbf` are checked only when present; `iss`/`aud`/`sub`/`jti` only when
  the corresponding verify option is supplied.

### Other API facts read from shipped packages

- **`csrf-csrf@4.0.3`** — `doubleCsrf()` defaults: `cookieName`
  `'__Host-psifi.x-csrf-token'`; `cookieOptions` `sameSite: 'strict'`,
  `secure: true`, `httpOnly: true`, `path: '/'`; `ignoredMethods`
  `['GET','HEAD','OPTIONS']`; `getCsrfTokenFromRequest` reads
  `req.headers['x-csrf-token']`; `size` 32; `hmacAlgorithm` `'sha256'`;
  `errorConfig` 403 / `'invalid csrf token'` / `'EBADCSRFTOKEN'`.
  `getSecret` and `getSessionIdentifier` are both **required**. The token is an
  HMAC over the session identifier, which is why a token from one session does
  not validate for another. Needs `req.cookies`, so `cookie-parser` first.
- **`multer@2.2.0`** — limit defaults `fieldNameSize` 100, `fieldSize` 1 MB,
  `fields`/`fileSize`/`files`/`parts`/`fieldNestingDepth` **Infinity**,
  `headerPairs` 2000. Error codes `LIMIT_PART_COUNT`, `LIMIT_FILE_SIZE`,
  `LIMIT_FILE_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`,
  `LIMIT_FIELD_COUNT`, `LIMIT_UNEXPECTED_FILE`, `MISSING_FIELD_NAME`,
  `LIMIT_FIELD_NESTING`.
- **`MaxFileSizeValidator`** — `file.size < maxSize`, strictly. Its `message`
  option is marked `@deprecated` in favour of `errorMessage`.
- **`FileTypeValidator.matchesFileType`** — `===` first, then
  `mimetype.match(fileType)`, which coerces a string to a `RegExp`. Options:
  `fileType`, `errorMessage`, `skipMagicNumbersValidation`, `fallbackToMimetype`,
  `overrideMimeType`.
- **`@nestjs/config@12.0.0`** — `validationSchema` is a `StandardSchemaV1`;
  `validationOptions` is `StandardSchemaV1.Options`, whose only field is
  `libraryOptions`. `validateWithStandardSchema` injects
  `{ abortEarly: false, allowUnknown: true }` under `libraryOptions` when
  `schema['~standard'].vendor === 'joi'`. A failure throws
  `Config validation error: <path>: <message>` at module construction.
  Other verified options: `validatePredefined` (default `true`),
  `skipProcessEnv`, `override`, `parser`, `expandVariables`, `ignoreEnvFile`.
- **`ConsoleLogger`** (`@nestjs/common@12.0.1`) — `structuredParams` defaults to
  `true` and merges every *plain object after the first argument* into one
  `params` object; a trailing **string** is taken as the context.
  `flattenParams` (default `false`) spreads params into the root in `json` mode,
  and framework keys win on a collision. `maxStringLength` defaults to 10000 and
  is ignored in `json` mode.
- **`nestjs-pino@5.1.0`** — exports `LoggerModule`, `Logger`, `PinoLogger`,
  `NativeLogger`, `LoggerErrorInterceptor`, `InjectPinoLogger`, `getLoggerToken`,
  `nativeLoggerOptions`. `Params` carries `pinoHttp`, `exclude`, `forRoutes`,
  `useExisting`, `renameContext`, `assignResponse`, `nativeLogger`.
  `PinoLogger.runInContext(fn, { bindings, inherit })` is the documented way to
  get request-style bindings in a worker or a cron job.
- **`pino@10.3.1` redact** — `{ paths, censor, remove }`. Documented path forms
  are `a.b.c`, `a["b-c"].d`, `["a-b"].c`, `a.b.*`, `a[*].b`; paths are **case
  sensitive**; wildcards are materially slower than explicit keys.
- **`pino-std-serializers`** — the default `err` serializer copies **every
  enumerable own property** of the error (`for (const key in err)`), which is how
  TypeORM's `parameters` and an HTTP client's `config.headers` reach a log line.
  `req` serializes `url` (from `originalUrl`), `query` and the **full**
  `headers`; `res` serializes the full response `headers`.
- **`pino-http@11.0.0`** — verified option names used in the page: `genReqId`,
  `autoLogging`, `customLogLevel`, `customReceivedMessage`,
  `customSuccessMessage`, `customErrorMessage`, `customAttributeKeys`,
  `customProps`, `quietReqLogger`, `quietResLogger`, `serializers`, `redact`.
- **`passport@0.7.0`** — `req.logIn()` calls `session.regenerate()`, then
  serializes, then `session.save()`; `req.logOut()` deletes the user key, saves,
  then regenerates. `keepSessionInfo: true` merges the previous session back over
  the new one, which reintroduces whatever was planted in it.
- **`express-session@1.19.0`** — `Session.regenerate()` → `Store.regenerate()`,
  which is `destroy(oldId)` then `generate(req)`, so the old record really is
  removed. The MemoryStore warning is printed **only** when `NODE_ENV` is exactly
  `'production'`. `session.MemoryStore` is exported, which is what makes a
  boot-time `instanceof` assertion possible.
- **`passport-jwt@4.0.1`** — `secretOrKey`, `secretOrKeyProvider`,
  `jwtFromRequest`, `issuer`, `audience`, `algorithms`, `ignoreExpiration`,
  `passReqToCallback`, `jsonWebTokenOptions`. It has its own options object and
  does not read `JwtModule`'s, which is why the algorithm pin has to be repeated.
- **`@nestjs/throttler@6.5.0`** — `ThrottlerOptions` = `{ name, limit, ttl,
  blockDuration, ignoreUserAgents, skipIf, getTracker, generateKey, setHeaders }`;
  module options take either an array or `{ throttlers: [...], storage,
  errorMessage, ... }`; `@Throttle({ name: { limit, ttl, blockDuration } })`.
- **npm deprecation notices**, quoted verbatim in `dependency-auditing.md` and
  each confirmed against the registry: `multer@1.4.5-lts.2`, `csurf@1.11.0`,
  the moved NATS client, the Apollo WebSocket subscriptions transport,
  unscoped `casl`, `request`, `prom-client`, `oslo`. `express-async-handler` is
  **not** npm-deprecated — the page says so explicitly and justifies it on
  Express 5 grounds instead.
- **npm CLI surface** used in the page, each exercised locally on npm 10.8.2:
  `npm audit --omit=dev --audit-level=<level>`, `npm audit --json`
  (`metadata.vulnerabilities`), `npm audit signatures`, `npm query '#pkg'`,
  `npm ls <pkg>`, `overrides` (including the scoped
  `{ "@nestjs/cli": { "tar": "…" } }` form, which prints `overridden` in
  `npm ls`).

---

## Validation state for these seven pages

Run from the repository root on 2026-09-11:

```
check.mjs        206 / 206 pages, 3714 links resolved, 0 errors, 0 warnings
lint-sql.mjs     no unmarked SQL string-building found
check-deps.mjs   every package named in the docs exists on the npm registry
ts fences        163 ts blocks across content/nestjs-security/, 0 parse failures
                 (esbuild, experimentalDecorators on; 15 classified as fragments)
```

`lint-snippets.mjs` itself was **not** run: it requires Node 24 for
`module.stripTypeScriptTypes`, and this machine is on Node 20.20.0. The esbuild
pass above is a stand-in and covers the same question (does every `ts` fence
parse), but the coordinator should still run `lint-snippets.mjs` on Node 24.
