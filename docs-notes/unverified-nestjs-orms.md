# Unverified — `content/nestjs-orms/`

Items I could not verify against an installed package's `.d.ts`, the npm registry, or
already-verified material in `CONTRIBUTING.md` Part 2 / the Part 1 pages. Each was
**left out** of the published pages rather than guessed at, per CONTRIBUTING §1.4 and §12.2.

Written during the 2026-09-11 pass that added `choosing-an-orm`, `prisma`, `mongoose`,
`drizzle`, `raw-drivers`, `comparison`, `repository-vs-active-record` and
`avoiding-n-plus-one`. `typeorm.md` was written earlier and was not modified.

## What was verified, and how

- **`typeorm@1.1.1`** — unpacked at `examples/orm-typeorm/node_modules/typeorm`. Confirmed
  `BaseEntity` exists in 1.1.1 with `useDataSource(dataSource: DataSource | null)`,
  `getRepository`, `create`, `find`, `findOne`, `save`, `remove`, `softRemove`, `recover`.
  This is what `repository-vs-active-record.md` documents.
- Every version number comes from `CONTRIBUTING.md` §1.3 and §11.1.
- Prisma 7 schema/config/adapter behaviour, `Prisma.sql` / `Prisma.join` / `Prisma.empty` /
  `Prisma.raw`, and the `$queryRaw` vs `$queryRawUnsafe` split are taken from the verified
  Part 1 page `content/orms/prisma.md`.
- Drizzle `sql`, `sql.raw`, `sql.identifier`, `sql.placeholder`, `relations()` (not
  `defineRelations()`) come from the verified `content/orms/drizzle.md`.
- `@nestjs/mongoose` decorators (`@Schema`, `@Prop`, `SchemaFactory`, `@InjectModel`,
  `@InjectConnection`, `getModelToken`, `ParseObjectIdPipe`, `IsObjectIdPipe`) and the
  `MongooseModuleOptions` keys come from the already-written, already-verified
  `content/nestjs-databases/mongodb.md`.
- `HealthIndicatorService.check(key)` with `.up()` / `.degraded()` / `.down()`, and the
  fact that Terminus ships `TypeOrmHealthIndicator`, `MongooseHealthIndicator` and
  `PrismaHealthIndicator`, come from the verified
  `content/nestjs-databases/health-checks.md`.

## Left out because unverified

1. **The generic signature of `PrismaClient` in 7.10.0.**
   `prisma.md` shows `this.$on('query', …)` inside `PrismaService.onModuleInit()`, which
   matches the verified runtime usage in `content/orms/prisma.md`. What I could **not**
   verify is the *type-level* requirement: in some Prisma majors a typed `$on('query')`
   needs the log level declared in the class's generic parameter
   (`extends PrismaClient<…>`). I did not unpack a generated 7.10.0 client, so the page
   makes no claim about that generic and does not show one. If a reader's `$on('query')`
   does not type-check, that is the missing piece and it is not documented here.

2. **Whether `@prisma/adapter-pg@7.10.0` accepts an existing `pg.Pool` instance.**
   The verified Part 1 page only shows the config form,
   `new PrismaPg({ connectionString, max, … })`. So `raw-drivers.md` does **not** document
   "share one pool between Prisma and a raw `pg` repository". It recommends reaching the
   driver through `$queryRaw` on the adapter's own pool instead, or a deliberately
   separate reporting pool.

3. **A negative claim about `@nestjs/terminus` 12 exports.**
   `drizzle.md`, `raw-drivers.md`, `comparison.md` and `choosing-an-orm.md` say there is no
   built-in Terminus indicator for Drizzle or a bare `pg` pool. That is inferred from the
   indicator table in the verified `health-checks.md`, not from reading the package's
   exports directly. It is the reason those pages show a custom `HealthIndicatorService`
   indicator, which is correct either way.

4. **`@nestjs/mongoose` 12 default values for `retryAttempts` / `retryDelay`.**
   The keys are verified; the defaults are not. `mongoose.md` sets both explicitly and
   states no default. (TypeORM's documented defaults of 10 / 3000 appear only on
   `typeorm.md`, which was verified in the earlier pass.)

5. **A per-connection equivalent of `mongoose.set('sanitizeFilter', true)`.**
   Only two forms are documented: the global `mongoose.set(…)` in `main.ts`, and the
   per-query `.setOptions({ sanitizeFilter: true })`. Both come from the verified
   `content/orms/mongoose.md`. Whether the `Connection` object that `MongooseModule`
   manages exposes an equivalent setter was not checked, so it is not mentioned.

6. **Third-party `nestjs-drizzle`-style wrapper packages.**
   I did not verify that any specific one exists or is maintained, so `drizzle.md` names
   none. It says only that if the reader finds a wrapper, they should weigh it against the
   ~30 lines the page shows.

7. **The PostgreSQL 65535 bind-parameter cap**, cited in `raw-drivers.md` as the reason to
   chunk multi-row inserts. This is the wire-protocol `int16` parameter count and is
   long-standing, but it was not re-verified against a running server in this pass.

## Not an omission, but worth flagging for review

- `prisma.md` states that **`$extends` returns a new client object rather than mutating the
  service instance**, and recommends a second provider whose `useFactory` calls
  `prisma.$extends(...)`. The `$extends` API itself is verified (Part 1), and the
  "returns a new client" behaviour follows from it; the *Nest consequence* is my analysis,
  not something read out of a `.d.ts`. It is presented as a design constraint, and the
  example is ordinary Nest provider code that does not depend on any unverified API.
- `raw-drivers.md` replaced a server-side `DECLARE CURSOR` / `FETCH FORWARD` export example
  with keyset pagination, partly because `FETCH FORWARD <count>` does not accept a bind
  parameter and the parameterised version would have been wrong. The keyset version is
  fully parameterised and is better advice anyway; the cursor trade-off is described in
  prose only.
