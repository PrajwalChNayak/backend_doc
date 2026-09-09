---
title: Comparison table
description: Prisma, Drizzle, TypeORM, Sequelize, Mongoose and Knex compared on type safety, migrations, raw SQL, relations, weight and escape-hatch safety — with actual recommendations.
status: current
updated: 2026-09-08
---

Six tools, one decision. This page compares them on the dimensions that change how your codebase feels six months in, and then tells you which one to pick. Version numbers here were verified against the npm registry on 2026-09-08.

## Why it exists

Most ORM comparisons refuse to recommend anything. That is not helpful — you have to pick one, and the differences between these are real and durable, not matters of taste.

Two framings to discard first. **Benchmarks are noise** at this layer: the gap between any two of these on a CRUD workload is smaller than one missing index. And **"most popular" is not a criterion**: Sequelize has the most downloads and is the one we recommend least for new work.

What actually matters is how well the tool tells you when you have broken something, how much of the migration problem it solves, and how safe its escape hatch is when you inevitably need raw SQL.

## When to use it

Direct answers first.

**Pick Prisma if** you are starting a new TypeScript project on PostgreSQL, MySQL or SQLite and you want the strongest type story and the best generated migrations. This is the default recommendation and the one that is hardest to regret. Accept the code-generation step and the larger runtime.

**Pick Drizzle if** you know SQL, want to keep knowing it, and are deploying somewhere that cares about cold starts or bundle size — serverless, edge, workers. Also pick it if you need SQL features Prisma cannot express (CTEs, window functions, `FOR UPDATE`) as a routine part of your work, not an occasional exception.

**Pick Knex if** you want a query builder and a migration runner and explicitly do *not* want a data model. Good alongside another tool for reporting queries. Accept that its TypeScript types are hand-written and will drift.

**Pick TypeORM if** you need a database the others do not support — Oracle, SAP HANA, Spanner, MSSQL — or your team's mental model is class-based entities from Hibernate or Entity Framework. Make sure you are reading 1.x material, not `0.3.x`.

**Pick Mongoose if** your database is MongoDB. There is no real competition; Prisma 7 dropped MongoDB entirely. The question is Mongoose or the raw driver, and for anything with a document shape you care about, it is Mongoose.

**Pick Sequelize if** you already have a Sequelize codebase. For a new project the honest answer is that Prisma or Drizzle does the same job with better types and better migrations. Its size, its hand-written migrations and its bolted-on types are all real costs, and v7 has been alpha for a long time.

Two honorable mentions this handbook does not cover in depth. **Kysely** (0.29.5) is a Knex-shaped query builder with genuine TypeScript inference — a serious option if you like Knex's model but want the types. **Objection.js** (3.1.5) adds models and relations on top of Knex; activity is low, so check the project's health before adopting it.

## How it works

### Versions

| Tool | Stable | npm `latest` | Notes |
| --- | --- | --- | --- |
| [Prisma](./prisma.md) | **7.10.0** | `8.0.0-rc.13` ⚠️ | `latest` is a release candidate — pin `prisma@7` |
| [Drizzle](./drizzle.md) | **0.45.2** | `0.45.2` | `1.0.0-rc.4` on the `rc` tag |
| [TypeORM](./typeorm.md) | **1.1.1** | `1.1.1` | 1.0 shipped 2026-05; ignore `0.3.x` docs |
| [Sequelize](./sequelize.md) | **6.37.8** | `6.37.8` | v7 still alpha (`7.0.0-alpha.9`) |
| [Mongoose](./mongoose.md) | **9.9.5** | `9.9.5` | MongoDB only |
| [Knex](./knex.md) | **3.3.0** | `3.3.0` | Query builder, not an ORM |

### Type safety

| Tool | Source of types | Partial `select` narrows? | Relations typed? | Verdict |
| --- | --- | --- | --- | --- |
| Prisma | Generated from `schema.prisma` | **Yes, exactly** | Yes, nested | **Best**. Types cannot drift from the schema. |
| Drizzle | Inferred from TS schema | **Yes** | Yes, via `with` | **Best**. No generation step; costs compile time. |
| TypeORM | Class decorators | No — returns the entity type | Partially | Adequate. Partial selects lie about the shape. |
| Mongoose | `InferSchemaType` | Partially | Needs explicit generics | Adequate for simple schemas. |
| Sequelize | `InferAttributes` declarations | No | No — declare by hand | Weak. Two sources of truth, unchecked. |
| Knex | Hand-written interfaces | Yes, if the interface is right | N/A | **Weakest**. Nothing checks types against the schema. |

The distinction that matters is *drift*. Prisma and Drizzle derive types from a schema artifact, so a schema change immediately changes the types. Knex and Sequelize require you to maintain a parallel declaration, so they can silently disagree with the database — which is exactly the failure an ORM was supposed to prevent.

### Migrations

| Tool | Generated from schema? | Format | Runner | Verdict |
| --- | --- | --- | --- | --- |
| Prisma | **Yes**, with a shadow DB | Plain `.sql` | `migrate dev` / `migrate deploy` | **Best**. Drift detection, status, resolve. |
| Drizzle | **Yes**, from a snapshot | Plain `.sql` | `drizzle-kit generate` / `migrate` | Very good. Hand-editing is normal. |
| TypeORM | **Yes**, entity diff | TypeScript classes | `migration:run` / `revert` | Good. Transaction mode is configurable. |
| Knex | No | JS/TS `up`/`down` | `migrate:latest` / `rollback` | Good runner, all hand-written. |
| Sequelize | No | JS `up`/`down` via `queryInterface` | `sequelize-cli db:migrate` | Adequate. Models and migrations drift. |
| Mongoose | N/A (schemaless) | Bring your own (`migrate-mongo`) | External | Not provided. Index management is on you. |

:::warning
Every generated migration renders a column rename as `DROP COLUMN` plus `ADD COLUMN`. A diff cannot know intent. Read every generated migration before applying it, on all three tools that generate them.
:::

### Raw SQL ergonomics

| Tool | Raw API | Composable? | Comfort level |
| --- | --- | --- | --- |
| Knex | `knex.raw(sql, bindings)` | Yes — fragments compose into builders | **Best**. Raw is a first-class citizen. |
| Drizzle | `` sql`…` `` tagged template | Yes — `sql` fragments nest anywhere | **Best**. Builder and raw are the same system. |
| Sequelize | `sequelize.query(sql, opts)` | No | Fine, but disconnected from the model API. |
| TypeORM | `dataSource.query(sql, params)` | Query builder composes; raw does not | Fine. |
| Prisma | `` $queryRaw`…` `` + `Prisma.sql` | Yes — `Prisma.sql` / `Prisma.join` / `Prisma.empty` | Good API, but a hard boundary: results are untyped rows. |
| Mongoose | `aggregate()`, `Model.collection` | N/A | Not SQL. Aggregation is the escape hatch. |

Prisma's raw API is well designed and it is still a *cliff*: you leave the type system entirely and hand-annotate the row type. Drizzle and Knex let raw fragments live inside otherwise-normal queries, which keeps the drop to SQL incremental instead of total.

### Relation loading

| Tool | Mechanism | Default strategy | N+1 risk |
| --- | --- | --- | --- |
| Prisma | `include` / nested `select` | Separate queries per relation | Low — no lazy proxies |
| Drizzle | `with` (relational) or explicit joins | Single statement for relational queries | Low |
| TypeORM | `relations` / `leftJoinAndSelect` | `relationLoadStrategy: 'join'`, configurable | **Medium** — `eager: true` and lazy relations both exist |
| Sequelize | `include` | Join, or `separate: true` | Medium — `include` + `limit` gets subtle |
| Mongoose | `populate()` | A second query with `$in` | **High** — populating in a loop is easy to write |
| Knex | You write the join | None | N/A — you own it |

Nobody is immune, because the N+1 is usually a `for` loop the developer wrote. The tools that make it *easiest* are the ones with lazy-loading proxies, where a property access is secretly a query.

### Database support

| Tool | PostgreSQL | MySQL/MariaDB | SQLite | MSSQL | Oracle | MongoDB | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Prisma 7 | Yes | Yes | Yes | Yes | No | **No** | CockroachDB |
| Drizzle | Yes | Yes | Yes | Yes | No | No | SingleStore, CockroachDB, Turso, D1, PGlite |
| TypeORM | Yes | Yes | Yes | Yes | **Yes** | Yes | SAP HANA, Spanner, CockroachDB |
| Sequelize | Yes | Yes | Yes | Yes | Yes | No | Snowflake, Db2 |
| Knex | Yes | Yes | Yes | Yes | Yes | No | CockroachDB |
| Mongoose | No | No | No | No | No | **Yes** | — |

Prisma 7 dropping MongoDB is the single biggest support change on this table. If you were using Prisma with MongoDB, you stay on v6 or you move to Mongoose.

Drizzle is the only one here targeting edge SQLite variants (Turso, Cloudflare D1, PGlite) as first-class.

### Weight and runtime cost

Direct runtime dependency counts, as published:

| Tool | Direct deps | Runtime shape |
| --- | --- | --- |
| Drizzle | **0** | Pure TS, no engine, driver is a peer dep. Smallest by a wide margin. |
| `@prisma/client` | 1 | Generated client + adapter. Large output, but v7 removed the Rust pool. |
| Mongoose | 6 | Bundles the MongoDB driver. |
| TypeORM | 10 | Builds full entity metadata at `initialize()` — startup cost scales with schema size. |
| Knex | 14 | Includes `lodash`, `commander`, the CLI. |
| Sequelize | 16 | Includes `lodash`, `moment`, `moment-timezone`, `validator`. Heaviest. |

For a long-lived server none of this matters much. For a function that cold-starts per request, Drizzle and TypeORM sit at opposite ends of the range.

### Maturity and learning curve

| Tool | First released | Activity | Learning curve | Docs quality |
| --- | --- | --- | --- | --- |
| Sequelize | 2011 | Steady on v6; v7 alpha for a long time | Medium — large surface, many footguns | Extensive, some of it stale |
| Knex | 2013 | Slow but maintained | **Low** — it is SQL with a chain | Good, terse |
| TypeORM | 2016 | Active; 1.0 in May 2026 | Medium-high — decorators, metadata, many options | Improved with 1.0; the web is full of `0.3.x` |
| Mongoose | 2010 | Very active | Medium — the schema layer is easy, the query semantics are not | Good |
| Prisma | 2019 | Very active | **Low** — the schema DSL is the whole learning curve | **Best in class** |
| Drizzle | 2022 | Very active | Low **if you know SQL**, high if you do not | Good, but currently ahead of the stable release |

:::warning
Two documentation hazards to plan for. The Drizzle website has largely moved to the 1.0 RC API — `defineRelations()` there will not compile against 0.45.2, which uses `relations()`. And Prisma's docs default to the v8 RC; the v7 pages live under a `/v7/` path.
:::

### Escape-hatch safety

This is the dimension most comparisons skip, and it is the one that produces CVEs.

| Tool | Safe form | Dangerous form | How easy is the mistake? |
| --- | --- | --- | --- |
| Prisma | `` $queryRaw`…${v}` ``, `Prisma.sql`, `Prisma.join` | `$queryRawUnsafe`, `$executeRawUnsafe`, **`Prisma.raw`** | **Low** — "Unsafe" is in the name. `Prisma.raw` inside a safe template is the trap. |
| Drizzle | `` sql`…${v}` `` | **`sql.raw()`** | **Low** — but `sql.raw()` nested in a `sql` template looks safe and is not. |
| Knex | `knex.raw('… ?', [v])`, `??`, `:name:` | `knex.raw` with interpolation | **Medium** — `?` vs `??` is easy to mix up. |
| TypeORM | `.where('id = :id', { id })`, `query(sql, params)` | `.where('id = ' + id)`, `orderBy(userInput)` | **Medium** — `where()` takes a string, so concatenation is one keystroke away. |
| Sequelize | `bind`, or `replacements` | Template interpolation; `sequelize.literal()` | **High** — two mechanisms with different guarantees, and `literal()` is unmarked raw. |
| Mongoose | `sanitizeFilter`, validated scalars | Filters built from `req.body`; **`$where`** | **Highest** — the hole is open by default and the payload is a plain JSON object. |

Read that last row carefully. Mongoose is the only tool here whose injection vector requires no raw API at all: `User.findOne({ email, password: req.body.password })` is ordinary-looking code and it is an authentication bypass. `sanitizeFilter` is off by default. Turn it on.

## Common patterns

### Use two tools

Nothing stops you running Prisma for the CRUD surface and Knex or raw `pg` for six reporting queries. Both connect to the same database; the only cost is two connection pools, which you should size accordingly.

This is usually a better answer than contorting one tool. What you should *not* do is have two tools that both own the schema — one migration source of truth, always.

### Changing your mind later

The realistic exit costs, worst to best:

- **Mongoose → anything.** You are changing databases, not ORMs.
- **TypeORM / Sequelize → anything.** Entities and models are woven through the code. Expect a rewrite of the data layer.
- **Prisma → Drizzle or back.** Both have a schema artifact and generated migrations. The migration history transfers; the query code does not.
- **Knex → anything.** Easiest. There is no data model to unwind, and Knex migrations keep working while you move queries.

A repository layer makes every one of these cheaper, because the ORM is imported in one directory instead of a hundred route files.

### Migrations can outlive the ORM

Your migration history is a durable asset and your query code is not. If you are unsure, it is legitimate to run migrations with a tool you are confident in (Knex, or plain `.sql` files) and query with whatever you like. Prisma and Drizzle both support applying an existing schema via introspection.

## Security considerations

**The escape-hatch table above is the security comparison.** Rank the tools by how easy the dangerous form is to write by accident, not by how loudly the docs warn about it.

**Every tool on this page parameterizes its generated queries.** No exceptions. If you only use the builder or the model API, you cannot inject SQL. All six holes are in the raw path — plus Mongoose's operator injection, which is not a raw path at all.

**No tool protects dynamic identifiers.** Table names, column names and `ORDER BY` targets are syntax, not values, so no placeholder in any of these six can carry them. Every one of these pages shows the same fix: an allow-list mapping a request token to an identifier you wrote. There is no tool-specific shortcut.

**Mass assignment is universal and unmitigated.** `data: req.body` (Prisma), `.set(req.body)` (Drizzle), `create(req.body)` (TypeORM, Sequelize, Mongoose) and `.update(req.body)` (Knex) all write whatever they are given. Only Sequelize offers a built-in allow-list (`{ fields: [...] }`). Validate and construct writes from named fields everywhere else.

**Field exposure is universal too.** Every tool returns all columns by default, password hash included. Mongoose's `select: false` is the only schema-level defense in the set; everyone else needs an explicit projection on every read that reaches a response.

## Production considerations

**Pool sizing is your job in all six.** `max` × replica count is your real connection count. Prisma 7 removed its own pool and delegates to the driver adapter; Drizzle and Knex never had one; TypeORM has `poolSize`; Sequelize has `pool.max`; Mongoose has `maxPoolSize` (driver default: 100 — set it).

**Every one of them can hang instead of failing.** Prisma's `connectionTimeoutMillis` defaults to unlimited, Knex's `acquireConnectionTimeout` defaults to 60 seconds, Sequelize's `pool.acquire` to 30 seconds, and Mongoose buffers commands while disconnected. Set an explicit, short timeout on all of them so pool exhaustion produces fast errors your load balancer can act on.

**Never run migrations from app startup in any of them.** `migrationsRun: true` (TypeORM), `sync()` (Sequelize), `autoIndex` (Mongoose) and calling `migrate()` in your server entry point are the same mistake wearing four hats. See [Migration strategy](./migration-strategy.md).

**Turn on slow-query logging in all six.** Each has an event or a hook. Log the SQL and the duration; do not log the parameters.

**Pin the major.** `prisma`'s `latest` tag is an RC right now, and Drizzle's snapshot format is tied to the `drizzle-kit` version. Lockfiles are necessary and not sufficient — a fresh CI container with an unpinned install can resolve differently.

**Budget for a documentation gap.** Drizzle's site documents the RC, Prisma's defaults to v8, and most TypeORM material online is `0.3.x`. Anchor your team on the version-pinned docs and this handbook rather than search results.

## Common mistakes

- **Choosing on download counts.** Sequelize wins that metric and is the weakest recommendation here for new work.
- **Choosing on benchmarks.** The difference is smaller than one missing index.
- **Assuming an ORM removes the need to know SQL.** It changes reading SQL from optional to mandatory.
- **Picking Prisma for MongoDB.** Prisma 7 does not support it.
- **Picking TypeORM from `0.3.x` tutorials.** Nearly every global helper in them was removed in 1.0.
- **Picking Knex expecting type safety.** The interfaces are hand-written and drift silently.
- **Picking Sequelize for a new TypeScript project** because it is the most popular.
- **Letting two tools both own the schema.** One migration source of truth.
- **Assuming Mongoose is safe because it is not SQL.** Its injection vector is open by default.
- **Not reading generated migrations.** All three generators emit drop-plus-add for a rename.

## Related topics

- [When to use an ORM](./when-to-use-an-orm.md) — whether to use one of these at all.
- [Prisma](./prisma.md), [Drizzle](./drizzle.md), [TypeORM](./typeorm.md), [Sequelize](./sequelize.md), [Mongoose](./mongoose.md), [Knex](./knex.md) — the detail behind every row above.
- [Migration strategy](./migration-strategy.md) — the part of the decision that outlives the ORM.
- [Testing with a database](./testing-with-a-database.md) — testing whichever you picked.
- [Choosing a database](../databases/choosing-a-database.md) — the decision that comes before this one.
- [SQL injection](../security/sql-injection.md) — the threat behind the escape-hatch ranking.
- [NoSQL injection](../security/nosql-injection.md) — why Mongoose ranks worst on that table.
- [Connection pooling](../databases/connection-pooling.md) — the setting every one of them makes you own.
