---
title: Choosing an ORM
description: TypeORM, Prisma, Mongoose, Drizzle and raw drivers inside NestJS 12 — what a first-party module actually buys you, how each one behaves in a DI container, and when no ORM is the right answer.
status: current
updated: 2026-09-11
---

Nest does not pick a data layer for you. It picks the *shape* of the integration: whatever you use has to become a provider, has to be constructed after configuration is validated, and has to be closed on shutdown. That shape is the same for all five options on this page — what differs is how much of it somebody has already written. The library-level comparison (types, migrations, weight, escape-hatch safety) is in [Comparison table](../orms/comparison.md) and is still correct; this page is only about the decision inside Nest.

## Why it exists

Two of these tools ship a Nest package and three do not, and that fact dominates the first week of a project in a way the library comparison does not capture. A first-party module is not just convenience — it decides who owns the connection lifecycle, what a unit test has to mock, and whether a health check is one line or thirty.

The second Nest-specific factor is the **repository seam**. Nest's whole value is that dependencies arrive through a constructor, so the question "can I replace this with a fake in `Test.createTestingModule()`?" has a different answer for each tool. Get that wrong and every test needs a database.

## The five options

| Option | Nest package | Version | What you write yourself |
| --- | --- | --- | --- |
| [TypeORM](./typeorm.md) | `@nestjs/typeorm` | 12.0.1 with `typeorm` 1.1.1 | Entities and migrations |
| [Mongoose](./mongoose.md) | `@nestjs/mongoose` | 12.0.0 with `mongoose` 9.10.0 | Schemas |
| [Prisma](./prisma.md) | **none** | `@prisma/client` 7.10.0 | A `PrismaService` and a `PrismaModule` — about 25 lines |
| [Drizzle](./drizzle.md) | **none** | `drizzle-orm` 0.45.2 | A custom provider, a token, and the shutdown hook |
| [Raw drivers](./raw-drivers.md) | **none** | `pg` 8.23.0, `mysql2` 3.24.4, `better-sqlite3` 13.0.3 | The pool provider, the repository layer, the SQL |

:::warning
TypeORM is on the **1.x** line. Any Nest tutorial that calls `createConnection()`, `getRepository()` as a global or `@EntityRepository` predates it. And the npm `latest` tag for `prisma` is `8.0.0-rc.13`, a release candidate — pin `prisma@7` and `@prisma/client@7`.
:::

## What a first-party module actually buys you

Four concrete things, and it is worth knowing them individually because you can reproduce all four by hand in an afternoon.

**1. Lifecycle ownership.** `TypeOrmModule.forRootAsync` and `MongooseModule.forRootAsync` connect during bootstrap and disconnect on shutdown. With Prisma or Drizzle, *you* write the `OnModuleInit`/`OnModuleDestroy` hooks — and if you forget, the failure is a rolling deploy that severs open connections rather than an error anyone sees. See [Connections and DI](../nestjs-databases/connections-and-di.md).

**2. Bootstrap retries.** `retryAttempts` / `retryDelay` exist on both modules and matter in Docker Compose and Kubernetes, where the app usually starts before the database accepts connections. A hand-rolled `useFactory` that connects eagerly has no retry unless you write one, and an `async` factory that hangs produces a process that is neither started nor failed.

**3. Per-entity provider tokens.** `forFeature([User])` and `forFeature([{ name: User.name, schema: UserSchema }])` register one provider per entity or model, so a service receives a narrow dependency instead of the whole connection. That token — `getRepositoryToken(User)`, `getModelToken(User.name)` — is what you override in a unit test.

**4. A ready-made health indicator.** `@nestjs/terminus` ships `TypeOrmHealthIndicator`, `MongooseHealthIndicator` and `PrismaHealthIndicator`. Drizzle and raw drivers need a custom indicator built on `HealthIndicatorService`. See [Health checks](../nestjs-databases/health-checks.md).

:::best-practice
Do not weight the absence of a Nest package too heavily. The `PrismaService` pattern is a class with two lifecycle methods, and the Drizzle provider is a `useFactory` returning one object. Both are in this section, both are about 25 lines, and neither has a maintenance burden. Weight items 2 and 4 instead — those are the ones people forget to write.
:::

## What each one is genuinely good at inside Nest

### TypeORM

The most *Nest-shaped* of the five. Decorated entity classes sit next to decorated controllers and providers; `@InjectRepository(User)` looks like every other injection; `Test.createTestingModule().overrideProvider(getRepositoryToken(User))` is documented and boring. If your team already thinks in Hibernate or Entity Framework terms, nothing here needs explaining.

It is also the only option with a real answer for Oracle, SAP HANA, Spanner and MSSQL.

The cost is type fidelity. `find({ select: { id: true } })` still returns `User`, so a partial select lies about the shape, and the fix is to map to a DTO immediately. It also builds full entity metadata at `initialize()`, so bootstrap time scales with schema size — visible on a readiness probe with a large schema.

### Prisma

The strongest type story, and in Nest it arrives through a **service you own** rather than a module you configure. That turns out to be an advantage: `PrismaService` is a normal provider, it can carry your own helpers, and `constructor(prisma: PrismaService)` needs no `@Inject()` decorator at all — the class is the token.

Prisma 7 moved the connection URL out of `schema.prisma` into `prisma.config.ts` and requires a **driver adapter**, which means the pool is `pg`'s pool with `pg`'s options. That is one fewer abstraction between you and the database, and it makes [Connection pooling](../nestjs-databases/connection-pooling.md) apply unchanged.

The costs are a generation step (`prisma generate` must run before the app type-checks, and it no longer runs on install), a large generated client, and a raw escape hatch that is a hard boundary — `$queryRaw` returns untyped rows.

### Mongoose

If the database is MongoDB, this is the decision. Prisma 7 dropped MongoDB support entirely, so the real question is Mongoose or the raw driver, and `@nestjs/mongoose` makes Mongoose the easy answer: `@Schema()`/`@Prop()` decorators keep the schema in the same idiom as the rest of the codebase, and `SchemaFactory.createForClass()` produces the Mongoose schema from it.

Mongoose is also the only tool here with a **schema-level** defence against field disclosure: `@Prop({ select: false })` on a password hash keeps it out of results unless a query asks for it.

The cost is that its injection risk is not SQL and is open by default — a `{ $ne: null }` from a request body is an authentication bypass. See [Mongoose](./mongoose.md) and [NoSQL injection](../nestjs-security/nosql-injection.md).

### Drizzle

The best fit when you want SQL to stay visible and the runtime to stay small. There is **no `@nestjs/drizzle`** — the integration is a community pattern, not a Nest package — but the pattern is a single `useFactory` provider, and after that the schema is plain TypeScript and every query reads like the SQL it becomes.

Two Nest-specific advantages. Drizzle has zero runtime dependencies and no metadata build, so bootstrap is as fast as constructing a `pg` pool — which matters if you deploy to anything that cold-starts. And because the `db` object is a plain value, faking it in a test is a plain object, with no decorator or token machinery.

The costs are the missing package (you own the lifecycle, the health indicator and the multi-database naming), type-check time on large schemas, and a documentation site that has largely moved to the 1.0 release candidate.

### Raw drivers

Not a fallback — a legitimate choice for a service whose data access is a dozen well-understood queries, and the right tool *inside* an ORM project for reporting, bulk loads and anything where you need to control the plan. A `pg` `Pool` as a provider plus a repository class per aggregate is a complete, testable data layer. See [Raw drivers](./raw-drivers.md).

## Type safety

| Tool | Source of types | Partial select narrows? | Drift risk |
| --- | --- | --- | --- |
| Prisma | Generated from `schema.prisma` | Yes, exactly | None, once `generate` has run |
| Drizzle | Inferred from the TS schema | Yes | None — no generation step to forget |
| TypeORM | Entity class decorators | **No** — returns the entity type | Low; the entity is the schema |
| Mongoose | `HydratedDocument<T>` from the `@Schema()` class | Partially | Low for scalars, weak for `populate()` |
| Raw driver | Interfaces you write | Yes, if the interface is right | **High** — nothing checks it against the database |

The Nest-specific note: none of this reaches your controllers if you map to DTOs at the service boundary, which you should be doing anyway. An exactly typed query result is most valuable *inside* the service, where it catches a renamed column at compile time. See [Serialization](../nestjs-validation/serialization.md).

## Migrations

| Tool | Generated? | Format | Nest-specific gotcha |
| --- | --- | --- | --- |
| TypeORM | Yes, entity diff | TypeScript classes | The CLI cannot read your module graph — it needs its own `DataSource` file |
| Prisma | Yes, with a shadow DB | Plain `.sql` | `migrate dev` no longer runs `generate` or the seed script |
| Drizzle | Yes, from a snapshot | Plain `.sql` | Commit `drizzle/meta` or the next diff is a full-schema migration |
| Mongoose | N/A | Bring your own | `autoIndex` builds indexes on model compile — turn it off in production |
| Raw driver | No | Whatever you pick | Nothing is provided; `node-pg-migrate`, Knex or plain `.sql` files |

The rule that applies to all five: **migrations run in a release step, never at boot.** `migrationsRun: true`, `synchronize: true`, `autoIndex` in production, and a `migrate()` call in `main.ts` are the same mistake wearing four hats — on three replicas they race each other. [Migrations](../nestjs-databases/migrations.md) has the pipeline.

## When no ORM is right

- **The service owns fewer than about twenty queries** and they are all well understood. A repository class over a `pg` pool is less code than a schema plus a generated client, and it has no version to keep pinned.
- **The work is reporting.** Window functions, `GROUP BY ROLLUP`, recursive CTEs and `LATERAL` joins are either awkward or impossible in every query API here. Writing them as SQL is not a compromise, it is the shorter path.
- **The work is bulk.** `COPY` on Postgres, `LOAD DATA` on MySQL, or a single multi-row `INSERT … ON CONFLICT` beats any per-row ORM call by an order of magnitude.
- **You need exact plan control.** Index hints, `SET LOCAL`, materialized-CTE fencing and `FOR UPDATE SKIP LOCKED` are things you tell the database, not your ORM.
- **The data is not relational at all.** A cache, a queue, a blob store. [Redis](../nestjs-databases/redis.md) is a provider like any other and no ORM is involved.

Running two tools is normal and usually better than contorting one: Prisma or TypeORM for the CRUD surface and a `pg` pool for six reporting queries. The only rule is that **one tool owns the schema** — two migration sources of truth is a guaranteed drift.

## A decision, in order

1. **MongoDB?** Mongoose with `@nestjs/mongoose`. There is no real second option.
2. **Oracle, SAP HANA, Spanner, or a team fluent in class-based entities?** TypeORM with `@nestjs/typeorm`.
3. **New TypeScript project on Postgres/MySQL/SQLite, mixed-seniority team, want migrations you did not write?** Prisma with a `PrismaService`. This is the default and the hardest to regret.
4. **Team knows SQL, cares about cold start or bundle size, or needs CTEs and window functions routinely?** Drizzle with a custom provider.
5. **A small service, a reporting job, or a bulk path inside any of the above?** A raw driver.

Nothing here is irreversible, but the exit costs differ. A repository layer — the ORM imported in one directory instead of forty — is what makes them all cheaper; see [Repository vs active record](./repository-vs-active-record.md).

## Security considerations

**Every one of these parameterises its generated queries.** If you only use the repository API, the model API or the query builder, you cannot inject SQL. All the holes are in the raw path, and each page in this section covers its own:

| Tool | Safe raw form | Dangerous form |
| --- | --- | --- |
| TypeORM | `.where('id = :id', { id })`, `query(sql, params)` | `.where('id = ' + id)`, `orderBy(userInput)` |
| Prisma | `` $queryRaw`…${v}` ``, `Prisma.sql`, `Prisma.join` | `$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw` |
| Drizzle | `` sql`…${v}` `` | `sql.raw()` |
| Mongoose | validated scalars, `sanitizeFilter` | a filter built from `req.body`, `$where` |
| Raw `pg` | `$1` placeholders | template interpolation |

**Mongoose is the outlier and it is worth saying plainly.** Its injection vector needs no raw API at all: `findOne({ email, password: req.body.password })` is ordinary code and an authentication bypass. The control is the global `ValidationPipe` plus `sanitizeFilter`, and neither is on by default.

**No tool protects dynamic identifiers.** Table names, column names and `ORDER BY` targets are syntax, not values, so no placeholder in any of the five can carry them. The fix is identical everywhere: an allow-list mapping a request token to an identifier you wrote. [SQL injection](../nestjs-security/sql-injection.md) has the full threat model.

**Mass assignment is universal.** `data: req.body` (Prisma), `.set(req.body)` (Drizzle), `create(req.body)` (TypeORM, Mongoose) all write whatever they are given. The global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` strips unknown fields before a service sees them — and the service should still construct the write from named fields, because a DTO can legitimately hold fields the entity must not take from a request. See [The ValidationPipe](../nestjs-validation/validation-pipe.md).

**Field exposure is universal too.** Every tool returns all columns by default. Mongoose's `select: false` and TypeORM's `select: false` are the only schema-level defences; Prisma, Drizzle and raw drivers need an explicit projection on every read that reaches a response body.

**The application user should not own the schema.** Whichever tool you pick, the app connects with a role that can read and write rows and nothing else, and DDL belongs to the migration job's role. That single control turns an injection that reaches your connection from a catastrophe into a data-disclosure incident.

## Production considerations

- **Whatever you choose, `app.enableShutdownHooks()` in `main.ts`.** It is not on by default, and without it no `OnModuleDestroy` runs on `SIGTERM` — so the pool is never drained on any of the five.
- **Size the pool against the database, not the app.** `max` × replica count is your real connection count. TypeORM calls it `poolSize`, Prisma passes it to the adapter, Drizzle and raw drivers use the driver's `max`, Mongoose uses `maxPoolSize` — whose driver default of 100 is far too high.
- **Set an acquisition timeout on all of them.** The `pg` default is wait-forever, and Mongoose buffers commands while disconnected. Either one turns pool exhaustion into an outage instead of fast 503s. [Retries and timeouts](../nestjs-databases/retries-and-timeouts.md).
- **Bound the initial connect.** `retryAttempts`/`retryDelay` on the two Nest modules; a timeout inside your `useFactory` for the others.
- **Budget for the generation or metadata step.** Prisma needs `prisma generate` in CI and in the Docker build before `tsc`; TypeORM builds entity metadata at `initialize()`; Drizzle costs `tsc` time instead. Only one of the three is a deploy-pipeline change.
- **Pin the majors.** `prisma`'s `latest` tag is an RC, `typeorm@1.1.1` requires Node 24.11+ on the 24 line, and `drizzle-orm` and `drizzle-kit` share a snapshot format and must move together.
- **Turn on slow-query logging in staging for all five** and log the SQL and the duration but never the parameters — those are user data. [Safe logging](../nestjs-security/safe-logging.md).
- **Decide the transaction convention before the second service needs one.** The container hands out pool-bound handles, so a transaction that spans services needs either an explicit parameter or `AsyncLocalStorage`. Pick one. [Transactions](../nestjs-databases/transactions.md).

## Common mistakes

- **Choosing on download counts or benchmarks.** The gap between any two of these on a CRUD workload is smaller than one missing index.
- **Ruling out Prisma or Drizzle because there is no `@nestjs/` package.** The integration is about 25 lines and it is in this section.
- **Ruling out TypeORM on `0.3.x` reputation.** The 1.0 release removed the global helpers that caused most of it.
- **Picking Prisma for MongoDB.** Prisma 7 does not support it.
- **Reading `0.3.x` TypeORM or Drizzle 1.0-RC documentation** against the versions you actually installed. Both are the first hit for most searches.
- **Letting two tools own the schema.** One migration source of truth, always.
- **Assuming an ORM removes the need to read SQL.** It changes reading SQL from optional to mandatory.
- **Injecting the connection, pool or `DataSource` straight into a controller.** Nothing then sits between HTTP and the database.
- **Deferring the transaction decision.** Retrofitting `AsyncLocalStorage` onto forty services is a much worse afternoon than choosing on day one.
- **Forgetting that the ORM choice does not change the shutdown, pooling or migration rules.** All five need the same operational work.

## Related topics

- [TypeORM](./typeorm.md), [Prisma](./prisma.md), [Mongoose](./mongoose.md), [Drizzle](./drizzle.md), [Raw drivers](./raw-drivers.md) — the integration detail behind every row above.
- [Comparison table](./comparison.md) — the same five scored side by side, with a "pick this if" list.
- [Repository vs active record](./repository-vs-active-record.md) — the pattern that makes changing your mind later cheap.
- [Avoiding N+1](./avoiding-n-plus-one.md) — the performance bug every one of these makes easy.
- [When to use an ORM](../orms/when-to-use-an-orm.md) — the framework-independent version of this decision.
- [Comparison table](../orms/comparison.md) — the library-level scoring, including Sequelize and Knex.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — the provider shape all five have to fit.
- [Migrations](../nestjs-databases/migrations.md) — the deploy pipeline none of them give you for free.
- [Health checks](../nestjs-databases/health-checks.md) — which Terminus indicators exist, and writing your own.
- [SQL injection](../nestjs-security/sql-injection.md) — the threat behind the escape-hatch table.
- [Choosing a database](../databases/choosing-a-database.md) — the decision that comes before this one.
