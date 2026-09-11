---
title: Deployment checklist
description: A grouped pre-deploy checklist for a NestJS 12 service — config, validation, security, database, shutdown, probes, observability, dependencies, resources and rollback.
status: current
updated: 2026-09-11
---

Work through this before the first production deploy of a Nest service, and again before any release that changes how it is exposed, authenticated or stored. Every item is one line and links to the page that explains why it is there — the checklist is an index, not a substitute for the reasoning.

Not every item applies to every service. Deciding one does not apply is fine; skipping it because you did not read it is not.

## Build and artifact

- [ ] The build runs `nest build` against `tsconfig.build.json`, and the entry point is `dist/main.js` — [Build and deployment](build-and-deployment.md)
- [ ] Every non-TypeScript asset is listed under `compilerOptions.assets` in `nest-cli.json` — [Build and deployment](build-and-deployment.md)
- [ ] `includeLibraryAssets` is set if a monorepo library ships assets — [Monorepo and library mode](../nestjs-advanced/monorepo-and-libraries.md)
- [ ] The container command is `node dist/main.js` — never `nest start`, `npm run`, or a shell form — [Docker](docker.md)
- [ ] `@nestjs/cli`, `@nestjs/schematics`, `typescript` and the test runner are devDependencies and are absent from the runtime image — [Build and deployment](build-and-deployment.md)
- [ ] `reflect-metadata`, `rxjs` and anything a global pipe needs are in `dependencies`, not `devDependencies` — [Docker](docker.md)
- [ ] `package.json` is copied into the runtime image, so `"type"` and `imports` still apply — [Docker](docker.md)
- [ ] The module format is decided repository-wide, with `moduleResolution: "nodenext"` if it is ESM — [ESM vs CommonJS in production](module-format-in-production.md)
- [ ] Source maps are emitted and `--enable-source-maps` is passed, or maps are uploaded to the error tracker — [Build and deployment](build-and-deployment.md)
- [ ] One image is built once, tagged with the git SHA, and promoted unchanged through environments — [Build and deployment](build-and-deployment.md)

## Configuration and secrets

- [ ] All configuration comes from the environment; nothing environment-specific is baked into the image — [Environment configuration](configuration.md)
- [ ] `ConfigModule.forRoot` validates a Standard Schema (Zod 4) at boot and the process exits non-zero on failure — [Configuration](../nestjs/configuration.md)
- [ ] No secret has a default anywhere: `getOrThrow`, never `get(key, fallback)` — [Environment configuration](configuration.md)
- [ ] There is no retry loop around configuration; the crash loop is what halts the rollout — [Environment configuration](configuration.md)
- [ ] `process.env` is read only inside the config layer, enforced by a lint rule — [Environment configuration](configuration.md)
- [ ] No `NODE_ENV` branch exists in a provider or a service — [Environment configuration](configuration.md)
- [ ] `NODE_ENV=production` is set in the image; staging uses it too, with a separate `APP_ENV` label — [Docker](docker.md)
- [ ] `ignoreEnvFile` is on in production so a stray `.env` cannot shadow injected variables — [Environment configuration](configuration.md)
- [ ] `.env` is in `.gitignore` and `.dockerignore`; only `.env.example` is committed — [Docker](docker.md)
- [ ] Secrets are injected from a secret store, never from a build arg or an image layer — [Secrets and config validation](../nestjs-security/secrets-and-config.md)
- [ ] No secret appears in `docker history`, `docker inspect`, or any layer — [Docker](docker.md)
- [ ] Every environment has its own credentials; staging cannot reach production data — [Secrets management](../security/secrets-management.md)
- [ ] Secret rotation has been performed once, as a drill, without downtime — [Secrets management](../security/secrets-management.md)
- [ ] The safe (allow-listed) config view is logged once at boot with the git SHA — [Environment configuration](configuration.md)
- [ ] Adding a required variable was done in three deploys: optional, set everywhere, then required — [Environment configuration](configuration.md)

## Validation and serialization

- [ ] A `ValidationPipe` is registered globally with `whitelist: true` and `transform: true` — [The ValidationPipe](../nestjs-validation/validation-pipe.md)
- [ ] `forbidNonWhitelisted` is on, or unknown properties are knowingly stripped rather than passed through — [Whitelisting and unknown properties](../nestjs-validation/unknown-properties.md)
- [ ] The same global pipe is registered in the e2e test setup, so tests exercise the real pipeline — [End-to-end tests](../nestjs-testing/e2e-tests.md)
- [ ] Every body, query and route parameter has a DTO or a schema; no handler reads a raw request — [DTOs](../nestjs-request-handling/dtos.md)
- [ ] Create and update DTOs allow-list fields; no client object is spread into an entity — [Validation as a security control](../nestjs-security/validation-as-a-control.md)
- [ ] Pagination limits are capped server-side regardless of what the client sends — [Performance](performance.md)
- [ ] Responses go through a serializer that strips internal fields, and it is not applied to huge lists by default — [Serialization](../nestjs-validation/serialization.md)
- [ ] Request body size is capped at the parser, and upload size is capped separately — [File uploads](../nestjs-request-handling/file-uploads.md)
- [ ] Uploads are checked by magic bytes, not by extension or `content-type` — [File upload security](../nestjs-security/file-upload-security.md)
- [ ] Route paths use path-to-regexp 8 syntax; no Express 4 wildcard or optional-parameter forms remain — [Routing and path syntax](../nestjs/routing-and-path-syntax.md)

## HTTP security

- [ ] `helmet` 8.3.0 is registered before the routes — [Security headers](../nestjs-security/security-headers.md)
- [ ] A Content-Security-Policy is set deliberately, not left at a default an API does not need — [Security headers](../nestjs-security/security-headers.md)
- [ ] HSTS is enabled with a meaningful `max-age`, after confirming HTTPS works everywhere — [Security headers](../nestjs-security/security-headers.md)
- [ ] `x-powered-by` is disabled on the underlying Express instance — [Security headers](../nestjs-security/security-headers.md)
- [ ] CORS uses an explicit origin allow-list; no reflected origin and no `*` with credentials — [CORS](../nestjs-security/cors.md)
- [ ] `trust proxy` matches your actual proxy depth, so client IPs and rate-limit keys are real — [How Nest uses Express](../express-vs-nestjs/how-nest-uses-express.md)
- [ ] TLS terminates at a load balancer or proxy, not in Node — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] The database connection uses TLS and verifies the server certificate — [PostgreSQL](../nestjs-databases/postgresql.md)

## Authentication and authorization

- [ ] Passwords are hashed with `argon2` 0.45.1 or `bcrypt` 6.0.0, never stored or logged — [Authentication](../nestjs-libraries/authentication.md)
- [ ] A global authentication guard is registered, with an explicit `@Public()` escape hatch — [Guards](../nestjs-request-handling/guards.md)
- [ ] JWT verification pins the algorithm; `alg: none` and algorithm confusion are impossible — [JWT pitfalls](../nestjs-security/jwt-pitfalls.md)
- [ ] Token expiry is short and there is a working revocation story — [JWT pitfalls](../nestjs-security/jwt-pitfalls.md)
- [ ] Session cookies are `httpOnly`, `secure`, `sameSite`, and the session id is regenerated on login — [Authentication and session security](../nestjs-security/authentication-and-session-security.md)
- [ ] Every route that returns or mutates a record checks ownership, not just authentication — [Authorization and IDOR](../nestjs-security/authorization-and-idor.md)
- [ ] Authorization is enforced in a guard or the service, never only in the client — [Authorization](../nestjs-libraries/authorization.md)
- [ ] CSRF protection is in place for cookie-authenticated state changes — [CSRF](../nestjs-security/csrf.md)
- [ ] Authentication failures are logged without the credential — [Safe logging](../nestjs-security/safe-logging.md)

## Rate limiting and abuse

- [ ] `@nestjs/throttler` 6.5.0 is configured with a shared Redis storage, not the in-process default — [Rate limiting with Throttler](../nestjs-libraries/throttler.md)
- [ ] The throttler key is a trustworthy client identity given your proxy configuration — [Rate limiting and abuse](../nestjs-security/rate-limiting.md)
- [ ] Login, password reset and token endpoints have their own stricter limits — [Rate limiting and abuse](../nestjs-security/rate-limiting.md)
- [ ] Health and readiness endpoints are exempt from throttling — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Expensive endpoints — search, export, upload — have their own tighter limits — [Rate limiting and abuse](../nestjs-security/rate-limiting.md)
- [ ] A server-level request timeout stops a slow client holding a connection through your drain window — [Graceful shutdown](graceful-shutdown.md)

## Database

- [ ] Migrations run as a discrete deploy step, never from `main.ts` or an `onModuleInit` hook — [Migrations](../nestjs-databases/migrations.md)
- [ ] Every migration is backward-compatible with the version currently serving traffic — [Migrations](../nestjs-databases/migrations.md)
- [ ] `synchronize` is off in every environment that holds data you care about — [TypeORM](../nestjs-orms/typeorm.md)
- [ ] Every migration has been tested against a production-sized copy — [Migrations](../nestjs-databases/migrations.md)
- [ ] Adding a column, index or constraint does not take a blocking lock — [Migrations](../databases/migrations.md)
- [ ] Indexes exist for every query on the request path; `EXPLAIN ANALYZE` shows no sequential scans — [Indexing basics](../databases/indexing-basics.md)
- [ ] No N+1 query in any list endpoint — [Avoiding N+1](../nestjs-orms/avoiding-n-plus-one.md)
- [ ] Pool size × processes × replicas is below `max_connections`, with headroom — [Connection pooling](../nestjs-databases/connection-pooling.md)
- [ ] A statement timeout and a pool acquire timeout are set — [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md)
- [ ] Transaction boundaries live in the service layer and never span an outbound HTTP call — [Transactions](../nestjs-databases/transactions.md)
- [ ] Every query is parameterised; no user input reaches a raw query by interpolation — [SQL injection](../nestjs-security/sql-injection.md)
- [ ] Mongo queries cannot receive an operator object from user input — [NoSQL injection](../nestjs-security/nosql-injection.md)
- [ ] The application's database user has only the privileges it needs — [Secrets management](../security/secrets-management.md)

## Backups and restore

- [ ] Automated backups are enabled with a retention period matching your requirements — [Migrations](../nestjs-databases/migrations.md)
- [ ] Point-in-time recovery is enabled where the data justifies it — [Migrations](../databases/migrations.md)
- [ ] **A restore has actually been performed into a scratch environment.** An untested backup is not a backup — [Migrations](../databases/migrations.md)
- [ ] Restore time has been measured and is acceptable to the business — [Migrations](../databases/migrations.md)
- [ ] Backups are stored in a separate account or region from the primary — [Secrets management](../security/secrets-management.md)
- [ ] Backup failure raises an alert; silent failure is the default failure mode — [Observability](observability.md)

## Graceful shutdown

- [ ] `app.enableShutdownHooks()` is called — without it every hook you wrote is dead code — [Graceful shutdown](graceful-shutdown.md)
- [ ] Readiness fails **before** anything closes, with a drain delay for the load balancer to converge — [Graceful shutdown](graceful-shutdown.md)
- [ ] `gracefulShutdownTimeoutMs` is set on `TerminusModule`, or an equivalent delay is implemented — [Health checks with Terminus](../nestjs-libraries/terminus.md)
- [ ] Queue workers stop consuming in `onModuleDestroy` and drain in `beforeApplicationShutdown` — [Background jobs with BullMQ](../nestjs-libraries/bullmq.md)
- [ ] Pools, Redis and external clients close in `onApplicationShutdown` — never in `onModuleDestroy` — [Graceful shutdown](graceful-shutdown.md)
- [ ] Every hook is idempotent and catches its own errors, given the v12 hierarchy-level ordering — [Graceful shutdown](graceful-shutdown.md)
- [ ] No code relies on hook ordering *between* providers within one hook — [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md)
- [ ] `forceCloseConnections: true` is set, so idle keep-alive sockets cannot hold `app.close()` open — [Graceful shutdown](graceful-shutdown.md)
- [ ] `return503OnClosing: true` is set, so a request arriving mid-shutdown gets a legible 503 rather than a reset — [Graceful shutdown](graceful-shutdown.md)
- [ ] `server.keepAliveTimeout` exceeds the proxy's idle timeout, with `headersTimeout` above it — [Graceful shutdown](../production/graceful-shutdown.md)
- [ ] The total shutdown budget fits inside `terminationGracePeriodSeconds` — [Graceful shutdown](graceful-shutdown.md)
- [ ] PID 1 is an init or `node` directly — never a shell, npm, or the Nest CLI — [Docker](docker.md)
- [ ] `docker stop` returns in about a second, proving `SIGTERM` reaches Nest — [Docker](docker.md)
- [ ] An e2e test calls `app.close()` in `afterAll`, so a throwing hook fails in CI — [Continuous integration](ci.md)
- [ ] The logger is flushed in `onApplicationShutdown` — [Observability](observability.md)

## Health probes

- [ ] Separate liveness and readiness endpoints exist, wired to separate probes — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] **Liveness checks nothing external.** No database, no cache, no downstream service — [Health checks](../nestjs-databases/health-checks.md)
- [ ] Readiness checks only the dependencies a request genuinely cannot be served without — [Health checks](../nestjs-databases/health-checks.md)
- [ ] An impaired-but-serving dependency reports `degraded`, not `down` — [Health checks with Terminus](../nestjs-libraries/terminus.md)
- [ ] Every network indicator has `withTimeout`, and expensive ones have `cacheFor` — [Health checks with Terminus](../nestjs-libraries/terminus.md)
- [ ] A startup probe covers the full `NestFactory.create()` boot window — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] `livenessProbe.failureThreshold` is at least 3; `readinessProbe.periodSeconds` is small — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Probes are `@Public()`, exempt from throttling, excluded from `setGlobalPrefix`, and version-neutral — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] No global filter or interceptor turns a probe's 503 into a 200 — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Probe bodies reveal no hostnames, driver errors, versions or connection strings — [Health checks with Terminus](../nestjs-libraries/terminus.md)
- [ ] The database-down case has been tested: pods go unready and stay running — [Health and readiness probes](health-and-readiness-probes.md)

## Logging

- [ ] Structured JSON to stdout; no log files inside the container — [Logging](../nestjs-libraries/logging.md)
- [ ] `bufferLogs: true` and `app.useLogger()` are set, so bootstrap lines share the format — [Observability](observability.md)
- [ ] Every line carries a correlation id from `AsyncLocalStorage`, not a request-scoped provider — [Observability](observability.md)
- [ ] The id is accepted from an inbound header and propagated on outbound calls — [Observability](observability.md)
- [ ] Background work — crons, queue consumers — opens its own context with a job id — [Observability](observability.md)
- [ ] Redaction is configured for authorization headers, cookies, passwords and tokens — [Safe logging](../nestjs-security/safe-logging.md)
- [ ] No DTO or request body is logged wholesale — [Safe logging](../nestjs-security/safe-logging.md)
- [ ] Failures are logged once, in the exception filter, with a stack and the correlation id — [Exception filters](../nestjs-request-handling/exception-filters.md)
- [ ] Probe endpoints are excluded from access logs — [Observability](observability.md)
- [ ] Stack traces and internal error details never reach the client — [Exception filters](../nestjs-request-handling/exception-filters.md)
- [ ] Log level is configurable and `debug` is off in production — [Environment configuration](configuration.md)
- [ ] `pino-pretty` is a devDependency and is not used in production — [Logging](../nestjs-libraries/logging.md)

## Monitoring and alerting

- [ ] Request rate, error rate and latency percentiles are recorded per **route pattern** — [Observability](observability.md)
- [ ] Metric labels are bounded; no ids or resolved paths — [Observability](observability.md)
- [ ] Event-loop delay is measured with `perf_hooks.monitorEventLoopDelay` — [Performance](performance.md)
- [ ] Connection-pool in-use and waiting counts are exported — [Connection pooling](../nestjs-databases/connection-pooling.md)
- [ ] Outbound dependency latency and error rate are recorded per dependency — [Observability](observability.md)
- [ ] Queue depth **and oldest-job age** are monitored — [Background jobs with BullMQ](../nestjs-libraries/bullmq.md)
- [ ] At least one business metric is monitored — orders, signups, payments — [Observability](observability.md)
- [ ] Tracing is enabled and sampled, with the SDK loaded via `--import` before the app — [Observability](observability.md)
- [ ] The trace id appears in log lines, so a slow trace links to its logs — [Observability](observability.md)
- [ ] Alerts fire on symptoms (error rate, latency, business volume), not causes (CPU, memory) — [Observability](observability.md)
- [ ] Every alert has a runbook link and a named owner — [Observability](observability.md)
- [ ] `/metrics` is not publicly reachable — [Observability](observability.md)
- [ ] Someone is actually on call, and the paging path has been tested — [Observability](observability.md)

## Dependencies and supply chain

- [ ] `npm ci` is used everywhere and `package-lock.json` is committed — [Continuous integration](ci.md)
- [ ] `npm audit --omit=dev --audit-level=high` passes in CI — [Dependency auditing](../nestjs-security/dependency-auditing.md)
- [ ] Nest packages are on the 12 line where a 12 line exists; `@nestjs/throttler` is 6.5.0 and `@nestjs/graphql` is 14.0.0 — [NestJS 11 → 12 migration](../nestjs-reference/v11-to-v12-migration.md)
- [ ] No deprecated or moved package is in use — `multer@1.x` is end of life, `csurf` is archived, and the unscoped NATS client was replaced by `@nats-io/transport-node` — [Dependency auditing](../nestjs-security/dependency-auditing.md)
- [ ] `@nestjs/observe` is treated as pre-1.0 (0.1.8) if it is used at all — [Observability with @nestjs/observe](../nestjs-libraries/observe.md)
- [ ] Node 24 LTS is the runtime; the CI runner also satisfies the CLI's higher floor — [Continuous integration](ci.md)
- [ ] The container image is scanned, and the base image is pinned and rebuilt on a schedule — [Docker](docker.md)
- [ ] GitHub Actions are pinned to a major, or a SHA where they touch secrets — [Continuous integration](ci.md)
- [ ] An automated dependency-update bot is enabled — [Dependency auditing](../nestjs-security/dependency-auditing.md)

## Container and resources

- [ ] Multi-stage build; `npm ci --omit=dev` produces the runtime `node_modules` — [Docker](docker.md)
- [ ] `.dockerignore` excludes `.env`, `.git`, `node_modules` and `dist` — [Docker](docker.md)
- [ ] The container runs as the non-root `node` user, enforced by `runAsNonRoot` at the platform — [Docker](docker.md)
- [ ] Capabilities are dropped and the root filesystem is read-only where possible — [Docker](docker.md)
- [ ] Memory and CPU requests and limits are set on every container — [Docker](docker.md)
- [ ] `--max-old-space-size` is roughly 75% of the container memory limit — [Performance](performance.md)
- [ ] One Nest process per container; scaling is by replicas — [Clustering](clustering.md)
- [ ] If clustering is used, `availableParallelism()` is used and pool sizes are divided by the worker count — [Clustering](clustering.md)
- [ ] Every `@Cron` and `@Interval` runs exactly once across all workers and replicas — [Scheduling](../nestjs-libraries/schedule.md)
- [ ] Caches, sessions, rate-limit counters and WebSocket broadcasts use a shared store — [Clustering](clustering.md)
- [ ] The image was built for the deployment architecture — [Docker](docker.md)
- [ ] At least two replicas run, across failure domains — [Clustering](clustering.md)

## Performance

- [ ] The service has been load-tested against a realistic dataset, profiling `dist/`, not the watch server — [Performance](performance.md)
- [ ] A latency SLO exists and the current p99 meets it — [Performance](performance.md)
- [ ] `grep -r "Scope.REQUEST" src/` has been reviewed; no scope has bubbled up unintentionally — [Injection scopes](../nestjs/injection-scopes.md)
- [ ] `ClassSerializerInterceptor` is not applied globally to endpoints returning large arrays — [Serialization](../nestjs-validation/serialization.md)
- [ ] No synchronous `fs`, `zlib` or `crypto` call is on the request path — [Performance](../production/performance.md)
- [ ] Long-running work returns a job id instead of holding the connection — [Background jobs with BullMQ](../nestjs-libraries/bullmq.md)
- [ ] Outbound HTTP uses a shared, pooled agent with keep-alive and timeouts — [Performance](../production/performance.md)
- [ ] No cached response can be served to a different user than it was built for — [Caching](../nestjs-libraries/cache-manager.md)
- [ ] The database slow-query log is enabled and has been reviewed — [Indexing basics](../databases/indexing-basics.md)

## Deploy and rollback

- [ ] CI runs lint, `tsc --noEmit`, `nest build`, unit tests and e2e tests against a real database — [Continuous integration](ci.md)
- [ ] CI boots the built artifact and hits `/livez` before the image is pushed — [Continuous integration](ci.md)
- [ ] Deployment is rolling or blue/green, gated on the readiness probe — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] **The rollback procedure has been executed at least once**, not just written down — [Build and deployment](build-and-deployment.md)
- [ ] Rollback does not require reversing a migration; schema changes are backward-compatible — [Migrations](../nestjs-databases/migrations.md)
- [ ] Old and new versions can run simultaneously during a rolling deploy — [Migrations](../nestjs-databases/migrations.md)
- [ ] Config changes are deployable and revertible independently of code — [Environment configuration](configuration.md)
- [ ] There is a documented incident path: who is paged, who declares, who communicates — [Observability](observability.md)
- [ ] The first deploy is scheduled when the people who wrote it are awake — [Continuous integration](ci.md)

## The five that matter most

Most teams do not check every box before the first deploy, and that is survivable. What separates a good outcome from a bad one is knowing which boxes are unchecked and having decided that consciously. The dangerous state is not "we have no rollback plan" — it is "we assumed we had one".

These five each convert a routine problem into an outage:

1. **Liveness checks nothing external.** One database blip otherwise restarts every replica simultaneously, and a 60-second failover becomes a 20-minute outage.
2. **`enableShutdownHooks()` is called and PID 1 is right.** Without both, every hook on the previous list is dead code and every deploy drops requests.
3. **Pools close in `onApplicationShutdown`, not `onModuleDestroy`.** The tidier-looking hook runs while requests are still executing.
4. **The restore has been tested.** An untested backup is a belief, not a capability.
5. **The rollback has been executed.** A procedure nobody has run does not work, and you find out during the incident.

Rerun the whole list on a schedule. A service that passed in March fails in September: a package was deprecated, an index was outgrown, a new replica count crossed `max_connections`, a certificate is close to expiry. Quarterly is a reasonable cadence; after any incident is mandatory.

## Common mistakes

- **Ticking a box you did not verify.** Worse than an empty box, because it stops anyone looking again.
- **Assuming backups work.** Automated backups fail silently for months. Restore, or you do not have backups.
- **Writing a rollback plan without running it.** The first execution should not be during an incident.
- **A database check in the liveness probe.** The most expensive single mistake on this list.
- **Never calling `enableShutdownHooks()`.** Every termination hook in the codebase is decorative.
- **Closing a pool in `onModuleDestroy`.** In-flight requests turn into 500s on every deploy.
- **Relying on hook ordering across providers after the v12 change.** It now runs by hierarchy level.
- **Running migrations at application boot.** N replicas start; N migrations race.
- **A migration that is not backward-compatible.** During a rolling deploy both versions are live; a dropped column breaks the old one instantly.
- **Registering global pipes and guards in `main.ts` but not in the e2e setup.** The suite tests a pipeline production does not have.
- **`@Cron` in the web process.** It fires once per worker and once per replica.
- **The default throttler or cache store behind multiple processes.** Limits multiply and hit rates collapse.
- **Shipping `@nestjs/cli` and `typescript` in the runtime image.** Size, CVE surface, and a compiler for anyone who gets a shell.
- **Checking the security boxes only before launch.** Every release changes the attack surface.
- **Ignoring an item because "it does not apply".** Write down why. Half the time the reason does not survive being written.
- **No staging environment that resembles production.** Everything here passes on a laptop with one user and an empty database.

## Related topics

- [Build and deployment](build-and-deployment.md) — the artifact, the CLI flags and promoting one image.
- [Environment configuration](configuration.md) — the config and secrets group, in full.
- [Graceful shutdown](graceful-shutdown.md) — the hooks and the ordering each item refers to.
- [Health and readiness probes](health-and-readiness-probes.md) — liveness, readiness and startup done correctly.
- [Docker](docker.md) — the container items, with the actual Dockerfile.
- [Continuous integration](ci.md) — what CI should prove before a deploy is allowed.
- [Observability](observability.md) — logs, correlation ids, metrics and tracing.
- [Performance](performance.md) — measuring against the SLO this list asks for.
- [Clustering](clustering.md) — the process model and what breaks across workers.
- [ESM vs CommonJS in production](module-format-in-production.md) — the module-format items.
- [OWASP API Top 10 in Nest](../nestjs-security/owasp-api-top-10.md) — the security items, organized by threat instead.
- [Deployment checklist](../production/deployment-checklist.md) — the Node and Express version of this list.
- [Troubleshooting](../nestjs-reference/troubleshooting.md) — when something on this list turns out to be unchecked.
