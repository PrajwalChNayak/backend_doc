# Unverified / deliberately omitted — `content/nestjs-databases/`

Pass date: **2026-09-11**. Everything written into the twelve pages of this section
was checked against an unpacked package's own `.d.ts` or against a fact already
recorded in `CONTRIBUTING.md` Part 2. The items below could **not** be verified to
that standard and were therefore left out of the pages entirely, per
CONTRIBUTING §1.4 and §12.2.

## Packages named in the brief or commonly expected, but omitted

| Item | Why it is not in the pages |
| --- | --- |
| `nestjs-cls` | The usual community answer to "transaction context in Nest". Its current version and its `ClsModule`/`@Transactional()` API surface were not verified against the registry or its `.d.ts`. The `transactions.md` page therefore builds the same pattern directly on `node:async_hooks` `AsyncLocalStorage`, which is a verified Node built-in. |
| `typeorm-transactional` | Same reason. The `@Transactional()` decorator and its `initializeTransactionalContext()` bootstrap requirement are widely used but unverified here. |
| `@testcontainers/postgresql` / `testcontainers` | Version and API not verified. `testing-with-a-database.md` uses a plain `docker run` one-liner and a `TEST_DATABASE_URL`, which needs no package at all and matches the Part-1 examples convention. |
| `@nestjs/sequelize`, `@mikro-orm/nestjs` | Named only where `@nestjs/terminus@12.0.0`'s own `health-indicator/index.d.ts` exports `SequelizeHealthIndicator` and `MikroOrmHealthIndicator`. Their own package versions were not checked, so no installation instruction or configuration example is given for either. |
| `@nestjs/schedule` cron providers in the seeding page | Mentioned only as "things a full `AppModule` would start". No `@Cron` API is documented here; that belongs to `nestjs-libraries/schedule.md`. |
| `pg-boss`, `graphile-worker`, and other queue-on-Postgres libraries | Not verified; `SKIP LOCKED` job queues are described in prose in `../databases/transactions.md` and not re-introduced here. |
| `opossum` (circuit breaker) | `retries-and-timeouts.md` shows a hand-written breaker as a singleton provider instead. The library's version and API were not verified. |
| `@prometheus-io/client` | `connection-pooling.md` describes exporting the pool counters without naming a metrics client, because the Part-1 notes flag `prom-client` as npm-deprecated and the replacement's version was not re-verified for this pass. |

## Facts confirmed by absence (worth recording so nobody "fixes" them)

- **`@nestjs/terminus@12.0.0` has no built-in Redis health indicator.** The full
  exported list in `dist/health-indicator/index.d.ts` is: HTTP, Mongoose, TypeORM,
  MikroORM, Sequelize, Prisma, microservice, gRPC, disk, memory. `health-checks.md`
  therefore builds a Redis indicator with `HealthIndicatorService`, which is the
  supported extension point.
- **`IsolationLevel` is not exported from `typeorm`'s root entry** in 1.1.1
  (`index.d.ts` exports `DataSource` but not the isolation type; the type lives at
  `driver/types/IsolationLevel`). `transactions.md` declares a local string-union
  type rather than importing a type that is not re-exported.
- **`Connection` and `AbstractRepository` resolve to `undefined` on TypeORM 1.x.**
  `@nestjs/typeorm@12.0.1`'s `common/typeorm-compat.d.ts` says so explicitly, and
  `InjectConnection` is marked `@deprecated` there. No page uses any of the three.
- **`pingCheck(key, { timeout })` is deprecated in Terminus 12.0.0**, in favour of
  chaining `.withTimeout(ms)` on the returned `HealthCheckAttempt`. Both forms are
  in the shipped types; only the chained form is documented.

## Generated-code APIs referenced but not unpackable

`transactions.md` and `migrations.md` reference `Prisma.TransactionClient` and
`Prisma.TransactionIsolationLevel.Serializable`. These live in the **generated**
client (`src/generated/prisma/client` under the Prisma 7 `prisma-client`
generator), not in a published `.d.ts` that `npm pack` can produce, so they were
taken from the already-fact-checked `content/orms/prisma.md` rather than verified
independently. If a future pass regenerates a client and finds these renamed, both
pages need the same edit.

## Not attempted

- No `examples/` directory was created for this section. Per the section brief the
  work was confined to `content/nestjs-databases/` and this notes file.
- MySQL's per-statement `MAX_EXECUTION_TIME` optimizer hint is documented in
  `retries-and-timeouts.md` as SQL, not as a driver option, because no `mysql2`
  option was found that applies it automatically.
