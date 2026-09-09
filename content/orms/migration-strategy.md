---
title: Migration strategy
description: Choosing a migration tool, expand/contract for zero-downtime schema change, running migrations in CI/CD, drift detection, and why forward-fix beats down-migrations.
status: current
updated: 2026-09-08
---

A migration tool applies ordered, recorded changes to a database schema. The tool is the easy part — every ORM on this site ships one and they all work. The hard part is the operational shape around it: when migrations run relative to a deploy, what happens when one fails, and how you change a column that a running application is currently using.

## Why it exists

Two problems, and only one of them is about applying SQL.

**Ordering and recording.** Twelve developers produce twelve schema changes. Something has to apply them in a deterministic order, exactly once, on every environment, and know which have already run. That is what the migrations table is for, and it is why "just run the SQL" stops working at about two people.

**Coordination with running code.** Your database schema and your application code are deployed by different mechanisms at different moments. For a window — seconds if you are lucky, minutes if you are not — old code is running against a new schema, or new code against an old one. Every zero-downtime technique on this page exists to make that window survivable.

## How it works

### Choosing a migration tool

Use the one that ships with the tool that owns your schema. Mixing is how you get two migration tables and a schema nobody can reproduce.

| If you use | Use | Style |
| --- | --- | --- |
| [Prisma](./prisma.md) | `prisma migrate` | Generated `.sql` from a schema diff |
| [Drizzle](./drizzle.md) | `drizzle-kit` | Generated `.sql` from a snapshot diff |
| [TypeORM](./typeorm.md) | `typeorm migration:*` | Generated TypeScript classes from an entity diff |
| [Sequelize](./sequelize.md) | `sequelize-cli` (or Umzug) | Hand-written `queryInterface` scripts |
| [Knex](./knex.md) | `knex migrate:*` | Hand-written `up`/`down` |
| [Mongoose](./mongoose.md) | `migrate-mongo` | Hand-written data migrations; no DDL to apply |
| Raw driver | Knex, Umzug, or plain `.sql` + a runner | Whatever you like |

Two properties are worth insisting on regardless of which you pick.

**The migration artifact should be readable SQL, or trivially convertible to it.** When a migration fails at 2am, you want to read the statement, not decode a builder chain. Prisma and Drizzle emit plain `.sql`; that is a real operational advantage.

**Migrations are immutable once merged.** Editing an applied migration means environments diverge silently, because the tool only records that the file ran, not what it contained. Fix forward with a new migration.

### Generated vs hand-written

Generated migrations come from diffing a declarative schema against a database. They save real time and they have one structural limitation you cannot engineer around: **a diff has no access to your intent.**

```sql title="What the generator writes for a rename"
ALTER TABLE "users" DROP COLUMN "full_name";
ALTER TABLE "users" ADD COLUMN "display_name" TEXT;
```

```sql title="What you meant" good
ALTER TABLE "users" RENAME COLUMN "full_name" TO "display_name";
```

The first one destroys every value in the column. This is not an edge case; renames are common, and this is the single most frequent way teams lose production data to an ORM.

The same blindness applies to:

- **Type changes.** A generated `int` → `bigint` may be a rewrite that locks the table for minutes.
- **`NOT NULL` additions.** The generator adds the constraint; it does not backfill the existing rows first, so the migration fails or locks.
- **Index creation.** Generators emit plain `CREATE INDEX`, which takes a write lock. On a large table you want `CONCURRENTLY`.
- **Column drops.** Correct SQL, wrong timing — see expand/contract below.

:::best-practice
Treat a generated migration as a **first draft**. Open the file, read every statement, and edit it. All three generators emit plain files precisely so you can. A migration that nobody read is a migration nobody reviewed.
:::

Hand-written migrations invert the trade: no surprises, more typing, and the risk that your models and your schema drift because nothing diffs them. Sequelize is the clearest example — its models and its migrations are entirely independent, and only one of them touches production.

### Expand and contract

The technique for changing a schema without downtime. You never change a thing in place; you add the new thing, move to it, then remove the old one — as **separate deploys**.

Renaming `full_name` to `display_name`, properly:

**1. Expand — add the new column. Deploy the migration alone.**

```sql title="migrations/001_add_display_name.sql"
ALTER TABLE users ADD COLUMN display_name TEXT;
```

Old code does not know the column exists. Nothing breaks. The column is nullable — an immediate `NOT NULL` would fail against existing rows.

**2. Dual-write — deploy code that writes both columns and reads the old one.**

```js title="src/repos/users.js"
export async function updateName(id, name) {
  await db('users').where({ id }).update({ full_name: name, display_name: name })
}
```

Now every new and updated row has both. Old replicas still running from step 1 write only `full_name`, which is fine because you are still reading `full_name`.

**3. Backfill — copy the existing rows, in batches.**

```sql title="migrations/002_backfill_display_name.sql"
UPDATE users SET display_name = full_name
WHERE display_name IS NULL AND id BETWEEN 1 AND 10000;
```

Batch it. A single `UPDATE` over ten million rows holds locks and bloats the write-ahead log. Loop over id ranges with a pause between batches, and run it as a job rather than a blocking migration if the table is large.

**4. Switch reads — deploy code that reads `display_name`.**

Both columns are populated, so this deploy is safe in both directions. **This is your rollback point**: if the new code misbehaves, redeploy the previous version and it reads `full_name`, which is still current.

**5. Stop writing the old column — deploy code that writes only `display_name`.**

**6. Contract — drop the old column, after the new code has been stable long enough that you will not roll back to a version that needs it.**

```sql title="migrations/003_drop_full_name.sql"
ALTER TABLE users DROP COLUMN full_name;
```

Six steps to rename a column. That is the actual cost of zero downtime, and it is why you should think hard before renaming things.

The same shape covers the other breaking changes:

| Change | Expand | Contract |
| --- | --- | --- |
| Rename column | Add new, dual-write, backfill | Drop old |
| Make column `NOT NULL` | Add with a default or backfill, add a `NOT VALID` check, validate it | Set `NOT NULL` |
| Change column type | Add new-typed column, dual-write, backfill | Drop old, rename |
| Split a table | Create new table, dual-write | Drop old columns |
| Remove a column | *(nothing)* | Stop reading it in code, deploy, then drop |

Note the last row. **Dropping a column requires a deploy first**, because a replica still running the old code will `SELECT` it. Same for dropping a table.

:::warning
`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT …` is cheap on modern PostgreSQL and MySQL, but adding `NOT NULL` to an *existing* column requires a full table scan while holding an exclusive lock. On PostgreSQL, add a `CHECK (col IS NOT NULL) NOT VALID` constraint, `VALIDATE CONSTRAINT` it without an exclusive lock, then set `NOT NULL` — which is then near-instant because the constraint proves it.
:::

### Running migrations in CI/CD

The order is: **migrate, then deploy code.** Because you are only ever making additive changes (expand/contract above), the new schema is always compatible with the currently-running old code.

```yaml title=".github/workflows/deploy.yml"
jobs:
  migrate:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm ci
      - run: npx prisma migrate deploy
        env:
          DATABASE_URL: ${{ secrets.MIGRATOR_DATABASE_URL }}

  deploy:
    needs: migrate
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/deploy.sh
```

Points to copy: a **separate job**, a **different database URL** (see the DDL user section below), and a hard `needs:` dependency so a failed migration stops the deploy.

Run `migrate deploy` / `migrate:latest` / `drizzle-kit migrate` — the apply-only commands. Never run the *generating* command (`prisma migrate dev`, `drizzle-kit generate`, `typeorm migration:generate`) in CI. Those compare against a live database and can decide to create or drop things.

#### Why not on app boot

Putting `await migrate()` in your server entry point works perfectly with one replica. Then you scale to three and it stops.

**They race.** Three processes start within milliseconds of each other and all read an empty migrations table. Every tool has a lock — Knex uses `knex_migrations_lock`, Prisma an advisory lock — so you usually get serialization rather than corruption. But "usually" is doing a lot of work: what you reliably get is two replicas blocked on a lock during startup, failing their readiness probes, and an orchestrator killing them mid-migration. A migration killed while holding a lock leaves the lock held, and the next deploy hangs.

**They break rollbacks.** Rolling back to the previous image re-runs its startup code. That code contains an older set of migrations, and the tool now sees migrations in the database it does not have files for.

**They break horizontal scaling.** An autoscaler adding a replica at peak load starts a process that tries to take a migration lock. Startup is now coupled to schema state for no reason.

**They hide failures.** A migration error during boot looks like a crash loop, not a schema problem.

**They need the wrong permissions.** Your application process now needs DDL rights permanently, to run migrations that happen twice a month.

:::danger
`migrationsRun: true` (TypeORM), `sequelize.sync()` (Sequelize), `autoIndex: true` (Mongoose in production) and `await migrate(db, …)` in your server entry point are the same mistake. Migrations are a deployment step. Run them from a job, a `release` phase, a Kubernetes `Job`, or an init container that runs exactly once — not from the process that serves traffic.
:::

If your platform has no separate migration phase, a Kubernetes `Job` with `backoffLimit: 0` gated ahead of the rollout is the standard substitute.

### Rollback reality

Every tool offers a `down` migration. In production you will almost never run one.

**Down migrations lose data by definition.** The `down` for "add a column" is "drop the column". Running it discards everything written since the `up`. That is not a rollback; it is a second destructive change.

**They are almost never tested.** The `up` runs in every environment on every deploy. The `down` runs when someone remembers to try it. Untested code executed under incident pressure against production is the worst possible combination.

**They cannot undo a rewrite.** Once `up` has changed a column type and truncated values, no `down` restores the originals.

**Rolling back code is different from rolling back schema — and it is the one you actually do.** With expand/contract, the schema is compatible with both versions, so redeploying the previous image is a complete, instant, safe rollback that touches no data.

The working strategy:

1. **Make schema changes backward-compatible** so you never need a schema rollback. This is the whole point of expand/contract.
2. **Roll back the code**, not the schema.
3. **When a migration is genuinely wrong, write a new migration that corrects it.** Forward-fix. It goes through review, it runs in staging first, it is recorded in history, and it is subject to the same care as any other change.
4. **Keep writing `down` migrations anyway** — they are genuinely useful in local development, where you rewind a branch a dozen times a day.
5. **Take a backup or a snapshot before any destructive migration.** For anything irreversible, that snapshot is your real rollback plan.

Every ORM has a way to mark a partially-applied migration resolved so the runner can move on — Prisma has `migrate resolve --applied` / `--rolled-back`, Knex has `forceFreeMigrationsLock`. Know yours before you need it.

### Drift detection

Drift is when the actual database schema differs from what your migrations describe. It comes from a manual `ALTER` during an incident, a `push`/`sync` command run against the wrong environment, or a migration that half-applied.

The cost is that your *next* generated migration is computed from the wrong baseline, so it tries to "fix" the drift — sometimes by dropping the column somebody added by hand.

| Tool | Drift check |
| --- | --- |
| Prisma | `prisma migrate status`; `prisma migrate dev` detects drift and reports it |
| Drizzle | `drizzle-kit check` validates the migration folder; `drizzle-kit generate` on a clean tree should produce nothing |
| TypeORM | `typeorm migration:generate` on a clean tree should produce an empty migration |
| Knex / Sequelize | `migrate:status` / `db:migrate:status` shows pending files only — no schema comparison |

The portable check, which works with every tool: **in CI, run the migrations against an empty database, then generate a migration. If the generator produces anything, the migrations and the schema definition disagree.**

```bash title="scripts/check-drift.sh"
#!/usr/bin/env bash
set -euo pipefail

docker run -d --name drift-check -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
export DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres"

npx prisma migrate deploy
npx prisma migrate diff \
  --from-config-datasource --to-schema-datamodel prisma/schema.prisma \
  --exit-code
```

Run it on every pull request. It catches the "I edited the schema and forgot to generate a migration" mistake before merge, which is the common case.

The other half is preventing drift: nobody applies DDL by hand, ever, including during an incident. If you must, write the migration file immediately afterwards and mark it applied.

### Separating the DDL user from the app user

Your application does not need permission to drop tables. Give it a role that cannot.

```sql title="db/roles.sql"
-- Owns the schema. Used only by migrations.
CREATE ROLE app_migrator LOGIN PASSWORD :'migrator_password';
GRANT ALL ON SCHEMA public TO app_migrator;

-- Runs the application. No DDL.
CREATE ROLE app_runtime LOGIN PASSWORD :'runtime_password';
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Tables created later by app_migrator get the same grants automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Explicitly deny the dangerous one.
REVOKE CREATE ON SCHEMA public FROM app_runtime;
```

The `ALTER DEFAULT PRIVILEGES` lines are the part people miss. Without them, every new table created by a migration is invisible to the runtime user, and you find out on deploy.

Two connection strings then: `MIGRATOR_DATABASE_URL` for the migration job, `DATABASE_URL` for the app. The migrator credential lives in your CI secret store and is never present in the application environment.

Why this is worth the setup:

- **SQL injection stops at `DROP TABLE`.** A successful injection against a runtime user with no DDL rights can still read and modify data — which is bad — but cannot destroy the schema or install a trigger.
- **`sync()` and `push` become impossible by accident.** They fail with a permission error instead of altering production.
- **Compromised application credentials have a smaller blast radius**, and the audit story is clearer: any DDL in the logs came from the migration job.

For Prisma, note that `prisma migrate dev` also needs `CREATEDB` for its shadow database. Grant that to the migrator role in development only; `migrate deploy` does not need it.

## Common patterns

### One migration per pull request, one concern per migration

A migration that adds a table, backfills it and drops a column is three things that can fail independently, in one transaction that either all works or all does not. Split them. Small migrations are easier to review, easier to time, and easier to reason about when one fails.

### Time your migrations against production-sized data

A migration that takes 40ms on your laptop's 100 rows can take 40 minutes and an exclusive lock on 100 million. Before merging anything that touches a large table, run it against a restored production snapshot and record the duration.

### Set a lock timeout on migrations

```sql
SET lock_timeout = '5s';
SET statement_timeout = '300s';
ALTER TABLE users ADD COLUMN display_name TEXT;
```

Without `lock_timeout`, an `ALTER TABLE` that cannot get its lock **queues behind a long-running query — and every subsequent query queues behind the `ALTER`.** That is how a "trivial" migration takes an entire application down. With it, the migration fails fast and you retry during a quieter moment.

### Separate data migrations from schema migrations

Backfilling ten million rows inside a schema migration holds a transaction open for the duration. Run backfills as idempotent, resumable, batched jobs that you can stop and restart. The schema migration adds the column; the job fills it.

### Seed data is not a migration

Reference data (country codes, plan tiers) belongs in a seed script that is idempotent — `INSERT … ON CONFLICT DO NOTHING`, or an upsert. Putting it in a migration means it runs once ever and cannot be corrected. See [Seeding](../databases/seeding.md).

## Security considerations

**The runtime user must not have DDL rights.** Covered above. This is the highest-value control on this page, because it converts a class of catastrophic outcomes into merely bad ones.

**Migration credentials are the most powerful in your system.** They can drop everything. Keep them in a CI secret store, scope them to the environment, never place them in the application's environment, and rotate them like production credentials. See [Secrets management](../security/secrets-management.md).

**Never build DDL from user input.** There is no legitimate reason for a runtime code path to generate `CREATE TABLE` or `ALTER TABLE` text. Multi-tenant systems that create a schema per tenant are the exception, and they must map a tenant id to an identifier through an allow-list or a strict validated pattern — never interpolate the tenant's chosen name.

**Migrations run against production data.** A migration that copies a column, renames a table, or writes to an audit log is handling real user records. Review them for PII the same way you review application code: a backfill that copies emails into a new denormalized table has just widened your exposure surface.

**Migration output ends up in CI logs.** Verbose modes print statements, and a data migration's error message can contain row values. Keep migration logs at the same access level as production logs.

**Check `migrate status` in your deployment health gate.** A silently skipped migration means new code is running against an old schema — often as a 500 loop, occasionally as a data corruption.

## Production considerations

**Migrate first, then deploy code.** With additive changes this is always safe. If you are ever tempted to reverse the order, the change is not additive and you need expand/contract.

**Never generate migrations in CI.** Only apply committed ones. `prisma migrate dev` and `typeorm migration:generate` compare against a live database and can create or drop things.

**Gate the deploy on the migration job.** A failed migration must stop the rollout, not race it.

**`CREATE INDEX CONCURRENTLY` for any index on a large table.** It cannot run inside a transaction, so disable the wrapping transaction for that migration — `migrationsTransactionMode: 'none'` in TypeORM, `config.transaction = false` in Knex, a standalone `.sql` file for Prisma and Drizzle.

**Know your dialect's transactional DDL story.** PostgreSQL rolls a failed migration back atomically. MySQL does not — a failure leaves the schema half-changed and you finish it by hand. On MySQL, keep migrations to one statement each.

**Always set `lock_timeout`.** An `ALTER` waiting on a lock blocks everything behind it.

**Snapshot before anything destructive.** `DROP COLUMN`, `DROP TABLE`, type changes. The snapshot is your rollback plan; the `down` migration is not.

**Have a plan for a stuck lock.** A migration killed mid-run leaves its lock held and every later run hangs. Know the command — `prisma migrate resolve`, `knex migrate:unlock` — before the incident.

**Keep migrations in version control alongside the code that needs them,** and never edit an applied one.

**Test migrations in CI against an empty database on every pull request.** Fresh Postgres container, run every migration from zero, then run your tests. This catches ordering bugs and a migration that only works because your dev database already had the table.

## Common mistakes

- **Running migrations from application startup.** Races across replicas, breaks rollback, couples scaling to schema state.
- **Applying a generated rename without reading it.** `DROP COLUMN` + `ADD COLUMN` loses the data.
- **Editing an applied migration.** Environments diverge silently.
- **Trusting `down` migrations as a production rollback.** They lose data and they are untested. Forward-fix.
- **Dropping a column in the same deploy that stops using it.** Old replicas still select it.
- **Adding `NOT NULL` to an existing column without a backfill.** Fails, or locks the table for a full scan.
- **Plain `CREATE INDEX` on a large table.** Write lock for the duration.
- **No `lock_timeout`.** A blocked `ALTER` blocks everything queued behind it.
- **Backfilling ten million rows in one statement inside a migration.** Long transaction, lock contention, WAL bloat.
- **Running the app with a DDL-capable database user.** Nothing needs it and it widens every other vulnerability.
- **Forgetting `ALTER DEFAULT PRIVILEGES`.** New tables are unreadable by the runtime user.
- **Generating migrations in CI.** It compares against a live database.
- **Never testing a migration against production-sized data.** 40ms locally, 40 minutes and an outage in production.
- **Letting drift accumulate.** The next generated migration is computed from the wrong baseline.

## Related topics

- [Migrations](../databases/migrations.md) — the mechanics, without the ORM layer.
- [Testing with a database](./testing-with-a-database.md) — running migrations in the test bootstrap.
- [Comparison table](./comparison.md) — the migration story of each ORM side by side.
- [Prisma](./prisma.md), [Drizzle](./drizzle.md), [TypeORM](./typeorm.md), [Sequelize](./sequelize.md), [Knex](./knex.md) — tool-specific commands.
- [Continuous integration](../production/ci.md) — where the migration job belongs in the pipeline.
- [Seeding](../databases/seeding.md) — reference data, which is not a migration.
- [Secrets management](../security/secrets-management.md) — handling the migrator credential.
- [Deployment checklist](../production/deployment-checklist.md) — migration gates before a release.
- [Indexing basics](../databases/indexing-basics.md) — why `CONCURRENTLY` matters.
