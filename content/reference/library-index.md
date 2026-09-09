---
title: Library index
description: The canonical version table for every package this handbook recommends, plus the packages that are deprecated and must never be used.
status: current
updated: 2026-09-08
---

Every version on this page is the npm `dist-tags.latest` value fetched on **2026-09-08**. Pin these: a caret range (`^`) in `package.json`, the bare version in prose. `scripts/check-deps.mjs` re-verifies each one against the registry and fails the build on drift, so if a row here disagrees with what npm serves, the checker will say so before a reader does.

:::warning `prisma` is the one anomaly
The npm `latest` dist-tag for `prisma` points at **`8.0.0-rc.13`**, a release candidate. The latest **stable** release is **`7.10.0`**, and `@prisma/client` stays on `7.10.0`. Install `prisma@7` explicitly — a bare `npm install prisma` pulls the RC.
:::

## Core

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `express` | 5.2.1 | The web framework. `body-parser` is bundled. | [Setup and project structure](../express/setup-and-project-structure.md) | [expressjs.com](https://expressjs.com/) |
| `@types/express` | 5.0.6 | TypeScript types matching Express 5. | [Native TypeScript support](../node/native-typescript-support.md) | [npm](https://www.npmjs.com/package/@types/express) |
| `compression` | 1.8.1 | gzip/deflate response compression. | [Compression](../express-libraries/compression.md) | [npm](https://www.npmjs.com/package/compression) |
| `http-errors` | 2.0.1 | Typed HTTP error objects with a `status`. | [Error handling](../express/error-handling.md) | [npm](https://www.npmjs.com/package/http-errors) |
| `dotenv` | 17.4.2 | `.env` loading — prefer `node --env-file`. | [Environment variables and config](../node/environment-variables-and-config.md) | [npm](https://www.npmjs.com/package/dotenv) |
| `undici` | 8.10.2 | The HTTP client behind global `fetch`; use it directly for pools and interceptors. | [Retries and timeouts](../databases/retries-and-timeouts.md) | [undici.nodejs.org](https://undici.nodejs.org/) |
| `nanoid` | 6.0.1 | Short URL-safe ids. ESM-only. | [Configuration](../production/configuration.md) | [npm](https://www.npmjs.com/package/nanoid) |
| `uuid` | 14.0.2 | UUID generation — prefer built-in `crypto.randomUUID()`. | [Configuration](../production/configuration.md) | [npm](https://www.npmjs.com/package/uuid) |
| `bullmq` | 6.3.4 | Redis-backed job queue. | [Redis](../databases/redis.md) | [docs.bullmq.io](https://docs.bullmq.io/) |
| `node-cron` | 4.6.0 | In-process scheduled tasks. | [Clustering](../production/clustering.md) | [npm](https://www.npmjs.com/package/node-cron) |
| `pm2` | 7.0.4 | Process supervisor — a container runtime usually replaces it. | [Process management](../express-libraries/process-management-and-graceful-shutdown.md) | [pm2.keymetrics.io](https://pm2.keymetrics.io/) |

## Security

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `helmet` | 8.3.0 | Sets the standard security response headers. | [Security headers with Helmet](../express-libraries/security-headers-helmet.md) | [helmetjs.github.io](https://helmetjs.github.io/) |
| `cors` | 2.8.6 | Cross-origin resource sharing middleware. | [CORS](../express-libraries/cors.md) | [npm](https://www.npmjs.com/package/cors) |
| `express-rate-limit` | 8.7.0 | Request rate limiting. | [Rate limiting](../express-libraries/rate-limiting.md) | [npm](https://www.npmjs.com/package/express-rate-limit) |
| `rate-limit-redis` | 6.0.1 | Shared Redis store so limits survive multiple instances. | [Rate limiting](../express-libraries/rate-limiting.md) | [npm](https://www.npmjs.com/package/rate-limit-redis) |
| `csrf-csrf` | 4.0.3 | Double-submit CSRF tokens. The replacement for `csurf`. | [CSRF](../security/csrf.md) | [npm](https://www.npmjs.com/package/csrf-csrf) |
| `sanitize-html` | 2.17.7 | Server-side HTML allow-listing. | [Cross-site scripting (XSS)](../security/xss.md) | [npm](https://www.npmjs.com/package/sanitize-html) |
| `dompurify` | 3.4.15 | HTML sanitizing; needs a DOM implementation on the server. | [Cross-site scripting (XSS)](../security/xss.md) | [DOMPurify](https://github.com/cure53/DOMPurify) |
| `validator` | 13.15.35 | String format predicates (`isEmail`, `isURL`). | [Validation](../express-libraries/validation.md) | [npm](https://www.npmjs.com/package/validator) |

## Authentication and sessions

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `jsonwebtoken` | 9.0.3 | Classic JWT sign/verify. | [JWT pitfalls](../security/jwt-pitfalls.md) | [npm](https://www.npmjs.com/package/jsonwebtoken) |
| `jose` | 6.2.12 | Modern JOSE — JWKS, EdDSA, encryption. Preferred for new work. | [JWT pitfalls](../security/jwt-pitfalls.md) | [jose](https://github.com/panva/jose) |
| `argon2` | 0.45.1 | Argon2id password hashing. Native build required. | [Password hashing](../express-libraries/password-hashing.md) | [npm](https://www.npmjs.com/package/argon2) |
| `bcrypt` | 6.0.0 | bcrypt password hashing. Native build required. | [Password hashing](../express-libraries/password-hashing.md) | [npm](https://www.npmjs.com/package/bcrypt) |
| `passport` | 0.7.0 | Pluggable authentication strategies. | [Authentication](../express-libraries/authentication.md) | [passportjs.org](https://www.passportjs.org/) |
| `passport-jwt` | 4.0.1 | JWT strategy for Passport. | [Authentication](../express-libraries/authentication.md) | [npm](https://www.npmjs.com/package/passport-jwt) |
| `passport-local` | 1.0.0 | Username/password strategy. | [Authentication](../express-libraries/authentication.md) | [npm](https://www.npmjs.com/package/passport-local) |
| `express-session` | 1.19.0 | Server-side sessions. Never use the default MemoryStore in production. | [Authentication and session security](../security/authentication-and-session-security.md) | [npm](https://www.npmjs.com/package/express-session) |
| `connect-redis` | 10.0.0 | Redis session store. | [Redis](../databases/redis.md) | [npm](https://www.npmjs.com/package/connect-redis) |
| `connect-mongo` | 6.0.0 | MongoDB session store. | [MongoDB](../databases/mongodb.md) | [npm](https://www.npmjs.com/package/connect-mongo) |
| `cookie-parser` | 1.4.7 | Populates `req.cookies` and `req.signedCookies`. | [Cookies](../express-libraries/cookies.md) | [npm](https://www.npmjs.com/package/cookie-parser) |
| `cookie-session` | 2.1.1 | Cookie-backed sessions — state lives in the client. | [Cookies](../express-libraries/cookies.md) | [npm](https://www.npmjs.com/package/cookie-session) |

## Validation

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `zod` | 4.5.4 | Schema validation and inferred types. Zod 4 API: `z.email()`, not `z.string().email()`. | [Validation](../express-libraries/validation.md) | [zod.dev](https://zod.dev/) |
| `express-validator` | 7.3.2 | Chainable per-field validators as middleware. | [Validation](../express-libraries/validation.md) | [express-validator](https://express-validator.github.io/docs/) |

## Logging and observability

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `pino` | 10.3.1 | Fast structured JSON logger. | [Logging](../express-libraries/logging.md) | [getpino.io](https://getpino.io/) |
| `pino-http` | 11.0.0 | Request logging middleware for pino. | [Logging](../express-libraries/logging.md) | [npm](https://www.npmjs.com/package/pino-http) |
| `pino-pretty` | 13.1.3 | Human-readable dev output. **Dev dependency only.** | [Logging](../express-libraries/logging.md) | [npm](https://www.npmjs.com/package/pino-pretty) |
| `morgan` | 1.12.0 | Apache-style request logs. Simpler, unstructured. | [Logging](../express-libraries/logging.md) | [npm](https://www.npmjs.com/package/morgan) |
| `winston` | 3.19.0 | Transport-oriented logger. | [Logging](../express-libraries/logging.md) | [winston](https://github.com/winstonjs/winston) |

## Uploads and files

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `multer` | 2.3.0 | `multipart/form-data` parsing. **1.x is deprecated — see below.** | [File uploads](../express-libraries/file-uploads.md) | [npm](https://www.npmjs.com/package/multer) |
| `file-type` | 22.0.2 | Magic-byte content sniffing — never trust the declared MIME type. ESM-only. | [File upload security](../security/file-upload-security.md) | [npm](https://www.npmjs.com/package/file-type) |
| `sharp` | 0.35.4 | Image re-encoding, which also strips malicious payloads. | [File upload security](../security/file-upload-security.md) | [sharp.pixelplumbing.com](https://sharp.pixelplumbing.com/) |
| `@aws-sdk/client-s3` | 3.1128.0 | S3 storage and presigned URLs. | [File uploads](../express-libraries/file-uploads.md) | [AWS SDK for JavaScript](https://docs.aws.amazon.com/sdk-for-javascript/) |

## Testing

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `supertest` | 7.2.2 | HTTP assertions against an Express app without binding a port. | [Testing](../express-libraries/testing.md) | [npm](https://www.npmjs.com/package/supertest) |
| `vitest` | 5.0.0 | Test runner — we prefer the built-in `node:test`. | [The built-in test runner](../node/built-in-test-runner.md) | [vitest.dev](https://vitest.dev/) |

`node:test` needs no dependency at all: `node --test --experimental-test-coverage`.

## API documentation

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `swagger-ui-express` | 5.0.1 | Serves Swagger UI from an OpenAPI document. | [API documentation](../express-libraries/api-documentation.md) | [npm](https://www.npmjs.com/package/swagger-ui-express) |
| `@asteasolutions/zod-to-openapi` | 9.1.0 | Generates OpenAPI from Zod schemas. Note the scope. | [API documentation](../express-libraries/api-documentation.md) | [npm](https://www.npmjs.com/package/@asteasolutions/zod-to-openapi) |
| `zod-openapi` | 6.0.2 | Alternative Zod → OpenAPI generator. | [API documentation](../express-libraries/api-documentation.md) | [npm](https://www.npmjs.com/package/zod-openapi) |
| `express-openapi-validator` | 5.6.2 | Validates requests and responses against an OpenAPI spec. | [API documentation](../express-libraries/api-documentation.md) | [npm](https://www.npmjs.com/package/express-openapi-validator) |

## Database drivers

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `pg` | 8.23.0 | PostgreSQL driver and connection pool. | [PostgreSQL with pg](../databases/postgresql-with-pg.md) | [node-postgres.com](https://node-postgres.com/) |
| `mysql2` | 3.24.4 | MySQL/MariaDB driver — use `mysql2/promise`. | [MySQL with mysql2](../databases/mysql-with-mysql2.md) | [npm](https://www.npmjs.com/package/mysql2) |
| `better-sqlite3` | 13.0.3 | Synchronous SQLite. Native build; prefer `node:sqlite` where you can. | [SQLite](../databases/sqlite.md) | [npm](https://www.npmjs.com/package/better-sqlite3) |
| `sqlite3` | 6.0.1 | Legacy async SQLite driver. Prefer the two above. | [SQLite](../databases/sqlite.md) | [npm](https://www.npmjs.com/package/sqlite3) |
| `mongodb` | 7.6.0 | Official MongoDB driver. | [MongoDB](../databases/mongodb.md) | [MongoDB Node driver](https://www.mongodb.com/docs/drivers/node/current/) |
| `redis` | 6.2.1 | node-redis client. | [Redis](../databases/redis.md) | [node-redis](https://github.com/redis/node-redis) |
| `ioredis` | 6.0.0 | Alternative Redis client with cluster support. | [Redis](../databases/redis.md) | [ioredis](https://github.com/redis/ioredis) |

`node:sqlite` ships with Node 24 — no package, no native build. See [SQLite](../databases/sqlite.md).

## ORMs and query builders

| Package | Stable | npm `latest` | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- | --- |
| `prisma` | **7.10.0** | ⚠️ `8.0.0-rc.13` | Schema-first ORM CLI and migration engine. | [Prisma](../orms/prisma.md) | [prisma.io](https://www.prisma.io/docs) |
| `@prisma/client` | 7.10.0 | 7.10.0 | The generated Prisma client. Stays on 7. | [Prisma](../orms/prisma.md) | [prisma.io](https://www.prisma.io/docs) |
| `drizzle-orm` | 0.45.2 | 0.45.2 | SQL-shaped, type-safe query builder. `1.0.0-rc.4` exists on the `rc` tag. | [Drizzle](../orms/drizzle.md) | [orm.drizzle.team](https://orm.drizzle.team/) |
| `drizzle-kit` | 0.31.10 | 0.31.10 | Drizzle migration generator. | [Drizzle](../orms/drizzle.md) | [orm.drizzle.team](https://orm.drizzle.team/) |
| `typeorm` | 1.1.1 | 1.1.1 | Decorator/DataMapper ORM. It reached 1.0 — do not write `0.3.x`. | [TypeORM](../orms/typeorm.md) | [typeorm.io](https://typeorm.io/) |
| `sequelize` | 6.37.8 | 6.37.8 | Mature Active Record ORM. v7 is still alpha. | [Sequelize](../orms/sequelize.md) | [sequelize.org](https://sequelize.org/) |
| `sequelize-cli` | 6.6.5 | 6.6.5 | Sequelize migrations and seeders. | [Migrations](../databases/migrations.md) | [npm](https://www.npmjs.com/package/sequelize-cli) |
| `mongoose` | 9.9.5 | 9.9.5 | MongoDB ODM with schemas. | [Mongoose](../orms/mongoose.md) | [mongoosejs.com](https://mongoosejs.com/) |
| `knex` | 3.3.0 | 3.3.0 | Query builder and migration runner. | [Knex](../orms/knex.md) | [knexjs.org](https://knexjs.org/) |
| `kysely` | 0.29.5 | 0.29.5 | Type-safe query builder. Mentioned for comparison only. | [Comparison table](../orms/comparison.md) | [kysely.dev](https://kysely.dev/) |
| `objection` | 3.1.5 | 3.1.5 | ORM on top of Knex. Low activity; comparison only. | [Comparison table](../orms/comparison.md) | [objection.js](https://vincit.github.io/objection.js/) |

## Tooling

| Package | Version | Purpose | On this site | Docs |
| --- | --- | --- | --- | --- |
| `typescript` | 7.0.2 | The TypeScript compiler and type checker. | [Native TypeScript support](../node/native-typescript-support.md) | [typescriptlang.org](https://www.typescriptlang.org/) |
| `tsx` | 4.23.13 | TypeScript execution — largely replaced by Node 24 type-stripping. | [Native TypeScript support](../node/native-typescript-support.md) | [npm](https://www.npmjs.com/package/tsx) |
| `eslint` | 10.10.0 | Linting with flat config. | [Continuous integration](../production/ci.md) | [eslint.org](https://eslint.org/) |

## Deprecated — do not use

:::deprecated These packages must never be recommended on this site
- **`multer@1.x`** (`1.4.5-lts.2`) — npm-deprecated: *"Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x."* Use `multer@2.3.0`. See [File upload security](../security/file-upload-security.md).
- **`csurf`** — archived and unmaintained. Use `csrf-csrf@4.0.3`, or a session-bound double-submit token. See [CSRF](../security/csrf.md).
- **`express-async-handler`** — unnecessary in Express 5, which forwards rejected promises to the error handler automatically. Delete the wrapper and the dependency. See [Express 4 → 5 migration](express-4-to-5-migration.md).
- **`request`** — long dead, no longer receiving fixes. Use global `fetch` or `undici@8.10.2`.
- **`prom-client`** — npm-deprecated in favor of `@prometheus-io/client`. See [Observability](../production/observability.md).
- **`oslo`** — npm-deprecated, superseded by oslojs.dev.
- **`zod-to-openapi`** (unscoped) — deprecated. Use `@asteasolutions/zod-to-openapi@9.1.0`; the scope is the whole difference.
- **`body-parser`** as a separate install — bundled into Express 5 as `express.json()`, `express.urlencoded()`, `express.text()` and `express.raw()`.
:::

## How these versions are kept honest

- Every number came from `registry.npmjs.org` `dist-tags.latest` on **2026-09-08**.
- `node scripts/check-deps.mjs` re-fetches each package, confirms it exists, and reports drift between this table and the registry.
- `prisma` is the deliberate exception: its `latest` tag is a release candidate, so the table records the stable version and flags the tag.
- A version that changes upstream is a documentation bug, not a reader problem — fix this page and let the checker confirm it.

## Common mistakes

- **Running `npm install prisma` without a major.** The `latest` tag serves `8.0.0-rc.13`; pin `prisma@7`.
- **Installing `body-parser` out of habit.** It is bundled in Express 5.
- **Using `zod-to-openapi` without the `@asteasolutions/` scope.** The unscoped package is deprecated.
- **Leaving `pino-pretty` in `dependencies`.** It is a development formatter and should never run in production.
- **Copying a version from a blog post instead of this table.** Blog posts are not re-verified by `check-deps.mjs`.

## Related topics

- [Express 4 → 5 migration](express-4-to-5-migration.md) — what changes when you move to `express@5.2.1`.
- [Cheat sheet](cheat-sheet.md) — the install commands and configuration for the packages above.
- [Dependency auditing](../security/dependency-auditing.md) — keeping these versions safe once they are pinned.
- [package.json and npm scripts](../node/package-json-and-npm-scripts.md) — how to express these pins correctly.
