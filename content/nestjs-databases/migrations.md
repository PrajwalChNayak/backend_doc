---
title: Migrations
description: Migrations as a deploy-pipeline step for a Nest service — never on boot with multiple replicas, a TypeORM DataSource the CLI can read, prisma migrate deploy, expand/contract, and a DDL user separate from the app user.
status: current
updated: 2026-09-11
---

A migration is a schema change, and a Nest application is usually several replicas starting at once. Those two facts settle the central question of this page: migrations run **once, in the deploy pipeline, before the new replicas start** — never from `onModuleInit`, never from `migrationsRun: true`, never from `synchronize: true`. Forward-only migrations, expand/contract, index locking and the cost of each DDL operation are covered in [Migrations](../databases/migrations.md); this page is about running them around a Nest deployment.

## The two settings that cause data loss

```ts title="src/database/database.module.ts"
TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    type: 'postgres' as const,
    url: config.getOrThrow<string>('DATABASE_URL'),
    autoLoadEntities: true,
    synchronize: false,   // never true against a database you would miss
    migrationsRun: false, // migrations are a deploy step, not a boot step
  }),
})
```

**`synchronize: true`** derives DDL from whatever entity files the running process loaded and applies it on start. A renamed property is a dropped column, and the data in it is gone with no migration file and no record. A deploy of the wrong branch rewrites production's schema. It is not a "development convenience with a production caveat" — it is a loaded weapon pointed at whatever database the process happens to connect to, including the one your integration tests point at.

Fail the bootstrap if it is ever true outside development:

```ts title="src/config/env.schema.ts"
import { z } from 'zod'

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    DATABASE_URL: z.url(),
    DB_SYNCHRONIZE: z.enum(['true', 'false']).default('false'),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.DB_SYNCHRONIZE === 'false', {
    message: 'DB_SYNCHRONIZE must be false in production',
  })
```

**`migrationsRun: true`** runs pending migrations from `DataSource.initialize()`. With one replica that is merely bad practice. With three replicas rolling out simultaneously it is three processes racing the same `ALTER TABLE`:

- TypeORM takes an advisory lock around its migration run on Postgres, so two replicas usually serialise rather than corrupt. "Usually" is doing a lot of work in that sentence, and MySQL has no equivalent.
- The replica that waits blocks its own startup behind the migration, so a slow migration fails its readiness probe and the orchestrator restarts it — mid-migration.
- The migration runs as the **application** database user, which means that user must own the schema. That is the permission you most want it not to have.
- A failed migration is now a failed *pod*, and the orchestrator's response is to try again. A partially-applied DDL retried in a loop is a genuinely bad afternoon.

## The deploy pipeline

The shape that works, in order:

1. **Build the image.** It contains the compiled application *and* the compiled migrations.
2. **Run migrations as a separate one-shot step** — a Kubernetes `Job`, an ECS task, a release command — using the same image and the **DDL credentials**.
3. **Wait for it to succeed.** A non-zero exit stops the deploy before any new replica starts.
4. **Roll out the new replicas** with the application credentials.

```yaml title="deploy/migrate-job.yaml"
apiVersion: batch/v1
kind: Job
metadata:
  name: api-migrate-{{ .Release.Revision }}
spec:
  backoffLimit: 0        # do not retry a partially-applied migration
  activeDeadlineSeconds: 900
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/api:{{ .Values.image.tag }}
          command: ['node', 'node_modules/typeorm/cli.js', 'migration:run', '-d', 'dist/database/data-source.js']
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: db-migrator, key: url }
```

`backoffLimit: 0` is deliberate. An automatic retry of a migration that failed halfway is how a broken schema becomes an unrecoverable one. A human should look at it.

In a Kubernetes chart, a Helm `pre-upgrade` hook or an ArgoCD `PreSync` hook gives you step 3 for free — the rollout does not begin until the job succeeds.

:::warning An init container is not the same thing
Putting the migration in an `initContainer` on the Deployment runs it once **per pod**, concurrently, which is the multi-replica race again in a different costume. Use a `Job` — one execution for the whole rollout.
:::

## TypeORM: a DataSource the CLI can read

The TypeORM CLI is a separate process. It cannot bootstrap your Nest application, so it cannot see `ConfigModule`, `forRootAsync` or any provider. It needs a file that default-exports a `DataSource`.

The failure mode to avoid is two sources of truth: a Nest module configured one way and a CLI data source configured another, drifting until migrations are generated against a schema that does not match production. Build both from one options object.

```ts title="src/database/data-source-options.ts"
import type { DataSourceOptions } from 'typeorm'

export function buildDataSourceOptions(env: NodeJS.ProcessEnv): DataSourceOptions {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')

  return {
    type: 'postgres',
    url,
    // Compiled output — the CLI runs against dist/, like production does.
    entities: ['dist/**/*.entity.js'],
    migrations: ['dist/database/migrations/*.js'],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    logging: ['error', 'warn', 'migration'],
  }
}
```

```ts title="src/database/data-source.ts"
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { buildDataSourceOptions } from './data-source-options.js'

// Default export: this is what `typeorm -d <file>` looks for.
export default new DataSource(buildDataSourceOptions(process.env))
```

```ts title="src/database/database.module.ts"
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'
import { buildDataSourceOptions } from './data-source-options.js'

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: () => ({
        ...buildDataSourceOptions(process.env),
        autoLoadEntities: true,
        migrationsRun: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
```

Now the two cannot drift, because there is one function.

`typeorm` 1.1.1 ships three binaries: `typeorm` (runs compiled JavaScript), `typeorm-ts-node-commonjs` and `typeorm-ts-node-esm`. Use the TypeScript ones only for `migration:generate` during development; the pipeline runs the compiled form.

```bash
# Development: diff the entities against the database and write a migration
npx typeorm-ts-node-esm migration:generate src/database/migrations/AddOrderStatusIndex \
  -d src/database/data-source.ts

# Or write an empty one to fill in by hand — for anything generation cannot express
npx typeorm-ts-node-esm migration:create src/database/migrations/BackfillOrderTotals

# Pipeline: apply, against compiled output
node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js

# What is pending?
node node_modules/typeorm/cli.js migration:show -d dist/database/data-source.js
```

:::danger Read every generated migration before you apply it
`migration:generate` diffs entities against the live schema. It cannot distinguish a **rename** from a **drop plus add**, so renaming an entity property produces `DROP COLUMN old` + `ADD COLUMN new` — a silent, complete loss of that column's data. It also emits `DROP INDEX`/`CREATE INDEX` pairs for cosmetic differences and will happily narrow a column type.

Generation is a first draft. Read it, edit it, and write the `down()` method yourself.
:::

A migration is a class with `up` and `down`, and the queries in it are parameterised like any other:

```ts title="src/database/migrations/1757500000000-AddOrderStatusIndex.ts"
import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrderStatusIndex1757500000000 implements MigrationInterface {
  name = 'AddOrderStatusIndex1757500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // CONCURRENTLY cannot run inside a transaction — see below.
    await queryRunner.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status ON orders (status)')
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_orders_status')
  }
}
```

TypeORM wraps each migration in a transaction by default, and `CREATE INDEX CONCURRENTLY` cannot run inside one. Run that migration with `-t false` (or `--transaction each` for the rest), keep it in its own file, and make it idempotent with `IF NOT EXISTS` so a retry is safe.

## Prisma

Prisma splits the two operations cleanly, which is one of its better design decisions.

```bash
# Development only: diff the schema, write a migration, apply it.
# Needs a shadow database, so the dev user needs CREATEDB.
npx prisma migrate dev --name add_order_status_index

# Pipeline: replay committed migration files. No diffing, no shadow database.
npx prisma migrate deploy

# Is the database up to date?
npx prisma migrate status

# After fixing a failed migration by hand
npx prisma migrate resolve --applied 20260911120000_add_order_status_index
```

`migrate deploy` is the production command: it only applies migration files that are already in the repository, so it cannot invent DDL from a schema drift. `migrate dev` must never run against production — it will offer to reset the database.

Two Prisma 7 CLI changes worth knowing because they break copied pipelines: `prisma migrate dev` **no longer runs `prisma generate` or the seed script automatically**, and the `--skip-generate` / `--skip-seed` flags are gone because there is nothing left to skip. Run `prisma generate` explicitly in the Docker build and `prisma db seed` explicitly where you want it.

:::warning Pin `prisma@7`
The npm `latest` dist-tag for `prisma` points at `8.0.0-rc.13`, a release candidate, while `@prisma/client` `latest` is the stable `7.10.0`. Installing without a range gives you a mismatched pair and an RC in your pipeline.

```bash
npm install --save-dev prisma@7
npm install @prisma/client@7
```
:::

`prisma generate` must run before the application type-checks, so it belongs in the Docker build stage, not the migration job. The migration job runs `migrate deploy` and nothing else.

## Two database users

The application user must not be able to change the schema. This is the highest-value, lowest-effort control on this page: an SQL injection that reaches the application connection cannot then `DROP TABLE`, cannot create a function, and cannot add a superuser.

```sql
-- The owner. Used only by the migration job.
CREATE ROLE app_migrator LOGIN PASSWORD 'from-your-secret-store';
GRANT ALL PRIVILEGES ON SCHEMA public TO app_migrator;

-- The application. No DDL, no ownership.
CREATE ROLE app_runtime LOGIN PASSWORD 'from-your-secret-store';
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- So that tables created by FUTURE migrations are reachable too.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
```

The `ALTER DEFAULT PRIVILEGES` lines are the ones people forget. Without them, the first table your next migration creates is invisible to the application and the deploy fails with "permission denied for table" on a table that plainly exists.

In the Nest application, that means two environment variables and two secrets. The migration job gets `DATABASE_URL` pointing at `app_migrator`; the Deployment gets one pointing at `app_runtime`. Same code, different credential — and the credential is what enforces the boundary, not a code review.

## Expand and contract, on a Nest timeline

A rolling deploy runs old and new code against the same database at the same time. Any migration that is not backwards compatible with the currently-running version breaks requests during the rollout window.

Renaming `users.name` to `users.display_name` is four deploys, not one:

| Deploy | Migration | Application code |
| --- | --- | --- |
| 1 — expand | `ADD COLUMN display_name`, backfill in batches, add a trigger or dual-write | writes both columns, reads `name` |
| 2 — switch reads | none | reads `display_name`, still writes both |
| 3 — stop writing the old | none | writes only `display_name` |
| 4 — contract | `DROP COLUMN name` | unchanged |

Each deploy is independently safe to roll back, which is the actual point. A single "rename" migration is a deploy you cannot roll back, because the old code needs a column that no longer exists.

The Nest-specific part is the entity. During deploy 1 and 2 the entity carries both properties:

```ts title="src/users/user.entity.ts"
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number

  /** @deprecated removed in the contract migration; do not read in new code. */
  @Column({ name: 'name', nullable: true })
  legacyName: string | null

  @Column({ name: 'display_name', nullable: true })
  displayName: string | null
}
```

Both columns are `nullable: true` throughout. A `NOT NULL` on the new column in deploy 1 breaks every insert from the old code, which does not set it. Add the constraint in a later migration, after the backfill is complete and the old code is gone.

Backfill in batches from a migration or a one-shot job, never as a single `UPDATE users SET display_name = name` on a large table — that takes a row lock on every row for the duration and blocks writes. [Migrations](../databases/migrations.md) has the batching pattern and the per-operation lock costs.

## Verifying, not migrating, at boot

The application should not *run* migrations, but it is entirely reasonable for it to refuse to start against a schema it does not understand. That catches the deploy where someone skipped the migration job.

```ts title="src/database/schema-guard.service.ts"
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Injectable()
export class SchemaGuardService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaGuardService.name)
  private readonly dataSource: DataSource

  constructor(@InjectDataSource() dataSource: DataSource) {
    this.dataSource = dataSource
  }

  async onApplicationBootstrap() {
    // showMigrations() returns true when migrations are PENDING. It only
    // reads the migrations table — it applies nothing.
    const pending = await this.dataSource.showMigrations()
    if (pending) {
      this.logger.error('database has pending migrations; refusing to start')
      throw new Error('pending migrations')
    }
    this.logger.log('schema is up to date')
  }
}
```

Throwing from `onApplicationBootstrap` fails the bootstrap, the pod never becomes ready, and the deploy stops with an accurate message instead of a stream of "column does not exist" 500s. During an expand/contract sequence, when the old version legitimately runs against a newer schema, relax this to a warning — the check is for "the migration did not run", not "the schema is newer than me".

## Security considerations

**The application user owns nothing.** DDL belongs to a separate role used only by the deploy pipeline. This converts a successful SQL injection from "the attacker rewrites the schema and installs a persistence mechanism" into "the attacker reads and writes rows they could reach anyway" — still bad, categorically less bad.

**Migration credentials live only in the pipeline.** A separate secret, mounted only into the migration job, never into the application Deployment, never in a `.env` a developer can copy. If a developer needs DDL locally, that is a local database.

**`synchronize: true` is a security problem, not only an availability one.** It applies DDL derived from whatever code the process is running. Anyone who can get a branch deployed can rewrite the schema, and dropping a column drops its data.

**Never build a migration's SQL from a variable.** Migrations run with the highest-privilege credential you have, so an interpolated identifier there is the worst possible place for one. Table and column names are literals in a migration file, always.

**Review migrations like production code.** They run as the owner. A migration that adds a `GRANT`, creates an extension, or changes a `SECURITY DEFINER` function is a privilege change, and it should need the same approval as an IAM change.

**Do not log the migration's connection string.** TypeORM's `logging: ['migration']` prints statements, not credentials, but a bootstrap failure in the job prints the options object — [Safe logging](../nestjs-security/safe-logging.md).

**Take a backup before a contract migration.** `DROP COLUMN` and `DROP TABLE` have no undo, and `down()` recreates the column empty. Verify that the backup restores, not just that it exists.

**Keep migration files immutable once applied.** Editing an applied migration means environments diverge invisibly: production ran the old text, the new environment runs the new text, and the checksums no longer describe reality. Fix forward with a new migration.

## Production considerations

- **Migrations are a pipeline step, before the rollout.** `synchronize: false`, `migrationsRun: false`, always.
- **A `Job`, not an `initContainer`.** One execution per rollout, not one per pod.
- **`backoffLimit: 0`.** Do not retry a partially-applied migration automatically.
- **Fail the deploy on a failed migration.** The new replicas must not start.
- **One options function shared by the Nest module and the CLI data source.** Drift between them produces migrations generated against a schema that does not exist.
- **Run the migration job against compiled output**, the same artifact the application runs, so a TypeScript-only path cannot behave differently.
- **Every migration must be backwards compatible with the running version.** Expand/contract for anything else.
- **`CREATE INDEX CONCURRENTLY` in its own migration, outside a transaction,** with `IF NOT EXISTS` so a retry is safe.
- **Batch backfills.** A single `UPDATE` over a large table locks every row it touches for the duration.
- **Set a lock timeout for DDL.** `SET lock_timeout = '5s'` at the top of a migration means it fails fast instead of queueing behind a long-running query and then blocking every subsequent query on that table.
- **Time-box the job** (`activeDeadlineSeconds`) so a migration that will never finish is visible rather than silently pending.
- **Test the rollback.** `migration:revert` / a `down()` that has never been run is a hope, not a plan.
- **Refuse to start on pending migrations** — a cheap guard that catches a skipped deploy step immediately.

## Common mistakes

- **`synchronize: true` anywhere but a scratch database.** It drops columns.
- **`migrationsRun: true` with more than one replica.** Concurrent migration runs during a rollout.
- **An `initContainer` running the migration.** One run per pod, concurrently.
- **The application user owning the schema.** An injection can then rewrite it.
- **Forgetting `ALTER DEFAULT PRIVILEGES`.** New tables are invisible to the application and the deploy fails on a table that exists.
- **Two data-source definitions.** The CLI and the app drift, and migrations are generated against the wrong schema.
- **Applying a generated migration unread.** A rename becomes `DROP COLUMN` + `ADD COLUMN` and the data is gone.
- **A `NOT NULL` column added in the expand step.** Every insert from the still-running old code fails.
- **`prisma migrate dev` in a pipeline.** It diffs, it needs a shadow database, and it offers to reset.
- **Installing `prisma` without pinning the major.** `latest` is a release candidate.
- **Editing a migration that has already been applied somewhere.** Environments diverge with no signal.
- **`CREATE INDEX CONCURRENTLY` inside TypeORM's default transaction.** It errors, and the migration is half-applied.
- **A single-statement backfill on a large table.** Locks every row and blocks writes for the duration.
- **No backup before a contract migration.** `down()` gives you an empty column back.

## Related topics

- [Migrations](../databases/migrations.md) — forward-only migrations, per-operation lock costs, `CREATE INDEX CONCURRENTLY` and expand/contract in detail.
- [Connections and DI](connections-and-di.md) — `synchronize`, `migrationsRun` and the rest of the `forRootAsync` options.
- [TypeORM](../nestjs-orms/typeorm.md) — entities, the CLI binaries and the generation workflow.
- [Prisma](../nestjs-orms/prisma.md) — `prisma.config.ts`, the driver adapter and the generated client.
- [Seeding](seeding.md) — the other thing that is not a boot step.
- [Testing with a database](testing-with-a-database.md) — running the same migrations in the test bootstrap.
- [Build and deployment](../nestjs-production/build-and-deployment.md) — where the migration job sits in the release.
- [Continuous integration](../nestjs-production/ci.md) — proving migrations apply cleanly before they reach production.
- [Docker](../nestjs-production/docker.md) — shipping the compiled migrations and running `prisma generate` in the build.
- [Secrets and config validation](../nestjs-security/secrets-and-config.md) — two credentials, two secrets, validated at boot.
