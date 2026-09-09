# Unverified / omitted — `content/express-libraries/`

Items I could not verify against CONTRIBUTING.md §1, the npm registry, or official
package documentation, and therefore either omitted from the pages or stated in a
deliberately loose form. Recorded for the "Remaining issues" report.

Author: Express Libraries section. Date: 2026-09-08.

Everything not listed here was verified this session against the published README,
type declarations, or dist source of the exact pinned version (helmet 8.3.0, cors 2.8.6,
express-rate-limit 8.7.0, rate-limit-redis 6.0.1, zod 4.5.4, express-validator 7.3.2,
jose 6.2.12, argon2 0.45.1, bcrypt 6.0.0, passport-jwt 4.0.1, express-session 1.19.0,
connect-redis 10.0.0, csrf-csrf 4.0.3, multer 2.3.0, file-type 22.0.2, compression 1.8.1,
pino-http 11.0.0, swagger-ui-express 5.0.1, @asteasolutions/zod-to-openapi 9.1.0,
clamscan 2.4.0), or against the Node 24 API JSON and the Express 5 API reference.

## `crypto.argon2()` stability (password-hashing.md)

- `crypto.argon2()` / `crypto.argon2Sync()` are documented in the Node 24 API and the
  JSON API index records them as **added in v24.7.0**, with parameters
  `{ message, nonce, parallelism, tagLength, memory, passes }` (plus `secret` and
  `associatedData`).
- The JSON index carries **no stability field** for them, so the page says "Node 24.7.0
  also added…" and never calls them stable. If someone can confirm the stability index
  from the rendered docs, the sentence can be tightened.

## Argon2 parameter floors (password-hashing.md)

- The page presents `argon2id` with `m=19456` (19 MiB), `t=2`, `p=1` as an
  "OWASP-style minimum" and explicitly frames it as a floor, with the real guidance
  being "measure to a 250–500 ms budget on your own hardware". That specific triple was
  **not** re-fetched from the OWASP Password Storage Cheat Sheet this session, which is
  why it is worded as a floor rather than quoted as a recommendation.
- The library defaults quoted alongside it (`type: argon2id`, `memoryCost: 65536`,
  `timeCost: 3`, `parallelism: 4`, `hashLength: 32`) **are** verified, from the
  node-argon2 wiki Options page and the shipped `argon2.d.cts`.

## Browser preflight cache caps (cors.md)

- The page says browsers cap `Access-Control-Max-Age` at roughly 2 hours (Chromium) and
  24 hours (Firefox). These are widely documented figures but were not verified against
  browser source this session, which is why they are given as approximations and the
  recommended value (600 s) sits well below both.

## Cookie storage limits (cookies.md)

- "Roughly 4096 bytes per cookie" and "around 180 cookies per domain in Chromium" are
  stated as approximations. The 4 KB figure is the long-standing RFC 6265 minimum that
  every browser implements; the per-domain count varies by engine and was not verified.

## swagger-ui-express options (api-documentation.md)

- Only options present in the 5.0.1 README are used: `explorer`, `swaggerOptions`,
  `customCss`, `customCssUrl`, `customJs`, plus `swaggerUi.serve`, `swaggerUi.setup()`
  and `swaggerUi.serveFiles()`.
- **Omitted:** `customSiteTitle` and `customfavIcon`, which appear in third-party
  material but are **not** documented in the 5.0.1 README. They are not mentioned on the
  page rather than being described from memory.
- `persistAuthorization` and `tryItOutEnabled` are Swagger UI (not swagger-ui-express)
  configuration keys, passed through `swaggerOptions`; the README points at the Swagger
  UI configuration document for that set rather than enumerating it.

## AWS SDK packages (file-uploads.md)

- `@aws-sdk/s3-request-presigner` and `@aws-sdk/lib-storage` are used for the presigned
  and streamed-upload patterns. Both resolve to **3.1127.0** on the registry, matching
  the `@aws-sdk/client-s3` version in CONTRIBUTING §1.3, but **neither package has a row
  in §1.3**. The page installs them as `@3` (caret-major) rather than pinning a version
  in prose. Add rows to §1.3 if the coordinator wants them pinned.
- `getSignedUrl(client, command, { expiresIn })` and `new Upload({ client, params })` are
  the documented entry points of those packages.

## clamscan (file-uploads.md)

- `new NodeClam().init(options)`, `.isInfected(path)` returning
  `{ file, isInfected, viruses }`, and `isInfected === null` meaning "could not scan" are
  all from the 2.4.0 README.
- The `clamdscan: { host, port }` option shape is taken from the README's options block.
  The full option surface (socket path, `removeInfected`, `quarantineInfected`, and so
  on) is not documented on the page because only the subset above was verified.

## Node test-runner coverage flags (testing.md)

- `--experimental-test-coverage` and the `--test-coverage-lines` /
  `--test-coverage-functions` / `--test-coverage-branches` thresholds are used as stated
  in CONTRIBUTING §1.1 ("`--experimental-test-coverage` / `--test-coverage-*` on 24").
  They were not independently re-verified against the Node 24 CLI documentation this
  session.
- `--test-reporter=junit` is named as one of the available reporters. The
  `--test-reporter-destination` pairing is used as documented behavior of the runner but
  was likewise not re-verified.

## PM2 (process-management-and-graceful-shutdown.md)

- `kill_timeout` (default 1.6 s), `wait_ready`, `listen_timeout` (default 3000 ms),
  `shutdown_with_message`, and PM2 sending **SIGINT** rather than SIGTERM are all from
  the PM2 "Graceful Start / Shutdown" documentation page.
- `instances`, `exec_mode: 'cluster'` and `max_memory_restart` are long-standing
  ecosystem-file keys used without re-verification; they are the only additional PM2
  options the page names.
- `pm2-logrotate` is mentioned by name only, with no version and no configuration.

## systemd and orchestrator settings

- The systemd unit uses `Type`, `ExecStart`, `Restart`, `RestartSec`, `KillSignal`,
  `KillMode`, `TimeoutStopSec`, `Environment`, `EnvironmentFile`, `StandardOutput` and
  `StandardError` — all standard `systemd.service` directives, not re-verified against
  the systemd manual this session.
- `terminationGracePeriodSeconds` and `preStop` are named as Kubernetes concepts without
  a manifest example, to stay inside this page's scope and leave the deployment-level
  detail to `content/production/graceful-shutdown.md`.

## Zod 4 error helpers (validation.md)

- `result.error.issues` is used for the API error response because it is the stable,
  structured form. `z.treeifyError()`, `z.flattenError()` and `z.prettifyError()` are
  named as alternatives; all four are confirmed exports of `zod@4.5.4`.
- The deprecation of `.format()` and `.flatten()` on `ZodError` is confirmed from the
  Zod 4 migration guide.

## Cross-references to pages owned by other authors

- Every outbound link resolves to a slug present in `scripts/nav.mjs`. Most of the
  `security/`, `production/`, `orms/` and `databases/` targets were being written
  concurrently, so their anchors were not checkable at the time of writing — no link on
  these pages uses an `#anchor`.
- `content/express-libraries/file-uploads.md` links to
  `../../examples/file-upload/README.md` as instructed by the brief. That directory
  exists in `examples/`; its contents were not authored by this section.
