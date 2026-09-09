---
title: What this covers
description: A map of the nine sections with a reason to read each, and an explicit list of what this handbook deliberately leaves out.
status: current
updated: 2026-09-08
---

Nine sections, roughly a hundred pages, all written against Node 24 LTS and Express 5. This page tells you what is in each one and — just as importantly — what is not here at all, so you do not spend an hour searching for a topic that was never written.

## The nine sections

| Section | Read it when |
| --- | --- |
| [Getting Started](introduction.md) | You want the scope, the opinions, the tooling and how to run the code. |
| [Node.js Fundamentals](../node/runtime-and-event-loop.md) | You need to understand the runtime under Express before you can debug it. |
| [Express Fundamentals](../express/setup-and-project-structure.md) | You are writing routes, middleware and error handling, or laying an app out. |
| [Express Libraries](../express-libraries/security-headers-helmet.md) | You need to pick and configure the packages a real API depends on. |
| [Databases](../databases/choosing-a-database.md) | You are talking to a database directly — drivers, pools, transactions, migrations. |
| [ORMs and Query Builders](../orms/when-to-use-an-orm.md) | You are deciding whether to use an ORM, or already have one and want it safe. |
| [Security](../security/owasp-api-top-10.md) | Anything you build is reachable from the internet. |
| [Production](../production/configuration.md) | You need it deployed, observable, and able to survive a restart. |
| [Reference](../reference/express-4-to-5-migration.md) | You are looking something up rather than learning it. |

### Getting Started

Four pages. [Introduction](introduction.md) states the scope and the opinions. This page maps the site. [Prerequisites](prerequisites.md) covers Node 24, version managers, npm 11, Docker, and editor setup. [Running the examples](running-the-examples.md) covers the `examples/` directory and the site's own validators.

### Node.js Fundamentals

The runtime itself, because most Express problems are actually Node problems.

- [Runtime and the event loop](../node/runtime-and-event-loop.md) — why one blocking call stalls every concurrent request.
- [ESM vs CommonJS](../node/esm-vs-commonjs.md) — the interop rules, and why the site is ESM-only.
- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — fields that matter, and `node --run`.
- [Async/await and promises](../node/async-await-and-promises.md) — concurrency, `Promise.all` vs `allSettled`, cancellation.
- [Error handling](../node/error-handling.md) — operational vs programmer errors, and when to let the process die.
- [Streams and buffers](../node/streams-and-buffers.md) — how to move data without loading it into memory.
- [Files and paths](../node/fs-and-path.md) — `node:fs/promises`, and path traversal.
- [The http module](../node/the-http-module.md) — what Express is a thin layer over.
- [Environment variables and config](../node/environment-variables-and-config.md) — `--env-file` and the shape of config.
- [The built-in test runner](../node/built-in-test-runner.md) — `node --test`, no test framework required.
- [Debugging](../node/debugging.md) — the inspector, heap and CPU profiles.
- [Native TypeScript support](../node/native-typescript-support.md) — type stripping, and exactly what it will not do.

### Express Fundamentals

Express 5 from the ground up.

- [Setup and project structure](../express/setup-and-project-structure.md) — a layout that survives growth.
- [Routing](../express/routing.md) — first match wins, in registration order.
- [Route parameters and path syntax](../express/route-parameters-and-path-syntax.md) — what path-to-regexp v8 accepts, and what it now rejects.
- [Middleware](../express/middleware.md) — the stack, and ordering rules that decide correctness.
- [Request and response](../express/request-and-response.md) — the objects every handler gets, with the Express 5 changes.
- [Error handling](../express/error-handling.md) — where a rejected async handler ends up.
- [Routers and modularity](../express/routers-and-modularity.md) — splitting the app up.
- [Static files](../express/static-files.md) — including the `dotfiles` default that breaks `/.well-known`.
- [Templating](../express/templating.md) — server-rendered views, and escaping.
- [Layered architecture](../express/layered-architecture.md) — route, controller, service, repository.

### Express Libraries

The packages you actually install, each with the current major version and its failure modes.

- [Security headers with Helmet](../express-libraries/security-headers-helmet.md) — what each header buys you.
- [CORS](../express-libraries/cors.md) — the preflight, and why `origin: true` is not "allow all".
- [Rate limiting](../express-libraries/rate-limiting.md) — and why an in-memory store breaks across replicas.
- [Validation](../express-libraries/validation.md) — Zod 4 at the edge.
- [Authentication](../express-libraries/authentication.md) — sessions vs tokens, honestly compared.
- [Password hashing](../express-libraries/password-hashing.md) — argon2 parameters that mean something.
- [File uploads](../express-libraries/file-uploads.md) — multer 2.x, since 1.x is deprecated.
- [Logging](../express-libraries/logging.md) — pino, structured output, redaction.
- [Compression](../express-libraries/compression.md) — and when to leave it to the proxy.
- [Cookies](../express-libraries/cookies.md) — the attribute matrix that decides whether they are safe.
- [API documentation](../express-libraries/api-documentation.md) — OpenAPI generated from the schemas you already wrote.
- [Testing](../express-libraries/testing.md) — `node:test` plus supertest.
- [Process management](../express-libraries/process-management-and-graceful-shutdown.md) — supervisors, restarts, signals.

### Databases

- [Choosing a database](../databases/choosing-a-database.md) — a decision list with the costs attached.
- [PostgreSQL with pg](../databases/postgresql-with-pg.md), [MySQL with mysql2](../databases/mysql-with-mysql2.md), [SQLite](../databases/sqlite.md), [MongoDB](../databases/mongodb.md), [Redis](../databases/redis.md) — the drivers, parameterised.
- [Connection pooling](../databases/connection-pooling.md) — the setting that most often causes a production outage.
- [Transactions](../databases/transactions.md) — isolation levels and where to put the boundary.
- [Migrations](../databases/migrations.md) and [Seeding](../databases/seeding.md) — schema change without downtime.
- [Health checks](../databases/health-checks.md) — a query cheap enough to run every few seconds.
- [Retries and timeouts](../databases/retries-and-timeouts.md) — because the network is not reliable.
- [N+1 queries](../databases/n-plus-one-queries.md) and [Indexing basics](../databases/indexing-basics.md) — where your latency actually goes.

### ORMs and Query Builders

[When to use an ORM](../orms/when-to-use-an-orm.md), then one page each for [Prisma](../orms/prisma.md), [Drizzle](../orms/drizzle.md), [TypeORM](../orms/typeorm.md), [Sequelize](../orms/sequelize.md), [Mongoose](../orms/mongoose.md) and [Knex](../orms/knex.md), a [comparison table](../orms/comparison.md), a [migration strategy](../orms/migration-strategy.md), and [testing with a database](../orms/testing-with-a-database.md).

### Security

Seventeen pages, each structured as threat → exploit → fix → verification. Start with [OWASP API Top 10 in Express](../security/owasp-api-top-10.md), which indexes the rest: [SQL injection](../security/sql-injection.md), [NoSQL injection](../security/nosql-injection.md), [XSS](../security/xss.md), [CSRF](../security/csrf.md), [authentication and session security](../security/authentication-and-session-security.md), [JWT pitfalls](../security/jwt-pitfalls.md), [secrets management](../security/secrets-management.md), [CORS misconfiguration](../security/cors-misconfiguration.md), [rate limiting and abuse](../security/rate-limiting-and-abuse.md), [mass assignment](../security/mass-assignment.md), [IDOR](../security/broken-object-level-authorization.md), [file upload security](../security/file-upload-security.md), [dependency auditing](../security/dependency-auditing.md), [security headers](../security/security-headers.md), [HTTPS and TLS](../security/https-and-tls.md), and [logging without leaking PII](../security/logging-without-leaking-pii.md).

### Production

- [Configuration](../production/configuration.md) — one validated, frozen config object; fail fast at boot.
- [Graceful shutdown](../production/graceful-shutdown.md) — the exact ordering that avoids dropped requests and 502s.
- [Clustering](../production/clustering.md) — when it helps, and when the orchestrator already did it.
- [Health and readiness probes](../production/health-and-readiness-probes.md) — and the liveness probe that restarts your whole fleet.
- [Observability](../production/observability.md) — logs, metrics, traces, and what to alert on.
- [Dockerfile](../production/dockerfile.md) — multi-stage, non-root, correct PID 1.
- [Continuous integration](../production/ci.md) — a workflow that actually catches things.
- [Performance](../production/performance.md) — measure first; the database usually wins.
- [Deployment checklist](../production/deployment-checklist.md) — the page to open before you ship.

### Reference

[Express 4 → 5 migration](../reference/express-4-to-5-migration.md), a [cheat sheet](../reference/cheat-sheet.md), the [library index](../reference/library-index.md) of every pinned version, and [troubleshooting](../reference/troubleshooting.md).

## What this does NOT cover

Scope is a feature. These are deliberate omissions, not gaps waiting to be filled.

| Not covered | Why, and where to go instead |
| --- | --- |
| **GraphQL** | A different request model, a different security model (query depth and complexity limits, persisted queries, per-field authorization) and a different tooling stack. Covering it properly would be its own handbook; covering it briefly would be worse than not covering it. |
| **gRPC and Protocol Buffers** | Same reason. It is a good choice for service-to-service traffic, and nothing here applies to it beyond the process-level operational pages. |
| **WebSockets and realtime** | Mentioned where it changes an operational decision — [graceful shutdown](../production/graceful-shutdown.md) has to drain long-lived connections, and [clustering](../production/clustering.md) breaks broadcast without a shared backplane — but there is no page on `ws`, Socket.IO, presence, or scaling fan-out. |
| **Frontend frameworks** | Out of scope for this pass. A Next.js section is planned as a later addition and will cover the client, rendering, and the boundary with these APIs. React, Vue and Svelte specifics stay out. |
| **Kubernetes operations** | The pages tell you what your *application* must do to behave in an orchestrator — `SIGTERM` handling, probe endpoints, the deregistration race, one process per container. Writing manifests, Helm charts, ingress, service meshes, autoscaling and cluster operations are not covered. |
| **Message brokers in depth** | Queues appear where they affect shutdown ordering and background work, and BullMQ is named. RabbitMQ topologies, Kafka partitioning and consumer-group semantics, exactly-once delivery and event-driven architecture are not covered. |

Also out of scope: serverless platform specifics beyond the connection-pooling consequence, mobile clients, browser JavaScript, CSS, machine learning, and any cloud provider's console.

:::note
"Not covered" means the site will not teach it. It does not mean avoid it. If your problem genuinely needs a message broker, use one — just get the design from a source that specializes in it.
:::

## How to tell whether a page is current

Every page carries `status` and `updated` in its front matter. `status: current` is the default and the vast majority. `status: legacy` means the page documents old-Node or Express 4 material on purpose; there is exactly one such page. `status: deprecated` marks material kept only so search finds it and tells you what replaced it.

Inline, Express 4 idioms are wrapped in a `:::legacy` callout and removed APIs in a `:::deprecated` callout. If you see neither marker, the code is meant for Express 5 on Node 24.

## Common mistakes

- **Searching for a topic in the wrong section.** Rate limiting has a configuration page under [Express Libraries](../express-libraries/rate-limiting.md) and a threat page under [Security](../security/rate-limiting-and-abuse.md). Same for logging, CORS, file uploads and security headers — the library page tells you how, the security page tells you why and what breaks.
- **Assuming an omission is an oversight.** The table above is the complete out-of-scope list. GraphQL is not hiding in a subsection.
- **Reading Production before Security.** Most of the checklist items in [Deployment checklist](../production/deployment-checklist.md) link into Security. The checklist is an index, not a substitute.
- **Expecting Express 4 answers.** Only [Express 4 → 5 migration](../reference/express-4-to-5-migration.md) contains them. Everywhere else, an Express 4 snippet found on the web will contradict this site — and the site is the one written against 5.2.1.

## Related topics

- [Introduction](introduction.md) — the opinions behind the structure above.
- [Prerequisites](prerequisites.md) — what to install before you start.
- [Running the examples](running-the-examples.md) — every example, and the validators that check this site.
- [Library index](../reference/library-index.md) — the verified version table referenced throughout.
- [Cheat sheet](../reference/cheat-sheet.md) — the condensed version of the whole site.
- [Deployment checklist](../production/deployment-checklist.md) — the fastest audit of what you are missing.
