---
title: Deployment checklist
description: A grouped pre-deploy checklist covering config, security, database, operations and rollback, with every item linking to the page that explains it.
status: current
updated: 2026-09-08
---

Work through this before the first production deploy, and again before any release that changes how the service is exposed, authenticated or stored. Every item is one line and links to the page that explains why it is here — the checklist is an index, not a substitute for the reasoning.

Not every item applies to every service. Deciding an item does not apply is fine; skipping it because you did not read it is not.

## Configuration and secrets

- [ ] All configuration comes from environment variables, not committed files — [Configuration](configuration.md)
- [ ] A single `config.js` is validated with Zod 4 at boot and exported frozen — [Configuration](configuration.md)
- [ ] The process exits non-zero when a required variable is missing, before binding a port — [Configuration](configuration.md)
- [ ] No secret has a fallback default anywhere in the codebase — [Configuration](configuration.md)
- [ ] `process.env` is read in exactly one module, enforced by a lint rule — [Configuration](configuration.md)
- [ ] No `NODE_ENV` branch exists in business logic — [Configuration](configuration.md)
- [ ] `NODE_ENV=production` is set in the image; staging uses it too, with a separate `APP_ENV` label — [Dockerfile](dockerfile.md)
- [ ] `.env` is in `.gitignore` and `.dockerignore`; only `.env.example` is committed — [Running the examples](../getting-started/running-the-examples.md)
- [ ] Secrets are injected from a secret store, not baked into the image or a build arg — [Secrets management](../security/secrets-management.md)
- [ ] No secret appears in `docker history`, `docker inspect`, or any image layer — [Dockerfile](dockerfile.md)
- [ ] Every environment has its own credentials; staging cannot reach production data — [Secrets management](../security/secrets-management.md)
- [ ] Secret rotation has been performed once, as a drill, without downtime — [Secrets management](../security/secrets-management.md)
- [ ] The safe (non-secret) config view is logged once at boot with the git SHA — [Observability](observability.md)
- [ ] Feature flags default to off and each has a removal date — [Configuration](configuration.md)

## HTTP security headers

- [ ] `helmet` 8.3.0 is registered before the routes — [Security headers with Helmet](../express-libraries/security-headers-helmet.md)
- [ ] A Content-Security-Policy is set and tested, not left at the default for an API that serves HTML — [Security headers](../security/security-headers.md)
- [ ] HSTS is enabled with a meaningful `max-age`, after confirming HTTPS works everywhere — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] `X-Content-Type-Options: nosniff` and a frame-ancestors policy are present — [Security headers](../security/security-headers.md)
- [ ] `x-powered-by` is disabled — [Security headers with Helmet](../express-libraries/security-headers-helmet.md)
- [ ] CORS uses an explicit origin allow-list; no reflected origin, no `*` with credentials — [CORS misconfiguration](../security/cors-misconfiguration.md)
- [ ] `app.set('trust proxy', …)` matches your actual proxy depth — [Request and response](../express/request-and-response.md)

## TLS

- [ ] TLS terminates at a load balancer or reverse proxy, not in Node — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] HTTP redirects to HTTPS, and the app rejects plaintext behind the proxy — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] TLS 1.2 minimum; TLS 1.3 preferred; weak ciphers disabled — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] Certificate renewal is automated and alerted on at 30 days remaining — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] Internal service-to-service traffic is encrypted, or the network is genuinely private — [HTTPS and TLS](../security/https-and-tls.md)
- [ ] The database connection uses TLS and verifies the server certificate — [PostgreSQL with pg](../databases/postgresql-with-pg.md)

## Authentication and authorization

- [ ] Passwords are hashed with `argon2` 0.45.1 (or bcrypt 6.0.0), never stored or logged — [Password hashing](../express-libraries/password-hashing.md)
- [ ] Session cookies are `httpOnly`, `secure`, `sameSite`, and scoped to a path — [Cookies](../express-libraries/cookies.md)
- [ ] Sessions are stored in Redis, not `MemoryStore` — [Authentication](../express-libraries/authentication.md)
- [ ] The session id is regenerated on login and destroyed on logout — [Authentication and session security](../security/authentication-and-session-security.md)
- [ ] JWTs specify the algorithm on verification; `alg: none` and algorithm confusion are impossible — [JWT pitfalls](../security/jwt-pitfalls.md)
- [ ] Token expiry is short and there is a working revocation story — [JWT pitfalls](../security/jwt-pitfalls.md)
- [ ] Every route that returns or mutates a record checks ownership, not just authentication — [IDOR and broken object-level authorization](../security/broken-object-level-authorization.md)
- [ ] CSRF protection is in place for cookie-authenticated state changes, using `csrf-csrf` 4.0.3 or a session-bound double-submit token — [CSRF](../security/csrf.md)
- [ ] Login, password reset and token endpoints are rate-limited separately and more strictly — [Rate limiting and abuse](../security/rate-limiting-and-abuse.md)
- [ ] Authentication failures are logged without the credential — [Logging without leaking PII](../security/logging-without-leaking-pii.md)

## Rate limiting and abuse

- [ ] `express-rate-limit` 8.7.0 is configured with `rate-limit-redis` 6.0.1, not the in-memory store — [Rate limiting](../express-libraries/rate-limiting.md)
- [ ] The key is a trustworthy client identity, given your proxy configuration — [Rate limiting](../express-libraries/rate-limiting.md)
- [ ] Health and readiness endpoints are exempt from rate limiting — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Expensive endpoints — search, export, upload — have their own tighter limits — [Rate limiting and abuse](../security/rate-limiting-and-abuse.md)
- [ ] Request body size is capped on every parser — [File uploads](../express-libraries/file-uploads.md)
- [ ] There is a server-level request timeout so a slow client cannot hold a connection — [Graceful shutdown](graceful-shutdown.md)

## Input validation

- [ ] Every request body, query and route parameter is validated with Zod 4 at the edge — [Validation](../express-libraries/validation.md)
- [ ] Handlers receive the parsed value, never the raw `req.body` — [Validation](../express-libraries/validation.md)
- [ ] Update and create schemas allow-list fields; no object is spread into a model — [Mass assignment](../security/mass-assignment.md)
- [ ] Pagination limits are capped server-side regardless of what the client sends — [Performance](performance.md)
- [ ] Every SQL query is parameterised; `scripts/lint-sql.mjs` passes — [SQL injection](../security/sql-injection.md)
- [ ] Mongo queries cannot receive an operator object from user input — [NoSQL injection](../security/nosql-injection.md)
- [ ] Uploads are checked by magic bytes with `file-type` 22.0.2, not by extension or `content-type` — [File upload security](../security/file-upload-security.md)
- [ ] Uploads are size-limited, stored outside the web root, and served with a safe content type — [File upload security](../security/file-upload-security.md)
- [ ] Any user text rendered into HTML is escaped or sanitized — [XSS](../security/xss.md)
- [ ] File paths built from user input are resolved and confirmed inside the allowed root — [Files and paths](../node/fs-and-path.md)

## Database

- [ ] Migrations run as a discrete deploy step, never on application boot — [Migrations](../databases/migrations.md)
- [ ] Every migration is backward-compatible with the currently running version — [Migrations](../databases/migrations.md)
- [ ] Every migration has been tested against a production-sized copy — [Migrations](../databases/migrations.md)
- [ ] Adding a column, an index or a constraint does not take a blocking lock — [Migrations](../databases/migrations.md)
- [ ] A rollback path exists for every migration, or the change is provably additive — [Migration strategy](../orms/migration-strategy.md)
- [ ] Indexes exist for every query in the request path; `EXPLAIN ANALYZE` confirms no sequential scans — [Indexing basics](../databases/indexing-basics.md)
- [ ] No N+1 query in any list endpoint — [N+1 queries](../databases/n-plus-one-queries.md)
- [ ] Pool size × replicas × processes is below the database's `max_connections`, with headroom — [Connection pooling](../databases/connection-pooling.md)
- [ ] A statement timeout and a pool acquire timeout are set — [Retries and timeouts](../databases/retries-and-timeouts.md)
- [ ] Transaction boundaries are in the service layer and never span an outbound HTTP call — [Transactions](../databases/transactions.md)
- [ ] The application's database user has only the privileges it needs — [Secrets management](../security/secrets-management.md)

## Backups and restore

- [ ] Automated backups are enabled with a retention period matching your requirements — [Migrations](../databases/migrations.md)
- [ ] Point-in-time recovery is enabled where the data justifies it — [Choosing a database](../databases/choosing-a-database.md)
- [ ] **A restore has actually been performed into a scratch environment.** An untested backup is not a backup — [Migrations](../databases/migrations.md)
- [ ] Restore time has been measured and is acceptable to the business — [Migrations](../databases/migrations.md)
- [ ] Backups are stored in a separate account or region from the primary — [Secrets management](../security/secrets-management.md)
- [ ] Backup failures raise an alert; silent backup failure is the default failure mode — [Observability](observability.md)

## Graceful shutdown

- [ ] `SIGTERM` and `SIGINT` are handled; the handler is idempotent — [Graceful shutdown](graceful-shutdown.md)
- [ ] Readiness flips to false first, with a drain delay before the socket closes — [Graceful shutdown](graceful-shutdown.md)
- [ ] `server.close()` is followed by `server.closeIdleConnections()` — [Graceful shutdown](graceful-shutdown.md)
- [ ] In-flight requests are awaited under a hard deadline, exiting non-zero on timeout — [Graceful shutdown](graceful-shutdown.md)
- [ ] Queue workers stop consuming and finish or return held jobs before pools close — [Graceful shutdown](graceful-shutdown.md)
- [ ] Database and Redis connections close **after** in-flight work, in dependency order — [Graceful shutdown](graceful-shutdown.md)
- [ ] The total shutdown budget fits inside `terminationGracePeriodSeconds` — [Graceful shutdown](graceful-shutdown.md)
- [ ] `server.keepAliveTimeout` exceeds the proxy's idle timeout, with `headersTimeout` above it — [Graceful shutdown](graceful-shutdown.md)
- [ ] `docker stop` returns in under a couple of seconds, proving `SIGTERM` reaches Node — [Dockerfile](dockerfile.md)
- [ ] PID 1 is an init (`dumb-init`/`tini`) or `node` directly — never a shell or npm — [Dockerfile](dockerfile.md)
- [ ] The logger is flushed before `process.exit()` — [Observability](observability.md)

## Health probes

- [ ] Separate liveness, readiness and startup endpoints exist — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] **Liveness checks nothing external.** No database, no cache, no downstream service — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Readiness checks only the dependencies a request genuinely cannot be served without — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Every dependency check has a timeout, and results are cached for a second or two — [Health checks](../databases/health-checks.md)
- [ ] Probes return 200 or 503 and reveal no hostnames, versions, or error strings — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Readiness `periodSeconds` is small enough for the shutdown flag to be noticed — [Graceful shutdown](graceful-shutdown.md)
- [ ] Probe paths are registered before auth middleware and excluded from access logs — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] The database-down case has been tested: pods go unready and stay running — [Health and readiness probes](health-and-readiness-probes.md)

## Logging

- [ ] Structured JSON logs to stdout with `pino` 10.3.1; no log files inside the container — [Logging](../express-libraries/logging.md)
- [ ] Every log line carries a correlation id via `AsyncLocalStorage` — [Observability](observability.md)
- [ ] The id is accepted from an inbound header and propagated on outbound calls — [Observability](observability.md)
- [ ] Redaction is configured for authorization headers, cookies, passwords and tokens — [Logging without leaking PII](../security/logging-without-leaking-pii.md)
- [ ] No PII, credential or full request body is logged — [Logging without leaking PII](../security/logging-without-leaking-pii.md)
- [ ] Probe endpoints are excluded from access logs — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] Errors are logged once, at the boundary, with a stack and the correlation id — [Error handling](../express/error-handling.md)
- [ ] Log level is configurable; `debug` is off in production — [Configuration](configuration.md)
- [ ] Stack traces and internal error details never reach the client — [Error handling](../express/error-handling.md)
- [ ] `pino-pretty` is a devDependency and is not used in production — [Logging](../express-libraries/logging.md)

## Monitoring and alerting

- [ ] Request rate, error rate and latency percentiles are recorded per route pattern — [Observability](observability.md)
- [ ] Metric labels use route patterns, never ids or raw paths — [Observability](observability.md)
- [ ] Event-loop delay is measured with `perf_hooks.monitorEventLoopDelay` — [Observability](observability.md)
- [ ] Connection-pool in-use and waiting counts are exported — [Connection pooling](../databases/connection-pooling.md)
- [ ] Outbound dependency latency and error rate are recorded per dependency — [Observability](observability.md)
- [ ] Queue depth and oldest-job age are monitored — [Observability](observability.md)
- [ ] At least one business metric is monitored — orders, signups, payments — [Observability](observability.md)
- [ ] Alerts fire on symptoms (error rate, latency, business volume), not causes (CPU, memory) — [Observability](observability.md)
- [ ] Every alert has a runbook link and a named owner — [Observability](observability.md)
- [ ] An SLO and error budget exist for the most important endpoint — [Observability](observability.md)
- [ ] Tracing is enabled and sampled, with the trace id in log lines — [Observability](observability.md)
- [ ] `/metrics` is not publicly reachable — [Observability](observability.md)
- [ ] Someone is actually on call, and the paging path has been tested — [Observability](observability.md)

## Dependencies and supply chain

- [ ] `npm ci` is used everywhere; `package-lock.json` is committed — [Continuous integration](ci.md)
- [ ] `npm audit --omit=dev --audit-level=high` passes in CI — [Dependency auditing](../security/dependency-auditing.md)
- [ ] No deprecated package is in use: `multer@1.x`, `csurf`, `request`, or an Express 4 async wrapper — [Dependency auditing](../security/dependency-auditing.md)
- [ ] `prom-client` has been replaced by `@prometheus-io/client` if metrics are exported — [Observability](observability.md)
- [ ] Node 24 LTS is the runtime; nothing is on an EOL line — [Prerequisites](../getting-started/prerequisites.md)
- [ ] The container image is scanned, and the base image is pinned and rebuilt on a schedule — [Dockerfile](dockerfile.md)
- [ ] GitHub Actions are pinned to a major, or a SHA where they touch secrets — [Continuous integration](ci.md)
- [ ] An automated dependency-update bot is enabled — [Dependency auditing](../security/dependency-auditing.md)

## Container and resources

- [ ] Multi-stage build; `npm ci --omit=dev` in the runtime stage — [Dockerfile](dockerfile.md)
- [ ] `.dockerignore` excludes `.env`, `.git` and `node_modules` — [Dockerfile](dockerfile.md)
- [ ] The container runs as the non-root `node` user, enforced by `runAsNonRoot` — [Dockerfile](dockerfile.md)
- [ ] Capabilities are dropped and the root filesystem is read-only where possible — [Dockerfile](dockerfile.md)
- [ ] Memory and CPU requests and limits are set on every container — [Dockerfile](dockerfile.md)
- [ ] `--max-old-space-size` is set relative to the container memory limit — [Performance](performance.md)
- [ ] One Node process per container; scaling is by replicas — [Clustering](clustering.md)
- [ ] If clustering is used, `availableParallelism()` is used, not `os.cpus().length` — [Clustering](clustering.md)
- [ ] The image was built for the deployment architecture — [Dockerfile](dockerfile.md)
- [ ] At least two replicas run, across failure domains — [Clustering](clustering.md)

## Performance

- [ ] The service has been load-tested against a realistic dataset — [Performance](performance.md)
- [ ] A latency SLO exists and current p99 meets it — [Performance](performance.md)
- [ ] No synchronous `fs`, `zlib` or `crypto` call is on the request path — [Performance](performance.md)
- [ ] Outbound HTTP uses a shared, pooled agent with keep-alive and timeouts — [Performance](performance.md)
- [ ] Compression happens at the proxy, or in Node — never both — [Compression](../express-libraries/compression.md)
- [ ] Every list endpoint paginates with a server-enforced maximum — [Performance](performance.md)
- [ ] The database slow-query log is enabled and has been reviewed — [Indexing basics](../databases/indexing-basics.md)

## Deploy and rollback

- [ ] One image is built once and promoted through environments unchanged — [Continuous integration](ci.md)
- [ ] Images are tagged with the git SHA, not only `latest` — [Dockerfile](dockerfile.md)
- [ ] Deployment is rolling or blue/green, with health gating and no downtime — [Health and readiness probes](health-and-readiness-probes.md)
- [ ] The built image was booted and smoke-tested in CI before being pushed — [Continuous integration](ci.md)
- [ ] **The rollback procedure has been executed at least once**, not just written down — [Continuous integration](ci.md)
- [ ] Rollback does not require reversing a migration; schema changes are backward-compatible — [Migration strategy](../orms/migration-strategy.md)
- [ ] Old and new versions can run simultaneously during a rolling deploy — [Migrations](../databases/migrations.md)
- [ ] Config changes are deployable and revertible independently of code — [Configuration](configuration.md)
- [ ] There is a documented incident path: who is paged, who declares, who communicates — [Observability](observability.md)
- [ ] The first deploy is scheduled when the people who wrote it are awake — [Continuous integration](ci.md)

## Production considerations

Two things about the checklist itself.

**Rerun it on a schedule.** A service that passed in March fails in September: a dependency was deprecated, an index was outgrown, a certificate is close to expiry, `max_connections` was reached by a new replica count. Quarterly is a reasonable cadence; after any incident is mandatory.

**Treat unchecked boxes as a written-down risk, not a blocker.** Very few teams check every box before the first deploy. What separates a good outcome from a bad one is knowing which boxes are unchecked and having decided that consciously. The dangerous state is not "we have no rollback plan" — it is "we assumed we had one".

Three items are worth more than the rest combined, because each one converts a routine problem into an outage:

1. **The restore has been tested.** An untested backup is a belief, not a capability.
2. **The rollback has been executed.** A procedure nobody has run does not work; you find out during the incident.
3. **Liveness checks nothing external.** This is the item that can take down an entire healthy fleet because of someone else's five-second blip.

## Common mistakes

- **Treating the checklist as a formality.** Ticking a box you did not verify is worse than an empty box, because it stops anyone looking again.
- **Assuming backups work.** Automated backups fail silently for months. Restore, or you do not have backups.
- **Writing a rollback plan without running it.** The first execution should not be during an incident.
- **A liveness probe that checks the database.** One database blip restarts every pod at once.
- **Migrations on application boot.** N replicas start; N migrations race.
- **A migration that is not backward-compatible.** During a rolling deploy both versions are live; a dropped column breaks the old one instantly.
- **Deploying on a Friday afternoon**, or when the author is unreachable.
- **Checking the security boxes only before launch.** Every release changes the attack surface.
- **Ignoring a box because "it does not apply".** Write down why. Half the time the reason does not survive being written.
- **No staging environment that resembles production.** Everything here passes on a laptop with one user and an empty database.
- **Sizing the connection pool per process and forgetting the replica count.** Multiply, then compare to `max_connections`.
- **Shipping with `debug` logging on.** Cost, noise, and the most likely path to logging something you should not.

## Related topics

- [Configuration](configuration.md) — the config and secrets group, in full.
- [Graceful shutdown](graceful-shutdown.md) — the shutdown sequence each item refers to.
- [Health and readiness probes](health-and-readiness-probes.md) — liveness, readiness and startup done correctly.
- [Observability](observability.md) — logs, metrics, traces, alerting and SLOs.
- [Dockerfile](dockerfile.md) — the container items, with the actual file.
- [Continuous integration](ci.md) — what CI should prove before a deploy is allowed.
- [Performance](performance.md) — measuring against the SLO the checklist asks for.
- [Clustering](clustering.md) — process model and replica count.
- [OWASP API Top 10 in Express](../security/owasp-api-top-10.md) — the security items, organized by threat instead.
- [Migrations](../databases/migrations.md) — backward-compatible schema change and restore testing.
- [Connection pooling](../databases/connection-pooling.md) — the arithmetic behind the pool-size item.
- [Troubleshooting](../reference/troubleshooting.md) — when something on this list turns out to be unchecked.
