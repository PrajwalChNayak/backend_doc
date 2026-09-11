---
title: Comparison table
description: TypeORM, Prisma, Mongoose, Drizzle and raw drivers scored inside NestJS 12 on first-party module, type safety, migrations, relation loading, raw-SQL ergonomics, escape-hatch safety, maturity and learning curve — with actual recommendations.
status: current
updated: 2026-09-11
---

Five options, one decision. This page scores them on the dimensions that change how a Nest codebase feels six months in, and then tells you which to pick. The library-level comparison — including Sequelize, Knex, Kysely and Objection — is in [Comparison table](../orms/comparison.md) and is still correct; everything here is either Nest-specific or a dimension where Nest changes the weighting.

Versions were verified against the npm registry on 2026-09-09: `@nestjs/typeorm` 12.0.1, `typeorm` 1.1.1, `@nestjs/mongoose` 12.0.0, `mongoose` 9.9.5, `@prisma/client` 7.10.0, `drizzle-orm` 0.45.2, `pg` 8.23.0.

## Why it exists

Most comparisons refuse to recommend anything. You have to pick one, and the differences here are durable rather than matters of taste.

Two framings to discard first. **Benchmarks are noise** at this layer — the gap between any two of these on a CRUD workload is smaller than one missing index. And **"most popular" is not a criterion**: the tool with the most tutorials is TypeORM, and most of those tutorials document a version that no longer exists.

What actually matters inside Nest is how much of the container work is already done, how loudly the tool tells you when you have broken something, and how safe its escape hatch is when you need raw SQL — which you will.

## The table

### Integration

| | [TypeORM](./typeorm.md) | [Prisma](./prisma.md) | [Mongoose](./mongoose.md) | [Drizzle](./drizzle.md) | [Raw drivers](./raw-drivers.md) |
| --- | --- | --- | --- | --- | --- |
| **First-party Nest module** | **Yes** — `@nestjs/typeorm` 12.0.1 | No | **Yes** — `@nestjs/mongoose` 12.0.0 | No | No |
| Connection lifecycle | Module owns it | You write `OnModuleInit` / `OnModuleDestroy` | Module owns it | You write the hook on a class | You write the hook on a class |
| Bootstrap retries | `retryAttempts` / `retryDelay` | Yours to write | `retryAttempts` / `retryDelay` | Yours to write | Yours to write |
| Per-entity provider | `forFeature([User])` | None — one client | `forFeature([{ name, schema }])` | None — one `db` | None — one pool |
| Injection form | `@InjectRepository(User)` | `constructor(prisma: PrismaService)` | `@InjectModel(User.name)` | `@Inject(DRIZZLE)` | `@Inject(PG_POOL)` or a service |
| Test seam | `getRepositoryToken(User)` | the `PrismaService` class | `getModelToken(User.name)` | the `DRIZZLE` token | the pool token or service |
| Terminus indicator | `TypeOrmHealthIndicator` | `PrismaHealthIndicator` | `MongooseHealthIndicator` | **none — write one** | **none — write one** |
| Integration code you own | ~0 lines | ~25 lines | ~0 lines | ~30 lines | ~40 lines |

The "integration code you own" row is the one people over-weight. Twenty-five lines is not a reason to choose a tool; a missing health indicator and a missing bootstrap retry are things you will forget, which is why they get their own rows.

### Type safety

| | TypeORM | Prisma | Mongoose | Drizzle | Raw drivers |
| --- | --- | --- | --- | --- | --- |
| Source of types | Entity class decorators | Generated from `schema.prisma` | `HydratedDocument<T>` from the `@Schema()` class | Inferred from the TS schema | Interfaces you write |
| Partial `select` narrows | **No** — returns the entity type | **Yes, exactly** | Partially | **Yes** | Yes, if the interface is right |
| Relations typed | Partially | **Yes, nested** | Needs explicit generics on `populate` | Yes, via `with` | N/A |
| Drift risk | Low | None once `generate` has run | Low for scalars | None | **High** — nothing checks it |
| Generation step | No | **Yes** — `prisma generate` before `tsc` | No | No | No |
| Cost | Metadata build at boot | Generated-client size, CI step | Weak on populate and discriminators | `tsc` time on large schemas | Correctness is on you |

The distinction that matters is **drift**. Prisma and Drizzle derive types from a schema artifact, so a schema change immediately changes the types. Hand-written row interfaces cannot disagree with the database loudly — only silently, at runtime, in production.

The Nest-specific caveat: none of this reaches your controllers if you map to DTOs at the service boundary, which you should be doing anyway. Exact query types are most valuable *inside* a service, where they turn a renamed column into a compile error. [Serialization](../nestjs-validation/serialization.md).

### Migrations

| | TypeORM | Prisma | Mongoose | Drizzle | Raw drivers |
| --- | --- | --- | --- | --- | --- |
| Generated from the schema | Yes, entity diff | **Yes**, with a shadow DB | N/A — schemaless | Yes, from a snapshot | No |
| Format | TypeScript classes | Plain `.sql` | Data scripts (`migrate-mongo`) | Plain `.sql` | Whatever you pick |
| Runner | `typeorm migration:run` | `prisma migrate deploy` | External | `drizzle-kit migrate` | External |
| Drift detection / status | `migration:show` | **`migrate status`, `migrate resolve`** | None | `drizzle-kit check` | None |
| Nest-specific gotcha | CLI needs its own `DataSource` file | `migrate dev` no longer runs `generate` | `autoIndex` builds indexes on model compile | commit `drizzle/meta` or the next diff is the whole schema | nothing provided at all |
| Boot-time footgun to disable | `synchronize`, `migrationsRun` | calling `migrate deploy` in `onModuleInit` | `autoIndex` in production | calling `migrate()` in `main.ts` | — |

Prisma has the most complete migration story of the five and it is the main reason it is the default recommendation below. Every generator here renders a column rename as `DROP COLUMN` plus `ADD COLUMN` — a diff cannot know intent — so **read every generated migration** on all three.

The rule that applies to all five: migrations run in a release step, never at boot. Three replicas booting together race the same migration. [Migrations](../nestjs-databases/migrations.md).

### Relation loading

| | Mechanism | Default strategy | N+1 risk |
| --- | --- | --- | --- |
| TypeORM | `relations: { posts: true }`, `leftJoinAndSelect` | join, `relationLoadStrategy` configurable | **Medium** — `eager: true` and `Promise<T>` lazy relations both exist |
| Prisma | `include` / nested `select` | a separate query per relation | Low — no lazy proxies |
| Mongoose | `populate()` | a second query with `$in` | **High** — populating in a loop is easy to write |
| Drizzle | `with` (relational) or explicit joins | one statement for relational queries | Low |
| Raw drivers | you write the join or the `= ANY($1)` batch | none | N/A — you own it |

Nobody is immune, because the N+1 is almost always a `for` loop somebody wrote. The tools that make it *easiest* are the ones with lazy proxies, where a property access is secretly a query — which in a Nest codebase means a serializer or an interceptor can issue queries nobody can see in the service. [Avoiding N+1](./avoiding-n-plus-one.md).

### Raw SQL ergonomics and escape-hatch safety

| | Safe form | Dangerous form | Composable? | How easy is the mistake? |
| --- | --- | --- | --- | --- |
| TypeORM | `.where('id = :id', { id })`, `query(sql, params)` | `.where('id = ' + id)`, `orderBy(userInput)` | Builder composes; raw does not | **Medium** — `where()` takes a string, so concatenation is one keystroke away |
| Prisma | `` $queryRaw`…${v}` ``, `Prisma.sql`, `Prisma.join` | `$queryRawUnsafe`, `$executeRawUnsafe`, **`Prisma.raw`** | Yes, via `Prisma.sql`/`join`/`empty` | **Low** — "Unsafe" is in the name; `Prisma.raw` inside a safe template is the trap |
| Mongoose | validated scalars, `sanitizeFilter`, `mongoose.trusted()` | a filter from `req.body`, **`$where`**, `Model.collection` | N/A — not SQL | **Highest** — the hole is open by default and the payload is plain JSON |
| Drizzle | `` sql`…${v}` ``, `sql.identifier()` | **`sql.raw()`** | **Yes** — `sql` fragments nest anywhere | **Low** — but `sql.raw()` inside a `sql` template looks safe and is not |
| Raw drivers | `$1` / `?` placeholders | template interpolation | You compose by hand | **Low** — the safe form is also the shorter one |

Two rows deserve reading twice.

**Mongoose** is the only tool here whose injection vector requires no raw API at all. `findOne({ email, passwordHash: req.body.password })` is ordinary-looking code and an authentication bypass, because `{ $ne: null }` is a perfectly valid JSON body. `sanitizeFilter` is off by default; the global `ValidationPipe` is the actual fix. [NoSQL injection](../nestjs-security/nosql-injection.md).

**Drizzle and raw drivers score well** for the same reason: the safe form is the natural one. In Drizzle a value interpolated into `` sql`…` `` is already a bind parameter, so reaching for `sql.raw()` takes deliberate effort. With `pg`, `query(text, params)` is shorter than building a string.

**No tool protects dynamic identifiers.** Table names, column names and `ORDER BY` targets are syntax, not values, so no placeholder in any of the five can carry them. The fix is identical everywhere — an allow-list mapping a request token to an identifier you wrote — and every page in this section shows it. [SQL injection](../nestjs-security/sql-injection.md).

### Maturity, weight and learning curve

| | First released | Current line | Runtime deps | Bootstrap cost | Learning curve | Documentation hazard |
| --- | --- | --- | --- | --- | --- | --- |
| TypeORM | 2016 | **1.1.1** (1.0 in May 2026) | 10 | metadata build, scales with schema size | Medium-high | **The web is full of `0.3.x`** — nearly every global helper in it was removed |
| Prisma | 2019 | **7.10.0** | 1 (plus a driver adapter) | client load | **Low** — the schema DSL is the whole curve | Docs default to the **v8 RC**; v7 lives under a separate path |
| Mongoose | 2010 | **9.9.5** | 6 (bundles the driver) | small | Medium — the schema layer is easy, the query semantics are not | Most material predates the Mongoose 9 hook changes |
| Drizzle | 2022 | **0.45.2** | **0** | negligible | Low **if you know SQL**, high if you do not | The site documents the **1.0 RC**; `defineRelations` will not compile on 0.45.2 |
| Raw drivers | `pg` since 2010 | `pg` **8.23.0** | few | negligible | Low, and it is SQL you already know | None — but nothing tells you when a query is wrong |

:::warning Three documentation hazards, and they will cost you a day each
- **TypeORM**: search results are overwhelmingly `0.3.x`. `createConnection()`, global `getRepository()`, `@EntityRepository` and `relations: ['posts']` are all gone.
- **Prisma**: the docs default to the v8 release candidate, and the npm `latest` tag for `prisma` **is** that RC. Pin `prisma@7`.
- **Drizzle**: the website has largely moved to the 1.0 RC. `defineRelations()` there is not the `relations()` in 0.45.2.

Anchor your team on version-pinned documentation rather than search results.
:::

## Pick this if…

**Pick Prisma if** you are starting a new TypeScript service on PostgreSQL, MySQL/MariaDB, SQLite, SQL Server or CockroachDB and you want the strongest type story and the most complete migration tooling. This is the default recommendation and the hardest to regret. You accept a code-generation step in CI and the Docker build, a large generated client, and a raw escape hatch that is a hard boundary. The missing Nest module is twenty-five lines, and it is on the [Prisma](./prisma.md) page.

**Pick TypeORM if** you need Oracle, SAP HANA, Spanner or MSSQL, or your team's mental model is class-based entities from Hibernate or Entity Framework, or you specifically want a first-party module and nothing you maintain. Accept that partial selects lie about their return type and that bootstrap cost scales with schema size — and make sure every reference you read is 1.x.

**Pick Mongoose if** your database is MongoDB. There is no real competition: Prisma 7 dropped MongoDB entirely, so the question is Mongoose or the driver, and for anything with a document shape you care about it is Mongoose. Turn `sanitizeFilter` on, enable the global `ValidationPipe` with `whitelist`, and write the test that posts `{"password":{"$ne":null}}` to your login route.

**Pick Drizzle if** your team knows SQL and wants to keep knowing it, or you deploy somewhere that cares about cold starts and bundle size, or you need CTEs, window functions and row locks as routine work rather than exceptions. Accept that you own the provider, the shutdown hook and the health indicator, and that you are on a pre-1.0 version whose own documentation has moved ahead of it.

**Pick raw drivers if** the service is small enough that a dozen statements is the whole data layer — or, far more often, **alongside** one of the above for reporting, bulk operations and anything needing exact plan control. Running two tools is normal and usually better than contorting one. The only rule is that one tool owns the schema.

**Do not** pick on download counts, benchmarks or the number of Medium posts. And do not pick Prisma for MongoDB.

## Changing your mind later

Realistic exit costs, worst to best:

- **Mongoose → anything.** You are changing databases, not ORMs.
- **TypeORM → anything.** Entities are woven through the code and carry behaviour. Expect a data-layer rewrite.
- **Prisma ↔ Drizzle.** Both have a schema artifact and generated `.sql` migrations. The migration history transfers; the query code does not.
- **Anything → raw drivers**, path by path. The cheapest, because it is additive: add a repository, move the queries you care about, leave the rest.

A repository layer makes every one of these cheaper, because the ORM is imported in one directory instead of forty route files. In Nest that layer is free — it is a provider — which is the whole argument in [Repository vs active record](./repository-vs-active-record.md).

## Security considerations

**The escape-hatch table above is the security comparison.** Rank the tools by how easy the dangerous form is to write by accident, not by how loudly the documentation warns about it.

**All five parameterise their generated queries.** If you only use the repository API, the model API or the query builder, you cannot inject SQL. Every hole is in the raw path — plus Mongoose's operator injection, which is not a raw path at all.

**Mass assignment is universal and unmitigated.** `data: dto` (Prisma), `.set(dto)` (Drizzle), `create(dto)` (TypeORM, Mongoose) and a spread into an `UPDATE` (raw) all write whatever they are given. The global `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` strips unknown properties before a service runs — and the service should still construct the write from named fields, because a DTO can legitimately hold values the model must not accept from a request. [Validation as a security control](../nestjs-security/validation-as-a-control.md).

**Field exposure is universal too.** Every tool returns all columns by default. TypeORM's `select: false` and Mongoose's `@Prop({ select: false })` are the only schema-level nets; Prisma, Drizzle and raw drivers need an explicit projection on every read that reaches a response body.

**Error messages disclose schema in all five.** A unique-constraint violation names the constraint, a Mongoose `ValidationError` names your fields, and a raw `pg` error names the table. Map them to HTTP status codes in one exception filter and log the detail instead of returning it.

**The application user should not own the schema** whichever you pick. The app connects with a role that can read and write rows; DDL belongs to the migration job. That single control turns an injection that reaches your connection from a catastrophe into an incident.

**Transaction correctness is a security property, not just a consistency one.** A balance check in JavaScript followed by a write is a way to spend the same funds twice with concurrent requests, in every tool on this table. Use a conditional `UPDATE` or a row lock. [Transactions](../nestjs-databases/transactions.md).

## Production considerations

**Pool sizing is your job in all five.** `max` × replica count is your real connection count. TypeORM has `poolSize`, Prisma passes it to the driver adapter, Drizzle and raw drivers use the driver's `max`, and Mongoose has `maxPoolSize` — whose driver default of **100 per instance** is the most dangerous default in this section.

**Every one of them can hang instead of failing.** The `pg` acquisition default is wait-forever (which covers Prisma, Drizzle and raw `pg`), and Mongoose buffers commands while disconnected. Set an explicit, short timeout on all of them so pool exhaustion produces fast errors a load balancer can act on.

**`app.enableShutdownHooks()` in `main.ts`, whichever you picked.** It is not on by default, and without it no `OnModuleDestroy` runs on `SIGTERM` — so neither the module-owned connections nor the ones you wrote are ever closed.

**Never run migrations from application startup in any of them.** `migrationsRun: true` (TypeORM), `synchronize: true` (TypeORM), `autoIndex` (Mongoose) and a `migrate()` call in `main.ts` (Prisma, Drizzle) are the same mistake wearing four hats.

**Turn on slow-query logging in all five**, log the SQL and the duration, and never log the parameters — those are user data. [Safe logging](../nestjs-security/safe-logging.md).

**Pin the majors.** `prisma`'s `latest` tag is an RC; `typeorm@1.1.1` needs Node 24.11+ on the 24 line; `drizzle-orm` and `drizzle-kit` share a snapshot format and must move together. Lockfiles are necessary and not sufficient — a fresh CI container with an unpinned install resolves differently.

**Budget the extra build step exactly once.** Only Prisma adds one (`prisma generate` before `tsc`, in CI and in the Dockerfile). TypeORM pays at boot instead, Drizzle pays in `tsc` time, and the other two pay nothing.

**Write the health indicator on day one for Drizzle and raw drivers.** The alternative is a readiness probe returning 200 while the database is unreachable. [Health checks](../nestjs-databases/health-checks.md).

**Decide the transaction convention before the second service needs one.** Explicit parameter or `AsyncLocalStorage`, written down, enforced in review. Half a codebase doing each is how a transaction commits three statements and leaves the fourth outside.

## Common mistakes

- **Choosing on download counts or benchmarks.** The gap is smaller than one missing index.
- **Treating "no `@nestjs/` package" as disqualifying.** It is twenty-five to forty lines, and they are in this section.
- **Treating "has a `@nestjs/` package" as sufficient.** It does not give you migrations, pooling discipline or a transaction convention.
- **Picking Prisma for MongoDB.** Prisma 7 does not support it.
- **Reading `0.3.x` TypeORM, Prisma v8 or Drizzle 1.0-RC documentation** against the versions you installed.
- **Assuming Mongoose is safe because it is not SQL.** Its injection vector is open by default.
- **Letting two tools own the schema.** One migration source of truth.
- **Forgetting the health indicator** on Drizzle or a raw pool.
- **Assuming the ORM choice changes the operational work.** Shutdown hooks, pool sizing, migration pipelines and timeouts are identical across all five.
- **Not reading generated migrations.** All three generators emit drop-plus-add for a rename.

## Related topics

- [Choosing an ORM](./choosing-an-orm.md) — the same decision as prose, with the "when no ORM is right" case.
- [TypeORM](./typeorm.md), [Prisma](./prisma.md), [Mongoose](./mongoose.md), [Drizzle](./drizzle.md), [Raw drivers](./raw-drivers.md) — the detail behind every row above.
- [Repository vs active record](./repository-vs-active-record.md) — the pattern that makes changing your mind cheap.
- [Avoiding N+1](./avoiding-n-plus-one.md) — the risk column, with fixes and detection.
- [Comparison table](../orms/comparison.md) — the library-level scoring, including Sequelize, Knex and Kysely.
- [Connections and DI](../nestjs-databases/connections-and-di.md) — the provider shape all five have to fit.
- [Transactions](../nestjs-databases/transactions.md) — the convention you have to choose once.
- [Migrations](../nestjs-databases/migrations.md) — the release-step pipeline none of them give you.
- [Connection pooling](../nestjs-databases/connection-pooling.md) — the setting every one of them makes you own.
- [Health checks](../nestjs-databases/health-checks.md) — which Terminus indicators exist and how to write one.
- [SQL injection](../nestjs-security/sql-injection.md) — the threat behind the escape-hatch ranking.
- [NoSQL injection](../nestjs-security/nosql-injection.md) — why Mongoose ranks worst on that row.
