---
title: Migrations
description: Versioned, forward-only schema changes run in CI, with expand/contract for zero downtime, CREATE INDEX CONCURRENTLY, lock_timeout, and a separate DDL credential.
status: current
updated: 2026-09-08
---

A migration is a versioned, reviewed, replayable change to your schema. The goal is that any database — a colleague's laptop, CI, staging, production — can be brought to the current schema by running the same ordered list of files, and that applying them to a live production database does not lock it.

## Why it exists

Without migrations, the schema is whatever someone typed into a console. There is no history, no review, no way to reproduce it, and no way to know whether staging matches production. The first time you find out they diverged is during an incident.

Three properties make a migration system work:

1. **Versioned and ordered.** Each change has an identity and a position. The database records which have been applied.
2. **In the repository, reviewed like code.** A schema change is a code change with a longer blast radius.
3. **Run automatically in CI and on deploy.** A migration that requires a human to remember it is a migration that will be forgotten.

## Forward-only

Most migration tools support a `down` migration that reverses the `up`. Write them if the tool requires it, keep them for local development, and **do not plan to use them in production**.

A `down` migration that drops a column destroys the data in it. Running it under incident pressure to "roll back the deploy" turns a bad deploy into a data-loss event, and the rollback itself is the least-tested code path you have.

The production rollback strategy is *forward*: write a new migration that undoes the change, review it, and deploy it like anything else. That path is tested, reviewable and reversible.

This is why the expand/contract pattern below matters so much: if each step is individually safe and backward-compatible, you never need a rollback, because you can simply stop.

## Never edit an applied migration

Once a migration has run anywhere outside your own machine, it is immutable.

Migration tools record applied migrations by name, and most also record a checksum. Editing an applied file means:

- Databases that already ran it never get your change — production has one schema, a fresh CI database has another.
- Checksum-verifying tools (Flyway, Prisma Migrate) refuse to run and the deploy fails.
- Tools without checksums do something worse: they succeed, and the divergence is silent until a query fails in production only.

The fix for a wrong migration is always a new migration. Even five minutes later. Even if it is embarrassing.

:::warning The one exception
A migration that exists only on your feature branch, has never been merged, and has only ever run on your own machine can be edited — but rewrite it fully, drop your local database and re-run from scratch to verify.
:::

## Migration user vs application user

The application must not own DDL.

The application connects with a role that can `SELECT`, `INSERT`, `UPDATE` and `DELETE` on its tables. Migrations connect with a different role that owns the schema and can `CREATE`, `ALTER` and `DROP`.

```sql title="postgres — one-time setup"
-- Owner of the schema; used only by the migration job.
CREATE ROLE app_migrate LOGIN PASSWORD :'migrate_password';
ALTER SCHEMA public OWNER TO app_migrate;

-- The application role: DML only.
CREATE ROLE app_user LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE appdb TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
REVOKE CREATE ON SCHEMA public FROM app_user;

-- Apply the same grants to tables future migrations create.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
```

The `ALTER DEFAULT PRIVILEGES` lines are the ones people miss. Without them, every new table is invisible to the application until someone runs a manual `GRANT`, and the failure appears as a permission error in production after a successful migration.

The security argument is direct: a SQL injection in an application that cannot execute DDL can read and modify rows, which is bad. The same injection in an application connected as the schema owner can `DROP TABLE`, which is unrecoverable without a restore. The privilege separation converts a catastrophe into an incident.

The same split in MySQL:

```sql title="mysql — one-time setup"
CREATE USER 'app_migrate'@'%' IDENTIFIED BY 'redacted';
GRANT ALL PRIVILEGES ON appdb.* TO 'app_migrate'@'%';

CREATE USER 'app'@'%' IDENTIFIED BY 'redacted';
GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'app'@'%';
```

Note that `app` gets no `FILE` privilege — that would allow `LOAD DATA INFILE` and `SELECT … INTO OUTFILE`, turning an injection into arbitrary file access.

## Migrations in CI

Run migrations as a **separate step before the new application version starts**, not from the application's own boot sequence.

Booting the app with a migration step means every replica races to run them at once. Tools take an advisory lock so only one wins, but the rest wait, your rolling deploy stalls, and a failed migration becomes a crash loop.

A working pipeline:

```yaml title=".github/workflows/deploy.yml"
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm ci
      - run: npm run migrate:up
        env:
          # The direct database URL with the DDL credential — never the pooler.
          DATABASE_URL: ${{ secrets.MIGRATE_DATABASE_URL }}

  deploy:
    needs: migrate
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/deploy.sh
```

Also run them on **every pull request** against a throwaway database, so a migration that fails on a clean schema is caught before merge:

```bash
docker run -d --name pgtest -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
npm run migrate:up
npm run migrate:status
```

And verify the resulting schema matches what the ORM or the checked-in schema file expects. A drift check that fails the build is how you stop someone hand-editing production.

:::warning Migrations must not go through a transaction-mode pooler
PgBouncer in transaction mode breaks session-level state, advisory locks and `CREATE INDEX CONCURRENTLY`. Give the migration job a direct connection string. See [Connection pooling](connection-pooling.md).
:::

## Locking pitfalls

This is the part that causes outages.

In PostgreSQL, most `ALTER TABLE` forms take an **ACCESS EXCLUSIVE** lock — the strongest there is. It conflicts with everything, including plain `SELECT`.

Usually that is fine, because the operation itself takes microseconds. The danger is the **lock queue**:

1. A long-running query holds an ACCESS SHARE lock on `users` — say a 30-second report.
2. Your `ALTER TABLE users` requests ACCESS EXCLUSIVE and waits behind it.
3. **Every subsequent query on `users` now queues behind your ALTER**, because lock requests are granted in order.

Your instant migration has taken the table offline for 30 seconds. The database looks healthy: low CPU, few active queries, everything waiting on locks.

The mitigation is `lock_timeout`. Fail fast and retry rather than queueing behind a long query.

```sql title="migrations/013_add_last_login.sql"
SET lock_timeout = '3s';
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
```

If it cannot get the lock in 3 seconds, the migration fails, nothing is blocked, and you retry when the report is not running. A failed migration is enormously better than a locked table.

:::best-practice
Put `SET lock_timeout = '3s'` at the top of every migration that touches an existing table, and run schema changes in a low-traffic window. Some tools support a retry loop around the lock acquisition; that is the ideal.
:::

### Operations and their cost in PostgreSQL

| Operation | Lock | Rewrites the table |
| --- | --- | --- |
| `ADD COLUMN` (nullable, no default) | ACCESS EXCLUSIVE, brief | No |
| `ADD COLUMN … DEFAULT <constant>` | ACCESS EXCLUSIVE, brief | No, since PG 11 |
| `ADD COLUMN … DEFAULT <volatile>` (e.g. `now()`) | ACCESS EXCLUSIVE | **Yes** — full rewrite |
| `ADD COLUMN … NOT NULL` without a default | ACCESS EXCLUSIVE | Fails unless the table is empty |
| `DROP COLUMN` | ACCESS EXCLUSIVE, brief | No — the data is left in place |
| `ALTER COLUMN TYPE` | ACCESS EXCLUSIVE | **Usually yes** |
| `SET NOT NULL` | ACCESS EXCLUSIVE | Full scan, unless a validated `CHECK` exists (PG 12+) |
| `ADD CONSTRAINT … NOT VALID` | ACCESS EXCLUSIVE, brief | No |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | Scans, but does not block reads or writes |
| `CREATE INDEX` | SHARE — **blocks writes** | — |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | Two passes, does not block writes |
| `ADD FOREIGN KEY` | ACCESS EXCLUSIVE on both tables | Scans, unless `NOT VALID` |

The pattern for adding a foreign key or a check constraint without a long lock is two steps:

```sql title="migrations/014_orders_user_fk.sql"
SET lock_timeout = '3s';
ALTER TABLE orders
  ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
  NOT VALID;
```

```sql title="migrations/015_orders_user_fk_validate.sql"
ALTER TABLE orders VALIDATE CONSTRAINT orders_user_id_fkey;
```

`NOT VALID` enforces the constraint on new rows immediately while skipping the scan of existing ones. `VALIDATE CONSTRAINT` then scans under a weak lock that permits reads and writes.

MySQL 8 performs many `ALTER TABLE` operations online (`ALGORITHM=INPLACE, LOCK=NONE`), but not all — and it silently falls back to a copying algorithm if you do not say otherwise. Be explicit so a slow rebuild fails instead of running:

```sql
ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL, ALGORITHM=INPLACE, LOCK=NONE;
```

## CREATE INDEX CONCURRENTLY

A plain `CREATE INDEX` takes a SHARE lock, which blocks writes for the whole build. On a large table that is minutes of failed inserts.

```sql title="migrations/016_orders_user_created_idx.sql"
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_user_id_created_at_idx
  ON orders (user_id, created_at DESC);
```

Four things you must know:

1. **It cannot run inside a transaction block.** Most migration tools wrap each migration in a transaction, so you must opt out. `node-pg-migrate` uses `exports.up.transaction = false`; Knex uses `config.transaction = false`; other tools have an equivalent flag. Without it you get `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.

2. **It can fail and leave an invalid index.** A concurrent build that is interrupted, deadlocks, or hits a uniqueness violation leaves an index marked `indisvalid = false`. It is not used by queries but *is* maintained on every write — pure cost. Find and clean them up:

   ```sql
   SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
     FROM pg_index WHERE NOT indisvalid;
   ```

   Then `DROP INDEX CONCURRENTLY <name>` and re-run. This is why the `IF NOT EXISTS` above matters for a re-runnable migration.

3. **It is slower and does two passes** over the table, so it costs more I/O than the blocking version. That is the trade you are making.

4. **`DROP INDEX CONCURRENTLY`** exists too, and dropping an index is not free either — a plain `DROP INDEX` takes ACCESS EXCLUSIVE.

Because a concurrent index build can take a long time, keep it in its own migration. A file that creates an index and also alters a column has one failure mode you cannot retry cleanly.

## Expand and contract

The zero-downtime pattern. The core idea: **the old code and the new code must both work against every intermediate schema**, because during a rolling deploy both are running.

Renaming `users.name` to `users.full_name` in one `ALTER TABLE RENAME COLUMN` breaks every running replica of the old version instantly. Instead, split it into steps that ship on separate deploys.

**Step 1 — Expand.** Add the new column. Nothing reads it yet.

```sql title="migrations/020_add_full_name.sql"
SET lock_timeout = '3s';
ALTER TABLE users ADD COLUMN full_name text;
```

**Step 2 — Dual write.** Deploy application code that writes both columns and still reads the old one.

```js title="src/repos/users.repo.js"
export function updateName(tx, id, value) {
  return tx.query('UPDATE users SET name = $1, full_name = $1 WHERE id = $2', [value, id])
}
```

**Step 3 — Backfill.** Copy existing rows, **in batches**. A single `UPDATE users SET full_name = name` locks every row it touches until commit, which on a large table means a long transaction, table bloat and blocked writers.

```js title="scripts/backfill-full-name.js"
import { pool } from '../src/db/pool.js'

const BATCH = 5_000

for (;;) {
  const { rowCount } = await pool.query(
    `UPDATE users SET full_name = name
      WHERE id IN (
        SELECT id FROM users WHERE full_name IS NULL ORDER BY id LIMIT $1
      )`,
    [BATCH],
  )
  if (rowCount === 0) break
  console.log('backfilled', rowCount)
  await new Promise((r) => setTimeout(r, 100)) // let replication catch up
}
```

The pause matters: a tight backfill loop generates WAL faster than a read replica can apply it, and replication lag becomes stale reads.

**Step 4 — Switch reads.** Deploy code that reads `full_name`. It still writes both, so a rollback to step 2 remains safe.

**Step 5 — Stop writing the old column.** Deploy.

**Step 6 — Contract.** Only once no running code references `name`:

```sql title="migrations/024_drop_name.sql"
SET lock_timeout = '3s';
ALTER TABLE users DROP COLUMN name;
```

Six deploys instead of one. Every intermediate state is safe, no step needs a rollback, and you can stop at any point.

The same shape covers the other breaking changes:

| Change | Expand | Contract |
| --- | --- | --- |
| Rename a column | Add new, dual-write, backfill, switch reads | Drop old |
| Narrow a type | Add new typed column, backfill with validation | Drop old |
| Add `NOT NULL` | Add nullable, backfill, add `CHECK … NOT VALID`, validate | `SET NOT NULL` (cheap once validated) |
| Split a table | Create new table, dual-write, backfill | Drop old columns |
| Add a unique constraint | `CREATE UNIQUE INDEX CONCURRENTLY`, fix duplicates | `ADD CONSTRAINT … USING INDEX` |

Note the `NOT NULL` row: in PostgreSQL 12 and later, `SET NOT NULL` can use an already-validated `CHECK (col IS NOT NULL)` constraint instead of scanning the table, turning a long ACCESS EXCLUSIVE hold into a brief one.

## The tools

| Tool | Style | Notes |
| --- | --- | --- |
| **node-pg-migrate** | JS or SQL files, Postgres only | Explicit and unopinionated. Supports per-migration `transaction = false`, which you need for `CREATE INDEX CONCURRENTLY`. Good default for a raw-`pg` codebase. |
| **Knex migrations** | JS files, query-builder API, many databases | Comes with `knex` 3.3.0. Convenient if you already use Knex; the builder abstraction hides Postgres-specific DDL, so drop to `knex.raw()` for concurrent indexes. See [Knex](../orms/knex.md). |
| **Prisma Migrate** | Generated SQL from a declarative schema | You edit `schema.prisma`; it diffs and generates SQL you can review and edit. Checksums applied migrations. Needs a direct URL, not a pooler. Prisma 7.10.0 — see [Prisma](../orms/prisma.md). |
| **Drizzle Kit** | Generated SQL from TypeScript schema | `drizzle-kit` 0.31.10. Generates plain SQL files you own and can edit. Lighter than Prisma. See [Drizzle](../orms/drizzle.md). |
| **Sequelize CLI** | JS files with `up`/`down` | `sequelize-cli` 6.6.5. Established; the API predates most zero-downtime practice, so write raw SQL for the risky operations. See [Sequelize](../orms/sequelize.md). |
| **Atlas** | Declarative or versioned, schema-as-code | Language-agnostic Go binary. Its differentiator is lint rules that **detect destructive and blocking changes in CI** — it will fail a pull request that adds a blocking index. Worth evaluating even alongside another tool. |

Plain SQL files run by a small script is also a legitimate choice. What matters is that changes are ordered, recorded, reviewed and replayable — not which library applies them.

Detailed comparison and the ORM-specific workflows: [Migration strategy](../orms/migration-strategy.md).

## Security considerations

**Separate the DDL credential from the application credential.** This is the highest-value control on the page. An injection in an application that cannot `DROP` costs you data confidentiality; the same injection with schema ownership costs you the data.

**Store the migration credential separately** and give it to the CI job only. It should not exist in the application's environment at all. See [Secrets management](../security/secrets-management.md).

**Review migrations like security-sensitive code.** A migration can `GRANT` privileges, disable row-level security, drop a `CHECK` constraint, or add a column with a default that leaks. A one-line `ALTER TABLE users DISABLE ROW LEVEL SECURITY` in a 400-line diff is easy to miss.

**Never put secrets in a migration file.** Migrations are committed, replayed and often logged in full. Seeding an admin password from a migration puts that password in git forever. See [Seeding](seeding.md).

**Do not log migration SQL that contains data.** A backfill that moves personal data can end up in CI logs, which usually have wider access than the database.

**Adding a column is an exposure decision.** A new `ssn` or `date_of_birth` column is immediately visible to any `SELECT *` and to any ORM that serializes whole rows. Add the column and the projection change together.

**Destructive statements need a second pair of eyes.** Require an explicit approval for any migration containing `DROP TABLE`, `DROP COLUMN`, or `TRUNCATE`. A CI lint rule that greps for those and demands a label is crude and effective.

## Production considerations

- **`SET lock_timeout` in every migration** that touches an existing table. Failing is better than queueing.
- **Take a backup or a snapshot immediately before migrating.** Cheap on managed platforms, and it is your only real recovery for a destructive mistake.
- **Run migrations as a discrete deploy step**, before the new version starts, never from application boot.
- **Migrations must be idempotent enough to retry.** `IF NOT EXISTS`, `IF EXISTS`, and re-runnable backfills. A migration that fails halfway must be safe to run again.
- **Time them in staging with production-sized data.** A migration that takes 200 ms on 10,000 rows can take 40 minutes on 40 million.
- **Batch every backfill,** with a pause, and watch replication lag while it runs.
- **Use a direct connection, not a transaction-mode pooler.**
- **Check for invalid indexes after a failed concurrent build.** They cost writes and serve no reads.
- **Deploy the expand step and the contract step in different releases,** with the intermediate versions actually deployed in between. Combining them defeats the pattern.
- **Detect drift.** A scheduled job that diffs the production schema against the migration output catches manual console changes.
- **Keep migrations small.** One concern per file. A file that adds a table, backfills it and creates a concurrent index has three failure modes and no clean retry.

## Common mistakes

- **Editing a migration that has already run.** Silent schema divergence, or a checksum failure at deploy time.
- **Relying on `down` migrations for production rollback.** They drop data and are never tested.
- **Running migrations from the application's boot.** Every replica races; a failure becomes a crash loop.
- **`CREATE INDEX` without `CONCURRENTLY`** on a large table. Writes are blocked for the whole build.
- **`CREATE INDEX CONCURRENTLY` inside a transaction.** The tool wraps migrations by default; you get an error, or worse, you disable the wrapper for a file that also needs atomicity.
- **No `lock_timeout`.** Your instant `ALTER TABLE` queues behind a report and takes the table offline.
- **`ADD COLUMN … DEFAULT now()`** — a volatile default forces a full table rewrite. A constant default does not.
- **`SET NOT NULL` on a huge table** without the validated-`CHECK` trick. Full scan under ACCESS EXCLUSIVE.
- **An unbatched backfill.** One enormous transaction, one enormous lock, one bloated table.
- **The application role owning the schema.** An injection becomes a `DROP TABLE`.
- **Forgetting `ALTER DEFAULT PRIVILEGES`.** New tables are unreadable by the application and the failure only appears in production.
- **Renaming a column in one step during a rolling deploy.** The old replicas break immediately.
- **Migrating through PgBouncer in transaction mode.** Advisory locks and concurrent index builds do not work.

## Related topics

- [Migration strategy](../orms/migration-strategy.md) — the ORM-specific workflows in depth.
- [Seeding](seeding.md) — reference data, and why it is not a migration.
- [Connection pooling](connection-pooling.md) — the direct connection migrations need.
- [Indexing basics](indexing-basics.md) — deciding which indexes are worth their write cost.
- [Transactions](transactions.md) — why a long DDL transaction blocks everything.
- [PostgreSQL with pg](postgresql-with-pg.md) — privileges, SQLSTATE codes and timeouts.
- [MySQL with mysql2](mysql-with-mysql2.md) — online DDL and the separate credential.
- [Continuous integration](../production/ci.md) — running migrations on every pull request.
- [Secrets management](../security/secrets-management.md) — keeping the DDL credential out of the app.
- [Deployment checklist](../production/deployment-checklist.md) — where the migration step sits.
